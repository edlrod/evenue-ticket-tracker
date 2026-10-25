# evenue-ticket-tracker

A tiny dashboard that shows how many tickets are sold for a run of theatre
performances. Seat availability is pulled from a ticketing vendor's PAC API,
aggregated into sold/available counts (overall + per section), and displayed
as a grid of cards. The show title is injected into the page at runtime from
the configured show data.

Live example: [show-tracker.<your-subdomain>.workers.dev]

## Architecture

The ticketing API sits behind PerimeterX bot protection, which blocks
datacenter IP ranges — including the ones Cloudflare Workers fetch from. So
the system is split in two:

```
┌────────────────────────────┐        ┌─────────────────────────────┐
│  fetcher (your machine)    │  push  │  Cloudflare Worker          │
│  scripts/fetcher.mjs       │ ─────► │  src/worker.js              │
│  runs hourly via Task      │  KV    │  serves public/ frontend +  │
│  Scheduler; residential IP │        │  /api/availability from KV  │
└────────────────────────────┘        └─────────────────────────────┘
```

- The **fetcher** runs on a trusted (residential) network, fetches every
  configured show, aggregates the raw per-seat rows into counts, and bulk-
  writes the results to the Worker's KV namespace. Past shows are skipped —
  their final numbers are already cached.
- The **Worker** only ever reads KV. It hosts the static frontend and a small
  JSON API (`/api/availability`, `/api/availability/<eventId>`), so there's
  no CORS or rate-limit exposure of the upstream API to visitors.

## Setup

1. `bun install` (or npm)
2. `cp wrangler.example.toml wrangler.toml` — create a KV namespace with
   `bunx wrangler kv namespace create CACHE` and paste its ID in.
3. `cp shows.example.json shows.json` — fill in your show's event IDs, dates
   and times. All shows share the `defaults` block.
4. `bunx wrangler deploy`
5. Fetch your first batch of data:
   - Open the venue's event page in your browser, then copy the `_px*`
     cookies (F12 → Application → Cookies) into a `cookies.txt` file in the
     project root as a single header-style line: `_px3=...; _pxhd=...`
   - `bun scripts/fetcher.mjs`
6. Schedule the refresh — `cp run.example.cmd run.cmd`, adjust the bun path,
   then register it with Task Scheduler (hourly works well).

## Notes

- PX cookies expire (hours to a couple of days). When the fetch log shows
  `403`s, re-harvest them from your browser.
- Data age is shown honestly on the dashboard; when your machine is off, the
  site serves the last cached numbers.
