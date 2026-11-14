// ─── MARKET QUADRANT — data fetch, breadth computation, caching ───────────────
// Pure module (no React). The UI lives in tradeskv.jsx.
//
// Result shape (all percentages are 0–100, 1dp):
//   overall / bias / trend / swing / momentum, pct_above_*, nnh_*, ...   (today)
//   as_of     "YYYY-MM-DD"  last trading day in the data
//   final     true when computed after that day's close (safe to cache / share)
//   history   [{ d, p200, p50, p10, nnh, sig }]  one row per trading day (≈14 months)
//   sectors   [{ name, n, p50, p200, p10, p50_chg, status }]  sorted by p50
//   leaders   [{ sym, sector, ret12m, ret3m, off_high }]       top RS stocks at highs

import { verifyAgainstBhav, isPlaceholderSymbol } from "./lib/marketChecks.js";

export const MQ_SIGNALS = ["INVEST", "SELECTIVE", "CASH"];

// Base URL for the app's own endpoints and data files. "" in the browser (same origin);
// the nightly GitHub job sets the deployed app URL so the same code runs in Node.
let API_BASE = "";
export function setApiBase(url) { API_BASE = String(url || "").replace(/\/+$/, ""); }

const LOCAL_KEY       = "td_mq_v12";  // v12: trade plans for every stock (IDEAS)
const BATCH           = 50;           // symbols per /api/spark call (server caps at 50)
const PARALLEL        = 3;            // spark calls in flight (avoids Yahoo 429s)
const RANGE           = "2y";         // 200-SMA + 52w history needs >1y
const MIN_COVERAGE    = 0.9;          // refuse to compute on <90% of the index
const VOL_DAYS        = 260;          // ~1 year of volumes: pocket pivots, EP, volume dry-up, scan backtests
// Follow-through bands (share of last-10-session pocket pivots still above their pivot close).
// Calibrated on Nifty 500, Jan–Nov 2026 (~200 sessions, ~2,600 new pivots): when FT ≥ 70, new
// pivots were higher 10 sessions later 72% of the time (avg +5.2%); at 40–70 it was 46–51%
// (≈ coin flip); below 40, 44–53%. Only the strong band carries a real edge.
export const FT_BANDS = { weak: 40, strong: 70 };
export const FT_CALIBRATION = { period: "Jan–Nov 2026", strongWin: 72, strongRet: 5.2, otherWin: 49 };
const INTRADAY_TTL_MS = 20 * 60 * 1000;
const CLOSE_MIN_IST   = 15 * 60 + 45; // treat data as final 15 min after the close
const SHARED_TABLE    = "market_quadrant";
const NIFTY500_CSV    = "https://archives.nseindia.com/content/indices/ind_nifty500list.csv";
const ALLORIGINS      = "https://api.allorigins.win/raw?url=";

const IST_MS = 5.5 * 3600 * 1000;

// ─── time helpers ────────────────────────────────────────────────────────────
function istParts(ms = Date.now()) {
  const d = new Date(ms + IST_MS);
  return { day: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}
export function istDayKey(tsSec) {
  return new Date(tsSec * 1000 + IST_MS).toISOString().slice(0, 10);
}
// Most recent weekday 15:45 IST at or before `now` (epoch ms). Holidays are not known,
// which only means an occasional extra recompute.
function lastCloseCutoff(now = Date.now()) {
  for (let back = 0; back < 8; back++) {
    const { day, dow } = istParts(now - back * 86400000);
    if (dow === 0 || dow === 6) continue;
    const cutoff = Date.parse(`${day}T00:00:00Z`) - IST_MS + CLOSE_MIN_IST * 60000;
    if (cutoff <= now) return cutoff;
  }
  return 0;
}
function isFinal(asOf, now = Date.now()) {
  const asOfCutoff = Date.parse(`${asOf}T00:00:00Z`) - IST_MS + CLOSE_MIN_IST * 60000;
  return now >= asOfCutoff;
}
const UNVERIFIED_TTL_MS = 30 * 60 * 1000; // after the close, retry until NSE's bhavcopy is out (~6pm IST)
export function isVerified(data) {
  return Boolean(data?.verification && data.verification.date === data.as_of);
}
function isFresh(entry, now = Date.now()) {
  if (!entry?.data || !entry.savedAt) return false;
  if (entry.data.final) {
    if (entry.savedAt < lastCloseCutoff(now)) return false;
    return isVerified(entry.data) || now - entry.savedAt < UNVERIFIED_TTL_MS;
  }
  return now - entry.savedAt < INTRADAY_TTL_MS;
}

// ─── local cache ─────────────────────────────────────────────────────────────
function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); } catch (_) { return null; }
}
function writeLocal(data, savedAt = Date.now()) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ data, savedAt })); } catch (_) {}
}
/** Last computed result regardless of age (for CALC / STATS), or null. */
export function getLastMarketQuadrant() {
  return readLocal()?.data ?? null;
}

// ─── shared cache (Supabase) — optional, injected by the app ─────────────────
let sharedClientGetter = null;
/** Pass a function returning a Supabase client (or null). */
export function configureSharedStore(getClient) { sharedClientGetter = getClient; }

function looksValid(d) {
  return d && MQ_SIGNALS.includes(d.overall) && Array.isArray(d.history) && typeof d.total === "number" && d.total >= 400
    && d.sector_stocks && typeof d.sector_stocks === "object" && d.environment && d.swing_state && "follow_through" in d && d.scans && d.sector_history && Array.isArray(d.themes) && "signal_backtest" in d && Array.isArray(d.scans.ep) && d.rs_of && d.scan_stats && d.plan_of;
}
async function readShared() {
  const sb = sharedClientGetter?.();
  if (!sb) return null;
  try {
    const { data, error } = await sb.from(SHARED_TABLE)
      .select("as_of, data, computed_at").order("as_of", { ascending: false }).limit(1);
    if (error || !data?.length) return null;
    const row = data[0];
    if (!looksValid(row.data)) return null;
    return { data: row.data, savedAt: Date.parse(row.computed_at) };
  } catch (_) { return null; }
}
async function writeShared(result) {
  const sb = sharedClientGetter?.();
  if (!sb || !result.final || !isVerified(result)) return; // only share NSE-verified results
  try {
    await sb.from(SHARED_TABLE).upsert(
      { as_of: result.as_of, data: result, computed_at: result.updated_at },
      { onConflict: "as_of" }
    );
  } catch (_) {}
}

// ─── fetching ────────────────────────────────────────────────────────────────
async function fetchTextWithTimeout(url, ms = 12000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(id); }
}

async function fetchNifty500Symbols() {
  try {
    const r = await fetch(API_BASE + "/nifty500.json");
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data) && data.length > 100) return data.filter(s => !isPlaceholderSymbol(s));
    }
  } catch (_) {}
  for (const url of [NIFTY500_CSV, ALLORIGINS + encodeURIComponent(NIFTY500_CSV)]) {
    try {
      const lines = (await fetchTextWithTimeout(url)).split(/\r?\n/).filter(l => l.trim());
      const syms = [];
      for (let i = 1; i < lines.length; i++) {
        const sym = lines[i].split(",")[2]?.trim().replace(/"/g, "").toUpperCase();
        if (sym && /^[A-Z0-9&_-]+$/.test(sym) && !isPlaceholderSymbol(sym)) syms.push(sym); // NSE uses DUMMY* placeholders
      }
      if (syms.length > 100) return syms;
    } catch (_) {}
  }
  return [];
}

async function fetchSectorMap() {
  try {
    const r = await fetch(API_BASE + "/nifty500_sectors.json");
    if (r.ok) return await r.json();
  } catch (_) {}
  return {};
}

