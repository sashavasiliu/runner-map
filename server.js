// Runner Map: a small Express server that signs you in with Strava (OAuth 2)
// and serves your runs to the front end in /public.
// The client secret stays on the server. Each visitor's Strava tokens live in
// an encrypted cookie in their own browser (AES-256-GCM), so the server keeps
// no database and nobody gets signed out when it restarts.

require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { generateDemoRuns } = require('./demo');

const {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  SESSION_SECRET,
  PORT = 3000,
} = process.env;
// Public address: set BASE_URL, or on Render it's detected automatically.
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_API = 'https://www.strava.com/api/v3';
const SCOPES = 'read,activity:read_all'; // activity:read_all includes private runs
const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);
const CACHE_TTL_MS = 15 * 60 * 1000; // re-fetch from Strava at most every 15 min
const PER_PAGE = 200; // Strava's maximum page size
const MAX_PAGES = 50; // safety cap: 10,000 activities

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
  console.warn(
    '\n[runner-map] STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET are missing.\n' +
      'Copy .env.example to .env and fill them in (see README.md).\n'
  );
}

if (!SESSION_SECRET && BASE_URL.startsWith('https://')) {
  console.warn('[runner-map] SESSION_SECRET is not set: everyone will be signed out on every restart.');
}

const app = express();
app.disable('x-powered-by');
app.use(encryptedCookieSession());

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

app.get('/auth/login', (req, res) => {
  if (!STRAVA_CLIENT_ID) {
    return res.status(500).send('Missing STRAVA_CLIENT_ID in .env');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: STRAVA_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: SCOPES,
    state,
  });
  res.redirect(`${STRAVA_AUTHORIZE_URL}?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, scope = '' } = req.query;

  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!state || state !== req.session.oauthState) {
    return res.redirect('/?error=invalid_state');
  }
  delete req.session.oauthState;

  if (!scope.split(',').some((s) => s.startsWith('activity:read'))) {
    return res.redirect('/?error=missing_activity_scope');
  }

  try {
    const token = await stravaTokenRequest({
      grant_type: 'authorization_code',
      code,
    });
    req.session = {
      strava: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: token.expires_at,
      },
      athlete: pickAthlete(token.athlete),
    };
    res.redirect('/');
  } catch (e) {
    console.error('[runner-map] token exchange failed:', e.message);
    res.redirect('/?error=token_exchange_failed');
  }
});

// Demo mode: fake runs, no Strava account needed. /auth/demo?runs=2000 for a
// bigger data set.
app.get('/auth/demo', (req, res) => {
  const count = Math.min(Math.max(parseInt(req.query.runs, 10) || 450, 1), 5000);
  req.session = {
    demo: { count },
    athlete: { id: `demo-${count}`, firstname: 'Demo', lastname: 'Runner', demo: true },
  };
  res.redirect('/');
});

app.post('/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

async function stravaTokenRequest(extra) {
  const resp = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      ...extra,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Strava token endpoint ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

// Returns a valid access token, refreshing it if it expires within a minute.
async function getAccessToken(req) {
  const s = req.session.strava;
  if (!s) return null;
  const now = Math.floor(Date.now() / 1000);
  if (s.expiresAt - 60 > now) return s.accessToken;

  const token = await stravaTokenRequest({
    grant_type: 'refresh_token',
    refresh_token: s.refreshToken,
  });
  req.session.strava = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: token.expires_at,
  };
  return token.access_token;
}

function pickAthlete(a = {}) {
  return {
    id: a.id,
    firstname: a.firstname,
    lastname: a.lastname,
    profile: a.profile_medium || a.profile,
    city: a.city,
    country: a.country,
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function requireAuth(req, res, next) {
  if (!req.session.strava && !req.session.demo) return res.status(401).json({ error: 'not_signed_in' });
  next();
}

app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.session.athlete);
});

// In-memory cache of runs per athlete, so reloading the page doesn't burn
// through Strava's rate limits.
const runCache = new Map(); // athleteId -> { fetchedAt, runs }

app.get('/api/runs', requireAuth, async (req, res) => {
  const athleteId = req.session.athlete?.id;
  const cached = runCache.get(athleteId);
  const forceRefresh = req.query.refresh === '1';

  if (cached && !forceRefresh && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return res.json({ fetchedAt: cached.fetchedAt, runs: cached.runs });
  }

  try {
    const runs = req.session.demo
      ? generateDemoRuns({ count: req.session.demo.count })
      : await fetchAllRuns(await getAccessToken(req));
    const entry = { fetchedAt: Date.now(), runs };
    runCache.set(athleteId, entry);
    res.json(entry);
  } catch (e) {
    console.error('[runner-map] fetching runs failed:', e.message);
    if (e.status === 429) {
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Strava rate limit reached. Try again in about 15 minutes.',
      });
    }
    if (e.status === 401) {
      return res.status(401).json({ error: 'not_signed_in' });
    }
    res.status(502).json({ error: 'strava_error', message: e.message });
  }
});

async function fetchAllRuns(token) {
  const runs = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${STRAVA_API}/athlete/activities?per_page=${PER_PAGE}&page=${page}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const err = new Error(`Strava API ${resp.status}: ${await resp.text()}`);
      err.status = resp.status;
      throw err;
    }
    const activities = await resp.json();
    for (const a of activities) {
      const type = a.sport_type || a.type;
      if (!RUN_TYPES.has(type)) continue;
      runs.push({
        id: a.id,
        name: a.name,
        type,
        date: a.start_date_local,
        distance: a.distance, // metres
        movingTime: a.moving_time, // seconds
        elapsedTime: a.elapsed_time, // seconds
        elevationGain: a.total_elevation_gain, // metres
        averageSpeed: a.average_speed, // m/s
        averageHeartrate: a.average_heartrate ?? null,
        polyline: a.map?.summary_polyline || null,
        startLatLng: a.start_latlng?.length ? a.start_latlng : null,
      });
    }
    if (activities.length < PER_PAGE) break;
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Encrypted cookie sessions
// ---------------------------------------------------------------------------

const COOKIE = 'runner_map';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // seconds
const SESSION_KEY = crypto
  .createHash('sha256')
  .update(SESSION_SECRET || crypto.randomBytes(32).toString('hex'))
  .digest();

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SESSION_KEY, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

function unseal(text) {
  try {
    const buf = Buffer.from(text, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', SESSION_KEY, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const json = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    return JSON.parse(json);
  } catch {
    return {}; // tampered, expired key, or garbage: start fresh
  }
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// req.session is a plain object. If a handler changes it (or sets it to null
// to sign out), the cookie is rewritten just before the response goes out.
function encryptedCookieSession() {
  const secure = BASE_URL.startsWith('https://');
  return (req, res, next) => {
    const raw = readCookie(req, COOKIE);
    req.session = raw ? unseal(raw) : {};
    const before = JSON.stringify(req.session);
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      const after = JSON.stringify(req.session || {});
      if (after !== before) {
        const empty = !req.session || after === '{}';
        const attrs = [`Path=/`, 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : null,
          `Max-Age=${empty ? 0 : COOKIE_MAX_AGE}`].filter(Boolean).join('; ');
        res.setHeader('Set-Cookie', `${COOKIE}=${empty ? '' : seal(req.session)}; ${attrs}`);
      }
      return writeHead.apply(this, args);
    };
    next();
  };
}

app.listen(PORT, () => {
  console.log(`[runner-map] running at ${BASE_URL}`);
  console.log(`[runner-map] OAuth callback: ${REDIRECT_URI}`);
});
