// Mutual funds: AMFI parser, category names, fund statistics (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmfi, normCat, fundStats } from "../api/mf.js";

const AMFI = `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date

Open Ended Schemes(Equity Scheme - Flexi Cap Fund)

PPFAS Mutual Fund

122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth Option;94.2890;17-Nov-2026
122640;INF879O01035;-;Parag Parikh Flexi Cap Fund;Regular Plan;Growth Option;86.1;17-Nov-2026
122641;INF879O01043;-;Parag Parikh Flexi Cap Fund;Direct Plan;IDCW Option;30.1;17-Nov-2026

Open Ended Schemes(Equity Schemes - Flexi Cap Fund)

Other Mutual Fund

999001;INF000000001;-;Other Flexi Cap Fund;Direct Plan;Growth Option;12.5;16-Nov-2026

Close Ended Schemes(Income)

Old Fund House

555;INF0;-;Some FMP;Direct Plan;Growth Option;10;17-Nov-2026
`;

test("AMFI file → open-ended Direct-Growth plans only, both category spellings merged", () => {
  const p = parseAmfi(AMFI);
  assert.equal(p.date, "2026-11-17");
  assert.deepEqual(p.cats, ["Equity · Flexi Cap"]);
  assert.equal(p.funds.length, 2);
  assert.deepEqual(p.funds[0], [122639, "Parag Parikh Flexi Cap Fund", "PPFAS Mutual Fund", 0, 94.289, "2026-11-17"]);
});

test("category names: old and new SEBI labels map to one name", () => {
  assert.equal(normCat("Equity Scheme - ELSS"), "Equity · ELSS (tax saver)");
  assert.equal(normCat("Equity Schemes - ELSS- Tax Saver Fund"), "Equity · ELSS (tax saver)");
  assert.equal(normCat("Debt Scheme - Short Duration Fund"), "Debt · Short Duration");
  assert.equal(normCat("Debt Schemes - Short Term Fund"), "Debt · Short Duration");
  assert.equal(normCat("Other Scheme - Index Funds"), "Index · Equity");
});

test("fund stats: returns, SIP, drawdown and AMFI's newer NAV appended", () => {
  // 6 years of NAVs growing 12% a year with a 20% dip in year 4
  const hist = [];
  const start = Date.parse("2020-11-17T00:00:00Z");
  for (let k = 0; k <= 6 * 365; k++) {
    const d = new Date(start + k * 864e5); if (d.getUTCDay() % 6 === 0) continue;
    let v = 10 * Math.pow(1.12, k / 365);
    if (k > 4 * 365 && k < 4 * 365 + 60) v *= 0.8;
    hist.push({ date: `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`, nav: v.toFixed(4) });
  }
  hist.reverse(); // mfapi lists newest first
  const last = parseFloat(hist[0].nav);
  const s = fundStats(hist, ["2026-11-30", last * 1.01]);
  assert.equal(s.date, "2026-11-30");
  assert.ok(Math.abs(s.chg - 1) < 0.05);
  assert.ok(Math.abs(s.ret.y5 - 12.2) < 1.2, `5y CAGR ${s.ret.y5}`);
  assert.ok(s.maxDD.pct <= -15 && s.maxDD.pct >= -25, `drawdown ${s.maxDD.pct}`);
  assert.equal(s.sip.y3.invested % 10000, 0);
  assert.ok(s.sip.y5.xirr > 5 && s.sip.y5.xirr < 20, `xirr ${s.sip.y5.xirr}`);
  assert.ok(s.series.length > 250);
});

test("full calendar years only (part years left out)", async () => {
  const { fullYears } = await import("../api/mf.js");
  const months = [["2023-06", 10, 10], ["2023-12", 10, 12], ["2024-01", 12, 12], ["2024-12", 12, 15], ["2025-12", 15, 18], ["2026-03", 18, 20]];
  assert.deepEqual(fullYears(months), { 2024: 25, 2025: 20 });
});