// Returns { closes: { "RELIANCE.NS": { "2025-01-02": close } }, vols: { "RELIANCE.NS": { "2026-07-01": volume } } }
async function fetchSparkBatch(nsTickers) {
  const url = `${API_BASE}/api/spark?symbols=${encodeURIComponent(nsTickers.join(","))}&range=${RANGE}&interval=1d&vol=${VOL_DAYS}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Spark API HTTP ${r.status}`);
  const json = await r.json();
  const closes = {}, vols = {};
  for (const item of (json?.spark?.result ?? [])) {
    const resp = item?.response?.[0];
    const ts = resp?.timestamp;
    const cl = resp?.indicators?.quote?.[0]?.close;
    if (!item?.symbol || !Array.isArray(ts) || !Array.isArray(cl)) continue;
    const byDay = {};
    for (let i = 0; i < ts.length; i++) if (cl[i] != null) byDay[istDayKey(ts[i])] = +cl[i];
    closes[item.symbol] = byDay;
    if (Array.isArray(item.volTail)) {
      const off = ts.length - item.volTail.length, vb = {};
      // Only keep a volume when that bar also has a close: Yahoo sometimes posts a bar with no
      // close and a partial intraday volume; those days are filled from NSE's full figures instead.
      item.volTail.forEach((v, k) => { if (v != null && ts[off + k] != null && cl[off + k] != null) vb[istDayKey(ts[off + k])] = v; });
      vols[item.symbol] = vb;
    }
  }
  return { closes, vols };
}

// Runs fn over items with at most `limit` in flight; never rejects (errors → null)
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i], i); } catch (_) { results[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Common date axis; dates present for fewer than half the stocks are dropped.
export function alignByDate(allData) {
  const counts = {};
  const entries = Object.entries(allData);
  for (const [, byDay] of entries) for (const d in byDay) counts[d] = (counts[d] || 0) + 1;
  const axis = Object.keys(counts).filter(d => counts[d] >= entries.length * 0.5).sort();
  const aligned = {};
  for (const [ticker, byDay] of entries) aligned[ticker] = axis.map(d => byDay[d] ?? null);
  return { axis, aligned };
}

// ─── strength rank (RS 1–99), setup grade, trade plan ─────────────────────────
const _retAt = (closes, i, bars) => {
  const c = closes[i]; if (c == null) return null;
  for (let k = i - bars; k >= Math.max(0, i - bars - 5); k--) if (closes[k] != null) return c / closes[k] - 1;
  return null;
};
/** IBD-style strength score: 40% last 3 months + 20% each for the three quarters before. */
export function rsScore(closes, i = closes.length - 1) {
  const r3 = _retAt(closes, i, 63), r6 = _retAt(closes, i, 126), r9 = _retAt(closes, i, 189), r12 = _retAt(closes, i, 252);
  if (r3 == null) return null;
  const parts = [[r3, 0.4], [r6, 0.2], [r9, 0.2], [r12, 0.2]].filter(([v]) => v != null);
  const w = parts.reduce((a, [, x]) => a + x, 0);
  return parts.reduce((a, [v, x]) => a + v * x, 0) / w;
}
/** Map a score to 1–99 using the Nifty 500's percentile cut-offs (array of 98 ascending scores). */
export function rsRating(score, breaks) {
  if (score == null || !breaks?.length) return null;
  let lo = 0, hi = breaks.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (breaks[m] <= score) lo = m + 1; else hi = m; }
  return Math.max(1, Math.min(99, lo + 1));
}
/**
 * Setup grade from up to 7 checks. Missing inputs are skipped (graded out of what's known).
 * A ≥ 85% of known checks, B ≥ 57%, else C.
 */
export function gradeSetup({ closes, vols, i = closes.length - 1, s50, s200, rs, sectorStatus, envOk }) {
  const c = closes[i];
  const win = closes.slice(Math.max(0, i - 251), i + 1).filter(x => x != null);
  const hi = win.length ? Math.max(...win) : null;
  const last10 = closes.slice(i - 9, i + 1).filter(x => x != null);
  const range10 = last10.length >= 8 ? Math.max(...last10) / Math.min(...last10) - 1 : null;
  let volDry = null;
  if (vols) {
    const v10 = vols.slice(i - 9, i + 1).filter(x => x != null), v50 = vols.slice(i - 59, i - 9).filter(x => x != null);
    if (v10.length >= 6 && v50.length >= 25) volDry = (v10.reduce((a, b) => a + b, 0) / v10.length) < 0.85 * (v50.reduce((a, b) => a + b, 0) / v50.length);
  }
  const checks = [
    ["Strength rank 80+", rs == null ? null : rs >= 80],
    ["Above 50 & 200-day SMA", s50 == null || s200 == null || c == null ? null : c > s50 && c > s200],
    ["Within 10% of 52-week high", hi == null || c == null ? null : c >= hi * 0.9],
    ["Tight: last 10 closes within 8%", range10 == null ? null : range10 <= 0.08],
    ["Volume drying up", volDry],
    ["Sector HOT/WARM", sectorStatus == null ? null : ["HOT", "WARM"].includes(sectorStatus)],
    ["Market allows new longs", envOk == null ? null : envOk],
  ];
  const known = checks.filter(x => x[1] != null), pass = known.filter(x => x[1]).length;
  const ratio = known.length ? pass / known.length : 0;
  return { grade: ratio >= 0.85 ? "A" : ratio >= 0.57 ? "B" : "C", pass, of: known.length, checks, range10, volDry };
}
/**
 * Suggested trade from closes: entry just above the 10-day closing high (or today's close if it
 * is breaking out), stop just under the last 5 closes, risk capped at 8%.
 */
export function tradePlan(closes, i = closes.length - 1) {
  const c = closes[i];
  const w10 = closes.slice(Math.max(0, i - 9), i + 1).filter(x => x != null);
  const w5 = closes.slice(Math.max(0, i - 4), i + 1).filter(x => x != null);
  if (c == null || w10.length < 5) return null;
  const pivot = Math.max(...w10.slice(0, -1).length ? w10.slice(0, -1) : w10);
  const breaking = c >= pivot;
  const entry = +(breaking ? c : pivot * 1.002).toFixed(2);
  let stop = +(Math.min(...w5) * 0.99).toFixed(2), note = null;
  if (stop >= entry) stop = +(entry * 0.95).toFixed(2);
  if ((entry - stop) / entry > 0.08) { stop = +(entry * 0.92).toFixed(2); note = "Stop capped at 8% below entry"; }
  return { entry, stop, riskPct: +(((entry - stop) / entry) * 100).toFixed(1), breaking, pivot: +pivot.toFixed(2), note };
}

/**
 * Historical check of each scan: for every session in the last ~250 with 10 sessions of future,
 * which stocks qualified, and how did they do over the next 10 sessions vs the average stock?
 * Returns { scanId: { signals, days, hit, avg, excess, from, to } }.
 */
export function scanBacktest(axis, stocks, volumes, last, horizon = 10, lookback = 250) {
  const ids = ["pivots", "ep", "tight", "reclaim50", "leaders"];
  const acc = Object.fromEntries(ids.map(id => [id, { n: 0, up: 0, sum: 0, ex: 0, days: new Set() }]));
  const start = Math.max(60, last - horizon - lookback), end = last - horizon;
  for (let t = start; t <= end; t++) {
    let uSum = 0, uN = 0;
    const fwd = new Map();
    for (const st of stocks) {
      const c0 = st.closes[t], c1 = st.closes[t + horizon];
      if (c0 == null || c1 == null) continue;
      const r = c1 / c0 - 1; fwd.set(st, r); uSum += r; uN++;
    }
    if (!uN) continue;
    const uAvg = uSum / uN;
    const hit = (id, st) => { const r = fwd.get(st); if (r == null) return; const a = acc[id]; a.n++; a.sum += r; a.ex += r - uAvg; if (r > 0) a.up++; a.days.add(t); };
    for (const st of stocks) {
      if (!fwd.has(st)) continue;
      const c = st.closes, p = c[t - 1], x = c[t];
      if (p == null || x == null) continue;
      const v = volumes?.[st.ticker];
      let avg50 = null;
      if (v && v[t] != null && v[t - 1] != null) {
        let sm = 0, cn = 0; for (let k = t - 50; k < t; k++) if (v[k] != null) { sm += v[k]; cn++; }
        if (cn >= 20) avg50 = sm / cn;
      }
      const chg = x / p - 1;
      if (avg50 != null && chg >= 0.045 && v[t] > v[t - 1] && v[t] > avg50) hit("pivots", st);
      if (avg50 != null && chg >= 0.08 && v[t] >= 3 * avg50) hit("ep", st);
      const s50 = st.s50[t], s200 = st.s200[t], h = st.h252[t];
      if (s50 != null && s200 != null && h != null && x > s50 && x > s200 && x >= h * 0.9) {
        const w = c.slice(t - 9, t + 1).filter(y => y != null);
        if (w.length >= 8 && Math.max(...w) / Math.min(...w) - 1 <= 0.06) hit("tight", st);
      }
      if (s50 != null && st.s50[t - 1] != null && x > s50 && p <= st.s50[t - 1]) hit("reclaim50", st);
      if (st.s10[t] != null && s50 != null && s200 != null && h != null && x > st.s10[t] && x > s50 && x > s200 && x >= h * 0.95) hit("leaders", st);
    }
  }
  const out = {};
  for (const id of ids) {
    const a = acc[id];
    out[id] = a.n ? { signals: a.n, days: a.days.size, hit: Math.round((a.up / a.n) * 100), avg: Math.round((a.sum / a.n) * 1000) / 10,
      excess: Math.round((a.ex / a.n) * 1000) / 10, from: axis[start], to: axis[end], horizon } : null;
  }
  return out;
}

/** Volumes on the same date axis as the closes: { ticker: [volume|null] }. */
export function alignVolumes(axis, allVol) {
  const out = {};
  for (const [t, byDay] of Object.entries(allVol || {})) out[t] = axis.map(d => byDay[d] ?? null);
  return out;
}

/**
 * Follow-through: do strong breakout days keep going?
 *   Pocket pivot = close ≥ 4.5% above the previous close, on volume above both the
 *   previous day's and the prior 50-day average.
 *   FT rate on day t = % of pivots from sessions t-10 … t-1 still closing above their
 *   pivot-day close on t. Also returns how many pivots there were and their average gain.
 * Returns { rate, events, avg_gain, label, history: [{ d, rate, events, fresh }] } or null.
 */
export function computeFollowThrough(axis, aligned, volumes, lookback = 10, keep = 40) {
  if (!volumes) return null;
  const tickers = Object.keys(aligned).filter(t => volumes[t]);
  if (tickers.length < 50) return null;
  const n = axis.length;
  const pivots = []; // [ticker, row]
  for (const t of tickers) {
    const c = aligned[t], v = volumes[t];
    for (let i = 51; i < n; i++) {
      if (c[i] == null || c[i - 1] == null || v[i] == null || v[i - 1] == null) continue;
      if (c[i] / c[i - 1] - 1 < 0.045 || v[i] <= v[i - 1]) continue;
      let sum = 0, cnt = 0;
      for (let k = i - 50; k < i; k++) if (v[k] != null) { sum += v[k]; cnt++; }
      if (cnt >= 20 && v[i] > sum / cnt) pivots.push([t, i]);
    }
  }
  const byRow = new Map();
  for (const p of pivots) { if (!byRow.has(p[1])) byRow.set(p[1], []); byRow.get(p[1]).push(p[0]); }
  const firstVolRow = Math.min(...tickers.map(t => volumes[t].findIndex(x => x != null)).filter(i => i >= 0));
  const history = [];
  for (let t = Math.max(firstVolRow + 51 + lookback, lookback); t < n; t++) {
    let held = 0, events = 0, gain = 0;
    for (let i = t - lookback; i < t; i++) {
      for (const tk of byRow.get(i) || []) {
        const now = aligned[tk][t], piv = aligned[tk][i];
        if (now == null || piv == null) continue;
        events++; gain += now / piv - 1; if (now > piv) held++;
      }
    }
    history.push({ d: axis[t], rate: events ? Math.round((held / events) * 100) : null, events, avg_gain: events ? Math.round((gain / events) * 1000) / 10 : null, fresh: (byRow.get(t) || []).length });
  }
  const lastH = history[history.length - 1];
  if (!lastH) return null;
  const label = lastH.rate == null ? "NO PIVOTS" : lastH.rate >= FT_BANDS.strong ? "STRONG" : lastH.rate >= FT_BANDS.weak ? "MIXED" : "WEAK";
  return { rate: lastH.rate, events: lastH.events, avg_gain: lastH.avg_gain, fresh: lastH.fresh, label, history: history.slice(-keep) };
}

// ─── series math ─────────────────────────────────────────────────────────────
export function smaSeries(arr, period, minP = Math.ceil(period * 0.75)) {
  const out = new Array(arr.length).fill(null);
  const buf = new Array(period).fill(null);
  let sum = 0, cnt = 0, head = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i], old = buf[head];
    buf[head] = v; head = (head + 1) % period;
    if (v != null) { sum += v; cnt++; }
    if (old != null) { sum -= old; cnt--; }
    if (cnt >= minP) out[i] = sum / cnt;
  }
  return out;
}
// O(n) rolling max/min (monotonic deque), nulls skipped
function rollExtreme(arr, period, isMax) {
  const out = new Array(arr.length).fill(null);
  const dq = [];
  let h = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v != null) {
      while (dq.length > h && (isMax ? arr[dq[dq.length - 1]] <= v : arr[dq[dq.length - 1]] >= v)) dq.pop();
      dq.push(i);
    }
    while (dq.length > h && dq[h] <= i - period) h++;
    out[i] = dq.length > h ? arr[dq[h]] : null;
  }
  return out;
}
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const sectorStatus = (p) => (p == null ? "—" : p >= 70 ? "HOT" : p >= 50 ? "WARM" : p >= 30 ? "COOL" : "COLD");

