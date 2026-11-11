// Vercel Node.js serverless function — batch historical closes for Market Quadrant
// Uses /v8/finance/chart per-symbol (same API as quote.js — known to work)
// Returns {
//   spark:  { result: [ { symbol, response:[{ timestamp:[...], indicators:{quote:[{close:[...]}]} }] } ] },
//   failed: [symbol, ...]
// }
// Timestamps are returned so the client can align series by date.

const MAX_SYMBOLS   = 50;
const CONCURRENCY   = 10;   // parallel Yahoo requests per invocation
const FETCH_TIMEOUT = 4000; // ms per symbol
const DEADLINE      = 8000; // ms — stop starting new fetches (Vercel Hobby limit is 10s)
const MIN_OK_RATIO  = 0.9;  // below this, the response is not cached at the edge

const ALLOWED_RANGES    = new Set(["6mo", "1y", "2y", "5y"]);
const ALLOWED_INTERVALS = new Set(["1d", "1wk"]);

const YF_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://finance.yahoo.com/",
  Origin: "https://finance.yahoo.com",
};

async function fetchOne(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, { headers: YF_HEADERS, signal: ctrl.signal });
    if (!r.ok) return null;
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    const timestamp = result?.timestamp;
    const rawCloses = result?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(timestamp) || !Array.isArray(rawCloses) || !timestamp.length) return null;
    // Round to 2dp to keep the payload small
    const closes = rawCloses.map((c) => (c == null ? null : Math.round(c * 100) / 100));
    return { symbol, response: [{ timestamp, indicators: { quote: [{ close: closes }] } }] };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { symbols } = req.query;
  const range = ALLOWED_RANGES.has(req.query.range) ? req.query.range : "2y";
  const interval = ALLOWED_INTERVALS.has(req.query.interval) ? req.query.interval : "1d";

  if (!symbols) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "symbols required" });
  }

  const symbolList = [...new Set(symbols.split(",").map((s) => s.trim()).filter(Boolean))];
  if (symbolList.length > MAX_SYMBOLS) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: `max ${MAX_SYMBOLS} symbols per request` });
  }

  const started = Date.now();
  const results = new Array(symbolList.length).fill(null);
  let next = 0;

  // Small worker pool: CONCURRENCY requests in flight; stop picking up work after DEADLINE
  const worker = async () => {
    while (next < symbolList.length && Date.now() - started < DEADLINE) {
      const i = next++;
      results[i] = await fetchOne(symbolList[i], range, interval);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, symbolList.length) }, worker));
    const ok = results.filter(Boolean);
    const failed = symbolList.filter((_, i) => !results[i]);

    // Only let the CDN cache responses that are (nearly) complete
    res.setHeader(
      "Cache-Control",
      ok.length >= symbolList.length * MIN_OK_RATIO ? "public, max-age=3600, s-maxage=3600" : "no-store"
    );
    res.json({ spark: { result: ok }, failed });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: e.message || String(e) });
  }
}
