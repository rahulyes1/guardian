// Close of the last daily bar dated before the latest trade's (IST) date, or null.
function previousSessionClose(result) {
  const ts = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  const lastTrade = result?.meta?.regularMarketTime;
  if (!Array.isArray(ts) || !Array.isArray(closes) || !lastTrade) return null;
  const istDay = (sec) => new Date((sec + 19800) * 1000).toISOString().slice(0, 10);
  const today = istDay(lastTrade);
  for (let i = ts.length - 1; i >= 0; i--) {
    if (closes[i] != null && istDay(ts[i]) < today) return closes[i];
  }
  return null;
}

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

  // range=5d (not 1d): we take the previous close from the daily bars ourselves, because
  // Yahoo's meta.chartPreviousClose for indices can skip a session (e.g. on 12 Nov 2026
  // ^NSEI reported 9 Nov's close instead of 11 Nov's, showing +1.02% instead of +0.18%).
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=5d`;

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
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;

    if (!meta || meta.regularMarketPrice == null) {
      return res.status(404).json({ error: "no data" });
    }

    const price = meta.regularMarketPrice;
    const rawPrev = previousSessionClose(result) ?? meta.previousClose ?? null;
    const prevClose = rawPrev != null ? +rawPrev.toFixed(2) : null;
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