/** Pure computation from aligned closes. Exported for testing. */
export function computeFromAligned(axis, aligned, sectorMap = {}, now = Date.now(), verification = null, volumes = null, themeMap = null, events = null, opts = {}) {
  const stocks = Object.entries(aligned)
    .filter(([, closes]) => closes.filter(c => c != null).length >= 150)
    .map(([ticker, closes]) => ({
      ticker,
      sym: ticker.replace(/\.NS$/, ""),
      closes,
      s200: smaSeries(closes, 200, 150),
      s50:  smaSeries(closes, 50, 40),
      s20:  smaSeries(closes, 20, 15),
      s10:  smaSeries(closes, 10, 8),
      h252: rollExtreme(closes, 252, true), l252: rollExtreme(closes, 252, false),
      h20:  rollExtreme(closes, 20, true),  l20:  rollExtreme(closes, 20, false),
      h65:  rollExtreme(closes, 65, true),  l65:  rollExtreme(closes, 65, false),
    }));

  const N = stocks.length;
  if (N < 50) throw new Error(`Too few valid stocks (${N}). Yahoo Finance may be throttling — try again later.`);
  const nRows = axis.length;
  const last = nRows - 1;

  // % of stocks above an SMA at a row; null when no stock has data that day
  const pctAt = (field, i, list = stocks) => {
    let cnt = 0, tot = 0;
    for (const s of list) {
      const c = s.closes[i], sm = s[field][i];
      if (c != null && sm != null) { tot++; if (c > sm) cnt++; }
    }
    return tot > 0 ? (cnt / tot) * 100 : null;
  };
  const p200 = [], p50 = [], p20 = [], p10 = [], nnh52 = [];
  for (let i = 0; i < nRows; i++) {
    p200.push(pctAt("s200", i)); p50.push(pctAt("s50", i)); p20.push(pctAt("s20", i)); p10.push(pctAt("s10", i));
    let nh = 0, nl = 0;
    for (const s of stocks) {
      const c = s.closes[i];
      if (c == null) continue;
      if (s.h252[i] != null && c >= s.h252[i] * 0.99) nh++;
      if (s.l252[i] != null && c <= s.l252[i] * 1.01) nl++;
    }
    nnh52.push(nh - nl);
  }

  // ── Model (after Nitin R's Market Quadrant framework) ──────────────────────
  // Bias:     regime from % above 200-SMA; it only flips after BIAS_DAYS straight
  //           sessions on the other side of 50% (otherwise "turning").
  // Trend:    UP = most stocks above 50-SMA AND 52w net new highs > 0 for 3 sessions;
  //           DOWN = the reverse; anything mixed = SIDEWAYS.
  // Swing:    UPSWING = ≥50% above 10-SMA and 10-day breadth ≥ 20-day breadth;
  //           DOWNSWING = the reverse; otherwise CHOPPY.
  // Momentum: 4-week change in % above 50-SMA. Sign = its 10-week average (POSITIVE/
  //           NEGATIVE); direction = latest 4-week change vs that average (IMPROVING/WORSENING).
  const BIAS_DAYS = 20;
  const LOWS_OK_MAX = 5; // ≈1% of the index at 52-week lows — beyond that, no full-size positions
  const regime = new Array(nRows).fill(null), sideRun = new Array(nRows).fill(0), side = new Array(nRows).fill(null);
  {
    let cur = null, s = null, run = 0;
    for (let i = 0; i < nRows; i++) {
      const v = p200[i];
      if (v != null) {
        const now = v >= 50 ? "BULL" : "BEAR";
        if (now === s) run++; else { s = now; run = 1; }
        if (run >= BIAS_DAYS) cur = s;
      }
      regime[i] = cur ?? s; side[i] = s; sideRun[i] = run;
    }
  }
  const trendAt = (i) => {
    if (p50[i] == null || i < 2) return null;
    const pos = nnh52[i] > 0 && nnh52[i - 1] > 0 && nnh52[i - 2] > 0;
    const neg = nnh52[i] < 0 && nnh52[i - 1] < 0 && nnh52[i - 2] < 0;
    return p50[i] >= 50 && pos ? "UP" : p50[i] < 50 && neg ? "DOWN" : "SIDEWAYS";
  };
  const swingAt = (i) => {
    if (p10[i] == null || p20[i] == null) return null;
    return p10[i] >= 50 && p10[i] >= p20[i] ? "UPSWING" : p10[i] < 50 && p10[i] <= p20[i] ? "DOWNSWING" : "CHOPPY";
  };
  const momentumAt = (i) => {
    const w = [];
    for (let k = 0; k < 14; k++) {
      const idx = i - k * 5;
      if (idx < 49) break;
      if (p50[idx] != null) w.unshift(p50[idx]);
    }
    const roc = w.slice(4).map((v, k) => v - w[k]);
    if (!roc.length) return { rising: false, raw: 0, ma: 0 };
    const ma = roc.reduce((a, b) => a + b, 0) / roc.length;
    const raw = roc[roc.length - 1];
    return { rising: raw > ma, raw, ma };
  };
  const signalAt = (i) => {
    if (i < 199 || p200[i] == null || p50[i] == null || p10[i] == null) return null;
    const b = (regime[i] === "BULL" ? 1 : 0) + (trendAt(i) === "UP" ? 1 : 0) + (swingAt(i) === "UPSWING" ? 1 : 0) + (momentumAt(i).rising ? 1 : 0);
    return b >= 3 ? "INVEST" : b === 2 ? "SELECTIVE" : "CASH";
  };

  // ── today ──
  const pct200 = r1(p200[last] ?? 0), pct50 = r1(p50[last] ?? 0), pct20 = r1(p20[last] ?? 0), pct10 = r1(p10[last] ?? 0);
  let above200 = 0, above50 = 0, above10 = 0, newHighs = 0, newLows = 0;
  let nnh20h = 0, nnh20l = 0, nnh65h = 0, nnh65l = 0;
  for (const s of stocks) {
    const c = s.closes[last];
    if (c == null) continue;
    if (s.s200[last] != null && c > s.s200[last]) above200++;
    if (s.s50[last]  != null && c > s.s50[last])  above50++;
    if (s.s10[last]  != null && c > s.s10[last])  above10++;
    if (s.h252[last] != null && c >= s.h252[last] * 0.99) newHighs++;
    if (s.l252[last] != null && c <= s.l252[last] * 1.01) newLows++;
    if (s.h20[last]  != null && c >= s.h20[last]  * 0.99) nnh20h++;
    if (s.l20[last]  != null && c <= s.l20[last]  * 1.01) nnh20l++;
    if (s.h65[last]  != null && c >= s.h65[last]  * 0.99) nnh65h++;
    if (s.l65[last]  != null && c <= s.l65[last]  * 1.01) nnh65l++;
  }
  const nnh52w = newHighs - newLows, nnh20 = nnh20h - nnh20l, nnh65 = nnh65h - nnh65l;
  const bias = regime[last] || (pct200 >= 50 ? "BULL" : "BEAR");
  const biasTurning = Boolean(side[last] && side[last] !== bias); // crossed 50% but not yet sustained
  const biasDays = sideRun[last];                                 // sessions on the current side of 50%
  const trend = trendAt(last) || "SIDEWAYS";
  const swingState = swingAt(last) || "CHOPPY";
  const swing = pct10 >= 70 ? "HOT" : pct10 >= 50 ? "WARM" : pct10 >= 30 ? "COOL" : "COLD"; // heat (kept for compatibility)
  const mom = momentumAt(last);
  const momentum = mom.rising ? "RISING" : "FALLING";
  const momentumSign = mom.ma > 0 ? "POSITIVE" : "NEGATIVE"; // smoothed momentum level (10-wk avg of 4-wk ROC)
  const momentumDir = mom.rising ? "IMPROVING" : "WORSENING";
  const overall = signalAt(last) ?? "CASH";

  // Breadth thrust: %>10-SMA now > 40 after being < 25 within the last 12 sessions
  let thrustDetected = false;
  if (pct10 > 40) {
    for (let k = 1; k <= 12; k++) {
      const v = p10[last - k];
      if (v != null && v < 25) { thrustDetected = true; break; }
    }
  }

  // ── Trading environment ──
  // Lockout rally: long-term bear, but short-term breadth went from washed-out to
  // stretched within 15 sessions — stocks run away without normal pullback entries.
  let minP10 = Infinity;
  for (let k = 0; k <= 15 && last - k >= 0; k++) if (p10[last - k] != null) minP10 = Math.min(minP10, p10[last - k]);
  const lockout = bias === "BEAR" && pct10 >= 70 && minP10 < 30;
  const envName = bias === "BULL" && trend === "UP" && swingState === "UPSWING" ? "EASY MONEY"
    : bias === "BEAR" && trend === "DOWN" && swingState === "DOWNSWING" ? "NO MONEY" : "HARD MONEY";
  const ENV_TEXT = {
    "EASY MONEY": "Broad participation — most clean setups follow through. Normal size; let winners run.",
    "HARD MONEY": "Mixed breadth — only the best setups and stronger pockets work. Be selective, size smaller, take profits quicker.",
    "NO MONEY": "Most structures are breaking down. Protect capital: sit out or trade very small.",
  };
  const environment = {
    name: envName,
    text: ENV_TEXT[envName],
    lockout,
    lockout_text: lockout
      ? "Lockout rally: stocks are running without normal pullback entries. Options: (1) drop to a lower timeframe for entries, (2) accept unconventional entries on the daily chart, or (3) sit out until a pause builds fresh setups. Index ETFs often give the cleanest risk/reward here."
      : null,
  };

  let score = Math.min(pct10 * 0.4, 40);
  if (nnh20 > 0) score += 20;
  if (nnh65 > 0) score += 20;
  if (mom.rising) score += 20;

  // ── history (every row that has a signal) ──
  // b/t/s/m/e = bias regime, trend, swing, momentum (sign+dir), environment on that day
  const envAt = (i) => {
    const b = regime[i], t = trendAt(i), sw = swingAt(i);
    return b === "BULL" && t === "UP" && sw === "UPSWING" ? "EASY MONEY" : b === "BEAR" && t === "DOWN" && sw === "DOWNSWING" ? "NO MONEY" : "HARD MONEY";
  };
  const history = [];
  for (let i = 199; i < nRows; i++) {
    const m = momentumAt(i);
    history.push({
      d: axis[i], p200: r1(p200[i]), p50: r1(p50[i]), p20: r1(p20[i]), p10: r1(p10[i]), nnh: nnh52[i], sig: signalAt(i),
      b: regime[i], t: trendAt(i), s: swingAt(i), m: `${m.ma > 0 ? "POSITIVE" : "NEGATIVE"} ${m.rising ? "IMPROVING" : "WORSENING"}`, e: envAt(i),
    });
  }
  let phaseWeeks = 0;
  for (let w = 1; w <= 52; w++) {
    if (signalAt(last - w * 5) === overall) phaseWeeks++; else break;
  }

  // ── to upgrade (each condition carries its unit for display) ──
  const toUpgrade = [];
  const nnhPos3 = nnh52[last] > 0 && nnh52[last - 1] > 0 && nnh52[last - 2] > 0;
  const investConds = () => {
    const c = [];
    if (bias !== "BULL") {
      if (pct200 >= 50) c.push({ metric: "Bias: sessions with ≥50% above 200-SMA", current: biasDays, needs: BIAS_DAYS, gap: BIAS_DAYS - biasDays, unit: "d" });
      else c.push({ metric: "Long-term breadth (200-SMA), then hold 20 sessions", current: pct200, needs: 50, gap: r1(50 - pct200), unit: "%" });
    }
    if (trend !== "UP") {
      if (pct50 < 50) c.push({ metric: "Medium breadth (50-SMA)", current: pct50, needs: 50, gap: r1(50 - pct50), unit: "%" });
      if (!nnhPos3) c.push({ metric: "Net New Highs (52w) positive 3 sessions", current: nnh52w, needs: "> 0 ×3", gap: nnh52w > 0 ? "hold" : Math.abs(nnh52w) + 1, unit: "" });
    }
    return c;
  };
  const swingConds = () => {
    const c = [];
    if (swingState !== "UPSWING") {
      if (pct10 < 50) c.push({ metric: "Swing breadth (10-SMA)", current: pct10, needs: 50, gap: r1(50 - pct10), unit: "%" });
      if (pct10 < pct20) c.push({ metric: "10-day breadth ≥ 20-day breadth", current: pct10, needs: `≥ ${pct20}%`, gap: r1(pct20 - pct10), unit: "%" });
    }
    if (!mom.rising) c.push({ metric: "Momentum (4-wk ROC, pts)", current: r1(mom.raw), needs: `> ${r1(mom.ma)}`, gap: r1(mom.ma - mom.raw), unit: "" });
    return c;
  };
  if (overall === "CASH") {
    const sc = swingConds(); if (sc.length) toUpgrade.push({ to: "SELECTIVE", conditions: sc });
    const ic = investConds(); if (ic.length) toUpgrade.push({ to: "INVEST", conditions: ic });
  } else if (overall === "SELECTIVE") {
    const ic = [...investConds(), ...swingConds()]; if (ic.length) toUpgrade.push({ to: "INVEST", conditions: ic });
  }

  // ── sectors ──
  const bySector = {};
  for (const s of stocks) (bySector[sectorMap[s.sym] || "Other"] ||= []).push(s);
  const sectors = Object.entries(bySector)
    .filter(([, list]) => list.length >= 3)
    .map(([name, list]) => {
      const sp50 = pctAt("s50", last, list);
      const sp50Prev = last >= 20 ? pctAt("s50", last - 20, list) : null;
      const sp50D1 = last >= 1 ? pctAt("s50", last - 1, list) : null;
      return {
        name, n: list.length,
        p50: r1(sp50), p200: r1(pctAt("s200", last, list)), p10: r1(pctAt("s10", last, list)),
        p50_chg: sp50 != null && sp50Prev != null ? r1(sp50 - sp50Prev) : null,
        status: sectorStatus(sp50),
        status_d1: sectorStatus(sp50D1),
      };
    })
    .sort((a, b) => (b.p50 ?? -1) - (a.p50 ?? -1));

  // ── leaders: above all 3 SMAs, within 5% of 52w high, ranked by 12-month return ──
  const retOver = (s, bars) => {
    const c = s.closes[last];
    for (let k = last - bars; k >= Math.max(0, last - bars - 5); k--) if (s.closes[k] != null) return c / s.closes[k] - 1;
    return null;
  };
  const leaders = stocks
    .filter(s => {
      const c = s.closes[last];
      return c != null && s.s10[last] != null && s.s50[last] != null && s.s200[last] != null && s.h252[last] != null
        && c > s.s10[last] && c > s.s50[last] && c > s.s200[last] && c >= s.h252[last] * 0.95;
    })
    .map(s => ({
      sym: s.sym,
      sector: sectorMap[s.sym] || "Other",
      ret12m: r1((retOver(s, 246) ?? NaN) * 100),
      ret3m: r1((retOver(s, 63) ?? NaN) * 100),
      off_high: r1((s.closes[last] / s.h252[last] - 1) * 100),
    }))
    .map(l => ({ ...l, ret12m: Number.isFinite(l.ret12m) ? l.ret12m : null, ret3m: Number.isFinite(l.ret3m) ? l.ret3m : null }))
    .sort((a, b) => (b.ret12m ?? b.ret3m ?? -999) - (a.ret12m ?? a.ret3m ?? -999))
    .slice(0, 15);

  // ── yesterday's leaders (to flag new ones) ──
  const isLeaderAt = (s, i) => {
    const c = s.closes[i];
    return c != null && s.s10[i] != null && s.s50[i] != null && s.s200[i] != null && s.h252[i] != null
      && c > s.s10[i] && c > s.s50[i] && c > s.s200[i] && c >= s.h252[i] * 0.95;
  };
  const leadersNew = leaders.filter(l => {
    const st = stocks.find(x => x.sym === l.sym);
    return st && last >= 1 && !isLeaderAt(st, last - 1);
  }).map(l => l.sym);

  // ── SCANS (each list strongest first, max 15) ──
  const ret3 = (s) => { const r = retOver(s, 63); return Number.isFinite(r) ? r1(r * 100) : null; };
  const base = (s) => ({ sym: s.sym, sector: sectorMap[s.sym] || "Other", ret3m: ret3(s),
    off_high: s.h252[last] != null && s.closes[last] != null ? r1((s.closes[last] / s.h252[last] - 1) * 100) : null });
  const byRs = (a, b) => (b.ret3m ?? -999) - (a.ret3m ?? -999);
  // 1. Pocket pivots today: ≥4.5% up on volume above yesterday's and the 50-day average
  const scanPivots = [];
  if (volumes) {
    for (const s of stocks) {
      const v = volumes[s.ticker]; const c = s.closes;
      if (!v || c[last] == null || c[last - 1] == null || v[last] == null || v[last - 1] == null) continue;
      const chg = c[last] / c[last - 1] - 1;
      if (chg < 0.045 || v[last] <= v[last - 1]) continue;
      let sum = 0, cnt = 0;
      for (let k = last - 50; k < last; k++) if (k >= 0 && v[k] != null) { sum += v[k]; cnt++; }
      if (cnt < 20 || v[last] <= sum / cnt) continue;
      scanPivots.push({ ...base(s), chg: r1(chg * 100), volx: r1(v[last] / (sum / cnt)) });
    }
    scanPivots.sort((a, b) => b.volx * b.chg - a.volx * a.chg);
  }
  // 2. Tight near highs: above 50 & 200-SMA, within 10% of 52w high, last 10 closes in a ≤6% range
  const scanTight = stocks.filter(s => {
    const c = s.closes[last];
    if (c == null || s.s50[last] == null || s.s200[last] == null || s.h252[last] == null) return false;
    if (!(c > s.s50[last] && c > s.s200[last] && c >= s.h252[last] * 0.9)) return false;
    const w = s.closes.slice(last - 9, last + 1).filter(x => x != null);
    if (w.length < 8) return false;
    return (Math.max(...w) / Math.min(...w) - 1) <= 0.06;
  }).map(s => {
    const w = s.closes.slice(last - 9, last + 1).filter(x => x != null);
    return { ...base(s), range10: r1((Math.max(...w) / Math.min(...w) - 1) * 100) };
  }).sort(byRs);
  // 3. Reclaimed the 50-SMA today (was below yesterday)
  const scanReclaim = stocks.filter(s => {
    const c = s.closes[last], p = s.closes[last - 1];
    return c != null && p != null && s.s50[last] != null && s.s50[last - 1] != null && c > s.s50[last] && p <= s.s50[last - 1];
  }).map(s => ({ ...base(s), a200: s.s200[last] != null && s.closes[last] > s.s200[last] })).sort(byRs);
  // 4. Episodic pivots: ≥8% up on ≥3× the 50-day average volume in the last 5 sessions,
  //    still holding within 3% of that day's close; flagged when results were due around it.
  const scanEp = [];
  if (volumes) {
    for (const [ticker, c] of Object.entries(aligned)) {
      const v = volumes[ticker]; if (!v) continue;
      const sym = ticker.replace(/\.NS$/, "");
      for (let i = last; i >= Math.max(51, last - 4); i--) {
        if (c[i] == null || c[i - 1] == null || v[i] == null) continue;
        const chg = c[i] / c[i - 1] - 1; if (chg < 0.08) continue;
        let sum = 0, cnt = 0; for (let k = i - 50; k < i; k++) if (v[k] != null) { sum += v[k]; cnt++; }
        if (cnt < 20 || v[i] < 3 * (sum / cnt) || c[last] == null || c[last] < c[i] * 0.97) continue;
        const day = axis[i];
        const res = (events?.[sym] || []).some(d => d <= day && (Date.parse(day) - Date.parse(d)) / 86400000 <= 4);
        const st = stocks.find(x => x.sym === sym);
        scanEp.push({ sym, sector: sectorMap[sym] || "Other", d: day, chg: r1(chg * 100), volx: r1(v[i] / (sum / cnt)),
          held: r1((c[last] / c[i] - 1) * 100), results: res, ret3m: st ? ret3(st) : null });
        break;
      }
    }
    scanEp.sort((a, b) => (b.results - a.results) || (b.d > a.d ? 1 : b.d < a.d ? -1 : 0) || (b.volx * b.chg - a.volx * a.chg));
  }
  // 5. IPO bases: listed within ~12 months (20–260 sessions of history), trading within 5% of
  //    the highest close since listing (or breaking it today)
  const scanIpo = [];
  for (const [ticker, c] of Object.entries(aligned)) {
    const first = c.findIndex(x => x != null);
    const age = last - first;
    if (first < 0 || age < 20 || age > 260 || c[last] == null) continue;
    let hi = -Infinity; for (let k = first; k < last; k++) if (c[k] != null) hi = Math.max(hi, c[k]);
    if (c[last] < hi * 0.95) continue;
    const sym = ticker.replace(/\.NS$/, "");
    scanIpo.push({ sym, sector: sectorMap[sym] || "Other", days: age, from_listing: r1((c[last] / c[first] - 1) * 100),
      off_high: r1((c[last] / Math.max(hi, c[last]) - 1) * 100), breakout: c[last] > hi });
  }
  scanIpo.sort((a, b) => (b.breakout - a.breakout) || (b.from_listing - a.from_listing));

  const scans = {
    pivots: scanPivots.slice(0, 15), pivots_total: scanPivots.length,
    ep: scanEp.slice(0, 15), ep_total: scanEp.length,
    ipo: scanIpo.slice(0, 15), ipo_total: scanIpo.length,
    tight: scanTight.slice(0, 15), tight_total: scanTight.length,
    reclaim50: scanReclaim.slice(0, 15), reclaim50_total: scanReclaim.length,
  };

  // ── sector momentum: equal-weight 1-month return of each sector's stocks ──
  for (const sec of sectors) {
    const rets = (bySector[sec.name] || []).map(s => retOver(s, 21)).filter(Number.isFinite);
    sec.ret1m = rets.length ? r1((rets.reduce((x, y) => x + y, 0) / rets.length) * 100) : null;
  }
  const momentumLeaders = sectors.filter(x => x.ret1m != null && x.ret1m > 0)
    .sort((x, y) => y.ret1m - x.ret1m).slice(0, 5).map(x => ({ name: x.name, ret1m: x.ret1m }));

  // ── sector rotation: weekly breadth (% above 50-SMA) and 1-month return, last 13 weeks ──
  const retFrom = (st, i, bars) => {
    const c = st.closes[i]; if (c == null) return null;
    for (let k = i - bars; k >= Math.max(0, i - bars - 5); k--) if (st.closes[k] != null) return c / st.closes[k] - 1;
    return null;
  };
  const weekRows = [];
  for (let k = 12; k >= 0; k--) if (last - k * 5 >= 0) weekRows.push(last - k * 5);
  const sectorHistory = {};
  for (const sec of sectors) {
    const list = bySector[sec.name] || [];
    sectorHistory[sec.name] = weekRows.map(i => {
      const rets = list.map(st => retFrom(st, i, 21)).filter(Number.isFinite);
      return { d: axis[i], p50: r1(pctAt("s50", i, list)), ret1m: rets.length ? r1((rets.reduce((x, y) => x + y, 0) / rets.length) * 100) : null };
    });
    // Rotation quadrant: breadth level (≥50) × 4-week breadth change (rising/falling)
    const h = sectorHistory[sec.name], now = h[h.length - 1]?.p50, ago = h[h.length - 5]?.p50;
    const rising = now != null && ago != null ? now > ago : null;
    sec.p50_4w = now != null && ago != null ? r1(now - ago) : null;
    sec.quadrant = now == null || rising == null ? null
      : now >= 50 ? (rising ? "LEADING" : "WEAKENING") : (rising ? "IMPROVING" : "LAGGING");
  }

  // ── themes (NSE thematic indices): breadth, 1-month return, strongest members ──
  const bySym = Object.fromEntries(stocks.map(st => [st.sym, st]));
  const themes = Object.entries(themeMap || {}).map(([name, syms]) => {
    const list = syms.map(x => bySym[x]).filter(Boolean);
    if (list.length < 4) return null;
    const tp = pctAt("s50", last, list), tpPrev = last >= 20 ? pctAt("s50", last - 20, list) : null;
    const rets = list.map(st => retFrom(st, last, 21)).filter(Number.isFinite);
    const top = list.filter(st => st.closes[last] != null && st.s50[last] != null && st.closes[last] > st.s50[last])
      .map(st => ({ sym: st.sym, ret3m: r1((retFrom(st, last, 63) ?? NaN) * 100) }))
      .filter(x => Number.isFinite(x.ret3m)).sort((a, b) => b.ret3m - a.ret3m).slice(0, 6);
    return { name, n: list.length, p50: r1(tp), p50_chg: tp != null && tpPrev != null ? r1(tp - tpPrev) : null,
      status: sectorStatus(tp), ret1m: rets.length ? r1((rets.reduce((x, y) => x + y, 0) / rets.length) * 100) : null, top };
  }).filter(Boolean).sort((a, b) => (b.p50 ?? -1) - (a.p50 ?? -1));

  // ── per-sector rankings: the stocks carrying each sector, strongest first ──
  // Rank: above 50-SMA first, then 3-month return (relative strength), then 1-month.
  const r1n = (v) => (Number.isFinite(v) ? r1(v * 100) : null);
  const sectorStocks = {};
  for (const [name, list] of Object.entries(bySector)) {
    sectorStocks[name] = list
      .filter(s => s.closes[last] != null)
      .map(s => {
        const c = s.closes[last];
        return {
          sym: s.sym,
          ret1m: r1n(retOver(s, 21)), ret3m: r1n(retOver(s, 63)),
          off_high: s.h252[last] != null ? r1((c / s.h252[last] - 1) * 100) : null,
          a50: s.s50[last] != null && c > s.s50[last],
          a200: s.s200[last] != null && c > s.s200[last],
        };
      })
      .sort((a, b) => (b.a50 - a.a50) || ((b.ret3m ?? -999) - (a.ret3m ?? -999)) || ((b.ret1m ?? -999) - (a.ret1m ?? -999)))
      .slice(0, 10);
  }

  // ── strength rank (RS 1–99) for every stock, relative to this universe (or given cut-offs) ──
  const scores = stocks.map(st => [st.sym, rsScore(st.closes, last)]).filter(([, v]) => v != null);
  const sorted = scores.map(([, v]) => v).sort((a, b) => a - b);
  const rsBreaks = opts.rsBreaks || (sorted.length >= 50 ? Array.from({ length: 98 }, (_, k) => r1(sorted[Math.floor(((k + 1) / 99) * sorted.length)] * 1000) / 1000) : null);
  const rsOf = {};
  for (const [sym, v] of scores) rsOf[sym] = rsRating(v, rsBreaks);
  for (const [ticker, closes] of Object.entries(aligned)) { // IPOs / short histories too
    const sym = ticker.replace(/\.NS$/, "");
    if (rsOf[sym] == null) { const v = rsScore(closes, last); if (v != null) rsOf[sym] = rsRating(v, rsBreaks); }
  }
  const envOk = overall !== "CASH" && environment.name !== "NO MONEY";
  const statusOfSector = Object.fromEntries(sectors.map(x => [x.name, x.status]));
  const gradeOf = {};
  for (const st of stocks) {
    gradeOf[st.sym] = gradeSetup({ closes: st.closes, vols: volumes?.[st.ticker] || null, i: last, s50: st.s50[last], s200: st.s200[last],
      rs: rsOf[st.sym], sectorStatus: statusOfSector[sectorMap[st.sym] || "Other"], envOk }).grade;
  }
  const planOf = {};
  for (const [ticker, closes] of Object.entries(aligned)) { const p = tradePlan(closes, last); if (p) planOf[ticker.replace(/.NS$/, "")] = { entry: p.entry, stop: p.stop, riskPct: p.riskPct, breaking: p.breaking }; }
  const enrich = (rows) => (rows || []).forEach(r => { r.rs = rsOf[r.sym] ?? null; r.grade = gradeOf[r.sym] ?? null; r.plan = planOf[r.sym] ?? null; });
  enrich(leaders);
  for (const k of ["pivots", "tight", "reclaim50", "ep", "ipo"]) enrich(scans[k]);
  for (const rows of Object.values(sectorStocks)) enrich(rows);
  for (const t of themes) enrich(t.top);

  // ── scan backtests: what happened 10 sessions after each past signal ──
  const scanStats = scanBacktest(axis, stocks, volumes, last);

  const asOf = axis[last];
  return {
    bias, trend, swing, momentum,
    bias_turning: biasTurning, bias_days: biasDays, bias_needed: BIAS_DAYS,
    swing_state: swingState, momentum_sign: momentumSign, momentum_dir: momentumDir,
    momentum_leaders: momentumLeaders, environment,
    follow_through: computeFollowThrough(axis, aligned, volumes),
    leaders_new: leadersNew, scans, scan_stats: scanStats, rs_of: rsOf, rs_breaks: rsBreaks, grade_of: gradeOf, plan_of: planOf,
    lows_ok: newLows <= LOWS_OK_MAX, lows_ok_max: LOWS_OK_MAX,
    pct_above_20: pct20,
    swing_confidence: Math.round(score), momentum_change: r1(mom.raw - mom.ma),
    pct_above_200: pct200, pct_above_50: pct50, pct_above_10: pct10,
    above_200: above200, above_50: above50, above_10: above10, total: N,
    nnh_20: nnh20, nnh_65: nnh65, nnh_52w: nnh52w,
    new_highs: newHighs, new_lows: newLows,
    overall, phase_weeks: phaseWeeks, thrust_detected: thrustDetected,
    to_upgrade: toUpgrade,
    history, sectors, leaders, sector_stocks: sectorStocks, sector_history: sectorHistory, themes, sector_of: Object.fromEntries(stocks.map(st => [st.sym, sectorMap[st.sym] || "Other"])),
    as_of: asOf,
    final: isFinal(asOf, now),
    verification,   // { date, checked, matched, corrected, missing, appended, source } or null
    updated_at: new Date(now).toISOString(),
  };
}

