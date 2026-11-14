// ─── Market data accuracy helpers (pure, no I/O) ──────────────────────────────
// Shared by the serverless API (api/), the app (tradeskv.jsx, marketQuadrant.js),
// the daily audit (scripts/audit-data.mjs) and the tests (tests/).
//
// Rule of thumb: NSE's own files/feeds are the source of truth. Yahoo is used only
// for live prices and history, and every Yahoo number is either confirmed against
// NSE or shown as unverified.

const IST_SEC = 19800; // +5:30

/** Unix seconds → IST date "YYYY-MM-DD". */
export function istDay(sec) {
  return new Date((sec + IST_SEC) * 1000).toISOString().slice(0, 10);
}
/** Epoch ms → { day: "YYYY-MM-DD", mins: minutes since IST midnight, dow: 0-6 } in IST. */
export function istParts(ms = Date.now()) {
  const d = new Date(ms + IST_SEC * 1000);
  return { day: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}
/** True during the regular NSE session (Mon–Fri 09:15–15:30 IST). Holidays are not known here. */
export function isSessionHours(ms = Date.now()) {
  const { mins, dow } = istParts(ms);
  return dow >= 1 && dow <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}
/** "YYYY-MM-DD" → "DDMMYYYY" (NSE archive file naming). */
export function nseFileDate(day) {
  const [y, m, d] = day.split("-");
  return `${d}${m}${y}`;
}
/** Weekdays (IST) from `fromMs` going back, newest first. */
export function recentWeekdays(fromMs = Date.now(), count = 7) {
  const out = [];
  for (let back = 0; out.length < count && back < count * 2; back++) {
    const { day, dow } = istParts(fromMs - back * 86400000);
    if (dow !== 0 && dow !== 6) out.push(day);
  }
  return out;
}

const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
/** "12-11-2026" or "12-Nov-2026" → "2026-11-12" (null if unparseable). */
export function parseNseDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (m && MONTHS[m[2].toUpperCase()]) return `${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}`;
  return null;
}

// ─── Yahoo chart helpers ─────────────────────────────────────────────────────

/**
 * Previous session's close from a Yahoo /v8/finance/chart result (interval=1d, range ≥ 5d):
 * the close of the last daily bar dated before the latest trade's IST date.
 * Do NOT use meta.chartPreviousClose — for indices it skipped a session on 12 Nov 2026.
 */
export function previousSessionClose(result) {
  const ts = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  const lastTrade = result?.meta?.regularMarketTime;
  if (!Array.isArray(ts) || !Array.isArray(closes) || !lastTrade) return null;
  const today = istDay(lastTrade);
  for (let i = ts.length - 1; i >= 0; i--) {
    if (closes[i] != null && istDay(ts[i]) < today) return closes[i];
  }
  return null;
}

/**
 * Sanity checks for a quote. Returns a list of issue codes (empty = looks sane):
 *   bad_price   price missing, non-finite or ≤ 0
 *   bad_prev    previous close missing or ≤ 0
 *   big_move    |change| beyond what the market allows (index > 10%, stock > 20% circuit)
 *   stale       quote time too old (> 15 min during session hours, > 5 days otherwise)
 */
export function quoteIssues({ price, prevClose, isIndex = false, quoteTimeMs, nowMs = Date.now() }) {
  const issues = [];
  if (!Number.isFinite(price) || price <= 0) issues.push("bad_price");
  if (!Number.isFinite(prevClose) || prevClose <= 0) issues.push("bad_prev");
  if (!issues.length) {
    const pct = Math.abs(price / prevClose - 1) * 100;
    if (pct > (isIndex ? 10 : 20.5)) issues.push("big_move");
  }
  if (Number.isFinite(quoteTimeMs)) {
    const age = nowMs - quoteTimeMs;
    if (isSessionHours(nowMs) ? age > 15 * 60000 : age > 5 * 86400000) issues.push("stale");
  }
  return issues;
}

// ─── NSE file parsers ────────────────────────────────────────────────────────

function splitCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}
const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * NSE ind_close_all_DDMMYYYY.csv →
 * { date, indices: { "Nifty 50": { open, high, low, close, change, changePct, prevClose }, ... } }
 */
