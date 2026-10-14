/* global L, buildLut */
// A Strava-style line heatmap for Leaflet.
//
// Every route is stroked once onto an offscreen canvas with a little alpha,
// so pixels covered by many runs become more opaque. That opacity is turned
// back into a run count, put on a log scale and coloured with a ramp. A street
// you ran 200 times glows; a one-off detour is a faint thread.

const HeatLayer = L.Layer.extend({
  initialize(options = {}) {
    this._routes = []; // [{ pts: Float64Array of world coords at zoom 0, bbox }]
    this._ramp = buildLut(options.ramp || ['#000', '#fff']);
    this._minAlpha = options.minAlpha ?? 0.35;
  },

  // routes: prepared routes from HeatLayer.prepare(latlngs)
  setRoutes(routes) {
    this._routes = routes;
    this._schedule();
    return this;
  },

  setRamp(ramp, minAlpha) {
    this._ramp = buildLut(ramp);
    if (minAlpha !== undefined) this._minAlpha = minAlpha;
    this._schedule();
    return this;
  },

  onAdd(map) {
    this._canvas = L.DomUtil.create('canvas', 'heat-canvas leaflet-zoom-hide');
    this._canvas.style.position = 'absolute';
    this._canvas.style.pointerEvents = 'none';
    this._accum = document.createElement('canvas');
    map.getPanes().overlayPane.appendChild(this._canvas);
    map.on('moveend zoomend resize viewreset', this._schedule, this);
    this._redraw();
  },

  // Several changes in one tick (new routes + map move) -> one redraw.
  _schedule() {
    if (!this._map || this._pending) return;
    this._pending = requestAnimationFrame(() => {
      this._pending = null;
      this._redraw();
    });
  },

  onRemove(map) {
    L.DomUtil.remove(this._canvas);
    map.off('moveend zoomend resize viewreset', this._schedule, this);
    if (this._pending) cancelAnimationFrame(this._pending);
    this._pending = null;
  },

  _redraw() {
    const map = this._map;
    if (!map) return;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(size.x * dpr);
    const h = Math.round(size.y * dpr);

    const canvas = this._canvas;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    if (!this._routes.length || !w || !h) return;

    // 1. accumulate: each route adds ALPHA of opacity where it passes
    const ALPHA = 0.05;
    const acc = this._accum;
    acc.width = w;
    acc.height = h;
    const actx = acc.getContext('2d', { willReadFrequently: true });
    const zoom = map.getZoom();
    const scale = 256 * Math.pow(2, zoom); // world size in px at this zoom
    const origin = map.project(map.containerPointToLatLng([0, 0]), zoom);
    actx.lineWidth = (zoom >= 15 ? 3 : zoom >= 12 ? 2.2 : 1.6) * dpr;
    actx.lineJoin = 'round';
    actx.lineCap = 'round';
    actx.strokeStyle = `rgba(0,0,0,${ALPHA})`;

    const k = scale / 256; // world coords were computed at zoom 0 (256 px world)
    const vx0 = origin.x / k, vy0 = origin.y / k;
    const vx1 = (origin.x + size.x) / k, vy1 = (origin.y + size.y) / k;
    for (const r of this._routes) {
      const [x0, y0, x1, y1] = r.bbox;
      if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue; // off screen
      const p = r.pts;
      actx.beginPath();
      actx.moveTo((p[0] * k - origin.x) * dpr, (p[1] * k - origin.y) * dpr);
      for (let i = 2; i < p.length; i += 2) {
        actx.lineTo((p[i] * k - origin.x) * dpr, (p[i + 1] * k - origin.y) * dpr);
      }
      actx.stroke();
    }

    // 2. alpha -> run count -> colour. Every output pixel depends only on the
    // accumulated alpha (0-255), so build a 256-entry lookup table.
    const img = actx.getImageData(0, 0, w, h);
    const src = new Uint32Array(img.data.buffer);
    const hist = new Uint32Array(256);
    for (let i = 0; i < src.length; i++) hist[src[i] >>> 24]++; // alpha byte (little-endian)
    hist[0] = 0;

    const logKeep = Math.log(1 - ALPHA);
    const countOf = (a) => Math.log(1 - Math.min(a, 254) / 255) / logKeep;
    // Scale against the 99th percentile of lit pixels, so a single
    // super-popular street doesn't flatten everything else.
    let lit = 0;
    for (let a = 1; a < 256; a++) lit += hist[a];
    let seen = 0;
    let a99 = 255;
    for (let a = 1; a < 256; a++) {
      seen += hist[a];
      if (seen >= lit * 0.99) { a99 = a; break; }
    }
    const logMax = Math.log1p(Math.max(3, countOf(a99)));

    const lut = this._ramp;
    const minA = this._minAlpha;
    const pixel = new Uint32Array(256); // packed RGBA per input alpha
    for (let a = 1; a < 256; a++) {
      const t = Math.min(1, Math.log1p(countOf(a)) / logMax);
      const li = Math.round(t * 255) * 3;
      const coverage = Math.min(1, a / (255 * ALPHA)); // anti-aliased edges
      const outA = Math.round(255 * coverage * (minA + (1 - minA) * t));
      pixel[a] = ((outA << 24) | (lut[li + 2] << 16) | (lut[li + 1] << 8) | lut[li]) >>> 0;
    }

    const out = canvas.getContext('2d').createImageData(w, h);
    const dst = new Uint32Array(out.data.buffer);
    for (let i = 0; i < src.length; i++) {
      const a = src[i] >>> 24;
      if (a) dst[i] = pixel[a];
    }
    canvas.getContext('2d').putImageData(out, 0, 0);
  },
});

// Project a route once (to world pixels at zoom 0) so redraws are cheap.
HeatLayer.prepare = function (latlngs) {
  const pts = new Float64Array(latlngs.length * 2);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  latlngs.forEach(([lat, lng], i) => {
    const p = L.CRS.EPSG3857.latLngToPoint(L.latLng(lat, lng), 0);
    pts[i * 2] = p.x;
    pts[i * 2 + 1] = p.y;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  });
  return { pts, bbox: [minX, minY, maxX, maxY] };
};