/**
 * Check the aligned Yahoo closes against NSE's official bhavcopy and correct them.
 * If Yahoo is missing the newest session entirely, that day is added from NSE.
 * Returns the verification summary (or null when the bhavcopy is unavailable).
 */
/**
 * Never compute on a half-populated day: if the newest date has closes for fewer than
 * `minCoverage` of stocks (Yahoo posts some bars late) and NSE didn't fill it, drop that
 * date so results use the last complete session. Returns the dropped date or null.
 */
export function trimIncompleteLastDay(axis, aligned, minCoverage = 0.9) {
  const last = axis.length - 1;
  if (last < 1) return null;
  const series = Object.values(aligned);
  const have = series.filter(c => c[last] != null).length;
  if (!series.length || have / series.length >= minCoverage) return null;
  const dropped = axis.pop();
  for (const c of series) c.pop();
  return dropped;
}

/** Where Yahoo has no volume for the bhavcopy day, use NSE's traded quantity. Returns count filled. */
export function fillVolumesFromBhav(axis, volumes, bhav) {
  const i = bhav?.date ? axis.indexOf(bhav.date) : -1;
  if (i < 0 || !volumes) return 0;
  let n = 0;
  for (const [ticker, v] of Object.entries(volumes)) {
    const b = bhav.closes[ticker.replace(/\.NS$/, "")];
    if (b?.vol != null && v[i] == null) { v[i] = b.vol; n++; }
  }
  return n;
}

