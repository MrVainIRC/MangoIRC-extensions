const SETTINGS_KEY = 'linkguard.settings.v3'
const SOURCE_CACHE_PREFIX = 'linkguard.source-cache.v3.'
const SOURCE_STATUS_PREFIX = 'linkguard.source-status.v1.'

const DEFAULT_LIMITS = {
  customSources: 20,
  sourceMiB: 8,
  indicators: 1000000,
  cacheMiB: 4
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

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = (selector) => document.querySelector(selector)

const markLinks = $('#mark-links')
const defang = $('#defang')
const httpUnsafe = $('#http-unsafe')
const goodSymbol = $('#good-symbol')
const badSymbol = $('#bad-symbol')
const markerPosition = $('#marker-position')
const refreshHours = $('#refresh-hours')
const sourceOpenPhish = $('#source-openphish')
const sourceScamLight = $('#source-scam-light')
const addSourceForm = $('#add-source-form')
const sourceURL = $('#source-url')
const sourceError = $('#source-error')
const customSources = $('#custom-sources')
const customSourceCount = $('#custom-source-count')
const summaryStatus = $('#summary-status')
const previewGood = $('#preview-good')
const previewBad = $('#preview-bad')
const ruleAction = $('#rule-action')
const ruleKind = $('#rule-kind')
const ruleValue = $('#rule-value')
const addRule = $('#add-rule')
const ruleHelp = $('#rule-help')
const ruleError = $('#rule-error')
const customRules = $('#custom-rules')
const customRuleCount = $('#custom-rule-count')
const saveSettingsButton = $('#save-settings')
const saveState = $('#save-state')

let settings = loadSettings()
let savedSettingsSnapshot = serializeUserSettings()
let dirty = false
let statusWatchTimer = null
document.addEventListener('change', () => {
  queueMicrotask(updateDirtyState)
})

saveSettingsButton.addEventListener('click', () => {
  if (!dirty) return
  saveSettings()
})


// ---------------------------------------------------------------------------
// Settings event handlers
// ---------------------------------------------------------------------------

markLinks.addEventListener('change', () => {
  settings.markLinks = markLinks.checked
  updateDirtyState()
})

defang.addEventListener('change', () => {
  settings.defang = defang.checked
  updateDirtyState()
})

if (httpUnsafe) {
  httpUnsafe.addEventListener('change', () => {
    settings.treatHttpAsUnsafe = httpUnsafe.checked
    updateDirtyState()
  })
}

goodSymbol.addEventListener('change', () => {
  settings.goodSymbol = goodSymbol.value
  previewGood.textContent = goodSymbol.value || '—'
  updateDirtyState()
})

badSymbol.addEventListener('change', () => {
  settings.badSymbol = badSymbol.value
  previewBad.textContent = badSymbol.value || '—'
  updateDirtyState()
})

markerPosition.addEventListener('change', () => {
  settings.markerPosition = markerPosition.value === 'before' ? 'before' : 'after'
  updateDirtyState()
})

refreshHours.addEventListener('change', () => {
  settings.refreshHours = clampNumber(refreshHours.value, 6, 24, 12)
  updateDirtyState()
})

sourceOpenPhish.addEventListener('change', () => {
  settings.sourceEnabled.openphish = sourceOpenPhish.checked
  updateDirtyState()
  renderStatusSafely()
})

sourceScamLight.addEventListener('change', () => {
  settings.sourceEnabled['scam-light'] = sourceScamLight.checked
  updateDirtyState()
  renderStatusSafely()
})



ruleKind.addEventListener('change', renderRuleHelp)

addRule.addEventListener('click', addCustomRule)

ruleValue.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    addCustomRule()
  }
})

addSourceForm.addEventListener('submit', (event) => {
  event.preventDefault()
  sourceError.textContent = ''

  if (settings.customSources.length >= settings.limits.customSources) {
    sourceError.textContent = `The current limit of ${settings.limits.customSources} GitHub lists has been reached.`
    return
  }

  const raw = githubToRawURL(sourceURL.value)
  if (!raw) {
    sourceError.textContent = 'Enter a public GitHub file URL.'
    return
  }

  if (allSourceURLs().has(raw)) {
    sourceError.textContent = 'That list is already configured.'
    return
  }

  const source = {
    id: `custom-${hashString(raw)}`,
    name: deriveSourceName(raw),
    url: raw,
    kind: 'auto',
    enabled: true
  }

  settings.customSources.push(source)
  sourceURL.value = ''
  updateDirtyState()
  sourceError.textContent = 'List added. Save changes to apply.'
  renderCustomSources()
  renderStatusSafely()
})

