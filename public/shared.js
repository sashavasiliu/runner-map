/* Shared by the map (app.js) and the overlay view (overlay.js). */
/* exported RAMPS, MODES, computeScale, rampColor, buildLut, escapeHtml,
   formatKm, formatPace, formatDuration, formatDate, loadPref, savePref */

// Colour ramps, low -> high. Lightness changes steadily along each ramp, and
// the "high" end always has the most contrast with the map, so the runs that
// matter most in a mode (fastest, newest, longest...) stand out and are drawn
// on top.
const RAMPS = {
  light: {
    value: ['#f6b44a', '#ee7445', '#d0386a', '#8a2a9b', '#3a1878'],
    heat: ['#fdc25a', '#fd8d3c', '#f03b20', '#bd0026', '#6b0029'],
    route: '#fc4c02',
    none: '#9aa0a6',
    selected: '#1565d8',
    casing: '#ffffff',
  },
  dark: {
    value: ['#5b34a8', '#9a2fa0', '#e0446f', '#f88a4a', '#fde68a'],
    heat: ['#4a1d8c', '#a62a83', '#ef5a4f', '#fcaa4a', '#fff4c4'],
    route: '#ff7034',
    none: '#7d838a',
    selected: '#4cc3ff',
    casing: '#0a0a0a',
  },
};

// Map modes. `value` returns the number a run is coloured by (null = no data).
const MODES = [
  { id: 'routes', label: 'Routes', kind: 'single' },
  { id: 'heat', label: 'Heatmap', kind: 'heat' },
  {
    id: 'pace', label: 'Pace', title: 'Average pace',
    value: (r) => r.averageSpeed || null,
    tick: (v) => formatPace(v), low: 'slower', high: 'faster',
  },
  {
    id: 'recency', label: 'Recency', title: 'Date',
    value: (r) => Date.parse(r.date),
    tick: (v) => new Date(v).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }),
    low: 'older', high: 'newer', noClip: true,
  },
  {
    id: 'distance', label: 'Distance', title: 'Distance',
    value: (r) => r.distance || null,
    tick: (v) => `${(v / 1000).toFixed(v < 10000 ? 1 : 0)} km`, low: 'shorter', high: 'longer',
  },
  {
    id: 'elevation', label: 'Climb', title: 'Elevation gain',
    value: (r) => (r.elevationGain != null ? r.elevationGain : null),
    tick: (v) => `${Math.round(v)} m`, low: 'flatter', high: 'hillier',
  },
  {
    id: 'heartrate', label: 'Heart rate', title: 'Average heart rate',
    value: (r) => r.averageHeartrate || null,
    tick: (v) => `${Math.round(v)} bpm`, low: 'easier', high: 'harder',
  },
];

// Colour scale domain: 5th-95th percentile, so one ultra or one stroll
// doesn't squash everyone else into the same colour.
function computeScale(mode, runs) {
  const vals = runs.map(mode.value).filter((v) => v != null).sort((a, b) => a - b);
  if (!vals.length) return null;
  if (mode.noClip) return { lo: vals[0], hi: vals[vals.length - 1] };
  const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
  return { lo: q(0.05), hi: q(0.95) };
}

// 256-entry RGB lookup table interpolated through the ramp's stops.
function buildLut(stops) {
  const rgb = stops.map(hexToRgb);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = interpolate(rgb, i / 255);
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function interpolate(rgbStops, t) {
  const n = rgbStops.length - 1;
  const x = Math.max(0, Math.min(1, t)) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  const a = rgbStops[i];
  const b = rgbStops[i + 1];
  return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * f));
}

function rampColor(stops, t) {
  const [r, g, b] = interpolate(stops.map(hexToRgb), t);
  return `rgb(${r},${g},${b})`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatKm(m) {
  return `${(m / 1000).toFixed(2)} km`;
}

function formatPace(mps) {
  if (!mps) return '–';
  const secPerKm = Math.round(1000 / mps);
  return `${Math.floor(secPerKm / 60)}:${String(secPerKm % 60).padStart(2, '0')} /km`;
}

function formatDuration(s, long = false) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (long) return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function formatDate(iso) {
  // start_date_local is already local time; drop the trailing Z so it isn't shifted
  return new Date(iso.replace('Z', '')).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function loadPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode etc. */ }
}
