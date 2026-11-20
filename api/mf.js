// Vercel Node.js serverless function — Indian mutual funds, updated daily.
//   /api/mf?type=list            AMFI's official daily NAV file → every open-ended Direct-Growth plan
//                                { date, cats: [category], funds: [[code, name, house, catIndex, nav, navDate]] }
//   /api/mf?type=fund&code=N     one fund: NAV, day change, returns, risk, SIP returns, chart series (mfapi.in history)
//   /api/mf?type=cat&cat=NAME    leaderboard for one category (returns + risk for every Direct-Growth fund in it)
// Sources: AMFI (amfiindia.com, the official daily NAV publication, ~9–11 pm IST) and mfapi.in (NAV history from AMFI).

const AMFI = "https://www.amfiindia.com/spages/NAVAll.txt";
const MFAPI = "https://api.mfapi.in/mf/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

async function get(url, { json = false, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: json ? "application/json" : "text/plain,*/*" } });
    if (!r.ok) return { status: r.status };
    return { status: 200, body: json ? await r.json() : await r.text() };
  } catch (e) {
    return { status: 0, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally { clearTimeout(t); }
}

const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const amfiDate = (s) => { const m = String(s || "").trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/); return m && MON[m[2]] ? `${m[3]}-${MON[m[2]]}-${m[1].padStart(2, "0")}` : null; };
const dmyDate = (s) => { const m = String(s || "").match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

/** One name per category: AMFI mixes old ("Equity Scheme - X") and new ("Equity Schemes - X") labels. */
export function normCat(raw) {
  const parts = String(raw).split(/\s+-\s+/);
  let grp = parts[0], name = parts.slice(1).join(" - ") || parts[0];
  grp = /equity/i.test(grp) ? "Equity" : /debt/i.test(grp) ? "Debt" : /hybrid/i.test(grp) ? "Hybrid" : /solution|child|retire/i.test(grp) ? "Solution"
    : /exchange traded|etf/i.test(grp) ? "ETF" : /index/i.test(grp) ? "Index" : "Other";
  name = name.replace(/\s*Funds?\s*$/i, "").replace(/\s+/g, " ").trim();
  if (/elss/i.test(name)) name = "ELSS (tax saver)";
  else if (/sectoral|thematic/i.test(name)) name = "Sectoral / Thematic";
  else if (/child/i.test(name)) name = "Children";
  else if (/retire/i.test(name)) name = "Retirement";
  const key = `${grp} · ${name}`;
  // old SEBI-era names → current names, so each category appears once
  const ALIAS = {
    "Debt · Banking and PSU Debt": "Debt · Banking and PSU", "Debt · Medium Term": "Debt · Medium Duration",
    "Debt · Medium to Long Term": "Debt · Medium to Long Duration", "Debt · Short Term": "Debt · Short Duration",
    "Debt · Ultra Short Term": "Debt · Ultra Short Duration", "Debt · Long Term": "Debt · Long Duration",
    "Debt · Dynamic Term": "Debt · Dynamic Bond", "Debt · Ultra Short to Short Term": "Debt · Low Duration",
    "Hybrid · Balanced Advantage Fund/ Dynamic Asset Allocation": "Hybrid · Balanced Advantage",
    "Hybrid · Dynamic Asset Allocation or Balanced Advantage": "Hybrid · Balanced Advantage",
    "Other · FoF Domestic": "Other · Fund of Funds (India)", "Other · Fund of Funds Scheme (Domestic)": "Other · Fund of Funds (India)",
    "Other · FoF Overseas": "Other · Fund of Funds (overseas)", "Other · Fund of Funds investing overseas": "Other · Fund of Funds (overseas)",
    "Other · Index": "Index · Equity", "Other · Gold ETF": "ETF · Gold ETF", "Other · Other ETFs": "ETF · Other ETF",
  };
  if (ALIAS[key]) return ALIAS[key];
  if (/^Other · Life Cycle/i.test(key)) return "Solution · Life cycle";
  return key;
}

/** AMFI NAVAll.txt → open-ended Direct-Growth plans with their category. Exported for tests. */
export function parseAmfi(text) {
  const cats = [], catIdx = new Map(), funds = [], seen = new Set();
  let cat = null, open = false, house = null, latest = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.includes(";")) {
      const m = line.match(/^(Open Ended|Close Ended|Interval Fund)[^(]*\((.+)\)$/i);
      if (m) { open = /^Open Ended/i.test(m[1]); cat = normCat(m[2]); }
      else house = line;
      continue;
    }
    if (!open || !cat) continue;
    const c = line.split(";");
    if (c.length < 6 || !/^\d+$/.test(c[0])) continue;
    let name = c[3], plan = "", option = "", nav, date;
    if (c.length >= 8) { plan = c[4]; option = c[5]; nav = c[6]; date = c[7]; }
    else { nav = c[4]; date = c[5]; }
    const label = `${name} ${plan} ${option}`;
    if (!/direct/i.test(label) || !/growth/i.test(label) || /idcw|dividend|bonus/i.test(label)) continue;
    const v = parseFloat(nav), d = amfiDate(date);
    if (!(v > 0) || !d) continue;
    name = name.replace(/\s*[-–]\s*direct\s*plan.*$/i, "").replace(/\s*[-–]\s*growth.*$/i, "").trim();
    const key = `${house}|${name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!catIdx.has(cat)) { catIdx.set(cat, cats.length); cats.push(cat); }
    funds.push([Number(c[0]), name, house, catIdx.get(cat), v, d]);
    if (!latest || d > latest) latest = d;
  }
  return { date: latest, cats, funds };
}

/** mfapi.in history → returns, risk, SIP and a chart series. Exported for tests. */
export function fundStats(hist, latest = null) {
  const rows = (hist || []).map(x => [dmyDate(x.date), parseFloat(x.nav)]).filter(([d, v]) => d && v > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  // AMFI's daily file is usually a day ahead of the history source: add its NAV when newer
  if (latest?.[0] && latest[1] > 0 && rows.length && latest[0] > rows[rows.length - 1][0]) rows.push([latest[0], latest[1]]);
  if (rows.length < 2) return null;
  const n = rows.length, [lastD, nav] = rows[n - 1];
  const t = (d) => Date.parse(d + "T00:00:00Z");
  const at = (daysBack) => { // NAV on the last date at or before (last − daysBack)
    const target = t(lastD) - daysBack * 86400000;
    let lo = 0, hi = n - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (t(rows[m][0]) <= target) { k = m; lo = m + 1; } else hi = m - 1; }
    return k >= 0 && t(rows[0][0]) <= target ? rows[k] : null;
  };
  const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
  const simple = (days) => { const p = at(days); return p ? r1((nav / p[1] - 1) * 100) : null; };
  const cagr = (years) => { const p = at(Math.round(years * 365.25)); return p ? r1((Math.pow(nav / p[1], 1 / years) - 1) * 100) : null; };
  const yStart = rows.find(r => r[0] >= `${lastD.slice(0, 4)}-01-01`);
  const prevYearEnd = [...rows].reverse().find(r => r[0] < `${lastD.slice(0, 4)}-01-01`);
  const ytd = prevYearEnd ? r1((nav / prevYearEnd[1] - 1) * 100) : yStart ? r1((nav / yStart[1] - 1) * 100) : null;
  const inceptYears = (t(lastD) - t(rows[0][0])) / (365.25 * 86400000);
  // risk: 1-year volatility, worst fall in 3 years
  const from1y = rows.findIndex(r => t(r[0]) >= t(lastD) - 365 * 86400000);
  const dr = []; for (let k = Math.max(1, from1y); k < n; k++) dr.push(rows[k][1] / rows[k - 1][1] - 1);
  const mean = dr.reduce((a, b) => a + b, 0) / (dr.length || 1);
  const vol = dr.length > 30 ? r1(Math.sqrt(dr.reduce((a, b) => a + (b - mean) ** 2, 0) / (dr.length - 1)) * Math.sqrt(248) * 100) : null;
  const from3y = Math.max(0, rows.findIndex(r => t(r[0]) >= t(lastD) - 3 * 365.25 * 86400000));
  let pk = rows[from3y][1], pkD = rows[from3y][0], dd = 0, ddFrom = null, ddTo = null;
  for (let k = from3y; k < n; k++) { if (rows[k][1] > pk) { pk = rows[k][1]; pkD = rows[k][0]; } const x = rows[k][1] / pk - 1; if (x < dd) { dd = x; ddFrom = pkD; ddTo = rows[k][0]; } }
  // consistency: every 1-year return over the last 3 years (weekly steps)
  const roll = [];
  for (let k = from3y; k < n; k += 5) {
    const end = rows[k], target = t(end[0]) - 365 * 86400000;
    let j = k; while (j > 0 && t(rows[j][0]) > target) j--;
    if (t(rows[j][0]) <= target && t(end[0]) - t(rows[j][0]) < 400 * 86400000) roll.push(end[1] / rows[j][1] - 1);
  }
  roll.sort((a, b) => a - b);
  const rolling = roll.length >= 20 ? { min: r1(roll[0] * 100), median: r1(roll[roll.length >> 1] * 100), max: r1(roll[roll.length - 1] * 100), pos: Math.round((roll.filter(v => v > 0).length / roll.length) * 100), n: roll.length } : null;
  // calendar years
  const years = [];
  for (let y = Number(lastD.slice(0, 4)) - 5; y < Number(lastD.slice(0, 4)); y++) {
    const s = [...rows].reverse().find(r => r[0] < `${y}-01-01`), e = [...rows].reverse().find(r => r[0] <= `${y}-12-31`);
    if (s && e && e[0] >= `${y}-12-01`) years.push([y, r1((e[1] / s[1] - 1) * 100)]);
  }
  // SIP: ₹10,000 on the first NAV day of each month; value today and XIRR
  const sip = (yrs) => {
    const start = t(lastD) - yrs * 365.25 * 86400000;
    if (t(rows[0][0]) > start) return null;
    const flows = []; let units = 0, month = null;
    for (const [d, v] of rows) {
      if (t(d) < start) continue;
      const m = d.slice(0, 7); if (m === month) continue; month = m;
      if (d.slice(0, 7) === lastD.slice(0, 7)) break; // no instalment in the current month
      units += 10000 / v; flows.push([t(d), -10000]);
    }
    if (!flows.length) return null;
    const value = units * nav; flows.push([t(lastD), value]);
    const npv = (r) => flows.reduce((a, [ms, cf]) => a + cf / Math.pow(1 + r, (ms - flows[0][0]) / (365.25 * 86400000)), 0);
    let lo = -0.99, hi = 5; for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (npv(mid) > 0) lo = mid; else hi = mid; }
    return { invested: (flows.length - 1) * 10000, value: Math.round(value), xirr: r1(((lo + hi) / 2) * 100) };
  };
  // chart: daily for the last year, weekly before that, up to 10 years
  const series = [];
  for (let k = 0; k < n; k++) {
    const age = t(lastD) - t(rows[k][0]);
    if (age > 10 * 365.25 * 86400000) continue;
    if (age <= 366 * 86400000 || k % 5 === 0 || k === n - 1) series.push([rows[k][0], Math.round(rows[k][1] * 10000) / 10000]);
  }
  const prev = rows[n - 2];
  return {
    nav, date: lastD, prev: prev[1], prevDate: prev[0], chg: r1((nav / prev[1] - 1) * 100 * 10) / 10,
    ret: { w1: simple(7), m1: simple(30), m3: simple(91), m6: simple(182), y1: simple(365), ytd, y3: cagr(3), y5: cagr(5), y10: cagr(10),
      inception: inceptYears >= 1 ? r1((Math.pow(nav / rows[0][1], 1 / inceptYears) - 1) * 100) : null },
    since: rows[0][0], vol, maxDD: { pct: r1(dd * 100), from: ddFrom, to: ddTo }, rolling, years,
    sip: { y1: sip(1), y3: sip(3), y5: sip(5) }, series,
  };
}

// Which index each active equity category should beat, and which long-running index fund stands in for it
const BENCH = {
  n50: { index: "Nifty 50", prefer: [/^UTI Nifty 50 Index/i, /^HDFC (NIFTY 50 Index|Index Fund.*NIFTY 50)/i, /^ICICI Prudential Nifty 50 Index/i, /nifty 50 index/i] },
  n500: { index: "Nifty 500", prefer: [/^Motilal Oswal Nifty 500 Index/i, /nifty 500 index/i] },
  lm250: { index: "Nifty LargeMidcap 250", prefer: [/^Edelweiss NIFTY Large Midcap 250 Index/i, /large ?mid ?cap 250 index/i] },
  mid150: { index: "Nifty Midcap 150", prefer: [/^Motilal Oswal Nifty Midcap 150 Index/i, /midcap 150 index/i] },
  small250: { index: "Nifty Smallcap 250", prefer: [/^Motilal Oswal Nifty Smallcap 250 Index/i, /smallcap 250 index/i] },
};
const BENCH_OF = {
  "Large Cap": "n50", "Large & Mid Cap": "lm250", "Mid Cap": "mid150", "Small Cap": "small250",
  "Flexi Cap": "n500", "Multi Cap": "n500", "Focused": "n500", "Value": "n500", "Contra": "n500", "ELSS (tax saver)": "n500",
};

/** Monthly history: [YYYY-MM, first NAV of the month, last NAV of the month]. Exported for tests. */
export function monthsOf(rows) {
  const out = [];
  for (const [d, v] of rows) {
    const m = d.slice(0, 7), last = out[out.length - 1];
    if (last && last[0] === m) last[2] = v; else out.push([m, v, v]);
  }
  return out;
}
/** Full calendar-year returns (%), last 10 years: { 2024: 18.2, ... } — part years left out. Exported for tests. */
export function fullYears(months) {
  const byYear = {};
  for (const [ym, first, last] of months) { const y = ym.slice(0, 4); (byYear[y] ||= { start: null, last: null, startM: ym, endM: ym }); byYear[y].last = last; byYear[y].endM = ym; }
  const ys = Object.keys(byYear).sort(), out = {};
  for (let i = 1; i < ys.length; i++) {
    const y = ys[i], prev = byYear[ys[i - 1]];
    if (prev.endM !== `${ys[i - 1]}-12` || byYear[y].endM !== `${y}-12`) continue;
    out[y] = Math.round((byYear[y].last / prev.last - 1) * 1000) / 10;
  }
  return Object.fromEntries(Object.entries(out).slice(-10));
}
/** Every fall of 10% or more since launch: peak, trough, depth, and when it got back to the peak. Exported for tests. */
export function fallsOf(rows) {
  const out = [];
  let pk = rows[0]?.[1], pkD = rows[0]?.[0], tr = pk, trD = pkD;
  const close = (recD) => { const depth = tr / pk - 1; if (depth <= -0.1) out.push({ peak: pkD, trough: trD, depth: Math.round(depth * 1000) / 10, recovered: recD }); };
  for (const [d, v] of rows) {
    if (v >= pk) { if (tr < pk) close(d); pk = v; pkD = d; tr = v; trD = d; }
    else if (v < tr) { tr = v; trD = d; }
  }
  if (tr < pk) close(null);
  return out.sort((a, b) => a.depth - b.depth).slice(0, 5);
}

async function mapLimited(items, limit, fn, deadline) {
  const out = new Array(items.length).fill(null); let next = 0;
  const worker = async () => { while (next < items.length && Date.now() < deadline) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const type = String(req.query.type || "");
  const started = Date.now();
  const fail = (status, error) => { res.setHeader("Cache-Control", "no-store"); return res.status(status).json({ error }); };
  try {
    if (type === "list") {
      const r = await get(AMFI, { timeout: 9000 });
      if (r.status !== 200) return fail(502, `AMFI NAV file unavailable (${r.status || r.error})`);
      const parsed = parseAmfi(r.body);
      if (!parsed.funds.length) return fail(502, "AMFI NAV file could not be read");
      // NAVs land ~9–11 pm IST: cache 3 h at the edge and serve the old copy while refreshing
      res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=10800, stale-while-revalidate=86400");
      return res.json({ source: "amfi-navall", ...parsed });
    }

    if (type === "fund") {
      const code = String(req.query.code || "").replace(/\D/g, "");
      if (!code) return fail(400, "code required");
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const [r, lr] = await Promise.all([get(MFAPI + code, { json: true, timeout: 8000 }), get(`https://${host}/api/mf?type=list`, { json: true, timeout: 8000 })]);
      if (r.status !== 200 || !r.body?.data) return fail(502, `NAV history unavailable (${r.status || r.error})`);
      const row = lr.status === 200 ? lr.body.funds.find(f => f[0] === Number(code)) : null;
      const st = fundStats(r.body.data, row ? [row[5], row[4]] : null);
      if (!st) return fail(404, "Not enough NAV history");
      res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=10800, stale-while-revalidate=86400");
      const daily = (hist, latest) => {
        const all = hist.map(x => [dmyDate(x.date), parseFloat(x.nav)]).filter(([d, v]) => d && v > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
        if (latest && latest[0] > (all[all.length - 1]?.[0] || "")) all.push(latest);
        return all;
      };
      const rowsAll = daily(r.body.data, row ? [row[5], row[4]] : null);
      // ?full=1 → every daily NAV (for exact SIP / purchase NAVs in the portfolio)
      const navs = req.query.full === "1" ? rowsAll : undefined;
      const cat = row ? lr.body.cats[row[3]] : null;
      // ?deep=1 → monthly history since launch, every big fall, and the category's index fund for comparison
      let deep;
      if (req.query.deep === "1") {
        deep = { months: monthsOf(rowsAll), falls: fallsOf(rowsAll) };
        const B = BENCH_OF[(cat || "").split(" · ")[1]];
        if (B && lr.status === 200) {
          const ci = lr.body.cats.indexOf("Index · Equity");
          const pool = lr.body.funds.filter(f => f[3] === ci && !/elss|etf|fof|equal|momentum|quality|value|low vol|alpha|next/i.test(f[1]));
          let pick = null; for (const re of BENCH[B].prefer) { pick = pool.find(f => re.test(f[1])); if (pick) break; }
          if (pick && pick[0] !== Number(code)) {
            const br = await get(MFAPI + pick[0], { json: true, timeout: 7000 });
            if (br.status === 200 && br.body?.data) deep.bench = { index: BENCH[B].index, code: pick[0], name: pick[1], months: monthsOf(daily(br.body.data, [pick[5], pick[4]])) };
          }
        }
      }
      return res.json({ source: "mfapi.in (AMFI NAVs)", code: Number(code), meta: r.body.meta, cat, ...st, navs, deep });
    }

    if (type === "cat") {
      const cat = String(req.query.cat || "");
      if (!cat) return fail(400, "cat required");
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const lr = await get(`https://${host}/api/mf?type=list`, { json: true, timeout: 8000 });
      if (lr.status !== 200) return fail(502, "Fund list unavailable");
      const ci = lr.body.cats.indexOf(cat);
      if (ci < 0) return fail(404, "Unknown category");
      const all = lr.body.funds.filter(f => f[3] === ci);
      const LIMIT = 60, offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const picked = all.slice(offset, offset + LIMIT);
      const rows = await mapLimited(picked, 8, async (f) => {
        let r = await get(MFAPI + f[0], { json: true, timeout: 5000 });
        if (r.status !== 200 && Date.now() < started + 7000) { await new Promise(res => setTimeout(res, 400)); r = await get(MFAPI + f[0], { json: true, timeout: 4000 }); }
        const st = r.status === 200 ? fundStats(r.body?.data, [f[5], f[4]]) : null;
        const yrs = st ? fullYears(monthsOf(r.body.data.map(x => [dmyDate(x.date), parseFloat(x.nav)]).filter(([d, v]) => d && v > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1)))) : null;
        return st ? { code: f[0], name: f[1], house: f[2], nav: st.nav, date: st.date, chg: st.chg, m1: st.ret.m1, m3: st.ret.m3, y1: st.ret.y1, y3: st.ret.y3, y5: st.ret.y5, vol: st.vol, dd: st.maxDD.pct, since: st.since, yrs }
          : { code: f[0], name: f[1], house: f[2], nav: f[4], date: f[5], missing: true };
      }, started + 8500);
      const out = rows.map((x, i) => x || { code: picked[i][0], name: picked[i][1], house: picked[i][2], nav: picked[i][4], date: picked[i][5], missing: true });
      const complete = out.filter(x => !x.missing).length;
      res.setHeader("Cache-Control", complete >= out.length * 0.8 ? "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400" : "no-store");
      return res.json({ source: "AMFI + mfapi.in", cat, total: all.length, offset, shown: out.length, complete, more: offset + LIMIT < all.length, funds: out });
    }

    // The cheap index-fund alternative for an active category: its returns are the bar to beat
    if (type === "bench") {
      const cat = String(req.query.cat || "");
      const B = BENCH_OF[cat.split(" · ")[1]];
      if (!B) return fail(404, "No benchmark for this category");
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const lr = await get(`https://${host}/api/mf?type=list`, { json: true, timeout: 8000 });
      if (lr.status !== 200) return fail(502, "Fund list unavailable");
      const ci = lr.body.cats.indexOf("Index · Equity");
      const pool = lr.body.funds.filter(f => f[3] === ci && !/elss|etf|fof|equal|momentum|quality|value|low vol|alpha|next/i.test(f[1]));
      let pick = null;
      for (const re of BENCH[B].prefer) { pick = pool.find(f => re.test(f[1])); if (pick) break; }
      if (!pick) return fail(404, "Benchmark fund not found");
      const r = await get(MFAPI + pick[0], { json: true, timeout: 8000 });
      const st = r.status === 200 ? fundStats(r.body?.data, [pick[5], pick[4]]) : null;
      if (!st) return fail(502, "Benchmark history unavailable");
      res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400");
      return res.json({ cat, index: BENCH[B].index, code: pick[0], name: pick[1], date: st.date, ret: st.ret, since: st.since, dd: st.maxDD.pct });
    }

    return fail(400, "type must be list, fund, cat or bench");
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
