// Generates realistic fake runs for demo mode, so the app can be tried (and
// developed) without a Strava account. Deterministic: the same seed always
// produces the same runs.
//
// What it simulates:
//  - a home area with a handful of favourite routes run again and again
//    (with GPS wobble), so the heatmap has real hot spots
//  - easy runs, tempo runs, intervals, long runs and races with matching pace
//  - fitness that improves over ~3 years
//  - a few trips (mountain trail runs, a city break) far from home
//  - treadmill runs with no GPS, and runs without heart-rate data

const HOME = { lat: 44.4705, lng: 26.0820, name: 'home' }; // Bucharest, Herastrau area
const TRIPS = [
  { lat: 45.6427, lng: 25.5887, name: 'mountains', trail: true }, // Brasov
  { lat: 53.2194, lng: 6.5665, name: 'city' }, // Groningen
];

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandom(seed) {
  const rand = mulberry32(seed);
  const api = {
    rand,
    range: (a, b) => a + (b - a) * rand(),
    int: (a, b) => Math.floor(a + (b - a + 1) * rand()),
    pick: (arr) => arr[Math.floor(rand() * arr.length)],
    gauss: () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = rand();
      while (v === 0) v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    weighted: (items) => {
      const total = items.reduce((s, i) => s + i.w, 0);
      let r = rand() * total;
      for (const i of items) if ((r -= i.w) <= 0) return i;
      return items[items.length - 1];
    },
  };
  return api;
}

// --- geometry (local metres <-> lat/lng) ------------------------------------

const M_PER_DEG = 111320;
function toLatLng(origin, x, y) {
  return [
    origin.lat + y / M_PER_DEG,
    origin.lng + x / (M_PER_DEG * Math.cos((origin.lat * Math.PI) / 180)),
  ];
}
function lengthOf(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return d;
}
// Resample a path of [x, y] metres to evenly spaced points.
function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    let t = step - carry;
    while (t <= seg) {
      out.push([x0 + ((x1 - x0) * t) / seg, y0 + ((y1 - y0) * t) / seg]);
      t += step;
    }
    carry = seg - (t - step);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// A street-grid walk: legs along a slightly rotated grid, like city blocks.
function gridWalk(R, start, targetLen, angle) {
  const dirs = [0, 1, 2, 3].map((k) => angle + (k * Math.PI) / 2);
  const pts = [start];
  let [x, y] = start;
  let dir = R.int(0, 3);
  let len = 0;
  while (len < targetLen) {
    const leg = Math.min(R.range(250, 900), targetLen - len);
    x += Math.cos(dirs[dir]) * leg;
    y += Math.sin(dirs[dir]) * leg;
    pts.push([x, y]);
    len += leg;
    const r = R.rand();
    if (r < 0.35) continue; // straight on through the junction
    dir = (dir + (r < 0.675 ? 1 : 3)) % 4; // turn left or right
  }
  return pts;
}

// Return to `to` along the grid (one leg per axis, sometimes split).
function gridReturn(from, to, angle) {
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const u = dx * c - dy * s; // along grid axis 1
  const mid = [from[0] + u * Math.cos(angle), from[1] + u * Math.sin(angle)];
  return [mid, to];
}

// A smooth, wobbly loop (park paths, lakeside routes).
function organicLoop(R, center, perimeter) {
  const r = perimeter / (2 * Math.PI);
  const h = [1, 2, 3].map(() => ({ a: R.range(0.05, 0.22), p: R.range(0, 6.28) }));
  const squash = R.range(0.55, 1);
  const rot = R.range(0, Math.PI);
  const pts = [];
  for (let i = 0; i <= 160; i++) {
    const t = (i / 160) * Math.PI * 2;
    const k = 1 + h.reduce((s, hh, n) => s + hh.a * Math.sin((n + 2) * t + hh.p), 0);
    const x0 = Math.cos(t) * r * k;
    const y0 = Math.sin(t) * r * k * squash;
    pts.push([
      center[0] + x0 * Math.cos(rot) - y0 * Math.sin(rot),
      center[1] + x0 * Math.sin(rot) + y0 * Math.cos(rot),
    ]);
  }
  return pts;
}

