/*
 * LinkGuard 0.1.0
 *
 * Privacy-first URL reputation for Mango Grove.
 *
 * "Not listed" means only that a URL/domain was not found in the enabled,
 * successfully loaded local lists. It is not a security guarantee.
 *
 * Chat URLs are never submitted to a reputation service. The extension only
 * downloads configured list files and matches locally.
 */

const VERSION = '0.1.0'

const SETTINGS_KEY = 'linkguard.settings.v3'
const SOURCE_CACHE_PREFIX = 'linkguard.source-cache.v3.'
const SOURCE_STATUS_PREFIX = 'linkguard.source-status.v1.'

const FETCH_TIMEOUT_MS = 25 * 1000
const RETRY_BACKOFF_MS = 5 * 60 * 1000

const DEFAULT_LIMITS = {
  customSources: 20,
  sourceMiB: 8,
  indicators: 1000000,
  cacheMiB: 4
}

const BUILTIN_SOURCES = {
  openphish: {
    id: 'openphish',
    name: 'OpenPhish Community',
    url: 'https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt',
    kind: 'url',
    enabledByDefault: true
  },
  'scam-light': {
    id: 'scam-light',
    name: 'Scam Blocklist Light',
    url: 'https://raw.githubusercontent.com/jarelllama/Scam-Blocklist/main/lists/wildcard_domains/scams_light.txt',
    kind: 'domain',
    enabledByDefault: false
  }
}

const DEFAULT_SETTINGS = {
  markLinks: true,
  defang: false,
  treatHttpAsUnsafe: true,
  goodSymbol: '✓',
  badSymbol: '✕',
  markerPosition: 'after',
  refreshHours: 12,
  sourceEnabled: {
    openphish: true,
    'scam-light': false
  },
  customSources: [],
  customRules: [],
  limits: { ...DEFAULT_LIMITS }
}

let settings = loadSettings()
let settingsSnapshot = JSON.stringify(settings)
let sourceStates = new Map()
let threatURLs = new Set()
let threatDomains = new Set()

let refreshInFlight = null
let refreshQueued = false
let queuedForce = false
let queuedSourceIDs = new Set()
let nextRefreshTimer = null
let sourceRetryAfter = new Map()

loadConfiguredCaches()
rebuildIndicators()
registerFilter()

grove.on('settingsChanged', () => {
  try {
    applySettingsChange()
  } catch (error) {
    console.warn(`LinkGuard could not apply changed settings: ${safeError(error)}`)
  }
})

grove.log('LinkGuard runtime started')
queueRefresh({ force: false, reason: 'startup' }).catch((error) => {
  console.warn(`LinkGuard initial refresh failed: ${safeError(error)}`)
})


// Re-read and validate shared settings whenever Mango wakes the Root.
function applySettingsChange() {
  const next = loadSettings()
  const snapshot = JSON.stringify(next)
  const changed = snapshot !== settingsSnapshot

  settings = next
  settingsSnapshot = snapshot

  // The Root is the sole owner of threat-list runtime state and caches.
  purgeInactiveSourceData()
  loadConfiguredCaches()
  rebuildIndicators()

  const missing = getConfiguredSources()
    .filter((source) => source.enabled)
    .filter((source) => {
      const state = sourceStates.get(source.id)
      return !state || (!state.urls.size && !state.domains.size)
    })
    .map((source) => source.id)

  if (changed) registerFilter()

  if (missing.length) {
    grove.log(
      `LinkGuard queued ${missing.length} enabled source${missing.length === 1 ? '' : 's'} for loading: ${missing.join(', ')}`
    )
    queueRefresh({
      force: true,
      sourceIds: missing,
      reason: 'settings-change'
    })
  } else {
    scheduleNextRefresh('settings-change')
  }

  grove.log(
    `LinkGuard applied settings${missing.length ? ` · loading ${missing.length} source${missing.length === 1 ? '' : 's'}` : ''}`
  )
}


