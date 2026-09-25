/*
 * DigitalTouch 0.1.0
 *
 * DigitalTouch-style animated drawing for the Mango composer.
 * Drawing stays local until the finished export is handed to Mango's uploader.
 */

(() => {
  'use strict';

  const stage = document.getElementById('stage');
  const ctx = stage.getContext('2d', { alpha: false });
  const hint = document.getElementById('emptyHint');
  const replayBadge = document.getElementById('replayBadge');
  const status = document.getElementById('status');
  const sizeInput = document.getElementById('size');
  const speedInput = document.getElementById('speed');
  const undoBtn = document.getElementById('undo');
  const clearBtn = document.getElementById('clear');
  const playBtn = document.getElementById('play');
  const sendGifBtn = document.getElementById('sendGif');
  const exportChipLabel = document.getElementById('exportChipLabel');
  const loopToggle = document.getElementById('loopToggle');
  const loopControl = document.getElementById('loopControl');

  const DRAW_REFERENCE_SIZE = 360;
  const SETTINGS_KEY = 'export-settings';
  const DEFAULT_EXPORT_SETTINGS = Object.freeze({
    format: 'gif',
    preset: 'balanced',
    exportSize: 360,
    fps: 18,
    webpQuality: 90,
    videoBitrate: 2500000
  });
  const MAX_UPLOAD = 8 * 1024 * 1024;
  const MOBILE_DPR_MAX = 1.25;
  const TABLET_DPR_MAX = 1.5;
  const DESKTOP_DPR_MAX = 2;
  const MIN_SAMPLE_DISTANCE_PX = 1.4;
  const MIN_SAMPLE_INTERVAL_MS = 7;
  const STROKE_MIN_LIFE = 300;
  const STROKE_MAX_LIFE = 1100;
  const STROKE_INITIAL_LIFE = 360;
  const STROKE_CONTINUITY = .88;
  const EFFECT_DURATION = {
    tap: 720,
    fireball: 1250,
    kiss: 1120,
    heartbeat: 1720,
    heartbreak: 1900
  };

  let selectedColor = '#ff375f';
  let inkMode = 'sketch';
  let placementEffect = null;
  let events = [];
  let activeStroke = null;
  let activeStrokeStartedAtReal = 0;
  let pointerRect = null;
  let replayRAF = 0;
  let liveRAF = 0;
  let liveRange = null;
  let replaying = false;
  let replayCursor = 0;
  let replayScale = 1;
  let busy = false;
  let exportSettings = { ...DEFAULT_EXPORT_SETTINGS };
  let loopEnabled = true;

  function now() { return performance.now(); }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function lerp(a, b, f) { return a + (b - a) * f; }
  function easeOut(v) { return 1 - Math.pow(1 - clamp(v, 0, 1), 3); }
  function easeInOut(v) {
    const x = clamp(v, 0, 1);
    return x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  }

  // ---------------------------------------------------------------------------
  // Export settings
  // ---------------------------------------------------------------------------

  function normalizeExportSettings(raw) {
    const data = { ...DEFAULT_EXPORT_SETTINGS, ...(raw || {}) };
    const formats = ['gif', 'webp', 'apng', 'webm', 'mp4'];
    const presets = ['small', 'balanced', 'high', 'max', 'custom'];
    const sizes = [256, 320, 360, 420, 480];
    const fpsValues = [10, 12, 15, 18, 24];
    const bitrates = [1200000, 1800000, 2500000, 3500000, 5000000];
    data.format = formats.includes(data.format) ? data.format : DEFAULT_EXPORT_SETTINGS.format;
    data.preset = presets.includes(data.preset) ? data.preset : DEFAULT_EXPORT_SETTINGS.preset;
    data.exportSize = sizes.includes(Number(data.exportSize)) ? Number(data.exportSize) : DEFAULT_EXPORT_SETTINGS.exportSize;
    data.fps = fpsValues.includes(Number(data.fps)) ? Number(data.fps) : DEFAULT_EXPORT_SETTINGS.fps;
    data.webpQuality = clamp(Number(data.webpQuality) || DEFAULT_EXPORT_SETTINGS.webpQuality, 40, 100);
    data.videoBitrate = bitrates.includes(Number(data.videoBitrate)) ? Number(data.videoBitrate) : DEFAULT_EXPORT_SETTINGS.videoBitrate;
    return data;
  }

  async function loadExportSettings() {
    try {
      const raw = await window.grove?.secrets?.application?.get?.(SETTINGS_KEY);
      exportSettings = normalizeExportSettings(raw ? JSON.parse(raw) : null);
    } catch (_) {
      exportSettings = { ...DEFAULT_EXPORT_SETTINGS };
    }
  }

  function syncExportUI() {
    const info = formatInfo(exportSettings.format);
    const preset = exportSettings.preset.charAt(0).toUpperCase() + exportSettings.preset.slice(1);
    const summary = `${info.label} · ${preset}`;
    if (exportChipLabel) exportChipLabel.textContent = summary;
    sendGifBtn.textContent = `Send ${info.label}`;
    const animated = info.label === 'GIF' || info.label === 'APNG' || info.label === 'WebP';
    if (loopControl) loopControl.classList.toggle('loop-hidden', !animated);
  }

  // ---------------------------------------------------------------------------
  // Timeline + playback
  // ---------------------------------------------------------------------------

  function playbackSpeed() {
    return Math.max(0.1, Number(speedInput.value) || 1);
  }

  function sourceScale() {
    return 1 / playbackSpeed();
  }

  function insertionTime() {
    return replaying ? replayCursor : timelineEnd();
  }

  function activeStrokeTime() {
    if (!activeStroke) return insertionTime();
    if (replaying) return Math.max(activeStroke.t, replayCursor);
    return activeStroke.t + Math.max(0, now() - activeStrokeStartedAtReal);
  }

  function setBusy(value, message) {
    busy = value;
    if (value) stopLivePreview();
    document.body.classList.toggle('busy', value);
    const empty = events.length === 0;
    sendGifBtn.disabled = value || empty;
    if (activeStroke) sendGifBtn.disabled = true;
    playBtn.disabled = value || empty;
    undoBtn.disabled = value || empty;
    clearBtn.disabled = value || empty;
    if (message) status.textContent = message;
  }

  function updateUI() {
    hint.hidden = events.length > 0 || !!activeStroke;
    setBusy(busy);
  }

  function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    const shortest = Math.min(window.innerWidth || 9999, window.innerHeight || 9999);
    const dprMax = shortest < 520 ? MOBILE_DPR_MAX : shortest < 900 ? TABLET_DPR_MAX : DESKTOP_DPR_MAX;
    const scale = Math.min(window.devicePixelRatio || 1, dprMax);
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    if (stage.width !== width || stage.height !== height) {
      stage.width = width;
      stage.height = height;
      renderAll();
    }
  }

  function syncViewport() {
    const viewport = window.visualViewport;
    const visibleHeight = Math.max(1, Math.round(viewport?.height || window.innerHeight || 1));
    document.documentElement.style.setProperty('--grove-viewport-height', `${visibleHeight}px`);
    const layoutHeight = window.innerHeight || visibleHeight;
    document.body.classList.toggle('keyboard-open', visibleHeight < layoutHeight - 120);
  }

  // ---------------------------------------------------------------------------
  // Canvas rendering
  // ---------------------------------------------------------------------------

  function clearCanvas(targetCtx, width, height) {
    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.globalAlpha = 1;
    targetCtx.fillStyle = '#000';
    targetCtx.fillRect(0, 0, width, height);
  }

  function scaleFor(width, height) {
    return Math.min(width, height) / DRAW_REFERENCE_SIZE;
  }

  function pointFromEvent(e, time = activeStrokeTime()) {
    const rect = pointerRect || stage.getBoundingClientRect();
    const pressure = e.pointerType === 'pen'
      ? clamp(e.pressure || 0.25, 0.08, 1)
      : (e.pressure > 0 ? clamp(e.pressure, 0.2, 1) : 0.65);
    return {
      x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((e.clientY - rect.top) / rect.height, 0, 1),
      p: pressure,
      t: time,
      v: 0,
      life: STROKE_INITIAL_LIFE
    };
  }

  function canvasPoint(e) {
    const rect = stage.getBoundingClientRect();
    return {
      x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((e.clientY - rect.top) / rect.height, 0, 1)
    };
  }

  function addPoint(stroke, point, rect) {
    const last = stroke.points[stroke.points.length - 1];
    if (last) {
      const dx = (point.x - last.x) * rect.width;
      const dy = (point.y - last.y) * rect.height;
      const dt = Math.max(1, point.t - last.t);
      const distance = Math.hypot(dx, dy);
      point.v = distance / dt;
      const speed = clamp((point.v - 0.05) / 1.25, 0, 1);
      point.life = lerp(STROKE_MIN_LIFE, STROKE_MAX_LIFE, Math.pow(speed, 0.68));
      stroke.maxLife = Math.max(stroke.maxLife, point.life);
    }
    stroke.points.push(point);
    const lastPoint = stroke.points[stroke.points.length - 1];
    stroke.end = Math.max(stroke.end, lastPoint.t + stroke.maxLife + (stroke.effect === 'comet' ? 620 : 0));
  }

  function strokeBaseWidth(stroke, width, height, pressure) {
    const s = scaleFor(width, height);
    return Math.max(1.4, stroke.size * s * (0.5 + pressure * 0.92));
  }

  function applyStrokeStyle(targetCtx, stroke, width, height, alpha, pressure, widthScale = 1) {
    targetCtx.globalAlpha = clamp(alpha, 0, 1);
    targetCtx.strokeStyle = stroke.color;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    targetCtx.lineWidth = strokeBaseWidth(stroke, width, height, pressure) * widthScale;
  }



  function drawDot(targetCtx, point, stroke, width, height, alpha, layers) {
    const base = strokeBaseWidth(stroke, width, height, point.p) * .55;
    const x = point.x * width;
    const y = point.y * height;
    targetCtx.save();
    targetCtx.globalCompositeOperation = 'lighter';
    for (const layer of layers) {
      targetCtx.globalAlpha = clamp(alpha * layer.a, 0, 1);
      targetCtx.fillStyle = stroke.color;
      targetCtx.beginPath();
      targetCtx.arc(x, y, Math.max(.7, base * layer.w), 0, Math.PI * 2);
      targetCtx.fill();
    }
    targetCtx.restore();
  }

  function segmentAlpha(time, b) {
    const age = time - b.t;
    if (age < 0 || age > b.life) return 0;
    const hold = b.life * .13;
    return age <= hold ? 1 : 1 - easeInOut((age - hold) / Math.max(1, b.life - hold));
  }

  function continuousSegmentAlphas(points, time) {
    const alphas = new Array(points.length).fill(0);
    let carry = 0;
    for (let i = points.length - 1; i > 0; i--) {
      carry = Math.max(segmentAlpha(time, points[i]), carry * STROKE_CONTINUITY);
      alphas[i] = carry;
    }
    return alphas;
  }

  function visibleStrokePoints(stroke, time) {
    const points = stroke.points || [];
    const visible = [];
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (point.t > time) {
        const previous = points[i - 1];
        if (previous && time > previous.t) {
          const f = clamp((time - previous.t) / Math.max(1, point.t - previous.t), 0, 1);
          visible.push({
            x: lerp(previous.x, point.x, f),
            y: lerp(previous.y, point.y, f),
            p: lerp(previous.p, point.p, f),
            t: time,
            life: point.life
          });
        }
        break;
      }
      visible.push(point);
    }
    return visible;
  }

  function smoothStrokePath(targetCtx, points, width, height) {
    targetCtx.beginPath();
    targetCtx.moveTo(points[0].x * width, points[0].y * height);
    if (points.length === 2) {
      targetCtx.lineTo(points[1].x * width, points[1].y * height);
      return;
    }
    for (let i = 1; i < points.length - 1; i++) {
      const point = points[i];
      const next = points[i + 1];
      targetCtx.quadraticCurveTo(
        point.x * width,
        point.y * height,
        (point.x + next.x) * .5 * width,
        (point.y + next.y) * .5 * height
      );
    }
    const last = points[points.length - 1];
    targetCtx.quadraticCurveTo(last.x * width, last.y * height, last.x * width, last.y * height);
  }

  function drawContinuousStroke(targetCtx, points, stroke, width, height, alpha, layers, lineCap = 'round') {
    const pressure = points.reduce((sum, point) => sum + point.p, 0) / points.length;
    targetCtx.save();
    targetCtx.globalCompositeOperation = 'lighter';
    for (const layer of layers) {
      applyStrokeStyle(targetCtx, stroke, width, height, alpha * layer.a, pressure, layer.w);
      targetCtx.lineCap = lineCap;
      smoothStrokePath(targetCtx, points, width, height);
      targetCtx.stroke();
    }
    targetCtx.restore();
  }

  function drawFadedContinuousStroke(targetCtx, points, pointAlphas, stroke, width, height, layers) {
    const bands = [
      { threshold: .03, alpha: .075 },
      { threshold: .15, alpha: .075 },
      { threshold: .27, alpha: .075 },
      { threshold: .39, alpha: .075 },
      { threshold: .51, alpha: .075 },
      { threshold: .63, alpha: .075 },
      { threshold: .75, alpha: .075 },
      { threshold: .87, alpha: .075 }
    ];
    for (let bandIndex = 0; bandIndex < bands.length; bandIndex++) {
      const band = bands[bandIndex];
      let start = -1;
      for (let i = 0; i < pointAlphas.length; i++) {
        if (pointAlphas[i] >= band.threshold) {
          start = i;
          break;
        }
      }
      if (start < 0) continue;
      const bandPoints = points.slice(start);
      if (bandPoints.length === 1) {
        drawDot(targetCtx, bandPoints[0], stroke, width, height, band.alpha, layers);
      } else {
        drawContinuousStroke(
          targetCtx,
          bandPoints,
          stroke,
          width,
          height,
          band.alpha,
          layers,
          'round'
        );
      }
    }
  }

  function continuousCoreAlpha(pointAlphas, maximum) {
    if (!pointAlphas.length) return 0;
    const minimum = Math.min(...pointAlphas);
    const peak = Math.max(...pointAlphas);
    // The minimum makes the whole path fade together. A small peak
    // contribution keeps the newest part readable without reintroducing a
    // hard, constant-opacity underlay.
    return clamp(minimum * maximum + peak * .05, 0, maximum);
  }

  function pseudo(seed) {
    const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return value - Math.floor(value);
  }

  function electricSegment(targetCtx, a, b, stroke, width, height, alpha, index) {
    const ax = a.x * width, ay = a.y * height, bx = b.x * width, by = b.y * height;
    const dx = bx - ax, dy = by - ay;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length, ny = dx / length;
    const steps = Math.max(3, Math.ceil(length / 10));
    const pressure = (a.p + b.p) * .5;

    function trace(widthScale, layerAlpha, offsetScale) {
      applyStrokeStyle(targetCtx, stroke, width, height, alpha * layerAlpha, pressure, widthScale);
      targetCtx.beginPath();
      targetCtx.moveTo(ax, ay);
      for (let step = 1; step < steps; step++) {
        const f = step / steps;
        const offset = (pseudo(index * 97 + step * 13) - .5) * Math.min(26, length * .38) * offsetScale;
        targetCtx.lineTo(ax + dx * f + nx * offset, ay + dy * f + ny * offset);
      }
      targetCtx.lineTo(bx, by);
      targetCtx.stroke();
    }

    targetCtx.save();
    targetCtx.globalCompositeOperation = 'lighter';
    trace(5.2, .12, .8);
    trace(2.4, .28, 1.0);
    trace(.72, 1.0, 1.2);
    targetCtx.restore();
  }

  function cometParticles(targetCtx, stroke, a, b, width, height, time, index, alpha) {
    const age = time - b.t;
    if (age < 0 || age > 620) return;
    const fade = 1 - age / 620;
    const scale = scaleFor(width, height);
    targetCtx.save();
    targetCtx.globalCompositeOperation = 'lighter';
    for (let n = 0; n < 3; n++) {
      const seed = index * 19 + n * 37;
      const angle = pseudo(seed) * Math.PI * 2;
      const distance = (15 + pseudo(seed + 1) * 42) * (age / 620) * scale;
      const x = b.x * width + Math.cos(angle) * distance;
      const y = b.y * height + Math.sin(angle) * distance - age * 0.012 * scale;
      const radius = (1.3 + pseudo(seed + 2) * 2.2) * scale;
      targetCtx.globalAlpha = fade * alpha * .95;
      targetCtx.fillStyle = stroke.color;
      targetCtx.beginPath();
      targetCtx.arc(x, y, Math.max(.7, radius), 0, Math.PI * 2);
      targetCtx.fill();
    }
    targetCtx.restore();
  }

  function drawStrokeAt(targetCtx, stroke, width, height, time) {
    const points = stroke.points || [];
    const mode = stroke.effect || 'sketch';
    const live = stroke === activeStroke;
    if (!points.length || time < stroke.t || (!live && time > stroke.end)) return;

    if (points.length === 1) {
      const p = points[0];
      const alpha = segmentAlpha(time, p);
      if (alpha <= 0) return;
      const layers = mode === 'glow'
        ? [{ w: 8, a: .11 }, { w: 3.4, a: .35 }, { w: 1, a: 1 }]
        : mode === 'comet'
          ? [{ w: 6, a: .12 }, { w: 2.5, a: .38 }, { w: 1, a: 1 }]
          : [{ w: 1, a: 1 }];
      drawDot(targetCtx, p, stroke, width, height, alpha, layers);
      return;
    }

    const visible = visibleStrokePoints(stroke, time);
    const pointAlphas = visible.map((point) => segmentAlpha(time, point));
    let lastVisible = pointAlphas.length - 1;
    while (lastVisible >= 0 && pointAlphas[lastVisible] <= 0) lastVisible--;
    if (lastVisible < 1) return;
    const firstVisible = pointAlphas.findIndex((alpha) => alpha > 0);
    const pathPoints = visible.slice(firstVisible, lastVisible + 1);
    const pathAlphas = pointAlphas.slice(firstVisible, lastVisible + 1);

    // Keep a faint continuous core under the fade bands. This is the part
    // that keeps Electric connected and prevents short fade bands from
    // reading as broken dashes in the other ink modes.
    drawContinuousStroke(
      targetCtx,
      pathPoints,
      stroke,
      width,
      height,
      continuousCoreAlpha(pathAlphas, mode === 'electric' ? .62 : .44),
      [{ w: .72, a: 1 }]
    );

    if (mode === 'glow') {
      drawFadedContinuousStroke(targetCtx, pathPoints, pathAlphas, stroke, width, height, [
        { w: 9.2, a: .14 },
        { w: 4.4, a: .34 },
        { w: 1.8, a: .86 },
        { w: .72, a: 1 }
      ]);
    } else if (mode === 'comet') {
      drawFadedContinuousStroke(targetCtx, pathPoints, pathAlphas, stroke, width, height, [
        { w: 7.4, a: .13 },
        { w: 3.4, a: .34 },
        { w: 1.4, a: .88 },
        { w: .58, a: 1 }
      ]);
      for (let i = 1; i < pathPoints.length; i += 3) {
        cometParticles(targetCtx, stroke, pathPoints[i - 1], pathPoints[i], width, height, time, i, pathAlphas[i]);
      }
    } else if (mode === 'electric') {
      drawFadedContinuousStroke(targetCtx, pathPoints, pathAlphas, stroke, width, height, [{ w: .72, a: 1 }]);
      const segmentAlphas = continuousSegmentAlphas(pathPoints, time);
      for (let i = 1; i < pathPoints.length; i++) {
        electricSegment(targetCtx, pathPoints[i - 1], pathPoints[i], stroke, width, height, segmentAlphas[i], i);
      }
    } else {
      drawFadedContinuousStroke(targetCtx, pathPoints, pathAlphas, stroke, width, height, [
        { w: 2.3, a: .11 },
        { w: 1, a: .98 }
      ]);
    }
  }

  function ring(targetCtx, x, y, radius, color, alpha, lineWidth) {
    targetCtx.globalAlpha = alpha;
    targetCtx.strokeStyle = color;
    targetCtx.lineWidth = lineWidth;
    targetCtx.beginPath();
    targetCtx.arc(x, y, radius, 0, Math.PI * 2);
    targetCtx.stroke();
  }

  function drawTap(targetCtx, event, width, height, time) {
    const local = time - event.t;
    if (local < 0 || local > EFFECT_DURATION.tap) return;
    const p = local / EFFECT_DURATION.tap;
    const s = scaleFor(width, height);
    const x = event.x * width, y = event.y * height;
    targetCtx.save();
    targetCtx.globalCompositeOperation = 'lighter';
    ring(targetCtx, x, y, (10 + 64 * easeOut(p)) * s, event.color, (1 - p) * .55, 11 * s);
    ring(targetCtx, x, y, (7 + 48 * easeOut(p)) * s, event.color, (1 - p) * 1.0, 4.8 * s);
    targetCtx.restore();
  }

  function drawFireball(targetCtx, event, width, height, time) {
    const local = time - event.t;
    if (local < 0 || local > EFFECT_DURATION.fireball) return;
    const p = local / EFFECT_DURATION.fireball;
    const s = scaleFor(width, height);
    const x = event.x * width, y = event.y * height;
    const alpha = p > .78 ? 1 - (p - .78) / .22 : 1;
    const base = (13 + Math.sin(Math.min(1, p * 2.8) * Math.PI * .5) * 39) * s;
    targetCtx.save();
    targetCtx.globalCompositeOperation = 'lighter';
    for (const layer of [{ r: 2.3, a: .10 }, { r: 1.55, a: .22 }, { r: .85, a: .92 }]) {
      targetCtx.globalAlpha = alpha * layer.a;
      const g = targetCtx.createRadialGradient(x, y, 0, x, y, base * layer.r);
      g.addColorStop(0, '#fff');
      g.addColorStop(.18, '#ffd60a');
      g.addColorStop(.55, event.color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      targetCtx.fillStyle = g;
      targetCtx.beginPath();
      targetCtx.arc(x, y, base * layer.r, 0, Math.PI * 2);
      targetCtx.fill();
    }
    for (let i = 0; i < 22; i++) {
      const seed = i + 40;
      const angle = pseudo(seed) * Math.PI * 2;
      const distance = (16 + pseudo(seed + 4) * 56) * p * s;
      const rr = Math.max(.7, (1.6 + pseudo(seed + 7) * 4.5) * (1 - p * .62) * s);
      targetCtx.globalAlpha = (1 - p) * .9;
      targetCtx.fillStyle = i % 2 ? '#ffd60a' : event.color;
      targetCtx.beginPath();
      targetCtx.arc(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance, rr, 0, Math.PI * 2);
      targetCtx.fill();
    }
    targetCtx.restore();
  }

  function heartPath(targetCtx, x, y, size) {
    targetCtx.beginPath();
    targetCtx.moveTo(x, y + size * .28);
    targetCtx.bezierCurveTo(x - size * .78, y - size * .18, x - size * .52, y - size * .88, x, y - size * .42);
    targetCtx.bezierCurveTo(x + size * .52, y - size * .88, x + size * .78, y - size * .18, x, y + size * .28);
    targetCtx.closePath();
  }

  function drawKiss(targetCtx, event, width, height, time) {
    const local = time - event.t;
    if (local < 0 || local > EFFECT_DURATION.kiss) return;
    const p = local / EFFECT_DURATION.kiss;
    const s = scaleFor(width, height);
    const x = event.x * width, y = event.y * height;
    const alpha = p > .72 ? 1 - (p - .72) / .28 : 1;
    const grow = .7 + .5 * easeOut(Math.min(1, p * 2));
    targetCtx.save();
    targetCtx.translate(x, y);
    targetCtx.scale(grow * s, grow * s);
    targetCtx.globalCompositeOperation = 'lighter';
    for (const layer of [{ w: 18, a: .10 }, { w: 9, a: .28 }, { w: 4.8, a: 1 }]) {
      targetCtx.globalAlpha = alpha * layer.a;
      targetCtx.strokeStyle = event.color;
      targetCtx.lineWidth = layer.w;
      targetCtx.lineCap = 'round';
      targetCtx.lineJoin = 'round';
      targetCtx.beginPath();
      targetCtx.moveTo(-31, 0);
      targetCtx.bezierCurveTo(-16, -16, -4, -10, 0, -3);
      targetCtx.bezierCurveTo(4, -10, 16, -16, 31, 0);
      targetCtx.bezierCurveTo(15, 18, -15, 18, -31, 0);
      targetCtx.stroke();
    }
    targetCtx.restore();
  }

  function drawHeartbeat(targetCtx, event, width, height, time, broken) {
    const duration = broken ? EFFECT_DURATION.heartbreak : EFFECT_DURATION.heartbeat;
    const local = time - event.t;
    if (local < 0 || local >= duration) return;
    const p = local / duration;
    // GIF export samples just before the nominal end. Finish the fade a bit
    // earlier so the last encoded frame is genuinely empty.
    if (p >= .94) return;
    const s = scaleFor(width, height);
    const x = event.x * width, y = event.y * height;
    const beat = 1 + Math.max(0, Math.sin(local / 105 * Math.PI)) * .30 * (1 - p * .25);
    const fadeProgress = p > .72 ? 1 - (p - .72) / .22 : 1;
    const alpha = Math.pow(Math.max(0, fadeProgress), .82);

    function drawHeart(px, py, size, a, splitClip) {
      targetCtx.save();
      if (splitClip) splitClip();
      targetCtx.translate(px, py);
      targetCtx.scale(beat * s, beat * s);
      for (const layer of [{ size: size * 1.36, a: .16 }, { size: size * 1.14, a: .34 }, { size, a: 1 }]) {
        targetCtx.globalAlpha = alpha * a * layer.a;
        targetCtx.fillStyle = event.color;
        heartPath(targetCtx, 0, 0, layer.size);
        targetCtx.fill();
      }
      targetCtx.restore();
    }

    targetCtx.save();
    targetCtx.globalCompositeOperation = 'lighter';
    if (!broken || p < .48) {
      drawHeart(x, y, 58, 1);
    } else {
      const split = easeInOut((p - .48) / .52) * 38 * s;
      drawHeart(x - split, y + split * .45, 48, 1, () => { targetCtx.beginPath(); targetCtx.rect(0, 0, x, height); targetCtx.clip(); });
      drawHeart(x + split, y + split * .45, 48, 1, () => { targetCtx.beginPath(); targetCtx.rect(x, 0, width - x, height); targetCtx.clip(); });
    }
    targetCtx.restore();
  }

  function drawEvent(targetCtx, event, width, height, time) {
    if (event.kind === 'stroke') drawStrokeAt(targetCtx, event, width, height, time);
    else if (event.kind === 'tap') drawTap(targetCtx, event, width, height, time);
    else if (event.kind === 'fireball') drawFireball(targetCtx, event, width, height, time);
    else if (event.kind === 'kiss') drawKiss(targetCtx, event, width, height, time);
    else if (event.kind === 'heartbeat') drawHeartbeat(targetCtx, event, width, height, time, false);
    else if (event.kind === 'heartbreak') drawHeartbeat(targetCtx, event, width, height, time, true);
  }

  function renderAt(targetCtx, width, height, time = Infinity) {
    clearCanvas(targetCtx, width, height);
    const renderTime = Number.isFinite(time) ? time : timelineEnd();
    for (const event of events) {
      const end = eventEnd(event);
      if (renderTime < event.t || renderTime >= end) continue;
      drawEvent(targetCtx, event, width, height, renderTime);
    }
    if (activeStroke) drawStrokeAt(targetCtx, activeStroke, width, height, renderTime);
  }

  function renderAll() {
    renderAt(ctx, stage.width, stage.height, activeStroke ? activeStrokeTime() : timelineEnd());
  }

  function eventEnd(event) {
    if (typeof event.end === 'number') return event.end;
    if (event.kind === 'stroke') {
      const last = event.points[event.points.length - 1];
      event.end = last ? last.t + (event.maxLife || 520) + (event.effect === 'comet' ? 620 : 0) : event.t;
    } else {
      event.end = event.t + (EFFECT_DURATION[event.kind] || 800);
    }
    return event.end;
  }

  function timelineEnd(includeActive = false) {
    let end = 0;
    for (const event of events) end = Math.max(end, eventEnd(event));
    if (includeActive && activeStroke) end = Math.max(end, activeStroke.end, activeStrokeTime());
    return end;
  }

  function stopLivePreview() {
    if (liveRAF) cancelAnimationFrame(liveRAF);
    liveRAF = 0;
    liveRange = null;
  }

  function liveFrame(ts) {
    if (busy || replaying) {
      liveRAF = 0;
      return;
    }

    if (activeStroke) {
      renderAt(ctx, stage.width, stage.height, activeStrokeTime());
      liveRAF = requestAnimationFrame(liveFrame);
      return;
    }

    if (liveRange) {
      const elapsed = Math.max(0, ts - liveRange.startedAt);
      const t = Math.min(liveRange.to, liveRange.from + elapsed);
      renderAt(ctx, stage.width, stage.height, t);
      if (t < liveRange.to) liveRAF = requestAnimationFrame(liveFrame);
      else { liveRange = null; liveRAF = 0; }
      return;
    }

    liveRAF = 0;
  }

  function ensureLivePreview() {
    if (!liveRAF && !busy && !replaying) liveRAF = requestAnimationFrame(liveFrame);
  }

  function animateRange(from, to) {
    if (busy || replaying) return;
    if (to <= from) {
      liveRange = null;
      renderAt(ctx, stage.width, stage.height, to);
      return;
    }
    liveRange = { from, to, startedAt: now() };
    ensureLivePreview();
  }

  function preview(startAt = 0) {
    if (!events.length || busy) return;
    stopLivePreview();
    cancelAnimationFrame(replayRAF);
    replaying = true;
    replayCursor = clamp(startAt, 0, timelineEnd());
    replayScale = sourceScale();
    const replayStart = replayCursor;
    const started = now();
    replayBadge.hidden = false;
    replayBadge.textContent = 'Replay · draw to insert';
    playBtn.disabled = true;

    function tick(ts) {
      if (!replaying) return;
      const rawSourceT = replayStart + (ts - started) / replayScale;
      const currentEnd = Math.max(timelineEnd(), activeStroke ? activeStrokeTime() : 0);
      replayCursor = Math.min(currentEnd, rawSourceT);
      renderAt(ctx, stage.width, stage.height, replayCursor);
      if (rawSourceT < currentEnd || activeStroke) replayRAF = requestAnimationFrame(tick);
      else {
        replaying = false;
        replayCursor = currentEnd;
        replayBadge.hidden = true;
        replayBadge.textContent = 'Replay';
        playBtn.disabled = false;
        renderAll();
      }
    }
    replayRAF = requestAnimationFrame(tick);
  }

  function sortEvents() {
    events.sort((a, b) => a.t - b.t || eventEnd(a) - eventEnd(b));
  }

  function labelFor(kind) {
    return ({ tap: 'Tap', fireball: 'Fireball', kiss: 'Kiss', heartbeat: 'Heartbeat', heartbreak: 'Heartbreak' })[kind] || 'Effect';
  }

  function addEffect(kind, point) {
    const start = insertionTime();
    const event = { kind, x: point.x, y: point.y, t: start, end: start + (EFFECT_DURATION[kind] || 800), color: selectedColor };
    events.push(event);
    sortEvents();
    status.textContent = `${labelFor(kind)} active.`;
    if (!replaying) animateRange(start, event.end);
    updateUI();
  }

  // ---------------------------------------------------------------------------
  // Input + editing
  // ---------------------------------------------------------------------------

  function beginStroke(e) {
    if (!replaying) stopLivePreview();
    pointerRect = stage.getBoundingClientRect();
    stage.setPointerCapture?.(e.pointerId);
    const start = insertionTime();
    activeStrokeStartedAtReal = now();
    activeStroke = {
      kind: 'stroke',
      t: start,
      end: start,
      color: selectedColor,
      size: Number(sizeInput.value),
      effect: inkMode,
      pointerType: e.pointerType || 'unknown',
      maxLife: STROKE_INITIAL_LIFE,
      points: []
    };
    addPoint(activeStroke, pointFromEvent(e, start), pointerRect);
    ensureLivePreview();
    updateUI();
  }

  function moveStroke(e) {
    if (!activeStroke) return;
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    const t = activeStrokeTime();
    const count = Math.max(1, samples.length);
    const rect = pointerRect || stage.getBoundingClientRect();
    let previous = activeStroke.points[activeStroke.points.length - 1];
    const previousT = previous?.t ?? activeStroke.t;

    for (let i = 0; i < samples.length; i++) {
      const sampleT = lerp(previousT, t, (i + 1) / count);
      const point = pointFromEvent(samples[i], sampleT);
      if (previous) {
        const dx = (point.x - previous.x) * rect.width;
        const dy = (point.y - previous.y) * rect.height;
        const distance = Math.hypot(dx, dy);
        const dt = point.t - previous.t;
        if (distance < MIN_SAMPLE_DISTANCE_PX && dt < MIN_SAMPLE_INTERVAL_MS && i < samples.length - 1) continue;
      }
      addPoint(activeStroke, point, rect);
      previous = point;
    }
    ensureLivePreview();
  }

  function finishStroke(e) {
    if (!activeStroke) return;
    const endAtRelease = activeStrokeTime();
    if (e) {
      const point = pointFromEvent(e, endAtRelease);
      const last = activeStroke.points[activeStroke.points.length - 1];
      if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.0005 || point.t - last.t > 10) addPoint(activeStroke, point, pointerRect || stage.getBoundingClientRect());
    }
    const completed = activeStroke;
    events.push(completed);
    sortEvents();
    activeStroke = null;
    pointerRect = null;
    activeStrokeStartedAtReal = 0;
    if (!replaying && completed.end > endAtRelease) animateRange(endAtRelease, completed.end);
    updateUI();
    status.textContent = 'Draw, touch, and send.';
  }

  stage.addEventListener('pointerdown', (e) => {
    if (busy) return;
    if (placementEffect) addEffect(placementEffect, canvasPoint(e));
    else beginStroke(e);
  });
  stage.addEventListener('pointermove', (e) => { if (!busy) moveStroke(e); });
  stage.addEventListener('pointerup', finishStroke);
  stage.addEventListener('pointercancel', finishStroke);
  stage.addEventListener('lostpointercapture', () => finishStroke());

  document.querySelectorAll('.swatch').forEach((button) => {
    button.addEventListener('click', () => {
      selectedColor = button.dataset.color;
      document.documentElement.style.setProperty('--accent', selectedColor);
      document.querySelectorAll('.swatch').forEach((item) => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
    });
  });

  document.querySelectorAll('.tool[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      inkMode = button.dataset.mode;
      placementEffect = null;
      document.querySelectorAll('.effect[data-effect]').forEach(item => { item.classList.remove('selected'); item.setAttribute('aria-pressed', 'false'); });
      document.querySelectorAll('.tool[data-mode]').forEach((item) => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      status.textContent = `${button.getAttribute('aria-label')} selected.`;
      updateUI();
    });
  });

  document.querySelectorAll('.effect[data-effect]').forEach((button) => {
    button.addEventListener('click', () => {
      placementEffect = button.dataset.effect;
      document.querySelectorAll('.tool[data-mode]').forEach((item) => { item.classList.remove('active'); item.setAttribute('aria-pressed', 'false'); });
      document.querySelectorAll('.effect[data-effect]').forEach((item) => {
        const active = item === button;
        item.classList.toggle('selected', active);
        item.setAttribute('aria-pressed', String(active));
      });
      status.textContent = `${labelFor(placementEffect)} active · tap the canvas.`;
    });
  });

  undoBtn.addEventListener('click', () => {
    stopLivePreview();
    events.pop();
    renderAll();
    updateUI();
  });

  clearBtn.addEventListener('click', () => {
    stopLivePreview();
    cancelAnimationFrame(replayRAF);
    replaying = false;
    replayBadge.hidden = true;
    events = [];
    activeStroke = null;
    placementEffect = null;
    inkMode = 'sketch';
    document.querySelectorAll('.effect[data-effect]').forEach(item => { item.classList.remove('selected'); item.setAttribute('aria-pressed', 'false'); });
    document.querySelectorAll('.tool[data-mode]').forEach(item => {
      const active = item.dataset.mode === 'sketch';
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderAll();
    updateUI();
    status.textContent = 'Canvas cleared.';
  });

  speedInput.addEventListener('change', () => {
    status.textContent = `Playback speed ${playbackSpeed()}×.`;
    if (replaying) preview(replayCursor);
  });

  loopToggle?.addEventListener('change', () => {
    loopEnabled = !!loopToggle.checked;
    status.textContent = loopEnabled ? 'Loop enabled.' : 'Loop disabled.';
  });

  playBtn.addEventListener('click', () => preview(0));

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  function makeExportCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas;
  }

  function frameDelaySchedule(frameCount, durationMs) {
    const delays = [];
    let emitted = 0;
    for (let i = 0; i < frameCount; i++) {
      const target = Math.round((i + 1) * durationMs / frameCount / 10);
      const delay = Math.max(2, target - emitted);
      emitted += delay;
      delays.push(delay);
    }
    return delays;
  }

  function exportPlan() {
    const end = timelineEnd(true);
    const scale = sourceScale();
    const fps = exportSettings.fps;
    const size = exportSettings.exportSize;
    const frameMs = 1000 / fps;
    const duration = Math.max(frameMs, end * scale);
    const frameCount = Math.max(2, Math.ceil(duration / frameMs));
    return { end, scale, duration, frameCount, delays: frameDelaySchedule(frameCount, duration), fps, size };
  }

  function exportContext(canvas) {
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    return context;
  }

  function renderExportFrame(context, plan, index) {
    const replayT = Math.min(plan.duration - 1, index * plan.duration / plan.frameCount);
    const sourceT = Math.min(plan.end, replayT / plan.scale);
    renderAt(context, plan.size, plan.size, sourceT);
  }

  async function exportGIF() {
    const plan = exportPlan();
    const exportCanvas = makeExportCanvas(plan.size);
    const ec = exportContext(exportCanvas);
    const encoder = new MangoTouchGIF.GIFEncoder(plan.size, plan.size, loopEnabled ? 0 : null);

    for (let i = 0; i < plan.frameCount; i++) {
      renderExportFrame(ec, plan, i);
      encoder.addFrame(ec.getImageData(0, 0, plan.size, plan.size), plan.delays[i]);
      if (i % 4 === 0) {
        status.textContent = `Rendering GIF… ${Math.round((i + 1) / plan.frameCount * 100)}%`;
        await new Promise(requestAnimationFrame);
      }
    }
    return encoder.finish();
  }

  function recorderMime(format) {
    if (typeof window.MediaRecorder !== 'function') return null;
    const candidates = format === 'mp4'
      ? ['video/mp4', 'video/mp4;codecs="avc1.424028"', 'video/mp4;codecs="avc1.42E01E"']
      : ['video/webm', 'video/webm;codecs="vp8"', 'video/webm;codecs="vp9"'];
    if (typeof MediaRecorder.isTypeSupported !== 'function') return candidates[0];
    return candidates.find((type) => {
      try { return MediaRecorder.isTypeSupported(type); } catch (_) { return false; }
    }) || candidates[0];
  }

  function captureCanvasStream(canvas, fps) {
    const capture = canvas?.captureStream || canvas?.webkitCaptureStream;
    if (typeof capture !== 'function') return null;
    try { return capture.call(canvas, fps); } catch (_) { return null; }
  }

  function stopMediaStream(stream) {
    try {
      const tracks = typeof stream?.getTracks === 'function' ? stream.getTracks() : [];
      tracks.forEach((track) => { try { track.stop(); } catch (_) {} });
    } catch (_) {}
  }

  async function exportVideo(format) {
    const label = format.toUpperCase();
    const mime = recorderMime(format);
    if (!mime) throw new Error(`${label} recording is not supported in this WebView.`);

    const plan = exportPlan();
    const canvas = makeExportCanvas(plan.size);
    const context = exportContext(canvas);
    renderAt(context, plan.size, plan.size, 0);

    let stream;
    let recorder;
    const chunks = [];
    try {
      stream = captureCanvasStream(canvas, plan.fps);
      if (!stream || typeof stream.getVideoTracks !== 'function' || !stream.getVideoTracks().length) {
        throw new Error('Canvas video capture is not available in this WebView.');
      }

      try {
        recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: exportSettings.videoBitrate });
      } catch (_) {
        recorder = new MediaRecorder(stream);
      }

      const actualType = recorder.mimeType || mime;
      if (format === 'mp4' && actualType && !actualType.toLowerCase().includes('mp4')) {
        throw new Error(`This WebView selected ${actualType} instead of MP4.`);
      }
      if (format === 'webm' && actualType && !actualType.toLowerCase().includes('webm')) {
        throw new Error(`This WebView selected ${actualType} instead of WebM.`);
      }

      const stopped = new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error(`${label} recorder did not finish.`)), Math.max(4000, plan.duration + 3000));
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data && event.data.size) chunks.push(event.data);
        });
        recorder.addEventListener('error', (event) => {
          window.clearTimeout(timeout);
          reject(new Error(event.error?.message || `${label} recording failed.`));
        }, { once: true });
        recorder.addEventListener('stop', () => {
          window.clearTimeout(timeout);
          resolve();
        }, { once: true });
      });

      recorder.start(250);
      await new Promise((resolve) => {
        const started = performance.now();
        const tick = (timestamp) => {
          const elapsed = Math.max(0, timestamp - started);
          const sourceT = Math.min(plan.end, elapsed / plan.scale);
          renderAt(context, plan.size, plan.size, sourceT);
          status.textContent = `Rendering ${label}… ${Math.min(100, Math.round(elapsed / plan.duration * 100))}%`;
          if (elapsed < plan.duration) requestAnimationFrame(tick);
          else {
            renderAt(context, plan.size, plan.size, plan.end);
            window.setTimeout(resolve, 120);
          }
        };
        requestAnimationFrame(tick);
      });

      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      if (!chunks.length) throw new Error(`${label} recorder produced no data.`);
      const blob = new Blob(chunks, { type: actualType || mime });
      if (!blob.size) throw new Error(`${label} recorder produced an empty file.`);
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
      stopMediaStream(stream);
    }
  }

  function u16BE(value) { return [(value >> 8) & 255, value & 255]; }
  function u32BE(value) { return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]; }
  function u32LE(value) { return [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255]; }
  function u24LE(value) { return [value & 255, (value >> 8) & 255, (value >> 16) & 255]; }
  function asciiBytes(value) { return Uint8Array.from([...value].map((char) => char.charCodeAt(0))); }

  function joinBytes(...parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }

  let crcTable;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let value = n;
        for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        crcTable[n] = value >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function pngChunk(type, data) {
    const typeBytes = asciiBytes(type);
    const crc = crc32(joinBytes(typeBytes, data));
    return joinBytes(Uint8Array.from(u32BE(data.length)), typeBytes, data, Uint8Array.from(u32BE(crc)));
  }

  async function deflate(data) {
    if (typeof CompressionStream !== 'function') throw new Error('APNG encoding is not supported in this browser.');
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function pngScanlines(imageData, width, height) {
    const rowSize = width * 4;
    const output = new Uint8Array(height * (rowSize + 1));
    for (let y = 0; y < height; y++) {
      const sourceStart = y * rowSize;
      const targetStart = y * (rowSize + 1);
      output[targetStart] = 0;
      output.set(imageData.data.subarray(sourceStart, sourceStart + rowSize), targetStart + 1);
    }
    return output;
  }

  function apngControl(size, sequence, delayCs) {
    return Uint8Array.from([
      ...u32BE(sequence),
      ...u32BE(size), ...u32BE(size),
      ...u32BE(0), ...u32BE(0),
      ...u16BE(Math.min(65535, Math.max(1, delayCs * 10))), ...u16BE(1000),
      0, 0
    ]);
  }

  async function exportAPNG() {
    const plan = exportPlan();
    const canvas = makeExportCanvas(plan.size);
    const context = exportContext(canvas);
    const chunks = [
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', Uint8Array.from([...u32BE(plan.size), ...u32BE(plan.size), 8, 6, 0, 0, 0])),
      pngChunk('acTL', Uint8Array.from([...u32BE(plan.frameCount), ...u32BE(loopEnabled ? 0 : 1)]))
    ];
    let sequence = 0;
    for (let i = 0; i < plan.frameCount; i++) {
      renderExportFrame(context, plan, i);
      const compressed = await deflate(pngScanlines(context.getImageData(0, 0, plan.size, plan.size), plan.size, plan.size));
      chunks.push(pngChunk('fcTL', apngControl(plan.size, sequence++, plan.delays[i])));
      if (i === 0) chunks.push(pngChunk('IDAT', compressed));
      else chunks.push(pngChunk('fdAT', joinBytes(Uint8Array.from(u32BE(sequence++)), compressed)));
      if (i % 2 === 0) {
        status.textContent = `Rendering APNG… ${Math.round((i + 1) / plan.frameCount * 100)}%`;
        await new Promise(requestAnimationFrame);
      }
    }
    chunks.push(pngChunk('IEND', new Uint8Array(0)));
    return joinBytes(...chunks);
  }

  function webpFrameChunks(bytes) {
    if (!isWebPBytes(bytes)) throw new Error('Invalid WebP frame.');
    const chunks = [];
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
      const size = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
      const dataStart = offset + 8;
      const dataEnd = dataStart + size;
      if (dataEnd > bytes.length) throw new Error('Invalid WebP frame chunk.');
      if (type !== 'VP8X') chunks.push(joinBytes(asciiBytes(type), Uint8Array.from(u32LE(size)), bytes.slice(dataStart, dataEnd), size & 1 ? Uint8Array.from([0]) : new Uint8Array(0)));
      offset = dataEnd + (size & 1);
    }
    return joinBytes(...chunks);
  }

  function webpChunk(type, data) {
    return joinBytes(asciiBytes(type), Uint8Array.from(u32LE(data.length)), data, data.length & 1 ? Uint8Array.from([0]) : new Uint8Array(0));
  }

  function isWebPBytes(bytes) {
    return bytes && bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  }

  async function exportWebP() {
    if (!window.MangoTouchWebP?.WebPEncoder) {
      throw new Error('Bundled WebP encoder is unavailable.');
    }

    const plan = exportPlan();
    const canvas = makeExportCanvas(plan.size);
    const context = exportContext(canvas);
    const frameChunks = [];
    const quality = exportSettings.webpQuality;

    for (let i = 0; i < plan.frameCount; i++) {
      renderExportFrame(context, plan, i);
      const rgba = context.getImageData(0, 0, plan.size, plan.size).data;
      const encoder = new window.MangoTouchWebP.WebPEncoder(plan.size, plan.size, rgba);
      const encoded = encoder.encode(quality);
      if (!isWebPBytes(encoded)) throw new Error('Bundled WebP encoder returned invalid data.');
      frameChunks.push(webpFrameChunks(encoded));
      if (i % 2 === 0) {
        status.textContent = `Rendering WebP… ${Math.round((i + 1) / plan.frameCount * 100)}%`;
        await new Promise(requestAnimationFrame);
      }
    }

    const canvasInfo = Uint8Array.from([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    canvasInfo.set(u24LE(plan.size - 1), 4);
    canvasInfo.set(u24LE(plan.size - 1), 7);
    const anim = Uint8Array.from([0, 0, 0, 0, ...(loopEnabled ? [0, 0] : [1, 0])]);
    const frames = [];
    for (let i = 0; i < frameChunks.length; i++) {
      const header = Uint8Array.from([
        ...u24LE(0), ...u24LE(0), ...u24LE(plan.size - 1), ...u24LE(plan.size - 1),
        ...u24LE(Math.min(0xffffff, plan.delays[i] * 10)), 0
      ]);
      frames.push(webpChunk('ANMF', joinBytes(header, frameChunks[i])));
    }
    const body = joinBytes(asciiBytes('WEBP'), webpChunk('VP8X', canvasInfo), webpChunk('ANIM', anim), ...frames);
    const result = joinBytes(asciiBytes('RIFF'), Uint8Array.from(u32LE(body.length)), body);
    if (!isWebPBytes(result)) throw new Error('Animated WebP assembly failed.');
    return result;
  }

  function formatInfo(format) {
    return ({
      gif: { label: 'GIF', filename: 'digital-touch.gif' },
      webp: { label: 'WebP', filename: 'digital-touch.webp' },
      apng: { label: 'APNG', filename: 'digital-touch.apng' },
      webm: { label: 'WebM', filename: 'digital-touch.webm' },
      mp4: { label: 'MP4', filename: 'digital-touch.mp4' }
    })[format] || { label: 'GIF', filename: 'digital-touch.gif' };
  }

  async function exportFormat(format) {
    if (format === 'gif') return exportGIF();
    if (format === 'webp') return exportWebP();
    if (format === 'apng') return exportAPNG();
    if (format === 'webm' || format === 'mp4') return exportVideo(format);
    throw new Error('Unknown export format.');
  }


  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------

  async function upload(bytes, filename, caption) {
    if (!window.grove?.composer?.upload) throw new Error('Mango composer upload API is unavailable.');
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error('Export returned no data.');
    if (bytes.byteLength > MAX_UPLOAD) throw new Error(`Export is too large (${(bytes.byteLength / 1048576).toFixed(1)} MiB).`);
    await window.grove.composer.upload(bytes, { filename, caption });
  }

  sendGifBtn.addEventListener('click', async () => {
    if (!events.length || busy) return;
    const format = exportSettings.format;
    const info = formatInfo(format);
    try {
      setBusy(true, `Rendering ${info.label}…`);
      const bytes = await exportFormat(format);
      status.textContent = `Uploading ${(bytes.byteLength / 1024).toFixed(0)} KiB ${info.label}…`;
      await upload(bytes, info.filename, `DigitalTouch (${info.label})`);
      setBusy(false, `${info.label} sent.`);
    } catch (error) {
      console.error(error);
      setBusy(false, error.message || `${info.label} export failed.`);
    }
  });

  new ResizeObserver(resizeCanvas).observe(stage);
  window.addEventListener('resize', () => { syncViewport(); resizeCanvas(); });
  window.visualViewport?.addEventListener('resize', syncViewport);
  (async () => {
    await loadExportSettings();
    syncExportUI();
    syncViewport();
    resizeCanvas();
    renderAll();
    updateUI();
  })();
})();
