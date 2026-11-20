// Quarterly results from an NSE results XBRL file (Ind-AS "integrated filing" format).
// parseResultXbrl(xml) → { from, to, basis, rev, profit, pbt, eps } — money in ₹ crore, for the quarter (context "OneD").

const tag = (xml, name, ctx = "OneD") => {
  const m = xml.match(new RegExp(`<[a-z-]+:${name}\\b[^>]*contextRef="${ctx}"[^>]*>([^<]*)<`));
  return m ? m[1].trim() : null;
};
const money = (xml, names) => {
  for (const n of names) { const v = tag(xml, n); if (v != null && v !== "" && Number.isFinite(+v)) return Math.round((+v / 1e7) * 100) / 100; }
  return null;
};

export function parseResultXbrl(xml) {
  xml = String(xml || "");
  const to = tag(xml, "DateOfEndOfReportingPeriod"), from = tag(xml, "DateOfStartOfReportingPeriod");
  if (!to) return null;
  const rev = money(xml, ["RevenueFromOperations", "InterestEarned", "TotalIncomeFromOperations", "Income"]);
  const owners = money(xml, ["ProfitOrLossAttributableToOwnersOfParent"]);
  const total = money(xml, ["ProfitLossForPeriod", "ProfitLossForThePeriod", "NetProfitLossForThePeriod"]);
  const pbt = money(xml, ["ProfitBeforeTax", "ProfitLossBeforeTax", "ProfitLossFromOrdinaryActivitiesBeforeTax"]);
  // owners' share of profit, unless it's clearly a mis-tagged figure (a sliver of the total profit)
  const profit = owners != null && !(total != null && total > 0 && owners >= 0 && owners < total * 0.4) ? owners : total;
  const epsRaw = tag(xml, "BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations") ?? tag(xml, "BasicEarningsLossPerShareFromContinuingOperations") ?? tag(xml, "BasicEarningsPerShareAfterExtraordinaryItems");
  const eps = epsRaw != null && Number.isFinite(+epsRaw) ? +epsRaw : null;
  if (rev == null && profit == null) return null;
  const days = from ? (Date.parse(to) - Date.parse(from)) / 864e5 : null;
  return { from, to, quarterly: days == null || (days >= 80 && days <= 100), basis: (tag(xml, "NatureOfReportStandaloneConsolidated") || "").toLowerCase() || null, rev, profit, pbt, eps };
}