/* -------------------------------------------------------------------------- */
/* Inbound filter                                                              */
/* -------------------------------------------------------------------------- */

function registerFilter() {
  grove.filters.set({ inbound: filterInbound })
}

function filterInbound(message) {
  try {
    if (!message || message.kind !== 'message') return 'allow'

    const originalText = typeof message.displayText === 'string' ? message.displayText : ''
    if (!originalText) return 'allow'

    // Mango may re-run an inbound filter against already transformed displayText
    // when filters are re-registered. Remove our own adjacent markers first so
    // rendering remains idempotent and changing marker position cannot leave
    // one marker on each side of a URL.
    const text = stripOwnMarkers(originalText)

    const urls = extractHTTPURLs(text)
    if (!urls.length) return 'allow'

    const classified = urls.map((entry) => {
      const verdict = classifyURL(entry.normalized)
      return {
        ...entry,
        listed: verdict.listed,
        source: verdict.source,
        rule: verdict.rule
      }
    })

    const listed = classified.filter((entry) => entry.listed)
    const showNotListed = hasLoadedEnabledSource()

    // With no loaded threat list, unsafe/local-rule verdicts still apply.
    // Only the reassuring not-listed marker is suppressed.
    if (!listed.length && !showNotListed) return 'allow'

    const result = { action: 'transform' }

    if (settings.markLinks || (settings.defang && listed.length)) {
      result.displayText = renderMarkedLinks(text, classified, { showNotListed })
    }

    // Do not add a second Mango decoration for unsafe URLs. The configured
    // per-URL marker is the single visual safety indicator for both listed
    // and not-listed links.
    if (!result.displayText) return 'allow'
    return result
  } catch (error) {
    // Security tooling must never make an IRC message disappear.
    console.warn(`LinkGuard allowed a message after a filter error: ${safeError(error)}`)
    return 'allow'
  }
}

