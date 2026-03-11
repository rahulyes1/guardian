// Vercel Node.js serverless function — CJS to avoid ESM/CJS interop issues
// yahoo-finance2 CJS export — try both patterns
const _yf = require("yahoo-finance2");
const yahooFinance = _yf.default ?? _yf;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  const yahooSym =
    symbol.startsWith("^") || symbol.includes(".")
      ? symbol
      : `${symbol}.NS`;

  try {
    const q = await yahooFinance.quote(yahooSym, {}, { validateResult: false });

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
};
