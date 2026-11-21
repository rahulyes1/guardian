// Position risk for long trades (shared by the journal, TODAY's heat and the stats).

/** Rupees at risk: zero once the stop is at or above the entry (a trailed stop locks in profit). */
export function openRisk(avgEntry, stop, qty) {
  const a = Number(avgEntry), s = Number(stop), q = Number(qty);
  return Number.isFinite(a) && Number.isFinite(s) && q > 0 ? Math.max(0, a - s) * q : 0;
}

/** R-multiple of a trade against the risk it started with (older trades fall back to the stored risk). */
export function tradeR(t) {
  const r = t?.initialRisk ?? t?.riskAmount;
  return r > 0 ? (t.pnl || 0) / r : null;
}
