/* global DateRangePicker, decodePolyline, RAMPS, MODES, computeScale, rampColor, formatKm, formatPace,
   formatDuration, formatDate, loadPref, savePref */

// "All runs, one start": every run is moved so it begins at the same point,
// then they're all drawn on top of each other on a blank canvas. No map,
// just the shapes of your running.

const $ = (sel) => document.querySelector(sel);

// Colour modes for this view: the map's modes, with "Glow" instead of the
// plain route colour and no heatmap (overlapping glow already does that job).
const OV_MODES = [
  { id: 'glow', label: 'Glow', kind: 'glow' },
  ...MODES.filter((m) => m.value),
];

const BG = { light: '#f6f5f1', dark: '#0b0b0d' };
const INK = { light: '28,29,31', dark: '236,236,238' }; // rgb for rings & labels
const GLOW = { light: '208,58,8', dark: '255,112,52' };
const SEL = { light: { line: '#1565d8', casing: '#ffffff' }, dark: { line: '#4cc3ff', casing: '#0b0b0d' } };

const state = {
  athlete: null,
  runs: [], // runs with GPS, prepared for drawing
  noGps: 0,
  visible: [],
  mode: loadPref('rm.overlayMode', 'glow'),
  theme: document.documentElement.dataset.theme || 'dark',
  scale: null,
  selected: null,
  view: { s: 0.05, ox: 0, oy: 0 }, // px per metre, screen position of the start point
  replay: null,
};

const picker = new DateRangePicker($('#date-btn'), { onChange: () => applyFilter() });
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
let dpr = window.devicePixelRatio || 1;
let cache = null; // snapshot of the last full render, reused while dragging
let cacheView = null;
let redrawTimer = null;

init();

async function init() {
  const resp = await fetch('/api/runs').catch(() => null);
  if (!resp || resp.status === 401) {
    location.href = '/';
    return;
  }
  const data = await resp.json();
  if (!resp.ok) {
    $('#loading').innerHTML = `<span>${data.message || 'Could not load your runs.'}</span>`;
    return;
  }

  for (const r of data.runs) {
    if (!r.polyline) {
      state.noGps++;
      continue;
    }
    const prepared = prepare(r);
    if (prepared) state.runs.push(prepared);
  }
  state.runs.sort((a, b) => a.date.localeCompare(b.date)); // oldest first

  picker.setRunDates(state.runs.map((r) => r.date));
  buildModes();
  bindUi();
  resize();
  applyFilter();
  $('#loading').classList.add('hidden');
  showHint();
}