export function applyNseCloses(axis, aligned, bhav) {
  if (!bhav?.date || !bhav.closes) return null;
  let appended = false;
  if (axis.length && bhav.date > axis[axis.length - 1]) {
    axis.push(bhav.date);
    for (const [ticker, series] of Object.entries(aligned)) {
      const b = bhav.closes[ticker.replace(/.NS$/, "")];
      series.push(b ? b.close : null);
    }
    appended = true;
  }
  const v = verifyAgainstBhav(axis, aligned, bhav);
  return v ? { ...v, appended, source: "NSE bhavcopy" } : null;
}

async function fetchBhav() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(API_BASE + "/api/nse?type=bhav&v=2", { signal: ctrl.signal }) /* v=2: response includes volume */;
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.date || !j.closes) return null;
    const closes = {};
    for (const [s, v] of Object.entries(j.closes)) closes[s] = { prev: v[0], close: v[1], vol: v[2] ?? null };
    return { date: j.date, closes };
  } catch (_) { return null; }
}

async function computeFresh(onProgress) {
  onProgress("Fetching Nifty 500 index list…", 3);
  const [symbols, sectorMap] = await Promise.all([fetchNifty500Symbols(), fetchSectorMap()]);
  const bhavPromise = fetchBhav(); // official NSE closes, fetched while Yahoo downloads
  const themesPromise = fetch(API_BASE + "/themes.json").then(r => (r.ok ? r.json() : null)).catch(() => null);
  const indexPromise = fetchSparkBatch(["^CRSLDX"]).then(r => r.closes["^CRSLDX"] || null).catch(() => null);
  const eventsPromise = fetchResultsCalendar();
  if (symbols.length < 100) throw new Error("Could not fetch Nifty 500 list — check internet connection.");

  const tickers = symbols.map(s => `${s}.NS`);
  const chunk = (list) => { const out = []; for (let i = 0; i < list.length; i += BATCH) out.push(list.slice(i, i + BATCH)); return out; };
  const batches = chunk(tickers);

  const allData = {}, allVol = {};
  let done = 0;
  await mapLimited(batches, PARALLEL, async (batch) => {
    const r = await fetchSparkBatch(batch);
    Object.assign(allData, r.closes); Object.assign(allVol, r.vols);
    done++;
    onProgress(`Downloading data (${done}/${batches.length} batches)…`, 5 + (done * 65) / batches.length);
  });

  const missing = tickers.filter(t => !allData[t]);
  if (missing.length) {
    onProgress(`Retrying ${missing.length} symbols…`, 72);
    await mapLimited(chunk(missing), PARALLEL, async (batch) => { const r = await fetchSparkBatch(batch); Object.assign(allData, r.closes); Object.assign(allVol, r.vols); });
  }
  const got = tickers.filter(t => allData[t]).length;
  if (got < tickers.length * MIN_COVERAGE) {
    throw new Error(`Only got data for ${got}/${tickers.length} stocks. Yahoo Finance may be throttling — try again in a few minutes.`);
  }

  onProgress("Computing breadth metrics…", 80);
  await new Promise(r => setTimeout(r, 0)); // let the progress paint
  const { axis, aligned } = alignByDate(allData);
  onProgress("Verifying closes against NSE…", 85);
  const bhavData = await bhavPromise;
  const verification = applyNseCloses(axis, aligned, bhavData);
  const droppedDay = trimIncompleteLastDay(axis, aligned); // e.g. Yahoo half-posted and NSE file not out yet
  if (droppedDay) onProgress(`${droppedDay} incomplete on Yahoo and not yet on NSE — using the last complete session`, 82);
  const volumes = alignVolumes(axis, allVol);
  if (verification) verification.volumes_filled = fillVolumesFromBhav(axis, volumes, bhavData);
  const result = computeFromAligned(axis, aligned, sectorMap, Date.now(), verification, volumes, await themesPromise, (await eventsPromise)?.results || null);
  if (droppedDay) result.pending_day = droppedDay;
  const idx = await indexPromise;
  result.signal_backtest = idx ? backtestSignal(result.history, idx) : null;
  return result;
}

