/**
 * Local fetcher - run on a machine with a residential IP (PerimeterX
 * blocks Cloudflare datacenter IPs).
 *
 * Fetches every configured show from evenue.net, aggregates the seat data
 * (reusing src/lib.js so logic stays in one place), then pushes all results
 * to the production KV namespace in a single bulk call via wrangler.
 *
 * Usage:
 *   bun scripts/fetcher.mjs            → fetch + push to production KV
 *   bun scripts/fetcher.mjs --local    → fetch + push to `bun run dev` KV
 *   (requires `wrangler login` to have been run at least once)
 */

import { getShows, isConfigured, fetchShow } from "../src/lib.js";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NAMESPACE_ID = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8")
  .match(/id\s*=\s*"([0-9a-f]+)"/)?.[1];
if (!NAMESPACE_ID) {
  console.error("Could not read KV namespace id from wrangler.toml");
  process.exit(1);
}

// Convert a file:// URL to a plain Windows-style path (e.g. C:\foo\bar.json).
function winPath(url) {
  return fileURLToPath(url).replace(/\//g, "\\");
}

// ISO "YYYY-MM-DD" string comparison — unambiguous and sorts correctly.
// The show's day has "passed" when today's LOCAL date is strictly after it,
// so on performance day itself we still fetch (last-minute sales happen).
// Past shows keep their final numbers in KV; there's nothing left to fetch.
function isPastShow(show) {
  if (!show.date) return false;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return show.date < today;
}

async function main() {
  // --local: push to the simulated KV used by `bun run dev` (wrangler dev)
  // instead of the production namespace. Useful for developing the frontend.
  const local = process.argv.includes("--local");

  // Cookie source, in priority order:
  //   1. PX_COOKIES env var          (PX_COOKIES="_px3=...; _pxhd=..." bun scripts/fetcher.mjs)
  //   2. cookies.txt in project root (one header-style line: "_px3=...; _pxhd=...")
  // Harvest from your browser: open https://venue.evenue.net/events/event-name,
  // F12 -> Application/Storage -> Cookies, copy the _px* names/values.
  let cookies = process.env.PX_COOKIES || "";
  if (!cookies) {
    try {
      cookies = readFileSync(new URL("../cookies.txt", import.meta.url), "utf8").trim();
    } catch {
      // No cookies file - fine, requests just run cookieless (may get blocked).
    }
  }
  if (cookies) console.log("Using PX cookies from " + (process.env.PX_COOKIES ? "env" : "cookies.txt"));

  const shows = getShows().filter(isConfigured);

  // In local mode, fetch EVERYTHING live — the simulated KV may be empty, so
  // past shows need real data too. Normal mode skips past shows since their
  // final numbers are already in production KV.
  const toFetch = local ? shows : shows.filter((s) => !isPastShow(s));
  if (!local) {
    const skipped = shows.length - toFetch.length;
    if (skipped > 0) {
      console.log(`Skipping ${skipped} past show(s) — final numbers already cached.`);
    }
  }

  if (toFetch.length === 0) {
    console.log("Nothing to fetch — all shows are in the past.");
    return;
  }

  console.log(`Fetching ${toFetch.length} shows…`);

  const entries = [];
  // Sequential with a gap: bursts of parallel requests are exactly what
  // tripped PerimeterX in the first place. Look like a browsing human.
  for (const show of toFetch) {
    try {
      const data = await fetchShow(show, cookies);
      console.log(
        `  ✓ ${show.label}: ${data.totals.sold}/${data.totals.total} sold (${data.totals.pctSold}%)`
      );
      entries.push({
        key: `availability:${show.eventId}`,
        value: JSON.stringify({ fetchedAt: Date.now(), ...data }),
      });
    } catch (err) {
      console.warn(`  ✗ ${show.label}: ${err.message} (keeping old cache)`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const ok = entries;
  if (ok.length === 0) {
    console.error("Nothing to push to KV.");
    process.exit(1);
  }

  const bulkFile = new URL("../.kv-bulk.json", import.meta.url);
  writeFileSync(bulkFile, JSON.stringify(ok));
  try {
    // Node/Bun refuse to spawn .cmd shims directly (CVE-2024-27980 hardening),
    // so invoke the runtime's own "x" subcommand instead of bunx.cmd/npx.cmd.
    const args = [
      "x",
      "wrangler",
      "kv",
      "bulk",
      "put",
      winPath(bulkFile),
      ...(local
        ? // Local mode: target the simulated KV of `wrangler dev`, addressed
          // by binding name (no namespace id needed).
          ["--binding=CACHE", "--local"]
        : [`--namespace-id=${NAMESPACE_ID}`, "--remote"]),
    ];
    execFileSync(process.execPath, args, {
      stdio: "inherit",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
    console.log(
      local
        ? `Pushed ${ok.length}/${shows.length} shows to local dev KV.`
        : `Pushed ${ok.length}/${toFetch.length} shows to KV.`
    );
  } finally {
    unlinkSync(bulkFile);
  }
}

main();