// Convert a run to metres east/north of its own start point.
function prepare(run) {
  const ll = decodePolyline(run.polyline);
  if (ll.length < 2) return null;
  const [lat0, lng0] = ll[0];
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const pts = new Float32Array(ll.length * 2);
  let maxR = 0;
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  ll.forEach(([lat, lng], i) => {
    const x = (lng - lng0) * mPerLng;
    const y = (lat - lat0) * mPerLat;
    pts[i * 2] = x;
    pts[i * 2 + 1] = y;
    maxR = Math.max(maxR, Math.hypot(x, y));
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });
  // cumulative distance along the route, for the replay dots
  const cum = new Float32Array(ll.length);
  for (let i = 1; i < ll.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  }
  return { ...run, pts, cum, maxR, bbox: [minX, minY, maxX, maxY] };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function buildModes() {
  const nav = $('#modes');
  for (const m of OV_MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = m.id;
    b.textContent = m.label;
    b.addEventListener('click', () => setMode(m.id));
    nav.appendChild(b);
  }
}

function renderModes() {
  for (const b of $('#modes').children) {
    const m = OV_MODES.find((x) => x.id === b.dataset.mode);
    const ok = !m.value || state.visible.some((r) => m.value(r) != null);
    b.disabled = !ok;
    b.title = ok ? '' : `None of these runs have ${m.title.toLowerCase()} data`;
  }
  if ($(`#modes [data-mode="${state.mode}"]`)?.disabled || !OV_MODES.some((m) => m.id === state.mode)) {
    state.mode = 'glow';
  }
  for (const b of $('#modes').children) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
}

function currentMode() {
  return OV_MODES.find((m) => m.id === state.mode) || OV_MODES[0];
}

function setMode(id) {
  stopReplay();
  state.mode = id;
  savePref('rm.overlayMode', id);
  renderModes();
  state.scale = currentMode().value ? computeScale(currentMode(), state.visible) : null;
  renderLegend();
  render();
}

function applyFilter() {
  stopReplay();
  state.visible = picker.isAllTime() ? state.runs : state.runs.filter((r) => picker.includes(r.date));
  if (state.selected && !state.visible.includes(state.selected)) select(null);
  renderModes();
  state.scale = currentMode().value ? computeScale(currentMode(), state.visible) : null;

  const km = state.visible.reduce((s, r) => s + r.distance, 0) / 1000;
  const years = state.visible.length
    ? `${state.visible[0].date.slice(0, 4)}–${state.visible[state.visible.length - 1].date.slice(0, 4)}`
    : '';
  const noGps = picker.isAllTime() && state.noGps ? ` · ${state.noGps} without GPS not shown` : '';
  $('#ov-stats').textContent = state.visible.length
    ? `${state.visible.length.toLocaleString()} runs · ${Math.round(km).toLocaleString()} km${noGps}`
    : 'No runs with GPS here';
  const when = picker.isAllTime()
    ? years.split('–')[0] === years.split('–')[1] ? years.split('–')[0] : years
    : picker.label();
  state.caption = `${state.visible.length} runs · ${Math.round(km).toLocaleString()} km · ${when}`;

  renderLegend();
  fitView();
  render();
}

function bindUi() {
  $('#theme-toggle').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = state.theme;
    savePref('rm.theme', state.theme);
    renderLegend();
    render();
  });
  $('#replay').addEventListener('click', () => (state.replay ? stopReplay() : startReplay()));
  $('#speed').addEventListener('click', cycleSpeed);
  $('#save').addEventListener('click', saveImage);
  $('#fit').addEventListener('click', () => {
    fitView();
    render();
  });
  $('#run-card-close').addEventListener('click', () => select(null));
  window.addEventListener('resize', () => {
    resize();
    fitView();
    render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return select(null);
    if (e.target.closest('select, button, .drp, input')) return; // let controls handle their own keys
    else if (e.key === ' ') {
      e.preventDefault();
      state.replay ? stopReplay() : startReplay();
    } else if (e.key === '+' || e.key === '=') zoomAt(innerWidth / 2, innerHeight / 2, 1.4);
    else if (e.key === '-') zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.4);
    else if (e.key === '0') {
      fitView();
      render();
    }
  });
  bindGestures();

  // Fade the mode bar's edges when it scrolls sideways (phones).
  const modes = $('#modes');
  const updateFade = () => {
    const overflow = modes.scrollWidth > modes.clientWidth + 1;
    modes.classList.toggle('fade-end', overflow && modes.scrollLeft + modes.clientWidth < modes.scrollWidth - 4);
    modes.classList.toggle('fade-start', overflow && modes.scrollLeft > 4);
  };
  modes.addEventListener('scroll', updateFade, { passive: true });
  window.addEventListener('resize', updateFade);
  requestAnimationFrame(updateFade);
}

function showHint() {
  const touch = matchMedia('(pointer: coarse)').matches;
  const hint = $('#hint');
  hint.textContent = touch ? 'Drag to move · pinch to zoom · tap a line' : 'Drag to move · scroll to zoom · click a line';
  hint.classList.remove('hidden');
  const hide = () => hint.classList.add('fade');
  setTimeout(hide, 5000);
  canvas.addEventListener('pointerdown', hide, { once: true });
}