export function parseIndexCloseCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2 || !/Index Name/i.test(lines[0])) return null;
  const hdr = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = (re) => hdr.findIndex((h) => re.test(h));
  const iName = col(/^index name/), iDate = col(/^index date/), iOpen = col(/^open/), iHigh = col(/^high/),
        iLow = col(/^low/), iClose = col(/^closing/), iChg = col(/^points change/), iPct = col(/^change\(%\)/);
  const indices = {}; let date = null;
  for (const l of lines.slice(1)) {
    const c = splitCsvLine(l);
    const close = num(c[iClose]), change = num(c[iChg]);
    if (!c[iName] || close == null) continue;
    date = date || parseNseDate(c[iDate]);
    indices[c[iName]] = {
      open: num(c[iOpen]), high: num(c[iHigh]), low: num(c[iLow]), close, change,
      changePct: num(c[iPct]),
      prevClose: change != null ? +(close - change).toFixed(2) : null,
    };
  }
  return date && Object.keys(indices).length ? { date, indices } : null;
}

/**
 * NSE sec_bhavdata_full_DDMMYYYY.csv → { date, closes: { SYMBOL: { prev, close, vol, deliv } } }  (deliv = delivery %)
 * Only equity series are kept: EQ / BE / BZ, plus RR (REITs) and IV (InvITs), which sit in the Nifty 500.
 */
export function parseBhavFullCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2 || !/SYMBOL/i.test(lines[0])) return null;
  const hdr = splitCsvLine(lines[0]).map((h) => h.toUpperCase());
  const iSym = hdr.indexOf("SYMBOL"), iSer = hdr.indexOf("SERIES"), iDate = hdr.indexOf("DATE1"),
        iPrev = hdr.indexOf("PREV_CLOSE"), iClose = hdr.indexOf("CLOSE_PRICE"), iVol = hdr.indexOf("TTL_TRD_QNTY"), iDel = hdr.indexOf("DELIV_PER");
  if ([iSym, iSer, iPrev, iClose].some((i) => i < 0)) return null;
  const closes = {}; let date = null;
  for (const l of lines.slice(1)) {
    const c = splitCsvLine(l);
    if (!["EQ", "BE", "BZ", "RR", "IV"].includes(c[iSer])) continue;
    const close = num(c[iClose]), prev = num(c[iPrev]);
    if (!c[iSym] || close == null) continue;
    date = date || parseNseDate(c[iDate]);
    closes[c[iSym]] = { prev, close, vol: iVol >= 0 ? num(c[iVol]) : null, deliv: iDel >= 0 ? num(c[iDel]) : null };
  }
  return date && Object.keys(closes).length ? { date, closes } : null;
}

/** NSE /api/allIndices JSON → { date, time, indices: { "NIFTY 50": { last, prevClose, changePct } } } */
export function parseAllIndices(json) {
  const rows = json?.data;
  if (!Array.isArray(rows)) return null;
  const indices = {};
  for (const r of rows) {
    if (!r?.index || !Number.isFinite(r.last)) continue;
    indices[r.index] = { last: r.last, prevClose: Number.isFinite(r.previousClose) ? r.previousClose : null, changePct: Number.isFinite(r.percentChange) ? r.percentChange : null };
  }
  const ts = String(json.timestamp || "");
  return Object.keys(indices).length ? { date: parseNseDate(ts), time: ts.split(" ")[1] || null, indices } : null;
}

// ─── Index reconciliation (header N50 / N500) ────────────────────────────────

/** Names used by each source for the two header indices. */
export const INDEX_KEYS = {
  nifty50:  { yahoo: "^NSEI",   nseFile: "Nifty 50",  nseLive: "NIFTY 50" },
  nifty500: { yahoo: "^CRSLDX", nseFile: "Nifty 500", nseLive: "NIFTY 500" },
};