function buildTemplates(R, count, spread, trail) {
  const angle = R.range(0, Math.PI / 4);
  const templates = [];
  for (let i = 0; i < count; i++) {
    const kind = trail ? 'trail' : R.pick(['loop', 'loop', 'grid', 'outback']);
    const startOffset = [R.gauss() * spread * 0.15, R.gauss() * spread * 0.15];
    let pts;
    if (kind === 'loop' || kind === 'trail') {
      const center = [R.gauss() * spread, R.gauss() * spread];
      const perim = R.range(2500, 7000);
      const loop = organicLoop(R, center, perim);
      pts = [startOffset, ...gridReturn(startOffset, loop[0], angle), ...loop, ...gridReturn(loop[0], startOffset, angle)];
    } else if (kind === 'grid') {
      const walk = gridWalk(R, startOffset, R.range(3000, 7000), angle);
      pts = [...walk, ...gridReturn(walk[walk.length - 1], startOffset, angle)];
    } else {
      const walk = gridWalk(R, startOffset, R.range(2500, 6000), angle);
      pts = [...walk, ...walk.slice(0, -1).reverse()];
    }
    templates.push({ pts: resample(pts, 20), weight: R.range(0.3, 1) ** 2, kind, angle });
  }
  return templates;
}

// Encode [lat, lng] pairs as a Google polyline (Strava's summary_polyline format).
function encodePolyline(coords, precision = 5) {
  const f = Math.pow(10, precision);
  let out = '';
  let pLat = 0;
  let pLng = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lng] of coords) {
    const a = Math.round(lat * f);
    const b = Math.round(lng * f);
    out += enc(a - pLat) + enc(b - pLng);
    pLat = a;
    pLng = b;
  }
  return out;
}

// Turn a template into one run's GPS track: optional extension, GPS wobble,
// then thin it out like Strava's low-resolution summary polyline.
function trackFromTemplate(R, tpl, origin, stretch) {
  let pts = tpl.pts;
  if (stretch < 0.95) {
    // shorter run: stop part-way round the route
    pts = pts.slice(0, Math.max(2, Math.round(pts.length * stretch)));
  } else if (stretch > 1.15) {
    // add an out-and-back spur for longer runs
    const at = R.int(0, pts.length - 1);
    const spurLen = (lengthOf(pts) * (stretch - 1)) / 2;
    const spur = resample(gridWalk(R, pts[at], spurLen, tpl.angle), 20);
    pts = [...pts.slice(0, at), ...spur, ...spur.slice().reverse(), ...pts.slice(at)];
  }
  let nx = 0;
  let ny = 0;
  const noisy = pts.map(([x, y]) => {
    nx = nx * 0.85 + R.gauss() * 2.2; // smooth, correlated wobble (~5 m)
    ny = ny * 0.85 + R.gauss() * 2.2;
    return [x + nx, y + ny];
  });
  const thin = resample(noisy, 45);
  return { coords: thin.map(([x, y]) => toLatLng(origin, x, y)), length: lengthOf(noisy) };
}

const WORKOUTS = [
  { kind: 'easy', w: 55, paceAdj: 25, names: ['Morning Run', 'Evening Run', 'Easy run', 'Recovery jog', 'Lunch Run'] },
  { kind: 'tempo', w: 12, paceAdj: -35, names: ['Tempo Tuesday', 'Threshold run', 'Tempo'] },
  { kind: 'intervals', w: 8, paceAdj: -20, names: ['Intervals 6x800', 'Track session', 'Hill repeats'] },
  { kind: 'long', w: 18, paceAdj: 35, names: ['Long run', 'Sunday long run', 'Long slow distance'] },
  { kind: 'race', w: 3, paceAdj: -55, names: ['Parkrun 5K', 'Race day', '10K race'] },
];