function renderLegend() {
  const el = $('#legend');
  const mode = currentMode();
  el.classList.remove('hidden');
  if (mode.kind === 'glow') {
    const c = GLOW[state.theme];
    const end = state.theme === 'dark' ? '#fff3d6' : '#5a1400';
    el.innerHTML = `
      <div class="legend-title">Glow</div>
      <div class="legend-bar" style="background:linear-gradient(90deg,rgba(${c},.35),rgb(${c}),${end})"></div>
      <div class="legend-ends"><span>one run</span><span>many runs overlap</span></div>`;
    return;
  }
  if (!state.scale) {
    el.classList.add('hidden');
    return;
  }
  const ramp = RAMPS[state.theme].value;
  const { lo, hi } = state.scale;
  const missing = state.visible.filter((r) => mode.value(r) == null).length;
  el.innerHTML = `
    <div class="legend-title">${mode.title}</div>
    <div class="legend-bar" style="background:linear-gradient(90deg,${ramp.join(',')})"></div>
    <div class="legend-ticks"><span>${mode.tick(lo)}</span><span>${mode.tick((lo + hi) / 2)}</span><span>${mode.tick(hi)}</span></div>
    <div class="legend-ends"><span>${mode.low}</span><span>${mode.high}</span></div>
    ${missing ? `<div class="legend-missing"><i style="background:${RAMPS[state.theme].none}"></i>${missing} without data</div>` : ''}`;
}

// ---------------------------------------------------------------------------
// View: fit, pan, zoom
// ---------------------------------------------------------------------------

function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  if (typeof dotsCanvas !== 'undefined') {
    dotsCanvas.width = canvas.width;
    dotsCanvas.height = canvas.height;
  }
}

// Free space for the drawing, between the floating panels.
function stageBox() {
  const narrow = innerWidth <= 760;
  const top = narrow ? 128 : 112;
  const bottom = narrow ? 120 : 40;
  return { x: 0, y: top, w: innerWidth, h: Math.max(100, innerHeight - top - bottom) };
}

// Centre the start point; size so 95% of runs fit entirely.
function fitView() {
  const box = stageBox();
  const radii = state.visible.map((r) => r.maxR).sort((a, b) => a - b);
  const r95 = radii.length ? radii[Math.floor((radii.length - 1) * 0.95)] : 1000;
  const s = (Math.min(box.w, box.h) / 2 - 16) / Math.max(r95, 300);
  state.view = { s, ox: box.x + box.w / 2, oy: box.y + box.h / 2 };
}

function zoomAt(px, py, factor) {
  const v = state.view;
  const s = Math.min(Math.max(v.s * factor, 0.002), 3);
  const k = s / v.s;
  state.view = { s, ox: px - (px - v.ox) * k, oy: py - (py - v.oy) * k };
  quickRender();
}

function bindGestures() {
  const pointers = new Map();
  let start = null;
  let moved = false;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    start = { x: e.clientX, y: e.clientY, view: { ...state.view }, pinch: pinchInfo(pointers) };
    moved = false;
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && !start.pinch) {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 4) moved = true;
      if (!moved) return;
      state.view = { ...start.view, ox: start.view.ox + dx, oy: start.view.oy + dy };
      quickRender();
    } else if (pointers.size === 2) {
      moved = true;
      const now = pinchInfo(pointers);
      if (!start.pinch) start = { ...start, view: { ...state.view }, pinch: now };
      const k = now.d / start.pinch.d;
      const s = Math.min(Math.max(start.view.s * k, 0.002), 3);
      const kk = s / start.view.s;
      state.view = {
        s,
        ox: now.x - (start.pinch.x - start.view.ox) * kk,
        oy: now.y - (start.pinch.y - start.view.oy) * kk,
      };
      quickRender();
    }
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!moved && pointers.size === 0 && e.type === 'pointerup') select(hitTest(e.clientX, e.clientY));
    if (pointers.size === 1) {
      const [p] = pointers.values();
      start = { x: p.x, y: p.y, view: { ...state.view }, pinch: null };
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => zoomAt(e.clientX, e.clientY, 2));

  canvas.addEventListener('pointermove', (e) => {
    if (pointers.size || e.pointerType !== 'mouse') return;
    canvas.style.cursor = hitTest(e.clientX, e.clientY) ? 'pointer' : 'grab';
  });
}