// ─── results calendar (NSE) ───────────────────────────────────────────────────
let _events = null;
/** { from, to, results: { SYM: ["YYYY-MM-DD"] } } or null; cached for 2 hours. */
export async function fetchResultsCalendar() {
  if (_events && Date.now() - _events.at < 2 * 3600000) return _events.data;
  try {
    const r = await fetch(API_BASE + "/api/nse?type=events");
    const data = r.ok ? await r.json() : null;
    if (data?.results) { _events = { at: Date.now(), data }; return data; }
  } catch (_) {}
  return null;
}
/** Next results date for a symbol from today (IST) within `days`, or null. */
export function upcomingResults(cal, sym, days = 7) {
  const today = new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
  const ds = (cal?.results?.[sym] || []).filter(d => d >= today).sort();
  if (!ds.length) return null;
  const inDays = Math.round((Date.parse(ds[0]) - Date.parse(today)) / 86400000);
  return inDays <= days ? { date: ds[0], inDays } : null;
}

// ─── wider universe: NSE Microcap 250 (loaded on demand, scans only) ─────────
const MICRO_KEY = "td_mq_micro_v3"; // v3: RS + grades + plans
let _microInflight = null;
export async function loadMicrocapScans({ force = false } = {}) {
  if (!force) {
    try {
      const e = JSON.parse(localStorage.getItem(MICRO_KEY) || "null");
      if (isFresh(e)) return e.data;
    } catch (_) {}
  }
  if (_microInflight) return _microInflight;
  _microInflight = (async () => {
    const [syms, sectorMap, bhav, cal] = await Promise.all([
      fetch(API_BASE + "/microcap250.json").then(r => r.json()), fetchSectorMap(), fetchBhav(), fetchResultsCalendar(),
    ]);
    const tickers = syms.filter(x => !isPlaceholderSymbol(x)).map(x => `${x}.NS`);
    const allData = {}, allVol = {};
    const chunks = []; for (let i = 0; i < tickers.length; i += BATCH) chunks.push(tickers.slice(i, i + BATCH));
    await mapLimited(chunks, PARALLEL, async (b) => { const r = await fetchSparkBatch(b); Object.assign(allData, r.closes); Object.assign(allVol, r.vols); });
    const got = Object.keys(allData).length;
    if (got < tickers.length * 0.8) throw new Error(`Only got data for ${got}/${tickers.length} microcaps — try again shortly.`);
    const { axis, aligned } = alignByDate(allData);
    const verification = applyNseCloses(axis, aligned, bhav);
    trimIncompleteLastDay(axis, aligned);
    const vols = alignVolumes(axis, allVol);
    if (verification) verification.volumes_filled = fillVolumesFromBhav(axis, vols, bhav);
    const r = computeFromAligned(axis, aligned, sectorMap, Date.now(), verification, vols, null, cal?.results || null,
      { rsBreaks: getLastMarketQuadrant()?.rs_breaks || null });
    const data = { as_of: r.as_of, final: r.final, verification, total: r.total, scans: r.scans, leaders: r.leaders, sector_of: r.sector_of, rs_of: r.rs_of, grade_of: r.grade_of, plan_of: r.plan_of };
    try { localStorage.setItem(MICRO_KEY, JSON.stringify({ data, savedAt: Date.now() })); } catch (_) {}
    return data;
  })().finally(() => { _microInflight = null; });
  return _microInflight;
}

