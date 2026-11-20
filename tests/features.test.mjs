// New data parsers: results XBRL, AMFI monthly report rows, fund-name keys (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResultXbrl } from "../lib/xbrl.js";
import { parseMonthlyReport, catKey, groupKey, baseKey, latestTer } from "../scripts/fund-facts.mjs";

test("TER export: latest day per scheme, direct and regular totals", () => {
  const H = ["NSDL Scheme Code", "Scheme Name", "Scheme Type", "Scheme Category", "TER Date", "Regular Plan - Base Expense Ratio (BER) (%)", "x", "x", "x", "Regular Plan - Total TER (%)", "Direct Plan - Base Expense Ratio (BER) (%)", "x", "x", "x", "Direct Plan - Total TER (%)"];
  const row = (name, day, r, d) => ["c", name, "Open Ended", "cat", day, 0, 0, 0, 0, r, 0, 0, 0, 0, d];
  const t = latestTer([H, row("Parag Parikh Flexi Cap Fund", 46296, 1.4, 0.6), row("Parag Parikh Flexi Cap Fund", 46298, 1.35, 0.55), row("Parag Parikh Flexi Cap Fund", 46297, 1.5, 0.7), ["For months May to March, the reference period…"]]);
  assert.deepEqual(t[baseKey("Parag Parikh Flexi Cap Fund - Direct Plan - Growth")], { date: 46298, d: 0.55, r: 1.35 });
  assert.throws(() => latestTer([["Scheme Name", "TER Date"]]));
});

const x = (body) => `<xbrli:xbrl>${body}</xbrli:xbrl>`;
const t = (name, v, ctx = "OneD") => `<in-capmkt:${name} contextRef="${ctx}" decimals="-5" unitRef="INR">${v}</in-capmkt:${name}>`;

test("XBRL quarter: revenue and owners' profit in ₹ crore, quarter length checked", () => {
  const r = parseResultXbrl(x(t("DateOfStartOfReportingPeriod", "2026-07-01") + t("DateOfEndOfReportingPeriod", "2026-09-30") + t("NatureOfReportStandaloneConsolidated", "Consolidated")
    + t("RevenueFromOperations", "731880000000") + t("ProfitLossForPeriod", "139340000000") + t("ProfitOrLossAttributableToOwnersOfParent", "138840000000")
    + t("RevenueFromOperations", "1454630000000", "FourD") + t("BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations", "38.37")));
  assert.equal(r.rev, 73188);
  assert.equal(r.profit, 13884);
  assert.equal(r.eps, 38.37);
  assert.equal(r.basis, "consolidated");
  assert.equal(r.quarterly, true);
});

test("XBRL: a mis-tagged sliver of owners' profit falls back to total profit; half-year files are flagged", () => {
  const r = parseResultXbrl(x(t("DateOfStartOfReportingPeriod", "2025-07-01") + t("DateOfEndOfReportingPeriod", "2025-09-30") + t("RevenueFromOperations", "29227900000")
    + t("ProfitLossForPeriod", "2844400000") + t("ProfitOrLossAttributableToOwnersOfParent", "182400000")));
  assert.equal(r.profit, 284.44);
  const h = parseResultXbrl(x(t("DateOfStartOfReportingPeriod", "2024-04-01") + t("DateOfEndOfReportingPeriod", "2024-09-30") + t("RevenueFromOperations", "1")));
  assert.equal(h.quarterly, false);
  // a real loss attributable to owners is kept
  const l = parseResultXbrl(x(t("DateOfStartOfReportingPeriod", "2026-07-01") + t("DateOfEndOfReportingPeriod", "2026-09-30") + t("RevenueFromOperations", "5") + t("ProfitLossForPeriod", "-20000000") + t("ProfitOrLossAttributableToOwnersOfParent", "-23000000")));
  assert.equal(l.profit, -2.3);
});

test("AMFI monthly report: open-ended categories with net flow and AUM; sub-totals skipped", () => {
  const rows = [
    [], ["Monthly Report for the month of October 2026"], ["Sr", "Scheme Name", "No. of Schemes"],
    ["A", "Open ended Schemes"], ["I", "Debt Schemes"], ["i", "Overnight Fund", 40, 830505, 728355.8, 673462.8, 54893.04, 139547.3, 135709.2],
    ["", "Sub Total - I ", 343, 1, 1, 1, 113437.8, 1, 1], ["II", "Equity Schemes"], ["v", "Small Cap Fund", 36, 30704519, 10254.7, 3847.2, 6407.49, 440874.5, 452932.1],
    ["B", "Close Ended Schemes"], ["I", "Debt"], ["i", "FMP", 1, 1, 1, 1, 999, 1, 1],
  ];
  const r = parseMonthlyReport(rows, "2026-10");
  assert.deepEqual(r.rows.map((x) => [x.group, x.name, x.net, x.aum]), [["Debt", "Overnight Fund", 54893, 139547], ["Equity", "Small Cap Fund", 6407, 440875]]);
});

test("category and scheme keys survive SEBI's renames", () => {
  assert.equal(catKey("ELSS"), catKey("ELSS- Tax Saver Fund"));
  assert.equal(catKey("Dynamic Asset Allocation/Balanced Advantage Fund"), catKey("Balanced Advantage Fund/ Dynamic Asset Allocation"));
  assert.equal(groupKey("Growth/Equity Oriented Schemes"), groupKey("Equity Schemes"));
  assert.equal(baseKey("Parag Parikh Flexi Cap Fund - Direct Plan - Growth"), baseKey("Parag Parikh Flexi Cap Fund"));
});
