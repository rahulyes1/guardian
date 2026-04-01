// Vercel Node.js serverless function — batch spark data for Market Quadrant
// Proxies Yahoo Finance spark API server-side (no CORS issues)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");

  const { symbols, range = "1y", interval = "1d" } = req.query;
  if (!symbols) return res.status(400).json({ error: "symbols required" });

  const url = `https://query2.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(symbols)}&range=${range}&interval=${interval}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://finance.yahoo.com/",
        Origin: "https://finance.yahoo.com",
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `upstream ${response.status}` });
    }

    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
