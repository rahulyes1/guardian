// Vercel Node.js serverless function — official NSE data (source of truth)
//   /api/nse?type=indices  latest ind_close_all file  → { date, indices: { "Nifty 50": {...}, "Nifty 500": {...} } }
//   /api/nse?type=bhav     latest sec_bhavdata_full   → { date, closes: { SYMBOL: { prev, close } } }  (EQ/BE/BZ)
//   /api/nse?type=live     NSE allIndices feed        → { date, time, indices: { "NIFTY 50": {...}, ... } }
// Errors return { error } with a non-200 status and are never cached.
import { parseIndexCloseCsv, parseBhavFullCsv, parseAllIndices, recentWeekdays, nseFileDate, istParts } from "../lib/marketChecks.js";

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
      for (const [s, v] of Object.entries(parsed.closes)) closes[s] = [v.prev, v.close];
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

    return fail(400, "type must be indices, bhav or live");
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
