// ─── Zerodha (Kite Console) tradebook import ──────────────────────────────────
// Console → Reports → Tradebook → Equity → download CSV. Columns:
//   symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,
//   trade_id,order_id,order_execution_time
// Fills are matched FIFO per symbol into the app's trade format: buys open/add, sells
// close; a position that returns to 0 becomes a closed trade. Shorts (a sell with no
// open position) and non-equity segments are skipped and counted.

function splitCsv(line) {
  const out = []; let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Parse the CSV into fills: [{ id, symbol, date, side, qty, price }] (+ skipped counts). */
export function parseTradebook(text) {
  const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error("The file is empty.");
  const hdr = splitCsv(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const col = (name) => hdr.indexOf(name);
  const need = ["symbol", "trade_date", "trade_type", "quantity", "price"];
  const missing = need.filter((n) => col(n) < 0);
  if (missing.length) throw new Error(`This doesn't look like a Zerodha tradebook (missing: ${missing.join(", ")}).`);
  const iSeg = col("segment"), iId = col("trade_id"), iTime = col("order_execution_time");
  const fills = []; let skippedSegment = 0;
  for (const l of lines.slice(1)) {
    const c = splitCsv(l);
    if (iSeg >= 0 && c[iSeg] && !/^EQ$/i.test(c[iSeg])) { skippedSegment++; continue; }
    const qty = Number(c[col("quantity")]), price = Number(c[col("price")]);
    const side = String(c[col("trade_type")] || "").toLowerCase();
    if (!c[col("symbol")] || !Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || !["buy", "sell"].includes(side)) continue;
    const day = c[col("trade_date")];
    const time = iTime >= 0 && /T|:/.test(c[iTime] || "") ? c[iTime] : null;
    fills.push({
      id: iId >= 0 && c[iId] ? String(c[iId]) : `${c[col("symbol")]}|${day}|${side}|${qty}|${price}|${fills.length}`,
      symbol: c[col("symbol")].toUpperCase().replace(/-(EQ|BE|BZ)$/, ""),
      date: time && time.includes("T") ? new Date(time).toISOString() : new Date(`${day}T10:00:00+05:30`).toISOString(),
      side, qty, price,
    });
  }
  fills.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { fills, skippedSegment };
}

/**
 * Build app trades from fills (FIFO), skipping fill ids already imported.
 * Returns { trades, closed, open, skippedShort, duplicates }.
 */
export function buildTrades(fills, existingIds = new Set()) {
  const pos = {}; // symbol → working trade
  const out = []; let skippedShort = 0, duplicates = 0;
  const r2 = (x) => Math.round(x * 100) / 100;
  for (const f of fills) {
    if (existingIds.has(f.id)) { duplicates++; continue; }
    let t = pos[f.symbol];
    if (f.side === "buy") {
      if (!t) {
        t = pos[f.symbol] = {
          id: `z-${f.id}`, symbol: f.symbol, setupType: "Imported", conviction: null, notes: "Imported from Zerodha tradebook",
          status: "open", date: f.date, entries: [], currentStop: 0, targets: [null, null, null], exits: [],
          avgEntry: 0, totalQty: 0, remainingQty: 0, pnl: 0, entry: 0, stop: 0, riskAmount: 0,
          source: "zerodha", importIds: [], _lots: [],
        };
      }
      t.entries.push({ price: f.price, qty: f.qty, riskAmount: 0, date: f.date, notes: "" });
      t._lots.push({ qty: f.qty, price: f.price });
      t.totalQty += f.qty; t.remainingQty += f.qty;
      t.avgEntry = r2(t.entries.reduce((s, e) => s + e.price * e.qty, 0) / t.totalQty); t.entry = t.avgEntry;
      t.importIds.push(f.id);
    } else {
      if (!t || t.remainingQty <= 0) { skippedShort++; continue; }
      let left = Math.min(f.qty, t.remainingQty), pnl = 0;
      const sold = left;
      while (left > 0 && t._lots.length) {
        const lot = t._lots[0], take = Math.min(lot.qty, left);
        pnl += (f.price - lot.price) * take; lot.qty -= take; left -= take;
        if (lot.qty <= 0) t._lots.shift();
      }
      t.exits.push({ price: f.price, qty: sold, pnl: r2(pnl), date: f.date, notes: "", reason: "Imported" });
      t.remainingQty -= sold; t.pnl = r2(t.pnl + pnl); t.importIds.push(f.id);
      t.status = t.remainingQty <= 0 ? "closed" : "partial";
      if (t.remainingQty <= 0) { delete t._lots; out.push(t); delete pos[f.symbol]; }
    }
  }
  for (const t of Object.values(pos)) { delete t._lots; out.push(t); }
  return { trades: out, closed: out.filter((t) => t.status === "closed").length, open: out.filter((t) => t.status !== "closed").length, skippedShort, duplicates };
}
