// Morning brief text (pure, testable): five plain lines from global cues, the market signal,
// institutional flows and today's risk rule. Missing inputs are skipped, never guessed.

const sgn = (v, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`;
const crore = (v) => `${v >= 0 ? "+" : "−"}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")} cr`;

/**
 * global: [{ name, price, chg }] (names as in the app's GLOBAL_TICKERS); mq: market quadrant result;
 * flows: { date, fii: { net }, dii: { net } }; riskPct: today's risk per trade (%).
 */
export function morningLines({ global = [], mq = null, flows = null, riskPct = null } = {}) {
  const by = (re) => global.find((g) => re.test(g.name || ""));
  const lines = [];
  const us = global.filter((g) => /S&P|Nasdaq/i.test(g.name || ""));
  const usAvg = us.length ? us.reduce((a, g) => a + g.chg, 0) / us.length : null;
  const asia = [by(/Nikkei/i), by(/Hang Seng/i), by(/Kospi/i)].filter(Boolean);
  if (usAvg != null || asia.length) {
    const tone = usAvg == null ? "" : usAvg <= -1 ? " — a weak start is likely" : usAvg >= 1 ? " — a firm start is likely" : " — no strong lead";
    lines.push(`Global: ${usAvg != null ? `US futures ${sgn(usAvg)}` : "US futures n/a"}${asia.length ? `; Asia ${asia.map((g) => `${g.name} ${sgn(g.chg)}`).join(", ")}` : ""}${tone}.`);
  }
  const crude = by(/Crude/i), gold = by(/Gold/i), inr = by(/USD\/INR/i);
  if (crude || gold || inr) {
    lines.push(`Commodities & rupee: ${[crude && `crude ${sgn(crude.chg)}`, gold && `gold ${sgn(gold.chg)}`, inr && `USD/INR ${inr.price?.toFixed(2)} (${sgn(inr.chg, 2)})`].filter(Boolean).join(", ")}${inr && inr.chg > 0.3 ? " — a weaker rupee usually weighs on stocks" : ""}.`);
  }
  if (mq?.overall) {
    lines.push(`Signal ${mq.overall}${mq.environment?.name ? ` (${mq.environment.name.toLowerCase()})` : ""}: ${mq.pct_above_50 != null ? `${Math.round(mq.pct_above_50)}% of Nifty 500 stocks above their 50-day average` : "breadth n/a"}.`);
  }
  if (flows?.fii || flows?.dii) {
    lines.push(`Flows${flows.date ? ` ${flows.date.slice(8)}/${flows.date.slice(5, 7)}` : ""}: ${[flows.fii && `FII ${crore(flows.fii.net)}`, flows.dii && `DII ${crore(flows.dii.net)}`].filter(Boolean).join(", ")}.`);
  }
  if (riskPct != null) {
    const lead = (mq?.momentum_leaders || []).slice(0, 3).map((m) => m.name);
    lines.push(riskPct === 0 ? "Today's rule: no new entries — protect what you hold." : `Today's rule: risk ${riskPct}% per trade${lead.length ? `; strongest sectors ${lead.join(", ")}` : ""}.`);
  }
  return lines.slice(0, 5);
}

/** Portfolio heat: open risk (₹) on open and part-closed trades as % of capital. */
export function heatPct(trades, portfolio) {
  const risk = (trades || []).filter((t) => !t.paper && (t.status === "open" || t.status === "partial")).reduce((a, t) => a + (t.riskAmount || 0), 0);
  return portfolio > 0 ? (risk / portfolio) * 100 : 0;
}
export const HEAT_LIMIT = 6;