function stripOwnMarkers(text) {
  const symbols = Array.from(new Set([
    settings.goodSymbol,
    settings.badSymbol,
    '✓',
    '✔',
    '○',
    '·',
    '✕',
    '×',
    '!',
    '⚠'
  ].filter((value) => typeof value === 'string' && value.length > 0)))

  if (!symbols.length) return text

  const symbolPattern = symbols
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join('|')

  if (!symbolPattern) return text

  let cleaned = text
  const urlCore = String.raw`https?:\/\/[^\s<>"']+`

  try {
    let previous
    do {
      previous = cleaned

      const before = new RegExp(
        `(?:${symbolPattern})(?:\\s+(?:${symbolPattern}))*\\s+(${urlCore})`,
        'giu'
      )
      cleaned = cleaned.replace(before, '$1')

      const after = new RegExp(
        `(${urlCore})(?:\\s+(?:${symbolPattern}))+(?=\\s|$)`,
        'giu'
      )
      cleaned = cleaned.replace(after, '$1')
    } while (cleaned !== previous)
  } catch (error) {
    console.warn(`LinkGuard could not normalize existing markers: ${safeError(error)}`)
    return text
  }

  return cleaned
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function renderMarkedLinks(text, entries, { showNotListed = true } = {}) {
  let output = text

  for (const entry of entries.slice().sort((a, b) => b.start - a.start)) {
    let renderedURL = entry.raw

    if (entry.listed && settings.defang) {
      renderedURL = defangURL(renderedURL)
    }

    let rendered = renderedURL

    if (settings.markLinks) {
      const symbol = entry.listed ? settings.badSymbol : (showNotListed ? settings.goodSymbol : '')
      if (symbol) {
        rendered = settings.markerPosition === 'before'
          ? `${symbol} ${renderedURL}`
          : `${renderedURL} ${symbol}`
      }
    }

    output = output.slice(0, entry.start) + rendered + output.slice(entry.end)
  }

  return output
}

function extractHTTPURLs(text) {
  const result = []
  const regex = /https?:\/\/[^\s<>"'`]+/giu
  let match

  while ((match = regex.exec(text)) !== null) {
    const raw = trimTrailingPunctuation(match[0])
    if (!raw) continue

    const normalized = normalizeURL(raw)
    if (!normalized) continue

    result.push({
      raw,
      normalized,
      start: match.index,
      end: match.index + raw.length
    })
  }

  return result
}

function trimTrailingPunctuation(value) {
  let result = value

  while (/[.,!?;:]$/u.test(result)) {
    result = result.slice(0, -1)
  }

  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    while (result.endsWith(close) && countChar(result, close) > countChar(result, open)) {
      result = result.slice(0, -1)
    }
  }

  return result
}

function countChar(value, char) {
  let count = 0
  for (const current of value) if (current === char) count++
  return count
}

function normalizeURL(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function normalizeDomain(value) {
  try {
    let candidate = String(value || '').trim().toLowerCase()
      .replace(/^\*\./u, '')
      .replace(/^\.+/u, '')
      .replace(/\.+$/u, '')

    if (!candidate || /\s/u.test(candidate) || candidate.includes('/')) return null

    const hostname = new URL(`http://${candidate}`).hostname.toLowerCase()
    if (!hostname || hostname === 'localhost') return null
    return hostname
  } catch {
    return null
  }
}

function classifyURL(normalizedURL) {
  const customRule = matchCustomRule(normalizedURL)
  if (customRule) {
    return {
      listed: customRule.action === 'block',
      source: 'custom',
      rule: customRule
    }
  }

  if (settings.treatHttpAsUnsafe && normalizedURL.startsWith('http://')) {
    return {
      listed: true,
      source: 'http',
      rule: null
    }
  }

  if (threatURLs.has(normalizedURL)) {
    return { listed: true, source: 'feed', rule: null }
  }

  try {
    if (isDomainListed(new URL(normalizedURL).hostname)) {
      return { listed: true, source: 'feed', rule: null }
    }
  } catch {
    // Ignore malformed URL here; extractor already validates normal messages.
  }

  return { listed: false, source: 'none', rule: null }
}


function matchCustomRule(normalizedURL) {
  const rules = Array.isArray(settings.customRules) ? settings.customRules : []
  if (!rules.length) return null

  let url
  try {
    url = new URL(normalizedURL)
  } catch {
    return null
  }

  let matched = null

  // Last matching rule wins.
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue
    if (customRuleMatches(rule, url)) matched = rule
  }

  return matched
}

function customRuleMatches(rule, url) {
  switch (rule.kind) {
    case 'domain': {
      const domain = normalizeDomain(rule.value)
      const host = normalizeDomain(url.hostname)
      if (!domain || !host) return false
      return host === domain || host.endsWith(`.${domain}`)
    }

    case 'url': {
      const candidate = normalizeURL(rule.value)
      return !!candidate && candidate === url.href
    }

    case 'pattern':
      return globMatch(rule.value, url.href)

    default:
      return false
  }
}

function globMatch(pattern, value) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 2048) return false

  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')

  try {
    return new RegExp(`^${escaped}$`, 'iu').test(value)
  } catch {
    return false
  }
}

function isDomainListed(hostname) {
  const host = normalizeDomain(hostname)
  if (!host) return false
  if (threatDomains.has(host)) return true

  const labels = host.split('.')
  for (let index = 1; index < labels.length - 1; index++) {
    if (threatDomains.has(labels.slice(index).join('.'))) return true
  }

  return false
}

function defangURL(value) {
  return value
    .replace(/^https:\/\//iu, 'hxxps://')
    .replace(/^http:\/\//iu, 'hxxp://')
}

/* -------------------------------------------------------------------------- */
/* Settings + sources                                                          */
/* -------------------------------------------------------------------------- */

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    return sanitizeSettings(raw)
  } catch (error) {
    console.warn(`LinkGuard could not load settings: ${safeError(error)}`)
    return cloneDefaults()
  }
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
}