/**
 * Pick the value to show for one index.
 *   live:  { date, time, last, prevClose, changePct } from NSE allIndices (official, real time)
 *   eod:   { date, close, prevClose, changePct } from NSE ind_close_all (official, after ~6pm)
 *   yahoo: { price, prevClose, changePct, asOf, issues }
 * Returns { price, changePct, source, verified, asOf, warning } or null.
 *   source: "nse-live" | "nse-eod" | "yahoo"
 *   verified: true when the value comes from NSE, or Yahoo agrees with NSE within tolerance
 *   warning: text when sources disagree or Yahoo failed sanity checks
 */
export function reconcileIndex({ live, eod, yahoo }, tolPct = 0.2) {
  const pctOf = (price, prev) => (price != null && prev ? +((price / prev - 1) * 100).toFixed(2) : null);
  let pick = null;
  if (live?.last != null && (!eod || !eod.date || !live.date || live.date >= eod.date)) {
    pick = { price: live.last, changePct: live.changePct ?? pctOf(live.last, live.prevClose), source: "nse-live", verified: true, asOf: `${live.date || ""} ${live.time || ""}`.trim() };
  } else if (eod?.close != null) {
    pick = { price: eod.close, changePct: eod.changePct ?? pctOf(eod.close, eod.prevClose), source: "nse-eod", verified: true, asOf: `${eod.date} close` };
  }

  const yOk = yahoo?.price != null && !(yahoo.issues || []).some((i) => i !== "stale");
  if (pick) {
    if (yahoo?.price != null) {
      const diff = Math.abs(yahoo.price / pick.price - 1) * 100;
      if (diff > tolPct) pick.warning = `Yahoo shows ${yahoo.price} (${diff.toFixed(2)}% off NSE) — showing NSE`;
    }
    return pick;
  }
  if (yOk) {
    return {
      price: yahoo.price, changePct: yahoo.changePct, source: "yahoo", verified: false, asOf: yahoo.asOf || null,
      warning: (yahoo.issues || []).includes("stale") ? "Unverified and possibly stale (NSE unreachable)" : "Unverified — NSE unreachable",
    };
  }
  return null;
}

// ─── Stock close verification (QUAD) ─────────────────────────────────────────

/**
 * Check aligned Yahoo closes against an NSE bhavcopy and correct them in place.
 *   axis:    sorted "YYYY-MM-DD" dates
 *   aligned: { "RELIANCE.NS": [close|null per axis date] }
 *   bhav:    parseBhavFullCsv() result
 * Checks the bhavcopy date (close) and the axis date before it (prev close).
 * Returns { date, checked, matched, corrected, filled, missing, examples } or null when the
 * bhavcopy date is not on the axis. "filled" = Yahoo had no bar (taken from NSE);
 * "corrected" = Yahoo had a bar with a different price (replaced by NSE's).
 */
export function verifyAgainstBhav(axis, aligned, bhav, tolPct = 0.1) {
  if (!bhav?.date || !bhav.closes) return null;
  const i = axis.indexOf(bhav.date);
  if (i < 0) return null;
  let checked = 0, matched = 0, corrected = 0, filled = 0, missing = 0;
  const examples = [];
  // returns "ok" | "filled" | "corrected"
  const fix = (series, idx, official, sym, label) => {
    if (official == null || idx < 0) return "ok";
    const y = series[idx];
    if (y != null && Math.abs(y / official - 1) * 100 <= tolPct) return "ok";
    if (y != null && examples.length < 10) examples.push(`${sym} ${label}: yahoo ${y} → NSE ${official}`);
    series[idx] = official;
    return y == null ? "filled" : "corrected";
  };
  for (const [ticker, series] of Object.entries(aligned)) {
    const sym = ticker.replace(/\.NS$/, "");
    const b = bhav.closes[sym];
    if (!b) { missing++; continue; }
    checked++;
    const r1 = fix(series, i, b.close, sym, bhav.date);
    const r2 = fix(series, i - 1, b.prev, sym, axis[i - 1] || "prev");
    if (r1 === "corrected" || r2 === "corrected") corrected++;
    else if (r1 === "filled" || r2 === "filled") filled++;
    else matched++;
  }
  return { date: bhav.date, checked, matched, corrected, filled, missing, examples };
}

/** True for NSE placeholder symbols that must never be treated as real stocks. */
export function isPlaceholderSymbol(sym) {
  return /^DUMMY/i.test(String(sym || ""));
}
