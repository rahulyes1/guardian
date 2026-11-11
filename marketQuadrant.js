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

export const MQ_SIGNALS = ["INVEST", "SELECTIVE", "CASH"];

const LOCAL_KEY       = "td_mq_v3";   // v3: adds history / sectors / leaders
const BATCH           = 50;           // symbols per /api/spark call (server caps at 50)
const PARALLEL        = 3;            // spark calls in flight (avoids Yahoo 429s)
const RANGE           = "2y";         // 200-SMA + 52w history needs >1y
const MIN_COVERAGE    = 0.9;          // refuse to compute on <90% of the index
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
function isFresh(entry, now = Date.now()) {
  if (!entry?.data || !entry.savedAt) return false;
  if (entry.data.final) return entry.savedAt >= lastCloseCutoff(now);
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
  return d && MQ_SIGNALS.includes(d.overall) && Array.isArray(d.history) && typeof d.total === "number" && d.total >= 400;
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
  if (!sb || !result.final) return;
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
    const r = await fetch("/nifty500.json");
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data) && data.length > 100) return data;
    }
  } catch (_) {}
  for (const url of [NIFTY500_CSV, ALLORIGINS + encodeURIComponent(NIFTY500_CSV)]) {
    try {
      const lines = (await fetchTextWithTimeout(url)).split(/\r?\n/).filter(l => l.trim());
      const syms = [];
      for (let i = 1; i < lines.length; i++) {
        const sym = lines[i].split(",")[2]?.trim().replace(/"/g, "").toUpperCase();
        if (sym && /^[A-Z0-9&_-]+$/.test(sym)) syms.push(sym);
      }
      if (syms.length > 100) return syms;
    } catch (_) {}
  }
  return [];
}

async function fetchSectorMap() {
  try {
    const r = await fetch("/nifty500_sectors.json");
    if (r.ok) return await r.json();
  } catch (_) {}
  return {};
}