function sanitizeSettings(raw) {
  const next = cloneDefaults()

  if (!raw || typeof raw !== 'object') return next

  next.markLinks = raw.markLinks !== false
  next.defang = raw.defang === true
  next.treatHttpAsUnsafe = raw.treatHttpAsUnsafe !== false
  next.goodSymbol = validSymbol(raw.goodSymbol, '✓')
  next.badSymbol = validSymbol(raw.badSymbol, '✕')
  next.markerPosition = raw.markerPosition === 'before' ? 'before' : 'after'
  next.refreshHours = [6, 12, 24].includes(Number(raw.refreshHours))
    ? Number(raw.refreshHours)
    : 12

  if (raw.sourceEnabled && typeof raw.sourceEnabled === 'object') {
    for (const id of Object.keys(BUILTIN_SOURCES)) {
      if (typeof raw.sourceEnabled[id] === 'boolean') {
        next.sourceEnabled[id] = raw.sourceEnabled[id]
      }
    }
  }

  if (Array.isArray(raw.customSources)) {
    next.customSources = raw.customSources
      .filter(isValidCustomSource)
      .slice(0, 20)
  }

  if (Array.isArray(raw.customRules)) {
    next.customRules = raw.customRules
      .filter(isValidCustomRule)
      .slice(0, 200)
  }

  next.limits = { ...DEFAULT_LIMITS }

  return next
}

