/**
 * evenue-ticket-tracker — Cloudflare Worker
 *
 * Serves aggregated seat-availability data from KV. Upstream fetching is
 * done by scripts/fetcher.mjs running on a trusted (residential) network -
 * PerimeterX blocks Cloudflare datacenter IPs, so the worker itself never
 * talks to evenue.net.
 *
 * Routes:
 *   GET /                    -> static frontend (public/)
 *   GET /api/availability    -> all shows
 *   GET /api/availability/<eventId> -> single show
 */

import { getShows, isConfigured } from "./lib.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || "*";

    if (url.pathname === "/api/availability") {
      return handleAllShows(env, origin);
    }

    const single = url.pathname.match(/^\/api\/availability\/(.+)$/);
    if (single) {
      const eventId = decodeURIComponent(single[1]);
      return handleSingleShow(env, eventId, origin);
    }

    return json(
      {
        status: "ok",
        routes: ["/api/availability", "/api/availability/<eventId>"],
      },
      200,
      origin,
    );
  },
  // No scheduled handler: the local fetcher refreshes KV on its own schedule.
};

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

async function handleAllShows(env, origin) {
  const shows = [];
  for (const show of getShows()) {
    if (!isConfigured(show)) {
      shows.push({
        name: show.name,
        title: show.title,
        label: show.label,
        date: show.date,
        error: "eventId not set in shows.json",
      });
      continue;
    }
    shows.push(await getShowData(env, show));
  }
  return json({ shows }, 200, origin);
}

async function handleSingleShow(env, eventId, origin) {
  const show = getShows().find((s) => s.eventId === eventId);
  if (!show) {
    return json({ error: `Unknown event: ${eventId}` }, 404, origin);
  }
  if (!isConfigured(show)) {
    return json({ error: "eventId not set in shows.json" }, 400, origin);
  }
  return json({ shows: [await getShowData(env, show)] }, 200, origin);
}

// ---------------------------------------------------------------------------
// KV reads
// ---------------------------------------------------------------------------

async function getShowData(env, show) {
  const ttl = Number(env.CACHE_TTL_SECONDS || 300) * 1000;

  let payload = null;
  try {
    payload = await env.CACHE.get(`availability:${show.eventId}`, "json");
  } catch {
    // KV hiccup - fall through to the "no data" response.
  }

  if (!payload) {
    return {
      name: show.name,
      title: show.title,
      label: show.label,
      eventId: show.eventId,
      date: show.date,
      time: show.time,
      type: show.type,
      error: "No data yet - the local fetcher hasn't run.",
    };
  }

  const ageMs = Date.now() - payload.fetchedAt;
  return {
    name: show.name,
    title: show.title,
    label: show.label,
    eventId: show.eventId,
    date: show.date,
    time: show.time,
    type: show.type,
    ageSeconds: Math.round(ageMs / 1000),
    stale: ageMs > ttl,
    ...payload,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body, status = 200, origin = "*") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Cache-Control": "public, max-age=30",
    },
  });
}
