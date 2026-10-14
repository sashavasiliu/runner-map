/* global L, decodePolyline, HeatLayer, DateRangePicker, RAMPS, MODES, computeScale, rampColor, escapeHtml,
   formatKm, formatPace, formatDuration, formatDate */

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Look & feel
// ---------------------------------------------------------------------------

// Basemap: standard OpenStreetMap tiles (free, no API key). They're very
// colourful, so styles.css mutes them for the light theme and inverts them
// for the dark theme, which keeps the routes the most colourful thing on screen.
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const ERROR_MESSAGES = {
  access_denied: 'You cancelled the Strava sign-in.',
  invalid_state: 'Sign-in expired or was tampered with. Please try again.',
  missing_activity_scope:
    'Runner Map needs permission to read your activities. Please tick the activity box on Strava.',
  token_exchange_failed: 'Strava sign-in failed. Check your client ID and secret in .env.',
  session: 'Could not start a session. Please try again.',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  athlete: null,
  runs: [], // all runs, newest first, each with decoded `latlngs`
  visible: [], // after the date filter
  mode: load('rm.mode', 'routes'),
  theme: document.documentElement.dataset.theme || 'light',
  selectedId: null,
  scale: null, // { lo, hi } for the current value mode
  extent: 'main', // 'main' (home area) or 'all'
};

let picker;
let map, tileLayer, routeLayer, heatLayer, selectedLayer, placeLayer;
const lineById = new Map();

function load(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode etc. */ }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

init();

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.has('error')) {
    showLogin(ERROR_MESSAGES[params.get('error')] || `Sign-in error: ${params.get('error')}`);
    history.replaceState(null, '', '/');
    return;
  }

  let resp;
  try {
    resp = await fetch('/api/me');
  } catch {
    return showLogin('Cannot reach the Runner Map server. Is it running?');
  }
  if (resp.status === 401) return showLogin();
  state.athlete = await resp.json();
  showApp();
  await loadRuns(false);
}

function showLogin(message) {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
  if (message) {
    $('#login-error').textContent = message;
    $('#login-error').classList.remove('hidden');
  }
}