function sanitizeLimits(raw) {
  return {
    customSources: Math.round(clampNumber(raw.customSources, 1, 20, DEFAULT_LIMITS.customSources)),
    sourceMiB: Math.round(clampNumber(raw.sourceMiB, 1, 50, DEFAULT_LIMITS.sourceMiB)),
    indicators: Math.round(clampNumber(raw.indicators, 10000, 1000000, DEFAULT_LIMITS.indicators) / 10000) * 10000,
    cacheMiB: Math.round(clampNumber(raw.cacheMiB, 0.5, 4, DEFAULT_LIMITS.cacheMiB) * 2) / 2
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function validSymbol(value, fallback) {
  if (typeof value !== 'string') return fallback
  if (value.length > 12 || /\s/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) return fallback
  return value
}

function isValidCustomSource(source) {
  return !!source &&
    typeof source.id === 'string' &&
    /^custom-[a-z0-9]+$/u.test(source.id) &&
    typeof source.name === 'string' &&
    source.name.length > 0 &&
    source.name.length <= 100 &&
    typeof source.url === 'string' &&
    isAllowedRawGitHubURL(source.url) &&
    (source.kind === 'auto' || source.kind === 'url' || source.kind === 'domain')
}

function isValidCustomRule(rule) {
  return !!rule &&
    typeof rule.id === 'string' &&
    /^rule-[a-z0-9]+$/u.test(rule.id) &&
    (rule.action === 'allow' || rule.action === 'block') &&
    (rule.kind === 'domain' || rule.kind === 'url' || rule.kind === 'pattern') &&
    typeof rule.value === 'string' &&
    rule.value.length > 0 &&
    rule.value.length <= 2048
}

function getConfiguredSourcesForSettings(value) {
  const builtins = Object.values(BUILTIN_SOURCES).map((source) => ({
    ...source,
    enabled: value.sourceEnabled[source.id] !== undefined
      ? value.sourceEnabled[source.id]
      : source.enabledByDefault
  }))

  const custom = value.customSources.map((source) => ({
    ...source,
    enabled: source.enabled !== false
  }))

  return [...builtins, ...custom]
}

function getConfiguredSources() {
  return getConfiguredSourcesForSettings(settings)
}

function isAllowedRawGitHubURL(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'raw.githubusercontent.com'
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* Feed cache + refresh                                                        */
/* -------------------------------------------------------------------------- */

function sourceStatusKey(id) {
  return SOURCE_STATUS_PREFIX + id
}

function writeSourceStatus(id, status, detail = '') {
  try {
    localStorage.setItem(sourceStatusKey(id), JSON.stringify({
      status,
      detail,
      updatedAt: Date.now()
    }))
  } catch (error) {
    console.warn(`LinkGuard could not persist status for ${id}: ${safeError(error)}`)
  }
}

function clearSourceStatus(id) {
  try {
    localStorage.removeItem(sourceStatusKey(id))
  } catch (error) {
    console.warn(`LinkGuard could not remove status for ${id}: ${safeError(error)}`)
  }
}

function cacheKey(id) {
  return SOURCE_CACHE_PREFIX + id
}

function deleteSourceData(id) {
  sourceStates.delete(id)
  try { localStorage.removeItem(cacheKey(id)) } catch {}
}

function purgeInactiveSourceData() {
  const enabledIDs = new Set(
    getConfiguredSources()
      .filter((source) => source.enabled)
      .map((source) => source.id)
  )

  for (const id of Array.from(sourceStates.keys())) {
    if (enabledIDs.has(id)) continue

    sourceStates.delete(id)
    sourceRetryAfter.delete(id)
    clearSourceStatus(id)
    try {
      localStorage.removeItem(cacheKey(id))
      grove.log(`LinkGuard removed disabled source ${id} from runtime state and storage`)
    } catch (error) {
      console.warn(`LinkGuard could not remove cache for disabled source ${id}: ${safeError(error)}`)
    }
  }

  // Also remove stale cached sources that are no longer configured/enabled,
  // even if they were not loaded into sourceStates in this Root instance.
  const configuredIDs = new Set(getConfiguredSources().map((source) => source.id))
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index)
    if (!key || !key.startsWith(SOURCE_CACHE_PREFIX)) continue

    const id = key.slice(SOURCE_CACHE_PREFIX.length)
    if (enabledIDs.has(id)) continue

    try {
      localStorage.removeItem(key)
      clearSourceStatus(id)
      grove.log(
        configuredIDs.has(id)
          ? `LinkGuard removed disabled source ${id} from storage`
          : `LinkGuard removed stale source ${id} from storage`
      )
    } catch (error) {
      console.warn(`LinkGuard could not remove stale cache ${id}: ${safeError(error)}`)
    }
  }
}

function loadConfiguredCaches() {
  const enabledSources = getConfiguredSources().filter((source) => source.enabled)
  const enabledIDs = new Set(enabledSources.map((source) => source.id))

  for (const existingID of Array.from(sourceStates.keys())) {
    if (!enabledIDs.has(existingID)) sourceStates.delete(existingID)
  }

  for (const source of enabledSources) {
    const cached = loadSourceCache(source)
    if (cached) sourceStates.set(source.id, cached)
  }
}

function loadSourceCache(source) {
  try {
    const parsed = JSON.parse(localStorage.getItem(cacheKey(source.id)) || '{}')
    if (!parsed || !Array.isArray(parsed.urls) || !Array.isArray(parsed.domains)) return null

    return {
      urls: new Set(parsed.urls.map(normalizeURL).filter(Boolean)),
      domains: new Set(parsed.domains.map(normalizeDomain).filter(Boolean)),
      updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
      lastError: null
    }
  } catch {
    return null
  }
}

function saveSourceCache(source, state) {
  try {
    const payload = JSON.stringify({
      updatedAt: state.updatedAt,
      urls: Array.from(state.urls),
      domains: Array.from(state.domains)
    })

    const maxCacheBytes = settings.limits.cacheMiB * 1024 * 1024
    if (utf8Size(payload) > maxCacheBytes) {
      console.warn(`LinkGuard did not persist ${source.name}: parsed cache exceeds ${settings.limits.cacheMiB} MiB limit`)
      return
    }

    localStorage.setItem(cacheKey(source.id), payload)
    grove.log(`LinkGuard persisted cache for ${source.name} (${source.id})`)
  } catch (error) {
    console.warn(`LinkGuard could not persist ${source.name}: ${safeError(error)}`)
  }
}

function rebuildIndicators() {
  const urls = new Set()
  const domains = new Set()

  for (const source of getConfiguredSources()) {
    if (!source.enabled) continue

    const state = sourceStates.get(source.id)
    if (!state) continue

    for (const url of state.urls) urls.add(url)
    for (const domain of state.domains) domains.add(domain)
  }

  threatURLs = urls
  threatDomains = domains
}

function hasLoadedEnabledSource() {
  return getConfiguredSources().some((source) => {
    if (!source.enabled) return false
    const state = sourceStates.get(source.id)
    return !!state && (state.urls.size > 0 || state.domains.size > 0)
  })
}


function scheduleNextRefresh(reason = 'schedule') {
  if (nextRefreshTimer) {
    clearTimeout(nextRefreshTimer)
    nextRefreshTimer = null
  }

  const enabled = getConfiguredSources().filter((source) => source.enabled)
  if (!enabled.length) {
    grove.log('LinkGuard automatic refresh idle: no enabled sources')
    return
  }

  const now = Date.now()
  const maxAge = settings.refreshHours * 60 * 60 * 1000
  let nextDueAt = Infinity

  for (const source of enabled) {
    const state = sourceStates.get(source.id)
    const dueAt = state?.updatedAt ? state.updatedAt + maxAge : now
    const retryAfter = sourceRetryAfter.get(source.id) || 0
    nextDueAt = Math.min(nextDueAt, Math.max(dueAt, retryAfter))
  }

  if (!Number.isFinite(nextDueAt)) return

  const delay = Math.max(0, nextDueAt - now)
  nextRefreshTimer = setTimeout(() => {
    nextRefreshTimer = null
    grove.log('LinkGuard automatic refresh check started')
    queueRefresh({ force: false, reason: 'automatic' })
  }, delay)

  const minutes = Math.max(0, Math.ceil(delay / 60000))
  grove.log(
    delay === 0
      ? `LinkGuard automatic refresh is due now (${reason})`
      : `LinkGuard next automatic refresh check in ${minutes} minute${minutes === 1 ? '' : 's'} (${reason})`
  )
}

function queueRefresh({ force = false, sourceIds = null, reason = 'refresh' } = {}) {
  if (force) queuedForce = true

  if (Array.isArray(sourceIds) && sourceIds.length) {
    for (const id of sourceIds) queuedSourceIDs.add(id)
  } else {
    // Empty set means "all enabled sources" for the next pass.
    queuedSourceIDs.clear()
  }

  refreshQueued = true

  if (!refreshInFlight) {
    refreshInFlight = runRefreshQueue(reason)
      .catch((error) => {
        console.warn(`LinkGuard refresh queue failed: ${safeError(error)}`)
      })
      .finally(() => {
        refreshInFlight = null
        if (refreshQueued) {
          queueMicrotask(() => queueRefresh({ reason: 'queued-followup' }))
        } else {
          scheduleNextRefresh('refresh-complete')
        }
      })
  }

  return refreshInFlight
}

async function runRefreshQueue(initialReason = 'refresh') {
  let reason = initialReason

  while (refreshQueued) {
    refreshQueued = false
    const force = queuedForce
    queuedForce = false

    const requestedIDs = new Set(queuedSourceIDs)
    queuedSourceIDs.clear()

    const allEnabled = getConfiguredSources().filter((source) => source.enabled)
    const sources = requestedIDs.size
      ? allEnabled.filter((source) => requestedIDs.has(source.id))
      : allEnabled

    if (sources.length) {
      grove.log(
        requestedIDs.size
          ? `LinkGuard loading ${sources.length} requested list${sources.length === 1 ? '' : 's'}`
          : `LinkGuard refreshing ${sources.length} enabled list${sources.length === 1 ? '' : 's'}`
      )
    }

    for (const source of sources) {
      try {
        await refreshSourceOnce(source, force)
      } catch (error) {
        const message = safeError(error)
        const previous = sourceStates.get(source.id)
        if (previous) previous.lastError = message
        sourceRetryAfter.set(source.id, Date.now() + RETRY_BACKOFF_MS)
        writeSourceStatus(source.id, 'error', message)
        console.warn(`LinkGuard refresh failed for ${source.name}: ${message}`)
      }
    }

    rebuildIndicators()
    registerFilter()

    grove.log(`LinkGuard refresh pass completed (${reason})`)
    reason = 'queued'
  }
}

async function refreshSourceOnce(source, force) {
  const current = getConfiguredSources().find((entry) => entry.id === source.id)
  if (!current || !current.enabled) {
    deleteSourceData(source.id)
    return false
  }

  source = current

  const previous = sourceStates.get(source.id)
  const now = Date.now()
  const maxAge = settings.refreshHours * 60 * 60 * 1000
  const retryAfter = sourceRetryAfter.get(source.id) || 0

  if (!force && retryAfter > now) return false
  if (!force && previous && previous.updatedAt && now - previous.updatedAt < maxAge) return false

  writeSourceStatus(source.id, 'loading')
  grove.log(`LinkGuard loading ${source.name} (${source.id})`)

  const text = await fetchThreatListText(source)

  const maxSourceBytes = settings.limits.sourceMiB * 1024 * 1024
  if (utf8Size(text) > maxSourceBytes) {
    throw new Error(`list exceeds ${settings.limits.sourceMiB} MiB limit`)
  }

  const parsed = parseThreatList(text)
  const count = parsed.urls.size + parsed.domains.size
  if (!count) throw new Error('list contained no usable indicators')

  const state = {
    urls: parsed.urls,
    domains: parsed.domains,
    updatedAt: Date.now(),
    lastError: null
  }

  sourceStates.set(source.id, state)
  sourceRetryAfter.delete(source.id)
  saveSourceCache(source, state)
  writeSourceStatus(source.id, 'loaded', String(count))
  grove.log(`LinkGuard loaded ${count} indicators from ${source.name}`)
  return true
}

async function fetchThreatListText(source) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(source.url, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'text/plain,*/*' }
    })

    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const declaredLength = Number(response.headers?.get?.('content-length') || 0)
    const maxSourceBytes = settings.limits.sourceMiB * 1024 * 1024

    if (Number.isFinite(declaredLength) && declaredLength > maxSourceBytes) {
      throw new Error(`list exceeds ${settings.limits.sourceMiB} MiB limit`)
    }

    return await response.text()
  } finally {
    clearTimeout(timeout)
  }
}

