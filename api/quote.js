// Vercel Node.js serverless function — single symbol quote
// Same pattern as TRADR: server-side Yahoo Finance fetch, no CORS issues
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  // Normalize: indices keep as-is (^NSEI), NSE stocks get .NS suffix
  const yahooSym =
    symbol.startsWith("^") || symbol.includes(".")
      ? symbol
      : `${symbol}.NS`;

  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yahooSym)}`;

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(6000),
    });

    if (!r.ok) return res.status(r.status).json({ error: "upstream error" });

    const data = await r.json();
    const q = data?.quoteResponse?.result?.[0];

    if (!q || q.regularMarketPrice == null) {
      return res.status(404).json({ error: "no data" });
    }

    res.json({
      symbol,
      price: q.regularMarketPrice,
      prevClose: q.regularMarketPreviousClose ?? null,
      change: q.regularMarketChange ?? null,
      changePct: q.regularMarketChangePercent ?? null,
      volume: q.regularMarketVolume ?? 0,
      dayHigh: q.regularMarketDayHigh ?? null,
      dayLow: q.regularMarketDayLow ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
