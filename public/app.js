/* Ticket tracker frontend — show title is injected at runtime from the API */

const API = "/api/availability";
const REFRESH_INTERVAL = 60 * 1000; // re-poll every 60s (server cache is 5-min)

const grid = document.getElementById("grid");
const showTitleEl = document.getElementById("show-title");
const updatedEl = document.getElementById("updated");
const totalSoldEl = document.getElementById("total-sold");
const errorBanner = document.getElementById("error-banner");

let timer = null;

function fmtAge(seconds) {
  if (seconds == null) return "unknown age";
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.round(seconds / 60);
  return `${m}m ago`;
}

// Local-date "YYYY-MM-DD", matching how the fetcher decides a show is past.
function todayLocal() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

function sectionRow(name, s) {
  const pct = s.total === 0 ? 0 : Math.round((s.sold / s.total) * 100);
  return `
    <div class="sec-row">
      <span class="sec-name">${name} - ${s.sold}/${s.total}</span>
      <span class="sec-pct">${pct}%</span>
      <div class="sec-bar"><div class="sec-bar-fill" style="width:${pct}%"></div></div>
    </div>`;
}

function showCard(show) {
  if (show.error) {
    return `
      <div class="card error">
        <div class="card-top">
          <span class="show-label">${show.label || show.name || show.eventId || "Show"}</span>
        </div>
        <div class="error-msg">${show.error}</div>
      </div>`;
  }

  const t = show.totals;
  const type = show.type || "evening";
  const sectionsHtml = show.sections
    ? `<details class="sections">
         <summary>Section breakdown</summary>
         ${Object.entries(show.sections)
           .map(([n, s]) => sectionRow(n, s))
           .join("")}
       </details>`
    : "";

  return `
    <div class="card">
      <div class="card-top">
        <span class="show-label">${show.label}</span>
        <span class="badge ${type}">${type}</span>
      </div>
      <div class="pct-row">
        <span class="pct">${t.pctSold}%</span>
        <span class="pct-caption">sold</span>
      </div>
      <div class="bar"><div class="bar-fill" style="width:${t.pctSold}%"></div></div>
      <div class="counts">
        <span><b>${t.sold}</b> sold</span>
        <span><b>${t.available}</b> available</span>
        <span><b>${t.total}</b> seats</span>
      </div>
      ${sectionsHtml}
      <div class="card-foot">
        <span>${show.date && show.date < todayLocal() ? "final" : `data ${fmtAge(show.ageSeconds)}`}</span>
      </div>
    </div>`;
}

async function load() {
  try {
    const res = await fetch(API);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();

    errorBanner.classList.add("hidden");
    errorBanner.textContent = "";

    const shows = (data.shows || []).slice().sort((a, b) => {
      const da = a.date || "",
        db = b.date || "";
      if (da !== db) return da < db ? -1 : 1;
      return (a.time || "") < (b.time || "") ? -1 : 1;
    });

    grid.innerHTML = shows.map(showCard).join("");

    // Show title, injected from the API (sourced from shows.json defaults).
    const title = shows.find((s) => s.title)?.title;
    if (title) {
      showTitleEl.textContent = title;
      document.title = `${title} - Ticket Tracker`;
    }

    // Header age should reflect the live data only: past shows are frozen
    // (the fetcher no longer refreshes them), so exclude them. Take the
    // oldest live age — that's how stale the updatable data can be.
    const today = todayLocal();
    const liveAges = shows
      .filter(
        (s) => s.ageSeconds != null && !(s.date && s.date < today),
      )
      .map((s) => s.ageSeconds);
    const oldestLive = liveAges.length ? Math.max(...liveAges) : null;
    updatedEl.textContent = liveAges.length
      ? "updated " + fmtAge(oldestLive)
      : "all shows final";

    // Client-side total across all successfully loaded shows.
    const totalSold = shows.reduce(
      (sum, s) => sum + (s.totals ? s.totals.sold : 0),
      0,
    );
    totalSoldEl.textContent = `Total sold: ${totalSold.toLocaleString()}`;
  } catch (err) {
    errorBanner.textContent = `Couldn't load availability: ${err.message}`;
    errorBanner.classList.remove("hidden");
  }
}

load();
timer = setInterval(load, REFRESH_INTERVAL);