function generateDemoRuns({ seed = 42, count = 450 } = {}) {
  const R = makeRandom(seed);
  const home = { ...HOME, templates: buildTemplates(R, 12, 1600, false) };
  const trips = TRIPS.map((t) => ({ ...t, templates: buildTemplates(R, 3, 2500, !!t.trail) }));

  const now = Date.now();
  const spanDays = 3 * 365;
  const runs = [];
  // Dates: more frequent recently, as fitness builds.
  const days = [];
  for (let i = 0; i < count; i++) days.push(Math.floor(spanDays * (1 - Math.sqrt(R.rand()))));
  days.sort((a, b) => b - a); // oldest first

  // Trips happen on a few specific week-long windows.
  const tripWindows = trips.map((t) => ({ trip: t, from: R.int(60, spanDays - 60) }));

  for (let i = 0; i < count; i++) {
    const daysAgo = days[i];
    const progress = 1 - daysAgo / spanDays; // 0 = three years ago, 1 = today
    const tw = tripWindows.find((w) => daysAgo <= w.from && daysAgo > w.from - 8);
    const place = tw ? tw.trip : home;

    const workout = R.weighted(WORKOUTS);
    const date = new Date(now - daysAgo * 86400000);
    const hour = workout.kind === 'long' || workout.kind === 'race' ? R.int(7, 9) : R.pick([6, 7, 12, 18, 19, 20]);
    date.setUTCHours(hour, R.int(0, 59), R.int(0, 59), 0);

    const treadmill = !tw && workout.kind !== 'race' && R.rand() < 0.05;
    let polyline = null;
    let distance;
    let startLatLng = null;
    if (treadmill) {
      distance = R.range(4000, 10000);
    } else {
      const tpl = R.weighted(place.templates.map((t) => ({ ...t, w: t.weight })));
      const want =
        workout.kind === 'long' ? R.range(14000, 24000 + 8000 * progress)
        : workout.kind === 'race' ? R.pick([5000, 10000, 10000, 21100])
        : R.range(4500, 11000);
      const stretch = want / lengthOf(tpl.pts);
      const track = trackFromTemplate(R, tpl, place, stretch);
      polyline = encodePolyline(track.coords);
      distance = track.length;
      startLatLng = track.coords[0];
    }

    const basePace = 345 - 40 * progress; // sec/km: 5:45 -> 5:05 over three years
    const trailAdj = place.trail ? 70 : 0;
    const pace = Math.max(215, basePace + workout.paceAdj + trailAdj + R.gauss() * 12);
    const movingTime = Math.round((distance / 1000) * pace);
    const elevPerKm = place.trail ? R.range(35, 70) : R.range(1.5, 7);
    const hasHr = R.rand() < 0.8 && daysAgo < spanDays * 0.85; // older runs: no HR strap
    const hr = 128 + (345 - pace) * 0.35 + (workout.kind === 'race' ? 18 : 0) + R.gauss() * 4;

    let name = place === home ? R.pick(workout.names) : place.trail ? 'Mountain trail run' : 'City break run';
    if (workout.kind === 'race' && !treadmill) {
      name = distance < 7000 ? 'Parkrun 5K' : distance < 15000 ? '10K race' : 'Half marathon';
    }
    runs.push({
      id: 900000 + i,
      name,
      type: place.trail ? 'TrailRun' : 'Run',
      date: date.toISOString().replace('.000Z', 'Z'),
      distance: Math.round(distance * 10) / 10,
      movingTime,
      elapsedTime: Math.round(movingTime * R.range(1.01, 1.12)),
      elevationGain: treadmill ? 0 : Math.round((distance / 1000) * elevPerKm),
      averageSpeed: Math.round((1000 / pace) * 1000) / 1000,
      averageHeartrate: hasHr ? Math.round(hr * 10) / 10 : null,
      polyline,
      startLatLng,
    });
  }
  return runs;
}

module.exports = { generateDemoRuns, encodePolyline };