function pinchInfo(pointers) {
  if (pointers.size < 2) return null;
  const [a, b] = [...pointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// While dragging, move/scale a snapshot of the last frame (instant), then do
// a full-quality render once the gesture pauses.
function quickRender() {
  if (state.replay) stopReplay();
  if (cache && cacheView) {
    const v = state.view;
    const k = v.s / cacheView.s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG[state.theme];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (v.ox - cacheView.ox * k), dpr * (v.oy - cacheView.oy * k));
    ctx.drawImage(cache, 0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(render, cache ? 120 : 0);
}

function render() {
  clearTimeout(redrawTimer);
  const t = state.theme;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = BG[t];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  drawRings();
  const dim = state.selected ? 0.22 : 1;
  drawRuns(orderedRuns(), { alpha: dim });
  if (state.selected) drawSelected(state.selected);
  drawRingLabels();
  drawStartDot();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  snapshot();
}

function snapshot() {
  if (!cache) cache = document.createElement('canvas');
  cache.width = canvas.width;
  cache.height = canvas.height;
  cache.getContext('2d').drawImage(canvas, 0, 0);
  cacheView = { ...state.view };
}

function orderedRuns() {
  const mode = currentMode();
  if (!mode.value) return state.visible; // oldest first, newest on top
  return state.visible.slice().sort((a, b) => {
    const va = mode.value(a);
    const vb = mode.value(b);
    if (va == null) return -1;
    if (vb == null) return 1;
    return va - vb;
  });
}

function lineStyle() {
  const mode = currentMode();
  const n = Math.max(1, state.visible.length);
  const zoomBoost = Math.min(2.2, Math.max(1, Math.sqrt(state.view.s / 0.05)));
  if (mode.kind === 'glow') {
    return {
      glow: true,
      width: 1.3 * zoomBoost,
      alpha: Math.min(0.55, Math.max(0.07, 3.2 / Math.sqrt(n))),
      composite: state.theme === 'dark' ? 'lighter' : 'multiply',
    };
  }
  return { glow: false, width: 1.4 * zoomBoost, alpha: 0.75, composite: 'source-over' };
}

function drawRuns(runs, { alpha = 1 } = {}) {
  const st = lineStyle();
  const mode = currentMode();
  const ramp = RAMPS[state.theme];
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = st.width;
  ctx.globalCompositeOperation = st.composite;
  if (st.glow) ctx.strokeStyle = `rgba(${GLOW[state.theme]},${st.alpha * alpha})`;
  ctx.globalAlpha = st.glow ? 1 : st.alpha * alpha;
  const view = viewRect();
  for (const r of runs) {
    if (!intersects(r.bbox, view)) continue;
    if (!st.glow) {
      const v = mode.value(r);
      ctx.strokeStyle = v == null || !state.scale ? ramp.none : rampColor(ramp.value, scaleT(v));
    }
    tracePath(r);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function tracePath(r) {
  const { s, ox, oy } = state.view;
  const p = r.pts;
  ctx.beginPath();
  ctx.moveTo(ox + p[0] * s, oy - p[1] * s);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(ox + p[i] * s, oy - p[i + 1] * s);
}

function scaleT(v) {
  const { lo, hi } = state.scale;
  return hi === lo ? 1 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
}

// World-space rectangle currently on screen (metres), for culling.
function viewRect() {
  const { s, ox, oy } = state.view;
  return [(0 - ox) / s, (oy - innerHeight) / s, (innerWidth - ox) / s, oy / s];
}
function intersects(b, v) {
  return !(b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3]);
}

// Ring look per theme: light mode needs much stronger ink to read on paper.
const RINGS = {
  light: { ring: 0.16, strong: 0.3, label: 0.78 },
  dark: { ring: 0.09, strong: 0.18, label: 0.6 },
};

function ringSteps() {
  const { s, ox, oy } = state.view;
  // pick a ring spacing that gives ~4-7 rings across the screen
  const maxR = Math.hypot(Math.max(ox, innerWidth - ox), Math.max(oy, innerHeight - oy)) / s;
  const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
  const step = steps.find((st) => maxR / st <= 7) || steps[steps.length - 1];
  return { step, maxR };
}

function drawRings() {
  const { s, ox, oy } = state.view;
  const ink = INK[state.theme];
  const look = RINGS[state.theme];
  const { step, maxR } = ringSteps();
  ctx.lineWidth = 1;
  for (let r = step, i = 1; r <= maxR; r += step, i++) {
    ctx.strokeStyle = `rgba(${ink},${i % 5 === 0 ? look.strong : look.ring})`;
    ctx.beginPath();
    ctx.arc(ox, oy, r * s, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Distance labels go on top of the runs, with a halo in the background
// colour so they stay readable over dense areas.
function drawRingLabels() {
  const { s, ox, oy } = state.view;
  const ink = INK[state.theme];
  const look = RINGS[state.theme];
  const { step, maxR } = ringSteps();
  ctx.font = '650 11.5px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const top = stageBox().y - 8;
  for (let r = step; r <= maxR; r += step) {
    if (r * s <= 28) continue;
    const label = r >= 1000 ? `${r / 1000} km` : `${r} m`;
    const a = -Math.PI / 4;
    const lx = ox + Math.cos(a) * r * s + 5;
    const ly = oy + Math.sin(a) * r * s - 3;
    if (lx + ctx.measureText(label).width > innerWidth - 6 || ly < top) continue; // would be clipped
    ctx.strokeStyle = BG[state.theme];
    ctx.lineWidth = 4;
    ctx.strokeText(label, lx, ly);
    ctx.fillStyle = `rgba(${ink},${look.label})`;
    ctx.fillText(label, lx, ly);
  }
}

function drawStartDot() {
  const { ox, oy } = state.view;
  ctx.fillStyle = BG[state.theme];
  ctx.beginPath();
  ctx.arc(ox, oy, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = `rgba(${INK[state.theme]},0.8)`;
  ctx.stroke();
}

function drawSelected(r) {
  const c = SEL[state.theme];
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  tracePath(r);
  ctx.strokeStyle = c.casing;
  ctx.lineWidth = 7;
  ctx.stroke();
  tracePath(r);
  ctx.strokeStyle = c.line;
  ctx.lineWidth = 3.5;
  ctx.stroke();
  // finish point
  const { s, ox, oy } = state.view;
  const n = r.pts.length;
  ctx.fillStyle = '#e5484d';
  ctx.strokeStyle = c.casing;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(ox + r.pts[n - 2] * s, oy - r.pts[n - 1] * s, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Picking a run
// ---------------------------------------------------------------------------

function hitTest(px, py) {
  if (!state.visible.length) return null;
  const { s, ox, oy } = state.view;
  const wx = (px - ox) / s;
  const wy = (oy - py) / s;
  const tol = 7 / s; // 7 px in metres
  let best = null;
  let bestD = tol;
  // newest / top-most first, so the visible line wins ties
  const runs = orderedRuns();
  for (let k = runs.length - 1; k >= 0; k--) {
    const r = runs[k];
    const b = r.bbox;
    if (wx < b[0] - tol || wx > b[2] + tol || wy < b[1] - tol || wy > b[3] + tol) continue;
    const p = r.pts;
    for (let i = 2; i < p.length; i += 2) {
      const d = segDist(wx, wy, p[i - 2], p[i - 1], p[i], p[i + 1]);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
  }
  // Near the start point every run overlaps; don't pick a random one there.
  if (best && Math.hypot(wx, wy) * s < 14) return null;
  return best;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function select(run) {
  state.selected = run;
  const card = $('#run-card');
  if (!run) {
    card.classList.add('hidden');
    render();
    return;
  }
  card.classList.remove('hidden');
  $('#run-card-title').textContent = run.name;
  const d = new Date(run.date.replace('Z', ''));
  $('#run-card-date').textContent = `${d.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })} · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const rows = [
    ['Distance', formatKm(run.distance)],
    ['Pace', formatPace(run.averageSpeed)],
    ['Moving time', formatDuration(run.movingTime, true)],
    ['Elevation', `${Math.round(run.elevationGain || 0)} m`],
    ['Furthest from start', formatKm(run.maxR)],
  ];
  if (run.averageHeartrate) rows.push(['Avg heart rate', `${Math.round(run.averageHeartrate)} bpm`]);
  $('#run-card-stats').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('#run-card-map').href = `/?run=${encodeURIComponent(run.id)}`;
  render();
}

// ---------------------------------------------------------------------------
// Replay: a glowing dot runs each route out from the start, in date order.
// Several runs are in flight at once; each dot moves at a speed that makes
// longer runs take longer, and leaves its line behind on the canvas.
// ---------------------------------------------------------------------------

const REPLAY_SPEEDS = [1, 2, 4];
const MS_PER_KM = 150; // at 1x: a 10 km run takes 1.5 s to draw
const dotsCanvas = $('#dots');
const dctx = dotsCanvas.getContext('2d');

function startReplay() {
  if (!state.visible.length) return;
  select(null);
  const runs = state.visible.slice(); // already oldest -> newest
  const launchSpan = Math.min(18000, Math.max(4000, runs.length * 30));
  const mode = currentMode();
  const ramp = RAMPS[state.theme];
  const items = runs.map((r, i) => {
    const v = mode.value ? mode.value(r) : null;
    const color = mode.value
      ? v == null || !state.scale ? ramp.none : rampColor(ramp.value, scaleT(v))
      : `rgb(${GLOW[state.theme]})`;
    return {
      r,
      color,
      t0: runs.length === 1 ? 0 : (i / (runs.length - 1)) * launchSpan,
      dur: Math.min(4500, Math.max(700, (r.distance / 1000) * MS_PER_KM)),
      k: 0, // index of the last route vertex already drawn
      x: 0, // last drawn point (metres)
      y: 0,
      doneAt: null,
    };
  });

  // start from the empty rings
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG[state.theme];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawRings();

  $('#replay').classList.add('playing');
  $('#replay span').textContent = 'Stop';
  const label = $('#replay-date');
  label.classList.remove('hidden');

  const rp = { items, elapsed: 0, last: performance.now(), launched: 0, raf: 0 };
  state.replay = rp;

  const tick = (now) => {
    if (state.replay !== rp) return;
    const speed = REPLAY_SPEEDS[state.replaySpeed || 0];
    rp.elapsed += Math.min(100, now - rp.last) * speed; // clamp: tab in background
    rp.last = now;
    const t = rp.elapsed;

    const st = lineStyle();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt'; // pieces meet cleanly between frames
    ctx.lineWidth = st.width;
    ctx.globalCompositeOperation = st.composite;
    ctx.globalAlpha = st.glow ? 1 : st.alpha;

    let active = 0;
    let newest = null;
    for (const it of items) {
      if (t < it.t0) break; // items are in launch order
      newest = it;
      if (it.doneAt !== null) continue;
      active++;
      const f = Math.min(1, (t - it.t0) / it.dur);
      advance(it, f, st);
      if (f >= 1) it.doneAt = t;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    drawDots(items, t);

    if (newest) {
      const idx = items.indexOf(newest) + 1;
      if (idx !== rp.launched) {
        rp.launched = idx;
        label.innerHTML = `<b>${new Date(newest.r.date.replace('Z', '')).toLocaleDateString(undefined, {
          month: 'long', year: 'numeric',
        })}</b><span>${idx.toLocaleString()} of ${items.length.toLocaleString()} runs</span>`;
      }
    }

    const allLaunched = rp.launched === items.length;
    const fading = items.some((it) => it.doneAt !== null && t - it.doneAt < 400);
    if (!allLaunched || active || fading) rp.raf = requestAnimationFrame(tick);
    else {
      state.replay = null;
      finishReplay(true);
    }
  };
  rp.raf = requestAnimationFrame(tick);
}

// Draw a run from where it got to last frame up to fraction f of its length.
function advance(it, f, st) {
  const r = it.r;
  const p = r.pts;
  const cum = r.cum;
  const total = cum[cum.length - 1];
  const target = f * total;
  const { s, ox, oy } = state.view;

  let k = it.k;
  ctx.beginPath();
  ctx.moveTo(ox + it.x * s, oy - it.y * s);
  while (k + 1 < cum.length && cum[k + 1] <= target) {
    k++;
    ctx.lineTo(ox + p[k * 2] * s, oy - p[k * 2 + 1] * s);
  }
  let x = p[k * 2];
  let y = p[k * 2 + 1];
  if (k + 1 < cum.length) {
    const seg = cum[k + 1] - cum[k];
    const u = seg > 0 ? (target - cum[k]) / seg : 0;
    x += (p[k * 2 + 2] - x) * u;
    y += (p[k * 2 + 3] - y) * u;
  }
  ctx.lineTo(ox + x * s, oy - y * s);
  ctx.strokeStyle = st.glow ? `rgba(${GLOW[state.theme]},${Math.min(1, st.alpha * 1.6)})` : it.color;
  ctx.stroke();
  it.k = k;
  it.x = x;
  it.y = y;
}

// The moving heads: a soft halo plus a bright core, on a separate canvas
// that's cleared every frame.
function drawDots(items, t) {
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.clearRect(0, 0, dotsCanvas.width, dotsCanvas.height);
  dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { s, ox, oy } = state.view;
  const dark = state.theme === 'dark';
  for (const it of items) {
    if (t < it.t0) break;
    let a = 1;
    if (it.doneAt !== null) {
      a = 1 - (t - it.doneAt) / 400;
      if (a <= 0) continue;
    }
    const x = ox + it.x * s;
    const y = oy - it.y * s;
    const halo = dctx.createRadialGradient(x, y, 0, x, y, 9);
    halo.addColorStop(0, withAlpha(it.color, 0.55 * a));
    halo.addColorStop(1, withAlpha(it.color, 0));
    dctx.fillStyle = halo;
    dctx.beginPath();
    dctx.arc(x, y, 9, 0, Math.PI * 2);
    dctx.fill();
    dctx.globalAlpha = a;
    dctx.fillStyle = dark ? '#fffaf0' : it.color;
    dctx.beginPath();
    dctx.arc(x, y, dark ? 2.6 : 3.3, 0, Math.PI * 2);
    dctx.fill();
    if (!dark) {
      dctx.lineWidth = 1.2;
      dctx.strokeStyle = '#ffffff';
      dctx.stroke();
    }
    dctx.globalAlpha = 1;
  }
}

function withAlpha(color, a) {
  const m = color.match(/\d+(\.\d+)?/g);
  if (color.startsWith('#')) {
    const h = color.slice(1);
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }
  return `rgba(${m[0]},${m[1]},${m[2]},${a})`;
}

function stopReplay() {
  if (!state.replay) return;
  cancelAnimationFrame(state.replay.raf);
  state.replay = null;
  finishReplay(false);
}

function finishReplay(completed) {
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.clearRect(0, 0, dotsCanvas.width, dotsCanvas.height);
  $('#replay').classList.remove('playing');
  $('#replay span').textContent = 'Replay';
  const label = $('#replay-date');
  setTimeout(() => label.classList.add('hidden'), completed ? 1800 : 0);
  render();
}

function cycleSpeed() {
  state.replaySpeed = ((state.replaySpeed || 0) + 1) % REPLAY_SPEEDS.length;
  $('#speed').textContent = `${REPLAY_SPEEDS[state.replaySpeed]}×`;
  $('#speed').setAttribute('aria-label', `Replay speed ${REPLAY_SPEEDS[state.replaySpeed]} times`);
}

// ---------------------------------------------------------------------------
// Save as image
// ---------------------------------------------------------------------------

function saveImage() {
  stopReplay();
  render();
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const o = out.getContext('2d');
  o.drawImage(canvas, 0, 0);
  o.scale(dpr, dpr);
  const ink = INK[state.theme];
  const pad = 24;
  o.textBaseline = 'alphabetic';
  o.fillStyle = `rgba(${ink},0.92)`;
  o.font = '700 20px Inter, system-ui, sans-serif';
  o.fillText('All runs, one start', pad, innerHeight - pad - 22);
  o.fillStyle = `rgba(${ink},0.6)`;
  o.font = '500 13px Inter, system-ui, sans-serif';
  const modeLabel = currentMode().kind === 'glow' ? '' : ` · coloured by ${currentMode().title.toLowerCase()}`;
  o.fillText(`${state.caption}${modeLabel}`, pad, innerHeight - pad);
  out.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const r = picker.range;
    a.download = `runner-map-all-runs${picker.isAllTime() ? '' : `-${r.from}_to_${r.to}`}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}
