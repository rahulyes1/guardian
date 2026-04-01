// Vercel Node.js serverless function — batch historical closes for Market Quadrant
// Uses /v8/finance/chart per-symbol (same API as quote.js — known to work)
// Returns { spark: { result: [ { symbol, response:[{ indicators:{quote:[{close:[...]}]} }] } ] } }
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=7200, s-maxage=7200");

  const { symbols, range = "1y", interval = "1d" } = req.query;
  if (!symbols) return res.status(400).json({ error: "symbols required" });

  const symbolList = symbols.split(",").map((s) => s.trim()).filter(Boolean);

  const YF_HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://finance.yahoo.com/",
    Origin: "https://finance.yahoo.com",
  };

  const fetchOne = async (symbol) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    try {
      const r = await fetch(url, { headers: YF_HEADERS });
      if (!r.ok) return null;
      const data = await r.json();
      const result = data?.chart?.result?.[0];
      if (!result) return null;
      const closes = result?.indicators?.quote?.[0]?.close ?? [];
      return {
        symbol,
        response: [{ indicators: { quote: [{ close: closes }] } }],
      };
    } catch {
      return null;
    }
  };

  try {
    const results = await Promise.all(symbolList.map(fetchOne));
    res.json({ spark: { result: results.filter(Boolean) } });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
