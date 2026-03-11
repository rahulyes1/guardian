// Vercel Node.js serverless function — single symbol quote
// yahoo-finance2 exports the YahooFinance class; must instantiate with new
import YahooFinance from "yahoo-finance2";
const yahooFinance = new YahooFinance();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  // Normalize: indices keep as-is (^NSEI), NSE stocks get .NS suffix
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
}