// ---------------------------------------------------------------------------
// Form state and persistence
// ---------------------------------------------------------------------------

function hydrate() {
  markLinks.checked = settings.markLinks
  defang.checked = settings.defang
  if (httpUnsafe) httpUnsafe.checked = settings.treatHttpAsUnsafe !== false
  goodSymbol.value = optionValueOrFallback(goodSymbol, settings.goodSymbol, '✓')
  badSymbol.value = optionValueOrFallback(badSymbol, settings.badSymbol, '✕')
  markerPosition.value = settings.markerPosition === 'before' ? 'before' : 'after'
  refreshHours.value = String(settings.refreshHours)
  sourceOpenPhish.checked = settings.sourceEnabled.openphish !== false
  sourceScamLight.checked = settings.sourceEnabled['scam-light'] === true
  previewGood.textContent = settings.goodSymbol || '—'
  previewBad.textContent = settings.badSymbol || '—'
}



function optionValueOrFallback(select, wanted, fallback) {
  const exists = Array.from(select.options).some((option) => option.value === wanted)
  return exists ? wanted : fallback
}

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    return {
      markLinks: raw.markLinks !== false,
      defang: raw.defang === true,
      treatHttpAsUnsafe: raw.treatHttpAsUnsafe !== false,
      goodSymbol: typeof raw.goodSymbol === 'string' ? raw.goodSymbol : DEFAULT_SETTINGS.goodSymbol,
      badSymbol: typeof raw.badSymbol === 'string' ? raw.badSymbol : DEFAULT_SETTINGS.badSymbol,
      markerPosition: raw.markerPosition === 'before' ? 'before' : 'after',
      refreshHours: [6, 12, 24].includes(Number(raw.refreshHours)) ? Number(raw.refreshHours) : 12,
      sourceEnabled: {
        openphish: raw.sourceEnabled && typeof raw.sourceEnabled.openphish === 'boolean'
          ? raw.sourceEnabled.openphish
          : true,
        'scam-light': raw.sourceEnabled && typeof raw.sourceEnabled['scam-light'] === 'boolean'
          ? raw.sourceEnabled['scam-light']
          : false
      },
      customSources: Array.isArray(raw.customSources)
        ? raw.customSources.filter(validStoredSource).slice(0, 20)
        : [],
      customRules: Array.isArray(raw.customRules)
        ? raw.customRules.filter(validStoredRule).slice(0, 200)
        : [],
      limits: { ...DEFAULT_LIMITS }
    }
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  }
}