// ─── public loader (deduplicated) ────────────────────────────────────────────
let inflight = null;
const progressListeners = new Set();
let lastProgress = { msg: "Initialising…", pct: 0 };
const emitProgress = (msg, pct) => {
  lastProgress = { msg, pct };
  for (const fn of progressListeners) fn(msg, pct);
};
export function subscribeProgress(fn) {
  progressListeners.add(fn);
  fn(lastProgress.msg, lastProgress.pct);
  return () => progressListeners.delete(fn);
}

/**
 * Returns the current Market Quadrant result.
 *   force:        skip caches and recompute
 *   allowCompute: false → only local/shared caches (any age for local); never downloads 500 stocks
 */
export async function loadMarketQuadrant({ force = false, allowCompute = true } = {}) {
  if (!force) {
    const local = readLocal();
    if (isFresh(local)) return local.data;
    const shared = await readShared();
    if (isFresh(shared)) { writeLocal(shared.data, shared.savedAt); return shared.data; }
    if (!allowCompute) return local?.data ?? shared?.data ?? null;
  }
  if (!inflight) {
    inflight = computeFresh(emitProgress)
      .then((result) => {
        writeLocal(result);
        writeShared(result);
        return result;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Does the overall signal add value? Holds the Nifty 500 at 100% exposure on INVEST,
 * 50% on SELECTIVE, 0% on CASH (signal at close t applied to the t→t+1 return), vs buy & hold.
 * idxByDay: { "YYYY-MM-DD": index close }. In-sample: same rules, same period. Cash earns 0.
 */
export function backtestSignal(history, idxByDay) {
  const rows = (history || []).filter(r => r.sig && idxByDay[r.d] != null);
  if (rows.length < 40) return null;
  const W = { INVEST: 1, SELECTIVE: 0.5, CASH: 0 };
  let strat = 1, hold = 1, peakS = 1, peakH = 1, ddS = 0, ddH = 0, exp = 0;
  const curve = [{ d: rows[0].d, s: 100, h: 100 }];
  const bySig = { INVEST: [], SELECTIVE: [], CASH: [] };
  for (let i = 1; i < rows.length; i++) {
    const r = idxByDay[rows[i].d] / idxByDay[rows[i - 1].d] - 1, w = W[rows[i - 1].sig] ?? 0;
    strat *= 1 + w * r; hold *= 1 + r; exp += w;
    bySig[rows[i - 1].sig]?.push(r);
    peakS = Math.max(peakS, strat); peakH = Math.max(peakH, hold);
    ddS = Math.min(ddS, strat / peakS - 1); ddH = Math.min(ddH, hold / peakH - 1);
    curve.push({ d: rows[i].d, s: Math.round(strat * 1000) / 10, h: Math.round(hold * 1000) / 10 });
  }
  const pct = (x) => Math.round(x * 1000) / 10;
  const avgDay = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10000) / 100 : null);
  return {
    from: rows[0].d, to: rows[rows.length - 1].d, sessions: rows.length,
    strat: { ret: pct(strat - 1), maxDD: pct(ddS), exposure: Math.round((exp / (rows.length - 1)) * 100) },
    hold: { ret: pct(hold - 1), maxDD: pct(ddH) },
    next_day: { INVEST: avgDay(bySig.INVEST), SELECTIVE: avgDay(bySig.SELECTIVE), CASH: avgDay(bySig.CASH) },
    days: { INVEST: bySig.INVEST.length, SELECTIVE: bySig.SELECTIVE.length, CASH: bySig.CASH.length },
    curve: curve.filter((_, i) => i % 3 === 0 || i === curve.length - 1),
  };
}

/** History row in force on a given date (ISO string or Date): the last session on or before it. */
export function historyOnDate(data, date) {
  const h = data?.history;
  if (!h?.length || !date) return null;
  const ms = typeof date === "string" ? Date.parse(date) : +date;
  if (!Number.isFinite(ms)) return null;
  const day = new Date(ms + IST_MS).toISOString().slice(0, 10);
  if (day < h[0].d) return null;
  let lo = 0, hi = h.length - 1, ans = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (h[mid].d <= day) { ans = h[mid]; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

/** Signal in force on a given date (ISO string or Date), from a result's history. */
export function signalOnDate(data, date) {
  const h = data?.history;
  if (!h?.length || !date) return null;
  const ms = typeof date === "string" ? Date.parse(date) : +date;
  if (!Number.isFinite(ms)) return null;
  const day = new Date(ms + IST_MS).toISOString().slice(0, 10);
  if (day < h[0].d) return null;
  let lo = 0, hi = h.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (h[mid].d <= day) { ans = h[mid].sig; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
