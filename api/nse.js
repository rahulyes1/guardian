// Vercel Node.js serverless function — official NSE data (source of truth)
//   /api/nse?type=indices  latest ind_close_all file  → { date, indices: { "Nifty 50": {...}, "Nifty 500": {...} } }
//   /api/nse?type=bhav     latest sec_bhavdata_full   → { date, closes: { SYMBOL: [prev, close, volume, delivery%] } }
//   /api/nse?type=live     NSE allIndices feed        → { date, time, indices: { "NIFTY 50": {...}, ... } }
//   /api/nse?type=flows    FII/DII cash market activity (latest day)  → { date, fii: {buy,sell,net}, dii: {...} }  (₹ crore)
//   /api/nse?type=deals    bulk + block deals (latest day)            → { date, deals: [{ sym, client, side, qty, price, kind }] }
//   /api/nse?type=events   NSE board-meeting calendar → { from, to, results: { SYMBOL: ["YYYY-MM-DD", ...] } }
//                          (financial results only; 10 days back to 21 days ahead)
// Errors return { error } with a non-200 status and are never cached.
import { parseIndexCloseCsv, parseBhavFullCsv, parseAllIndices, recentWeekdays, nseFileDate, istParts, parseNseDate } from "../lib/marketChecks.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const KEEP_INDICES = ["Nifty 50", "Nifty 500"];
const DEADLINE_MS = 8500; // stay under Vercel's 10s

async function get(url, { json = false, timeout = 4000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: json ? "application/json" : "text/csv,*/*", Referer: "https://www.nseindia.com/" },
    });
    if (!r.ok) return { status: r.status };
    return { status: 200, body: json ? await r.json() : await r.text() };
  } catch (e) {
    return { status: 0, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

// Newest weekday file that exists (NSE publishes ~6pm IST; holidays have no file)
async function latestArchive(makeUrl, parse, started) {
  const tried = [];
  for (const day of recentWeekdays(Date.now(), 6)) {
    if (Date.now() - started > DEADLINE_MS) break;
    const url = makeUrl(nseFileDate(day));
    const r = await get(url, { timeout: 5000 });
    tried.push(`${day}:${r.status}`);
    if (r.status === 200) {
      const parsed = parse(r.body);
      if (parsed) return { parsed, tried };
    }
  }
  return { parsed: null, tried };
}

// Cache longer once today's file is in; retry often while waiting for it
function cacheFor(date) {
  const { day, mins } = istParts();
  if (date === day) return 6 * 3600;
  return mins >= 16 * 60 && mins <= 21 * 60 ? 600 : 1800;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const type = String(req.query.type || "");
  const started = Date.now();
  const fail = (status, error, extra = {}) => {
    res.setHeader("Cache-Control", "no-store");
    return res.status(status).json({ error, ...extra });
  };

  try {
    if (type === "indices") {
      const { parsed, tried } = await latestArchive(
        (d) => `https://nsearchives.nseindia.com/content/indices/ind_close_all_${d}.csv`, parseIndexCloseCsv, started);
      if (!parsed) return fail(502, "NSE index close file unavailable", { tried });
      const indices = Object.fromEntries(KEEP_INDICES.filter((k) => parsed.indices[k]).map((k) => [k, parsed.indices[k]]));
      res.setHeader("Cache-Control", `public, max-age=300, s-maxage=${cacheFor(parsed.date)}`);
      return res.json({ source: "nse-ind_close_all", date: parsed.date, indices });
    }

    if (type === "bhav") {
      const { parsed, tried } = await latestArchive(
        (d) => `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}.csv`, parseBhavFullCsv, started);
      if (!parsed) return fail(502, "NSE bhavcopy unavailable", { tried });
      const closes = {};
      for (const [s, v] of Object.entries(parsed.closes)) closes[s] = [v.prev, v.close, v.vol, v.deliv];
      res.setHeader("Cache-Control", `public, max-age=300, s-maxage=${cacheFor(parsed.date)}`);
      return res.json({ source: "nse-sec_bhavdata_full", date: parsed.date, closes });
    }

    if (type === "live") {
      const r = await get("https://www.nseindia.com/api/allIndices", { json: true, timeout: 5000 });
      const parsed = r.status === 200 ? parseAllIndices(r.body) : null;
      if (!parsed) return fail(502, `NSE live feed unavailable (${r.status || r.error})`);
      const keep = ["NIFTY 50", "NIFTY 500"];
      const indices = Object.fromEntries(keep.filter((k) => parsed.indices[k]).map((k) => [k, parsed.indices[k]]));
      res.setHeader("Cache-Control", "public, max-age=15, s-maxage=20");
      return res.json({ source: "nse-allIndices", date: parsed.date, time: parsed.time, indices });
    }

    if (type === "flows") {
      const r = await get("https://www.nseindia.com/api/fiidiiTradeReact", { json: true, timeout: 6000 });
      const rows = r.status === 200 && Array.isArray(r.body) ? r.body : null;
      if (!rows?.length) return fail(502, `NSE FII/DII data unavailable (${r.status || r.error})`);
      const pick = (re) => rows.find((x) => re.test(x.category || ""));
      const conv = (x) => (x ? { buy: Number(x.buyValue), sell: Number(x.sellValue), net: Number(x.netValue) } : null);
      res.setHeader("Cache-Control", "public, max-age=900, s-maxage=1800");
      return res.json({ source: "nse-fiidii", date: parseNseDate(rows[0].date), fii: conv(pick(/FII|FPI/i)), dii: conv(pick(/DII/i)) });
    }

    if (type === "deals") {
      const r = await get("https://www.nseindia.com/api/snapshot-capital-market-largedeal", { json: true, timeout: 7000 });
      const b = r.status === 200 ? r.body : null;
      if (!b) return fail(502, `NSE deals data unavailable (${r.status || r.error})`);
      const take = (arr, kind) => (Array.isArray(arr) ? arr : []).map((x) => ({
        sym: x.symbol, client: x.clientName, side: x.buySell, qty: Number(x.qty), price: Number(x.watp), kind,
      })).filter((x) => x.sym && Number.isFinite(x.qty));
      res.setHeader("Cache-Control", "public, max-age=900, s-maxage=1800");
      return res.json({ source: "nse-largedeal", date: parseNseDate(b.as_on_date), deals: [...take(b.BLOCK_DEALS_DATA, "block"), ...take(b.BULK_DEALS_DATA, "bulk")] });
    }

    if (type === "events") {
      const dmy = (ms) => { const d = new Date(ms + 19800000); return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`; };
      const from = dmy(Date.now() - 10 * 86400000), to = dmy(Date.now() + 21 * 86400000);
      const r = await get(`https://www.nseindia.com/api/event-calendar?index=equities&from_date=${from}&to_date=${to}`, { json: true, timeout: 7000 });
      const rows = r.status === 200 ? (Array.isArray(r.body) ? r.body : r.body?.data || []) : null;
      if (!rows) return fail(502, `NSE event calendar unavailable (${r.status || r.error})`);
      const results = {};
      for (const e of rows) {
        if (!e?.symbol || !/result/i.test(e.purpose || "")) continue;
        const day = parseNseDate(e.date);
        if (day) (results[e.symbol] ||= []).includes(day) || results[e.symbol].push(day);
      }
      res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=7200");
      return res.json({ source: "nse-event-calendar", from, to, results });
    }

    return fail(400, "type must be indices, bhav, live or events");
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