function parseThreatList(text) {
  const urls = new Set()
  const domains = new Set()

  for (const rawLine of String(text || '').split(/\r?\n/u)) {
    if (urls.size + domains.size >= settings.limits.indicators) {
      throw new Error(`list exceeds ${settings.limits.indicators} indicator limit`)
    }

    let line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('!') || line.startsWith('[')) continue

    const adblock = /^\|\|([a-z0-9._-]+)\^(?:$|[$])/iu.exec(line)
    if (adblock) {
      const domain = normalizeDomain(adblock[1])
      if (domain) domains.add(domain)
      continue
    }

    const hosts = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+([^\s#]+)(?:\s|$)/iu.exec(line)
    if (hosts) {
      const domain = normalizeDomain(hosts[1])
      if (domain) domains.add(domain)
      continue
    }

    line = line.replace(/\s+#.*$/u, '').trim()
    if (!line) continue

    const url = normalizeURL(line)
    if (url) {
      urls.add(url)
      continue
    }

    const domain = normalizeDomain(line)
    if (domain) domains.add(domain)
  }

  return { urls, domains }
}

function utf8Size(value) {
  try {
    return new TextEncoder().encode(String(value)).byteLength
  } catch {
    return String(value).length
  }
}

function safeError(error) {
  if (!error) return 'unknown error'
  if (error.name === 'AbortError') return 'request timed out'
  return String(error.message || error).slice(0, 300)
}

console.info(`LinkGuard ${VERSION} ready`)