function sanitizeLimits(raw) {
  return {
    customSources: Math.round(clampNumber(raw.customSources, 1, 20, DEFAULT_LIMITS.customSources)),
    sourceMiB: Math.round(clampNumber(raw.sourceMiB, 1, 8, DEFAULT_LIMITS.sourceMiB)),
    indicators: Math.round(clampNumber(raw.indicators, 10000, 1000000, DEFAULT_LIMITS.indicators) / 10000) * 10000,
    cacheMiB: Math.round(clampNumber(raw.cacheMiB, 0.5, 4, DEFAULT_LIMITS.cacheMiB) * 2) / 2
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function prepareSettingsForSave() {
  const beforeRules = settings.customRules.length
  settings.customRules = settings.customRules.filter((rule) => rule.enabled !== false)

  const removedRules = beforeRules - settings.customRules.length
  if (removedRules) {
    console.info(`LinkGuard Settings removed ${removedRules} disabled custom rule${removedRules === 1 ? '' : 's'} before saving`)
    renderCustomRules()
    renderStatusSafely()
  }
}

function serializeUserSettings() {
  const persisted = { ...settings }
  delete persisted.limits
  return JSON.stringify(persisted)
}

function saveSettings() {
  prepareSettingsForSave()

  const serialized = serializeUserSettings()
  localStorage.setItem(SETTINGS_KEY, serialized)
  savedSettingsSnapshot = serialized
  updateDirtyState()

  console.info('LinkGuard Settings saved configuration and notified running Roots')
  grove.settings.changed()
  saveState.textContent = 'Saved · applying…'
  startStatusWatch()
}

function updateDirtyState() {
  dirty = serializeUserSettings() !== savedSettingsSnapshot
  saveSettingsButton.disabled = !dirty
  saveState.textContent = dirty ? 'Unsaved changes' : 'No unsaved changes'
  saveState.classList.toggle('is-dirty', dirty)
}

function startStatusWatch() {
  if (statusWatchTimer) clearInterval(statusWatchTimer)

  const startedAt = Date.now()
  const maxWatchMs = 5 * 60 * 1000
  renderStatusSafely()

  statusWatchTimer = setInterval(() => {
    renderStatusSafely()

    if (allEnabledSourcesSettled() || Date.now() - startedAt >= maxWatchMs) {
      clearInterval(statusWatchTimer)
      statusWatchTimer = null
      if (!dirty) saveState.textContent = 'Saved'
    }
  }, 500)
}

function allEnabledSourcesSettled() {
  const enabledIDs = []

  if (settings.sourceEnabled.openphish) enabledIDs.push('openphish')
  if (settings.sourceEnabled['scam-light']) enabledIDs.push('scam-light')

  for (const source of settings.customSources) {
    if (source.enabled !== false) enabledIDs.push(source.id)
  }

  if (!enabledIDs.length) return true

  return enabledIDs.every((id) => {
    const status = readSourceStatus(id)
    if (status?.status === 'loaded' || status?.status === 'error') return true

    const cache = readCache(id)
    return !!cache && cache.urls.length + cache.domains.length > 0
  })
}




function validStoredSource(source) {
  return !!source &&
    typeof source.id === 'string' &&
    /^custom-[a-z0-9]+$/u.test(source.id) &&
    typeof source.name === 'string' &&
    typeof source.url === 'string' &&
    isAllowedRawGitHubURL(source.url)
}

function validStoredRule(rule) {
  return !!rule &&
    typeof rule.id === 'string' &&
    /^rule-[a-z0-9]+$/u.test(rule.id) &&
    (rule.action === 'allow' || rule.action === 'block') &&
    (rule.kind === 'domain' || rule.kind === 'url' || rule.kind === 'pattern') &&
    typeof rule.value === 'string' &&
    rule.value.length > 0 &&
    rule.value.length <= 2048
}

// ---------------------------------------------------------------------------
// Local rules
// ---------------------------------------------------------------------------

function addCustomRule() {
  ruleError.textContent = ''

  const action = ruleAction.value
  const kind = ruleKind.value
  const rawValue = String(ruleValue.value || '').trim()
  const validated = validateRuleInput(kind, rawValue)

  if (!validated.ok) {
    ruleError.textContent = validated.error
    return
  }

  if (settings.customRules.length >= 200) {
    ruleError.textContent = 'Maximum of 200 custom rules reached.'
    return
  }

  const duplicate = settings.customRules.some((rule) =>
    rule.action === action &&
    rule.kind === kind &&
    rule.value === validated.value
  )

  if (duplicate) {
    ruleError.textContent = 'That rule already exists.'
    return
  }

  settings.customRules.push({
    id: `rule-${hashString(`${action}|${kind}|${validated.value}|${Date.now()}`)}`,
    action,
    kind,
    value: validated.value,
    enabled: true
  })

  ruleValue.value = ''
  updateDirtyState()
  renderCustomRules()
  renderStatusSafely()
}

function validateRuleInput(kind, input) {
  if (!input) return { ok: false, error: 'Enter a link or wildcard pattern.' }
  if (input.length > 2048) return { ok: false, error: 'Rule is too long.' }

  if (kind === 'domain') {
    const candidate = input
      .toLowerCase()
      .replace(/^\*\./u, '')
      .replace(/^\.+/u, '')
      .replace(/\.+$/u, '')

    if (!candidate || /\s/u.test(candidate) || candidate.includes('/')) {
      return { ok: false, error: 'Enter a link host such as example.com.' }
    }

    try {
      const hostname = new URL(`http://${candidate}`).hostname.toLowerCase()
      if (!hostname || hostname === 'localhost') throw new Error()
      return { ok: true, value: hostname }
    } catch {
      return { ok: false, error: 'Enter a valid link host such as example.com.' }
    }
  }

  if (kind === 'url') {
    try {
      const url = new URL(input)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
      url.hash = ''
      return { ok: true, value: url.href }
    } catch {
      return { ok: false, error: 'Enter a complete http:// or https:// link.' }
    }
  }

  if (kind === 'pattern') {
    if (!/^https?:\/\//iu.test(input)) {
      return { ok: false, error: 'Wildcard link patterns must start with http:// or https://.' }
    }
    if (!input.includes('*')) {
      return { ok: false, error: 'Wildcard link patterns must contain at least one *.' }
    }
    return { ok: true, value: input }
  }

  return { ok: false, error: 'Unknown rule type.' }
}

function renderRuleHelp() {
  if (!ruleHelp || !ruleKind || !ruleValue) return

  switch (ruleKind.value) {
    case 'domain':
      ruleHelp.textContent = 'Matches links on this host and its subdomains.'
      ruleValue.placeholder = 'example.com'
      break
    case 'url':
      ruleHelp.textContent = 'Matches one exact HTTP/HTTPS link.'
      ruleValue.placeholder = 'https://example.com/path'
      break
    case 'pattern':
      ruleHelp.textContent = 'Use * inside a complete link pattern.'
      ruleValue.placeholder = 'https://*.example.com/path/*'
      break
  }
}

function renderCustomRules() {
  customRules.replaceChildren()

  const count = settings.customRules.length
  customRuleCount.textContent = `${count} rule${count === 1 ? '' : 's'}`

  if (!count) {
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    empty.textContent = 'No custom rules yet.'
    customRules.append(empty)
    return
  }

  settings.customRules.forEach((rule, index) => {
    const row = document.createElement('div')
    row.className = 'custom-rule-row'

    const meta = document.createElement('div')
    meta.className = 'custom-rule-meta'

    const badges = document.createElement('div')
    badges.className = 'rule-badges'

    const actionBadge = document.createElement('span')
    actionBadge.className = 'rule-badge'
    actionBadge.textContent = rule.action === 'allow' ? 'ALLOW' : 'BLOCK'

    const kindBadge = document.createElement('span')
    kindBadge.className = 'rule-badge'
    kindBadge.textContent = rule.kind === 'url'
      ? 'EXACT LINK'
      : rule.kind === 'pattern'
        ? 'WILDCARD'
        : 'DOMAIN'

    badges.append(actionBadge, kindBadge)

    const value = document.createElement('code')
    value.className = 'rule-value'
    value.textContent = rule.value

    meta.append(badges, value)

    const controls = document.createElement('div')
    controls.className = 'custom-rule-controls'

    const toggleLabel = document.createElement('label')
    toggleLabel.className = 'switch'

    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = rule.enabled !== false
    toggle.setAttribute('aria-label', `Enable ${rule.value}`)
    toggle.addEventListener('change', () => {
      rule.enabled = toggle.checked
      updateDirtyState()
      renderStatusSafely()
    })

    const toggleVisual = document.createElement('span')
    toggleLabel.append(toggle, toggleVisual)

    const up = document.createElement('button')
    up.type = 'button'
    up.className = 'icon-button'
    up.textContent = '↑'
    up.title = 'Move up'
    up.disabled = index === 0
    up.addEventListener('click', () => {
      if (index === 0) return
      ;[settings.customRules[index - 1], settings.customRules[index]] =
        [settings.customRules[index], settings.customRules[index - 1]]
      updateDirtyState()
      renderCustomRules()
    })

    const down = document.createElement('button')
    down.type = 'button'
    down.className = 'icon-button'
    down.textContent = '↓'
    down.title = 'Move down'
    down.disabled = index === settings.customRules.length - 1
    down.addEventListener('click', () => {
      if (index >= settings.customRules.length - 1) return
      ;[settings.customRules[index], settings.customRules[index + 1]] =
        [settings.customRules[index + 1], settings.customRules[index]]
      updateDirtyState()
      renderCustomRules()
    })

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'icon-button'
    remove.textContent = '×'
    remove.title = 'Remove rule'
    remove.addEventListener('click', () => {
      settings.customRules = settings.customRules.filter((item) => item.id !== rule.id)
      updateDirtyState()
      renderCustomRules()
      renderStatusSafely()
    })

    controls.append(toggleLabel, up, down, remove)
    row.append(meta, controls)
    customRules.append(row)
  })
}

// ---------------------------------------------------------------------------
// GitHub list UI
// ---------------------------------------------------------------------------

function renderCustomSources() {
  customSources.replaceChildren()
  updateSourceCounter()

  if (!settings.customSources.length) {
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    empty.textContent = 'No additional GitHub lists yet.'
    customSources.append(empty)
    return
  }

  for (const source of settings.customSources) {
    const row = document.createElement('div')
    row.className = 'custom-source-row'

    const meta = document.createElement('div')
    meta.className = 'custom-source-meta'

    const title = document.createElement('strong')
    title.textContent = source.name

    const detail = document.createElement('small')
    detail.textContent = source.url

    const status = document.createElement('em')
    status.id = `status-${source.id}`
    status.textContent = cacheStatus(source.id)

    meta.append(title, detail, status)

    const controls = document.createElement('div')
    controls.className = 'custom-source-controls'

    const toggleLabel = document.createElement('label')
    toggleLabel.className = 'switch'
    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = source.enabled !== false
    toggle.setAttribute('aria-label', `Enable ${source.name}`)
    const toggleVisual = document.createElement('span')
    toggle.addEventListener('change', () => {
      source.enabled = toggle.checked
      updateDirtyState()
      renderStatusSafely()
    })
    toggleLabel.append(toggle, toggleVisual)

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'icon-button'
    remove.textContent = '×'
    remove.title = `Remove ${source.name}`
    remove.setAttribute('aria-label', `Remove ${source.name}`)
    remove.addEventListener('click', () => {
      settings.customSources = settings.customSources.filter((item) => item.id !== source.id)
      updateDirtyState()
      renderCustomSources()
      renderStatusSafely()
    })

    controls.append(toggleLabel, remove)
    row.append(meta, controls)
    customSources.append(row)
  }
}

function updateSourceCounter() {
  customSourceCount.textContent = `${settings.customSources.length} / ${settings.limits.customSources}`
  const atLimit = settings.customSources.length >= settings.limits.customSources
  sourceURL.disabled = atLimit
  addSourceForm.querySelector('button[type="submit"]').disabled = atLimit
}

// ---------------------------------------------------------------------------
// Source status UI
// ---------------------------------------------------------------------------

function renderStatusSafely() {
  try {
    renderStatus()
  } catch (error) {
    console.warn(`LinkGuard Settings status rendering failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function renderStatus() {
  updateBuiltInSourceStatus('openphish', settings.sourceEnabled.openphish)
  updateBuiltInSourceStatus('scam-light', settings.sourceEnabled['scam-light'])

  for (const source of settings.customSources) {
    const node = document.getElementById(`status-${source.id}`)
    if (node) node.textContent = cacheStatus(source.id)
  }

  const enabledIDs = []
  if (settings.sourceEnabled.openphish) enabledIDs.push('openphish')
  if (settings.sourceEnabled['scam-light']) enabledIDs.push('scam-light')
  for (const source of settings.customSources) {
    if (source.enabled !== false) enabledIDs.push(source.id)
  }

  let total = 0
  let loaded = 0

  for (const id of enabledIDs) {
    const cache = readCache(id)
    if (!cache) continue
    const count = cache.urls.length + cache.domains.length
    if (count) {
      loaded++
      total += count
    }
  }

  if (!enabledIDs.length) {
    summaryStatus.textContent = 'No threat lists enabled.'
  } else if (!loaded) {
    summaryStatus.textContent = 'Waiting for enabled threat lists to finish loading.'
  } else {
    summaryStatus.textContent = `${loaded}/${enabledIDs.length} sources loaded · ${formatNumber(total)} indicators available locally.`
  }
}

function updateBuiltInSourceStatus(id, enabled) {
  const pill = document.getElementById(`pill-${id}`)
  const detail = document.getElementById(`status-${id}`)
  if (!pill || !detail) return

  if (!enabled) {
    pill.textContent = 'Off'
    pill.className = 'status-pill'
    detail.textContent = 'Disabled'
    return
  }

  const cache = readCache(id)
  const status = readSourceStatus(id)

  if (cache && cache.urls.length + cache.domains.length > 0) {
    pill.textContent = 'Loaded'
    pill.className = 'status-pill status-pill-good'
  } else if (status?.status === 'loading') {
    pill.textContent = 'Loading'
    pill.className = 'status-pill'
  } else if (status?.status === 'error') {
    pill.textContent = 'Error'
    pill.className = 'status-pill status-pill-bad'
  } else if (status?.status === 'loaded') {
    pill.textContent = 'Loaded'
    pill.className = 'status-pill status-pill-good'
  } else {
    pill.textContent = 'Waiting'
    pill.className = 'status-pill'
  }

  detail.textContent = cacheStatus(id)
}

function cacheStatus(id) {
  const cache = readCache(id)
  if (cache) {
    const count = cache.urls.length + cache.domains.length
    if (count) return `${formatNumber(count)} indicators · ${formatAge(cache.updatedAt)}`
  }

  const status = readSourceStatus(id)
  if (status?.status === 'loading') return 'Loading…'
  if (status?.status === 'loaded') {
    const count = Number(status.detail)
    return Number.isFinite(count) && count > 0
      ? `${formatNumber(count)} indicators · loaded`
      : 'Loaded'
  }
  if (status?.status === 'error') return `Error: ${status.detail || 'load failed'}`

  return 'Not loaded'
}

function readSourceStatus(id) {
  try {
    const parsed = JSON.parse(localStorage.getItem(SOURCE_STATUS_PREFIX + id) || '{}')
    if (!parsed || typeof parsed.status !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function readCache(id) {
  try {
    const parsed = JSON.parse(localStorage.getItem(SOURCE_CACHE_PREFIX + id) || '{}')
    if (!Array.isArray(parsed.urls) || !Array.isArray(parsed.domains)) return null
    if (!Number.isFinite(parsed.updatedAt)) return null
    return parsed
  } catch {
    return null
  }
}


function formatAge(timestamp) {
  const ageMs = Math.max(0, Date.now() - Number(timestamp || 0))
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (ageMs < minute) return 'updated just now'
  if (ageMs < hour) {
    const minutes = Math.floor(ageMs / minute)
    return `updated ${minutes} min ago`
  }
  if (ageMs < day) {
    const hours = Math.floor(ageMs / hour)
    return `updated ${hours} h ago`
  }

  const days = Math.floor(ageMs / day)
  return `updated ${days} d ago`
}

function formatNumber(value) {
  try {
    return new Intl.NumberFormat().format(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// GitHub URL helpers
// ---------------------------------------------------------------------------

function githubToRawURL(input) {
  let url

  try {
    url = new URL(String(input || '').trim())
  } catch {
    try {
      url = new URL(`https://${String(input || '').trim()}`)
    } catch {
      return null
    }
  }

  if (url.protocol !== 'https:') return null

  if (url.hostname === 'raw.githubusercontent.com') {
    return url.href
  }

  if (url.hostname !== 'github.com') return null

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 5) return null
  if (parts[2] !== 'blob' && parts[2] !== 'raw') return null

  const [owner, repo, , ref, ...pathParts] = parts
  if (!owner || !repo || !ref || !pathParts.length) return null

  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${pathParts.map(encodeURIComponent).join('/')}`
}

function isAllowedRawGitHubURL(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'raw.githubusercontent.com'
  } catch {
    return false
  }
}

function allSourceURLs() {
  const urls = new Set([
    'https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt',
    'https://raw.githubusercontent.com/jarelllama/Scam-Blocklist/main/lists/wildcard_domains/scams_light.txt'
  ])
  for (const source of settings.customSources) urls.add(source.url)
  return urls
}

function deriveSourceName(rawURL) {
  try {
    const parts = new URL(rawURL).pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const owner = parts[0] || 'GitHub'
    const repo = parts[1] || 'list'
    const file = parts[parts.length - 1] || 'list'
    return `${owner}/${repo} · ${file}`.slice(0, 100)
  } catch {
    return 'GitHub list'
  }
}

function hashString(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

window.addEventListener('focus', renderStatusSafely)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) renderStatusSafely()
})

// Initialize after all event handlers are registered so rendering failures cannot
// disable the settings workflow.
hydrate()
renderCustomSources()
renderCustomRules()
renderRuleHelp()
renderStatusSafely()
updateDirtyState()

