# Runner Map

Sign in with Strava and see all your runs on one map, with totals, a year filter,
and a list you can click to highlight a single route.

## Map modes

| Mode | What it shows |
|---|---|
| **Routes** | Every run in one colour, newest on top |
| **Heatmap** | Where you run most: streets you've run many times glow, one-off routes are faint |
| **Pace** | Each route coloured by average pace (faster = more vivid, drawn on top) |
| **Recency** | Coloured by date, newest most vivid |
| **Distance** | Short to long runs |
| **Climb** | Elevation gain per run |
| **Heart rate** | Average heart rate (only enabled if your runs have HR data) |

The colour scales ignore the top and bottom 5% so one ultra or one stroll doesn't
wash out everything else; the legend shows the actual range. Use the moon/sun
button for the **dark map**. Mode and theme are remembered.

**Dates:** the calendar button picks any range: click a start day and an end
day (days you ran have a dot), or use a quick option (last 7/30 days, last 3
or 12 months, a specific year). With nothing chosen it shows all time. The
range carries over between the map and One start while the tab is open.

Other details: hover a route for its name, click it (or a list item) for a
detail card, Esc to close; arrow keys move through the list. The map opens on
the area where most of your runs are; a chip at the bottom offers to show runs
in other places, which appear as labelled pins when zoomed out.

## "One start" view

Click **One start** at the end of the mode bar (or open `/overlay.html`). It's a
second view with no map: every run is moved so it starts at the same centre
point, and all of them are drawn on top of each other. Rings mark the distance
from the start.

- **Glow** makes routes brighter where they overlap; the other colour modes
  work like on the map (pace, recency, distance, climb, heart rate).
- **Replay** sends a glowing dot out along each run from the start, in date
  order, leaving the line behind it (space bar). The **1×** button switches
  between 1×, 2× and 4× speed.
- **Save image** downloads the picture as a PNG with a caption.
- Drag, scroll/pinch to zoom, and click a line to see that run, with a
  **Show on map** link back to it.

## Try it without Strava

Click **Try it with demo data** on the sign-in page (or open
<http://localhost:3000/auth/demo>). It generates ~450 realistic fake runs
(favourite loops, tempo and long runs, a few trips, treadmill runs without GPS).
For a stress test use `/auth/demo?runs=3000`.

## 1. Create a Strava API app (one time)

1. Go to <https://www.strava.com/settings/api> and create an application.
2. Set **Authorization Callback Domain** to `localhost`.
3. Copy the **Client ID** and **Client Secret**.

## 2. Configure

1. Copy `.env.example` to `.env`.
2. Paste your Client ID and Client Secret into `.env`.
3. Change `SESSION_SECRET` to any long random string.

`.env` is in `.gitignore`, so your secret never ends up in git.

## 3. Run

You need Node.js 18.11 or newer (<https://nodejs.org>).

```bash
npm install
npm run dev      # restarts automatically when you edit server.js
```

Or open `runner-map.code-workspace` in VS Code (File → Open Workspace from File)
and press **F5** ("Run Runner Map"), which starts the server and opens the browser.

Open <http://localhost:3000>, click **Connect with Strava**, and approve access.

## How it works

```
browser ──/auth/login──▶ server ──redirect──▶ Strava sign-in
browser ◀──cookie────── server ◀──code────── Strava (/auth/callback)
browser ──/api/runs───▶ server ──token──────▶ Strava API (all activities, 200 per page)
```

- `server.js`: Express server. Handles the OAuth flow, keeps the access and
  refresh tokens in the server-side session, refreshes the token when it
  expires, pages through `/athlete/activities`, keeps only runs
  (Run, TrailRun, VirtualRun), and caches them for 15 minutes.
- `demo.js`: the fake-run generator behind demo mode.
- `public/app.js`: the map page: modes, legend, list, selection, theming.
- `public/overlay.html` + `overlay.js`: the "One start" view (plain canvas).
- `public/shared.js`: colours, modes and formatting used by both pages.
- `public/datepicker.js`: the calendar date-range pop-up.
- `public/heat.js`: the line heatmap (a custom canvas layer for Leaflet).
- `public/polyline.js`: decodes Strava's `summary_polyline` route format.
- The basemap is the standard OpenStreetMap tile server (free, no key). It's
  muted (light) or inverted (dark) with a CSS filter in `styles.css`. It's
  meant for light, personal use, which is what this app is.

## Notes

- **Scope**: the app asks for `activity:read_all` so private runs show up too.
  Change `SCOPES` in `server.js` to `read,activity:read` for public runs only.
- **Rate limits**: Strava limits how many API calls an app can make every 15
  minutes and every day. Each page is 200 activities, so loading is cheap, but don't
  hammer the Refresh button.
- **Sessions** are stored in memory, so restarting the server signs you out.
  That's fine for local use; use a persistent session store before deploying.
- Runs recorded without GPS (treadmill, etc.) appear in the list as
  "(no GPS)" and are counted in the totals, but have no line on the map.

## Ideas for next steps

- Detailed streams per run (`/activities/{id}/streams`) for pace/HR charts
- Store runs in SQLite so only new activities are fetched (`after=` param)
- Webhooks (`/push_subscriptions`) to update automatically after each run