// Returns { "RELIANCE.NS": { "2025-01-02": close, ... }, ... }
async function fetchSparkBatch(nsTickers) {
  const url = `/api/spark?symbols=${encodeURIComponent(nsTickers.join(","))}&range=${RANGE}&interval=1d`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Spark API HTTP ${r.status}`);
  const json = await r.json();
  const out = {};
  for (const item of (json?.spark?.result ?? [])) {
    const resp = item?.response?.[0];
    const ts = resp?.timestamp;
    const closes = resp?.indicators?.quote?.[0]?.close;
    if (!item?.symbol || !Array.isArray(ts) || !Array.isArray(closes)) continue;
    const byDay = {};
    for (let i = 0; i < ts.length; i++) if (closes[i] != null) byDay[istDayKey(ts[i])] = +closes[i];
    out[item.symbol] = byDay;
  }
  return out;
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
function alignByDate(allData) {
  const counts = {};
  const entries = Object.entries(allData);
  for (const [, byDay] of entries) for (const d in byDay) counts[d] = (counts[d] || 0) + 1;
  const axis = Object.keys(counts).filter(d => counts[d] >= entries.length * 0.5).sort();
  const aligned = {};
  for (const [ticker, byDay] of entries) aligned[ticker] = axis.map(d => byDay[d] ?? null);
  return { axis, aligned };
}

// ─── series math ─────────────────────────────────────────────────────────────
function smaSeries(arr, period, minP) {
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
export function computeFromAligned(axis, aligned, sectorMap = {}, now = Date.now()) {
  const stocks = Object.entries(aligned)
    .filter(([, closes]) => closes.filter(c => c != null).length >= 150)
    .map(([ticker, closes]) => ({
      ticker,
      sym: ticker.replace(/\.NS$/, ""),
      closes,
      s200: smaSeries(closes, 200, 150),
      s50:  smaSeries(closes, 50, 40),
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
  const p200 = [], p50 = [], p10 = [], nnh52 = [];
  for (let i = 0; i < nRows; i++) {
    p200.push(pctAt("s200", i)); p50.push(pctAt("s50", i)); p10.push(pctAt("s10", i));
    let nh = 0, nl = 0;
    for (const s of stocks) {
      const c = s.closes[i];
      if (c == null) continue;
      if (s.h252[i] != null && c >= s.h252[i] * 0.99) nh++;
      if (s.l252[i] != null && c <= s.l252[i] * 1.01) nl++;
    }
    nnh52.push(nh - nl);
  }

  // Momentum: weekly snapshots of %>50-SMA, 4-week ROC vs its average
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
    const b = (p200[i] >= 50 ? 1 : 0) + (p50[i] >= 50 && nnh52[i] > 0 ? 1 : 0) + (p10[i] >= 50 ? 1 : 0) + (momentumAt(i).rising ? 1 : 0);
    return b >= 3 ? "INVEST" : b === 2 ? "SELECTIVE" : "CASH";
  };

  // ── today ──
  const pct200 = r1(p200[last] ?? 0), pct50 = r1(p50[last] ?? 0), pct10 = r1(p10[last] ?? 0);
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
  const bias = pct200 >= 50 ? "BULL" : "BEAR";
  const trend = pct50 >= 50 && nnh52w > 0 ? "UP" : "DOWN";
  const swing = pct10 >= 70 ? "HOT" : pct10 >= 50 ? "WARM" : pct10 >= 30 ? "COOL" : "COLD";
  const mom = momentumAt(last);
  const momentum = mom.rising ? "RISING" : "FALLING";
  const overall = signalAt(last) ?? "CASH";

  // Breadth thrust: %>10-SMA now > 40 after being < 25 within the last 12 sessions
  let thrustDetected = false;
  if (pct10 > 40) {
    for (let k = 1; k <= 12; k++) {
      const v = p10[last - k];
      if (v != null && v < 25) { thrustDetected = true; break; }
    }
  }

  let score = Math.min(pct10 * 0.4, 40);
  if (nnh20 > 0) score += 20;
  if (nnh65 > 0) score += 20;
  if (mom.rising) score += 20;

  // ── history (every row that has a signal) ──
  const history = [];
  for (let i = 199; i < nRows; i++) {
    history.push({ d: axis[i], p200: r1(p200[i]), p50: r1(p50[i]), p10: r1(p10[i]), nnh: nnh52[i], sig: signalAt(i) });
  }
  let phaseWeeks = 0;
  for (let w = 1; w <= 52; w++) {
    if (signalAt(last - w * 5) === overall) phaseWeeks++; else break;
  }

  // ── to upgrade (each condition carries its unit for display) ──
  const toUpgrade = [];
  const investConds = () => {
    const c = [];
    if (pct200 < 50) c.push({ metric: "Long-term breadth (200-SMA)", current: pct200, needs: 50, gap: r1(50 - pct200), unit: "%" });
    if (pct50 < 50)  c.push({ metric: "Medium breadth (50-SMA)", current: pct50, needs: 50, gap: r1(50 - pct50), unit: "%" });
    if (nnh52w <= 0) c.push({ metric: "Net New Highs (52-week)", current: nnh52w, needs: "> 0", gap: Math.abs(nnh52w) + 1, unit: "" });
    return c;
  };
  if (overall === "CASH") {
    const sc = [];
    if (pct10 < 50) sc.push({ metric: "Swing breadth (10-SMA)", current: pct10, needs: 50, gap: r1(50 - pct10), unit: "%" });
    if (!mom.rising) sc.push({ metric: "Momentum (4-wk ROC, pts)", current: r1(mom.raw), needs: `> ${r1(mom.ma)}`, gap: r1(mom.ma - mom.raw), unit: "" });
    if (sc.length) toUpgrade.push({ to: "SELECTIVE", conditions: sc });
    const ic = investConds(); if (ic.length) toUpgrade.push({ to: "INVEST", conditions: ic });
  } else if (overall === "SELECTIVE") {
    const ic = investConds(); if (ic.length) toUpgrade.push({ to: "INVEST", conditions: ic });
  }

  // ── sectors ──
  const bySector = {};
  for (const s of stocks) (bySector[sectorMap[s.sym] || "Other"] ||= []).push(s);
  const sectors = Object.entries(bySector)
    .filter(([, list]) => list.length >= 3)
    .map(([name, list]) => {
      const sp50 = pctAt("s50", last, list);
      const sp50Prev = last >= 20 ? pctAt("s50", last - 20, list) : null;
      return {
        name, n: list.length,
        p50: r1(sp50), p200: r1(pctAt("s200", last, list)), p10: r1(pctAt("s10", last, list)),
        p50_chg: sp50 != null && sp50Prev != null ? r1(sp50 - sp50Prev) : null,
        status: sectorStatus(sp50),
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

  const asOf = axis[last];
  return {
    bias, trend, swing, momentum,
    swing_confidence: Math.round(score), momentum_change: r1(mom.raw - mom.ma),
    pct_above_200: pct200, pct_above_50: pct50, pct_above_10: pct10,
    above_200: above200, above_50: above50, above_10: above10, total: N,
    nnh_20: nnh20, nnh_65: nnh65, nnh_52w: nnh52w,
    new_highs: newHighs, new_lows: newLows,
    overall, phase_weeks: phaseWeeks, thrust_detected: thrustDetected,
    to_upgrade: toUpgrade,
    history, sectors, leaders,
    as_of: asOf,
    final: isFinal(asOf, now),
    updated_at: new Date(now).toISOString(),
  };
}

async function computeFresh(onProgress) {
  onProgress("Fetching Nifty 500 index list…", 3);
  const [symbols, sectorMap] = await Promise.all([fetchNifty500Symbols(), fetchSectorMap()]);
  if (symbols.length < 100) throw new Error("Could not fetch Nifty 500 list — check internet connection.");

  const tickers = symbols.map(s => `${s}.NS`);
  const chunk = (list) => { const out = []; for (let i = 0; i < list.length; i += BATCH) out.push(list.slice(i, i + BATCH)); return out; };
  const batches = chunk(tickers);

  const allData = {};
  let done = 0;
  await mapLimited(batches, PARALLEL, async (batch) => {
    Object.assign(allData, await fetchSparkBatch(batch));
    done++;
    onProgress(`Downloading data (${done}/${batches.length} batches)…`, 5 + (done * 65) / batches.length);
  });

  const missing = tickers.filter(t => !allData[t]);
  if (missing.length) {
    onProgress(`Retrying ${missing.length} symbols…`, 72);
    await mapLimited(chunk(missing), PARALLEL, async (batch) => Object.assign(allData, await fetchSparkBatch(batch)));
  }
  const got = tickers.filter(t => allData[t]).length;
  if (got < tickers.length * MIN_COVERAGE) {
    throw new Error(`Only got data for ${got}/${tickers.length} stocks. Yahoo Finance may be throttling — try again in a few minutes.`);
  }

  onProgress("Computing breadth metrics…", 80);
  await new Promise(r => setTimeout(r, 0)); // let the progress paint
  const { axis, aligned } = alignByDate(allData);
  return computeFromAligned(axis, aligned, sectorMap);
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
