// Vercel Node.js serverless function — single symbol quote
// Uses Yahoo Finance v8 chart API (no crumb/auth needed, unlike the quote API).
// Every response carries `source`, `asOf` and `issues` (sanity-check results) so the app
// never shows a number it can't vouch for without saying so.
import { previousSessionClose, quoteIssues } from "../lib/marketChecks.js";

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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const response = await fetch(url, {
      signal: ctrl.signal,
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
    const quoteTimeMs = meta.regularMarketTime ? meta.regularMarketTime * 1000 : NaN;
    const issues = quoteIssues({ price, prevClose, isIndex: yahooSym.startsWith("^"), quoteTimeMs });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      symbol,
      price,
      prevClose,
      change,
      // A failed check means the % can't be trusted — don't hand out a number for it
      changePct: issues.includes("bad_prev") || issues.includes("big_move") ? null : changePct,
      volume: meta.regularMarketVolume ?? 0,
      dayHigh: meta.regularMarketDayHigh ?? null,
      dayLow: meta.regularMarketDayLow ?? null,
      source: "yahoo",
      asOf: Number.isFinite(quoteTimeMs) ? new Date(quoteTimeMs).toISOString() : null,
      issues,
    });
  } catch (e) {
    res.status(e.name === "AbortError" ? 504 : 500).json({ error: e.name === "AbortError" ? "upstream timeout" : e.message || String(e) });
  } finally {
    clearTimeout(timer);
  }
}
