/**
 * Shared show-config + upstream logic.
 *
 * Used by:
 *   - src/worker.js        (server: serves cached data from KV)
 *   - scripts/fetcher.mjs  (local: fetches upstream from a residential IP
 *                           and pushes results to KV - PerimeterX blocks
 *                           Cloudflare datacenter IPs, so this must run
 *                           from a trusted network)
 */

import showsConfig from "../shows.json" with { type: "json" };

// evenue's edge rejects non-browser User-Agents with a 403.
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Show config
// ---------------------------------------------------------------------------

/** Merge per-show entries with shared defaults, and build display labels. */
export function getShows() {
  const defaults = showsConfig.defaults || {};
  return showsConfig.shows.map((s) => {
    const show = { ...defaults, ...s };
    show.title = show.name; // show name, for the page header (before the date label is appended)
    show.label = buildLabel(show);
    show.name = `${show.name} - ${show.label}`;
    return show;
  });
}

/** Placeholder IDs (until real ones are pasted in) shouldn't hit upstream. */
export function isConfigured(show) {
  return Boolean(show.eventId) && !/paste|your_|todo|xxx/i.test(show.eventId);
}

/** "2026-10-18" + "14:00" -> "Sun, Oct 18 · 2:00 PM" */
export function buildLabel(show) {
  if (!show.date) return show.eventId || "";
  const [y, m, d] = show.date.split("-").map(Number);
  const [hh, mm] = (show.time || "19:30").split(":").map(Number);
  // UTC-anchored so the weekday/date never shift with the runner's timezone.
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const h12 = ((hh + 11) % 12) + 1;
  const ampm = hh < 12 ? "AM" : "PM";
  return `${days[dt.getUTCDay()]}, ${months[m - 1]} ${d} · ${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
}

// ---------------------------------------------------------------------------
// Upstream fetch + aggregation
// ---------------------------------------------------------------------------

/** Fetch one show's seat map and aggregate into totals + per-section counts. */
export async function fetchShow(show, cookies = "") {
  const params = new URLSearchParams({
    distributorId: show.distributorId,
    availability: "A|S",
    policyCd: show.policyCd,
    policyType: show.policyType,
  });
  for (const section of show.sections) {
    params.append("levelSectionCd", section);
  }

  // The venue's evenue host and referer come from shows.json defaults —
  // they're venue-specific config, not code.
  const host = show.upstreamHost;
  if (!host) throw new Error("upstreamHost not set in shows.json defaults");

  const url = `${host}/pac-api/seat-availability/event-id/${encodeURIComponent(
    show.eventId,
  )}/seatAvailabilityForSections?${params.toString()}`;

  const headers = {
    "User-Agent": BROWSER_UA,
    Origin: host,
    Referer: show.upstreamReferer || `${host}/events/`,
    Accept: "application/json, text/plain, */*",
  };
  // PerimeterX session cookies harvested from a real browser (see
  // scripts/fetcher.mjs for how to supply them). Without these, PX scores
  // the request as a cookieless bot once your IP is on its radar.
  if (cookies) headers["Cookie"] = cookies;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Upstream returned ${res.status}`);
  }

  // The response is [ [rows...], ["LEVELSECTIONCD","ROWCD","SEATCD","AVAILABLE"] ].
  // Each row is [section, row, seat, availableFlag].
  const payload = await res.json();
  const seats =
    Array.isArray(payload) && Array.isArray(payload[0]?.[0])
      ? payload[0]
      : payload;

  const sections = {};
  let sold = 0;
  let available = 0;

  for (const seat of seats) {
    if (!Array.isArray(seat)) continue; // header row or unexpected entry
    const [section, , , flag] = seat;
    if (typeof flag !== "number") continue; // skip header row
    const entry = (sections[section] ||= { available: 0, sold: 0 });
    if (flag === 1) {
      available++;
      entry.available++;
    } else {
      sold++;
      entry.sold++;
    }
  }

  const total = sold + available;
  const pct = (n) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);

  return {
    totals: {
      total,
      sold,
      available,
      pctSold: pct(sold),
      pctAvailable: pct(available),
    },
    sections: Object.fromEntries(
      Object.entries(sections).map(([name, s]) => {
        const st = s.sold + s.available;
        return [
          name,
          {
            ...s,
            total: st,
            pctSold: st === 0 ? 0 : Math.round((s.sold / st) * 1000) / 10,
          },
        ];
      }),
    ),
  };
}
