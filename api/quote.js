// Vercel Node.js serverless function — single symbol quote
// Uses Yahoo Finance v8 chart API (no crumb/auth needed, unlike the quote API)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  const yahooSym =
    symbol.startsWith("^") || symbol.includes(".")
      ? symbol
      : `${symbol}.NS`;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=1d`;

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
    const meta = data?.chart?.result?.[0]?.meta;

    if (!meta || meta.regularMarketPrice == null) {
      return res.status(404).json({ error: "no data" });
    }

    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const change = prevClose != null ? +(price - prevClose).toFixed(2) : null;
    const changePct =
      prevClose != null && prevClose !== 0
        ? +((change / prevClose) * 100).toFixed(4)
        : null;

    res.json({
      symbol,
      price,
      prevClose,
      change,
      changePct,
      volume: meta.regularMarketVolume ?? 0,
      dayHigh: meta.regularMarketDayHigh ?? null,
      dayLow: meta.regularMarketDayLow ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