function showApp() {
  const a = state.athlete;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');

  $('#athlete-name').textContent = [a.firstname, a.lastname].filter(Boolean).join(' ') || 'You';
  if (a.profile && a.profile.startsWith('http')) $('#athlete-avatar').src = a.profile;
  else $('#athlete-avatar').classList.add('hidden');
  $('#demo-badge').classList.toggle('hidden', !a.demo);
  $('#refresh').classList.toggle('hidden', !!a.demo);

  map = L.map('map', { zoomControl: false, preferCanvas: true, worldCopyJump: true })
    .setView([45.94, 24.97], 6);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.createPane('selected').style.zIndex = 450;
  routeLayer = L.layerGroup().addTo(map);
  selectedLayer = L.layerGroup().addTo(map);
  placeLayer = L.layerGroup();
  applyTheme(state.theme);
  map.on('click', () => selectRun(null));
  map.on('zoomend', updatePlaceVisibility);

  buildModeButtons();

  $('#logout').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    location.href = '/';
  });
  $('#refresh').addEventListener('click', () => loadRuns(true));
  picker = new DateRangePicker($('#date-btn'), { onChange: () => applyFilter({ refit: true }) });
  $('#theme-toggle').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    save('rm.theme', state.theme);
  });
  $('#run-card-close').addEventListener('click', () => selectRun(null));
  $('#extent-chip').addEventListener('click', () => {
    state.extent = state.extent === 'main' ? 'all' : 'main';
    fitToRuns(true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') selectRun(null);
  });
  $('#run-list').addEventListener('keydown', onListKey);

  // Hint that the mode bar scrolls sideways when it doesn't fit (phones).
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

async function loadRuns(forceRefresh) {
  setStatus(forceRefresh ? 'Refreshing from Strava…' : '');
  $('#map-loading').classList.remove('hidden');
  $('#refresh').disabled = true;
  try {
    const resp = await fetch(`/api/runs${forceRefresh ? '?refresh=1' : ''}`);
    if (resp.status === 401) return showLogin('Your Strava session expired. Please sign in again.');
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || data.error || 'Something went wrong.');

    state.runs = data.runs
      .map((r) => ({ ...r, latlngs: r.polyline ? decodePolyline(r.polyline) : null }))
      .sort((a, b) => b.date.localeCompare(a.date));
    picker.setRunDates(state.runs.map((r) => r.date));
    const wanted = Number(new URLSearchParams(location.search).get('run'));
    const wantedRun = wanted && state.runs.find((r) => r.id === wanted);
    if (wantedRun && !picker.includes(wantedRun.date)) {
      picker.setRange({ preset: 'all' }, { silent: true }); // make sure the requested run is visible
    }
    applyFilter({ refit: true });
    if (wanted && state.runs.some((r) => r.id === wanted)) {
      history.replaceState(null, '', '/');
      selectRun(wanted, { from: 'list' });
    }
    setStatus(
      state.athlete.demo
        ? 'Showing generated demo runs.'
        : `Updated ${new Date(data.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    );
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    $('#refresh').disabled = false;
    $('#map-loading').classList.add('hidden');
  }
}

function applyFilter({ refit }) {
  state.visible = picker.isAllTime() ? state.runs : state.runs.filter((r) => picker.includes(r.date));
  if (state.selectedId && !state.visible.some((r) => r.id === state.selectedId)) selectRun(null);
  renderStats();
  renderModeButtons();
  drawMap();
  renderList();
  if (refit) {
    state.extent = 'main';
    fitToRuns(false);
  }
}

// ---------------------------------------------------------------------------
// Theme & modes
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  const toggle = $('#theme-toggle');
  const next = theme === 'dark' ? 'light' : 'dark';
  toggle.setAttribute('aria-label', `Switch to ${next} map`);
  toggle.title = `Switch to ${next} map`;

  // One tile layer for both themes; the dark look is a CSS filter (styles.css).
  if (!tileLayer) {
    tileLayer = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
    tileLayer.bringToBack();
  }

  if (state.runs.length) {
    drawMap();
    updateSwatches();
  }
}

function currentMode() {
  return MODES.find((m) => m.id === state.mode) || MODES[0];
}

function buildModeButtons() {
  const nav = $('#modes');
  nav.innerHTML = '';
  for (const m of MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = m.id;
    b.textContent = m.label;
    b.addEventListener('click', () => setMode(m.id));
    nav.appendChild(b);
  }
  const link = document.createElement('a');
  link.href = '/overlay.html';
  link.className = 'mode-link';
  link.title = 'All your runs drawn from one starting point, no map';
  link.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10"/></svg>One start';
  nav.appendChild(link);
}

// Disable modes with no data (e.g. heart rate when no run has it).
function renderModeButtons() {
  for (const b of $('#modes').querySelectorAll('button')) {
    const m = MODES.find((x) => x.id === b.dataset.mode);
    const available = !m.value || state.visible.some((r) => m.value(r) != null && r.latlngs);
    b.disabled = !available;
    b.title = available ? '' : `None of these runs have ${m.title.toLowerCase()} data`;
    b.setAttribute('aria-pressed', String(m.id === state.mode));
  }
  if (!currentMode().value) return;
  const btn = $(`#modes [data-mode="${state.mode}"]`);
  if (btn && btn.disabled) state.mode = 'routes';
  for (const b of $('#modes').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
}

function setMode(id) {
  if (id === state.mode) return;
  state.mode = id;
  save('rm.mode', id);
  renderModeButtons();
  drawMap(); // note: the map view stays where it is
  updateSwatches();
  $(`#modes [data-mode="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function colorFor(run) {
  const mode = currentMode();
  const ramp = RAMPS[state.theme];
  if (!mode.value) return ramp.route;
  const v = mode.value(run);
  if (v == null || !state.scale) return ramp.none;
  return rampColor(ramp.value, scaleT(v));
}

function scaleT(v) {
  const { lo, hi } = state.scale;
  return hi === lo ? 1 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
}

function drawMap() {
  const mode = currentMode();
  const ramp = RAMPS[state.theme];
  const withRoute = state.visible.filter((r) => r.latlngs && r.latlngs.length > 1);

  routeLayer.clearLayers();
  lineById.clear();
  state.scale = mode.value ? computeScale(mode, withRoute) : null;

  if (mode.kind === 'heat') {
    if (!heatLayer) heatLayer = new HeatLayer();
    heatLayer.setRamp(ramp.heat, state.theme === 'dark' ? 0.3 : 0.45);
    heatLayer.setRoutes(withRoute.map((r) => (r._heat ||= HeatLayer.prepare(r.latlngs))));
    if (!map.hasLayer(heatLayer)) heatLayer.addTo(map);
  } else {
    if (heatLayer && map.hasLayer(heatLayer)) heatLayer.remove();

    // Draw order: runs without data first, then low -> high, so the
    // highlighted end of the scale sits on top.
    const order = withRoute.slice();
    if (mode.value) {
      order.sort((a, b) => {
        const va = mode.value(a);
        const vb = mode.value(b);
        if (va == null) return -1;
        if (vb == null) return 1;
        return va - vb;
      });
    } else {
      order.reverse(); // oldest first, newest on top
    }

    const single = !mode.value;
    for (const run of order) {
      const v = mode.value ? mode.value(run) : null;
      const noData = !single && v == null;
      const style = {
        color: colorFor(run),
        weight: noData ? 1.5 : 2.5,
        opacity: single ? (state.theme === 'dark' ? 0.55 : 0.5) : noData ? 0.35 : 0.85,
      };
      run._style = style;
      const line = lineFor(run).setStyle(style);
      routeLayer.addLayer(line);
      lineById.set(run.id, line);
    }
  }

  drawPlaces(withRoute);
  renderLegend();
  if (state.selectedId) drawSelected();
}

// Group runs by where they start (~50 km cells). Used to find the "main"
// area and to label places when zoomed far out.
function placesOf(runs) {
  const cells = new Map();
  for (const r of runs) {
    const [lat, lng] = r.latlngs[0];
    const key = `${Math.round(lat * 2)}:${Math.round(lng * 2)}`;
    if (!cells.has(key)) cells.set(key, { runs: [], lat: 0, lng: 0 });
    const c = cells.get(key);
    c.runs.push(r);
    c.lat += lat;
    c.lng += lng;
  }
  return [...cells.values()]
    .map((c) => ({ runs: c.runs, center: [c.lat / c.runs.length, c.lng / c.runs.length] }))
    .sort((a, b) => b.runs.length - a.runs.length);
}

// When zoomed out to country level, routes shrink to specks, so show one
// labelled pin per place instead. Clicking a pin zooms to it.
function drawPlaces(withRoute) {
  placeLayer.clearLayers();
  for (const p of placesOf(withRoute)) {
    const n = p.runs.length;
    const icon = L.divIcon({
      className: 'place-pin-wrap',
      html: `<div class="place-pin"><b>${n}</b> run${n === 1 ? '' : 's'}</div>`,
      iconSize: null,
    });
    L.marker(p.center, { icon, keyboard: true, title: `Zoom to ${n} run${n === 1 ? '' : 's'}` })
      .on('click', () => {
        const b = L.latLngBounds([]);
        for (const r of p.runs) b.extend(boundsOf(r));
        map.flyToBounds(b, { padding: [60, 60], maxZoom: 15, duration: 0.8 });
      })
      .addTo(placeLayer);
  }
  updatePlaceVisibility();
}

function updatePlaceVisibility() {
  if (!placeLayer) return;
  const show = map.getZoom() <= 9 && placeLayer.getLayers().length > 0;
  if (show && !map.hasLayer(placeLayer)) placeLayer.addTo(map);
  if (!show && map.hasLayer(placeLayer)) placeLayer.remove();
}

function boundsOf(run) {
  return (run._bounds ||= L.latLngBounds(run.latlngs));
}

// One Leaflet polyline per run, created once and restyled on mode changes.
function lineFor(run) {
  if (!run._line) {
    run._line = L.polyline(run.latlngs, { interactive: true, bubblingMouseEvents: false })
      .bindTooltip(() => tooltipHtml(run), { sticky: true, direction: 'top', offset: [0, -8], className: 'run-tip' })
      .on('click', () => selectRun(run.id, { from: 'map' }))
      .on('mouseover', function () { this.setStyle({ weight: run._style.weight + 2.5, opacity: 1 }); })
      .on('mouseout', function () { this.setStyle(run._style); });
  }
  return run._line;
}

function drawSelected() {
  selectedLayer.clearLayers();
  const run = state.runs.find((r) => r.id === state.selectedId);
  if (!run || !run.latlngs) return;
  const ramp = RAMPS[state.theme];
  const opts = { pane: 'selected', interactive: false };
  L.polyline(run.latlngs, { ...opts, color: ramp.casing, weight: 8, opacity: 0.9 }).addTo(selectedLayer);
  L.polyline(run.latlngs, { ...opts, color: ramp.selected, weight: 4.5, opacity: 1 }).addTo(selectedLayer);
  const start = run.latlngs[0];
  const end = run.latlngs[run.latlngs.length - 1];
  L.circleMarker(end, { ...opts, radius: 6, color: ramp.casing, weight: 2, fillColor: '#e5484d', fillOpacity: 1 }).addTo(selectedLayer);
  L.circleMarker(start, { ...opts, radius: 6, color: ramp.casing, weight: 2, fillColor: '#2fb344', fillOpacity: 1 }).addTo(selectedLayer);
}

function renderLegend() {
  const el = $('#legend');
  const mode = currentMode();
  const ramp = RAMPS[state.theme];
  const withRoute = state.visible.filter((r) => r.latlngs);

  if (mode.kind === 'single' || !withRoute.length) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');

  if (mode.kind === 'heat') {
    el.innerHTML = `
      <div class="legend-title">How often you ran there</div>
      <div class="legend-bar" style="background:linear-gradient(90deg,${ramp.heat.join(',')})"></div>
      <div class="legend-ends"><span>once</span><span>all the time</span></div>`;
    return;
  }

  const { lo, hi } = state.scale || {};
  const missing = withRoute.filter((r) => mode.value(r) == null).length;
  el.innerHTML = `
    <div class="legend-title">${mode.title}</div>
    <div class="legend-bar" style="background:linear-gradient(90deg,${ramp.value.join(',')})"></div>
    <div class="legend-ticks"><span>${mode.tick(lo)}</span><span>${mode.tick((lo + hi) / 2)}</span><span>${mode.tick(hi)}</span></div>
    <div class="legend-ends"><span>${mode.low}</span><span>${mode.high}</span></div>
    ${missing ? `<div class="legend-missing"><i style="background:${ramp.none}"></i>${missing} run${missing === 1 ? '' : 's'} without data</div>` : ''}`;
}

function tooltipHtml(run) {
  const mode = currentMode();
  const v = mode.value ? mode.value(run) : null;
  const shown = ['recency', 'distance']; // already in the tooltip
  const extra = mode.value && !shown.includes(mode.id) ? ` · ${v == null ? 'no data' : mode.tick(v)}` : '';
  return `<strong>${escapeHtml(run.name)}</strong><br>${formatDate(run.date)} · ${formatKm(run.distance)}${extra}`;
}

// Fit the map to the "main" area (where most runs start) rather than every
// run ever, so one holiday run abroad doesn't zoom the map out to a continent.
function fitToRuns(animate) {
  const withRoute = state.visible.filter((r) => r.latlngs);
  const chip = $('#extent-chip');
  if (!withRoute.length) {
    chip.classList.add('hidden');
    return;
  }

  const near = placesOf(withRoute)[0].runs;
  const elsewhere = withRoute.length - near.length;

  const target = state.extent === 'all' || !elsewhere ? withRoute : near;
  const bounds = L.latLngBounds([]);
  for (const r of target) bounds.extend(boundsOf(r));
  const sidePad = window.innerWidth > 760 ? 60 : 24;
  map.fitBounds(bounds, { padding: [sidePad, sidePad], paddingTopLeft: [sidePad, 64], animate, maxZoom: 16 });

  if (!elsewhere) {
    chip.classList.add('hidden');
  } else {
    chip.classList.remove('hidden');
    chip.textContent =
      state.extent === 'all'
        ? 'Back to your main area'
        : `+ ${elsewhere} run${elsewhere === 1 ? '' : 's'} in other places · Show all`;
  }
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function renderStats() {
  const list = state.visible;
  const sum = (key) => list.reduce((acc, r) => acc + (r[key] || 0), 0);
  const n = (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  $('#stat-count').textContent = n(list.length);
  $('#stat-distance').textContent = n(sum('distance') / 1000);
  $('#stat-time').textContent = n(sum('movingTime') / 3600);
  $('#stat-elev').textContent = n(sum('elevationGain'));
}

// The list is rendered in chunks as you scroll, so thousands of runs stay snappy.
const LIST_CHUNK = 150;
let listRendered = 0;
let listObserver = null;

function renderList() {
  const ul = $('#run-list');
  ul.innerHTML = '';
  listRendered = 0;
  if (!state.visible.length) {
    ul.innerHTML = '<li class="empty">No runs here yet.</li>';
    return;
  }
  appendListItems(LIST_CHUNK);
}

function appendListItems(count) {
  const ul = $('#run-list');
  ul.querySelector('.sentinel')?.remove();
  const frag = document.createDocumentFragment();
  const end = Math.min(state.visible.length, listRendered + count);
  for (let i = listRendered; i < end; i++) frag.appendChild(listItem(state.visible[i]));
  listRendered = end;
  if (listRendered < state.visible.length) {
    const sentinel = document.createElement('li');
    sentinel.className = 'sentinel';
    sentinel.setAttribute('aria-hidden', 'true');
    frag.appendChild(sentinel);
    listObserver ||= new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) appendListItems(LIST_CHUNK);
    }, { rootMargin: '400px' });
    listObserver.disconnect();
    listObserver.observe(sentinel);
  }
  ul.appendChild(frag);
}

// Make sure a run's row exists (e.g. when it's picked on the map).
function listItemFor(id) {
  const idx = state.visible.findIndex((r) => r.id === id);
  if (idx >= listRendered) appendListItems(idx - listRendered + LIST_CHUNK);
  return document.querySelector(`#run-list li[data-id="${id}"]`);
}

function listItem(run) {
  const li = document.createElement('li');
  li.dataset.id = run.id;
  li.tabIndex = 0;
  li.className = run.id === state.selectedId ? 'selected' : '';
  li.innerHTML = `
    <div class="run-name"><i class="swatch"></i><span></span>${run.latlngs ? '' : '<em>no GPS</em>'}</div>
    <div class="run-meta">
      <span>${formatDate(run.date)}</span>
      <span>${formatKm(run.distance)}</span>
      <span>${formatPace(run.averageSpeed)}</span>
      <span>${formatDuration(run.movingTime)}</span>
    </div>`;
  li.querySelector('.run-name span').textContent = run.name; // user text: never innerHTML
  paintSwatch(li.querySelector('.swatch'), run);
  li.addEventListener('click', () => selectRun(run.id, { from: 'list' }));
  return li;
}

function paintSwatch(el, run) {
  const show = currentMode().value && run.latlngs;
  el.style.display = show ? '' : 'none';
  if (show) el.style.background = colorFor(run);
}

function updateSwatches() {
  const byId = new Map(state.visible.map((r) => [String(r.id), r]));
  for (const li of document.querySelectorAll('#run-list li[data-id]')) {
    paintSwatch(li.querySelector('.swatch'), byId.get(li.dataset.id));
  }
}

function onListKey(e) {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    selectRun(Number(li.dataset.id), { from: 'list' });
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (e.key === 'ArrowDown' && li.nextElementSibling?.classList.contains('sentinel')) appendListItems(LIST_CHUNK);
    const next = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
    if (next && next.dataset.id) {
      next.focus();
      selectRun(Number(next.dataset.id), { from: 'list' });
    }
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function selectRun(id, { from } = {}) {
  if (id === state.selectedId && from !== 'list') return;
  document.querySelector('#run-list li.selected')?.classList.remove('selected');
  state.selectedId = id;
  $('#map').classList.toggle('has-selection', id != null);
  selectedLayer.clearLayers();

  document.querySelector('.map-wrap').classList.toggle('card-open', id != null);
  if (id == null) {
    $('#run-card').classList.add('hidden');
    return;
  }
  const run = state.runs.find((r) => r.id === id);
  if (!run) return;

  drawSelected();
  showRunCard(run);

  const li = listItemFor(id);
  if (li) {
    li.classList.add('selected');
    li.scrollIntoView({ block: 'nearest', behavior: from === 'map' ? 'smooth' : 'auto' });
  }
  if (from === 'list' && run.latlngs) {
    const b = boundsOf(run);
    const narrow = window.innerWidth <= 760;
    map.flyToBounds(b, {
      paddingTopLeft: [40, 70],
      paddingBottomRight: narrow ? [30, 150] : [310, 40], // keep clear of the run card
      maxZoom: 15,
      duration: 0.6,
    });
  }
}

function showRunCard(run) {
  $('#run-card').classList.remove('hidden');
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
  ];
  if (run.averageHeartrate) rows.push(['Avg heart rate', `${Math.round(run.averageHeartrate)} bpm`]);
  if (!run.latlngs) rows.push(['GPS', 'not recorded']);
  $('#run-card-stats').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  const link = $('#run-card-link');
  link.classList.toggle('hidden', !!state.athlete.demo);
  link.href = `https://www.strava.com/activities/${run.id}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setStatus(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}
