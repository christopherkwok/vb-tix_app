# 🏐 NYUrban Volleyball Ticket Tracker

A lightweight, **zero-dependency** Node.js app that scrapes [NYUrban's volleyball schedule](https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1) every 5 minutes and shows available spots in a live-updating UI.

## Features

- ✅ **Real-time scraping** — checks for open spots every 5 minutes (no API needed)
- ✅ **Live UI** — Server-Sent Events (SSE) push updates to the browser instantly
- ✅ **Browser notifications** — opt-in alerts when new spots open
- ✅ **Zero dependencies** — pure Node.js built-ins only (`http`, `https`, `fs`, `url`)
- ✅ **Filter by availability** — All / Available / Full
- ✅ **Force refresh** — manual refresh button for instant re-check

## Requirements

- **Node.js v16+** (comes with macOS/Windows/Linux, or [nodejs.org](https://nodejs.org))
- No npm install needed

## Quick Start

```bash
# 1. Clone / download the folder
cd volleyball-tracker

# 2. Start the server
node server.js

# 3. Open your browser
open http://localhost:3333
```

The terminal will show scraping activity. The browser auto-connects via SSE.

## How it works

```
Browser (SSE) ←──────── Node.js server ─────→ nyurban.com (scrape every 5min)
     ↓                       ↓
Live UI update         Regex HTML parser
                       (no external libs)
```

### Parsing strategy

The scraper tries three patterns in order, so it adapts to site changes:
1. `<tr>` rows in a results table (most common WordPress plugin output)
2. `<div class="game/event/session">` blocks
3. `<li>` items with time patterns

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Serves the UI |
| GET | `/api/games` | Returns current game list as JSON |
| GET | `/api/status` | Server health + stats |
| GET | `/api/stream` | SSE stream (live updates) |
| POST | `/api/refresh` | Trigger immediate scrape |

## Customizing the interval

Edit the last line of `server.js`:
```js
startPolling(5 * 60 * 1000);  // change to e.g. 60 * 1000 for every minute
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "No games found" | The site structure may have changed. Check the console output for raw HTML clues. |
| 403 error | NYUrban may be rate-limiting. The app retries on the next interval. |
| Browser notifications don't work | Allow permissions in browser settings → Site Settings |

## License

MIT — free for personal use.
