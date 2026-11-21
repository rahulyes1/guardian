// Morning brief: the five lines and the 6% heat flag (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { morningLines, heatPct, HEAT_LIMIT } from "../lib/morning.js";

const global = [
  { name: "S&P 500 fut", price: 6967, chg: -3.2 }, { name: "Nasdaq fut", price: 25291, chg: -4.92 },
  { name: "Nikkei", price: 59444, chg: 0.71 }, { name: "Hang Seng", price: 22842, chg: -1.96 }, { name: "Kospi", price: 5138, chg: 1.39 },
  { name: "Crude", price: 83.62, chg: 0.49 }, { name: "Gold", price: 3539, chg: -3.98 }, { name: "USD/INR", price: 93.29, chg: -0.19 },
];
const mq = { overall: "SELECTIVE", environment: { name: "HARD MONEY" }, pct_above_50: 58.6, momentum_leaders: [{ name: "Healthcare" }, { name: "Realty" }, { name: "Auto" }, { name: "Textiles" }] };
const flows = { date: "2026-11-20", fii: { net: 10308.4 }, dii: { net: -4860.2 } };

test("five lines: global, commodities, signal, flows, today's rule", () => {
  const l = morningLines({ global, mq, flows, riskPct: 0.25 });
  assert.equal(l.length, 5);
  assert.equal(l[0], "Global: US futures −4.1%; Asia Nikkei +0.7%, Hang Seng −2.0%, Kospi +1.4% — a weak start is likely.");
  assert.equal(l[1], "Commodities & rupee: crude +0.5%, gold −4.0%, USD/INR 93.29 (−0.19%).");
  assert.equal(l[2], "Signal SELECTIVE (hard money): 59% of Nifty 500 stocks above their 50-day average.");
  assert.equal(l[3], "Flows 20/11: FII +₹10,308 cr, DII −₹4,860 cr.");
  assert.equal(l[4], "Today's rule: risk 0.25% per trade; strongest sectors Healthcare, Realty, Auto.");
});

test("missing inputs are skipped, not invented; no-entry days say so", () => {
  assert.deepEqual(morningLines({}), []);
  assert.deepEqual(morningLines({ riskPct: 0 }), ["Today's rule: no new entries — protect what you hold."]);
  assert.equal(morningLines({ global: [{ name: "USD/INR", price: 94, chg: 0.5 }] })[0], "Commodities & rupee: USD/INR 94.00 (+0.50%) — a weaker rupee usually weighs on stocks.");
});

test("heat: open risk on real open/partial trades as % of capital; flag above 6%", () => {
  const trades = [
    { status: "open", riskAmount: 4000 }, { status: "partial", riskAmount: 2500 },
    { status: "closed", riskAmount: 9999 }, { status: "open", riskAmount: 9999, paper: true },
  ];
  assert.equal(heatPct(trades, 100000), 6.5);
  assert.ok(heatPct(trades, 100000) > HEAT_LIMIT);
  assert.equal(heatPct([], 100000), 0);
  assert.equal(heatPct(trades, 0), 0);
});
