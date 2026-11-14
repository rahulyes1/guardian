import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTradebook, buildTrades } from "../lib/tradeImport.js";

const CSV = `symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time
INFY,INE009A01021,2026-10-01,NSE,EQ,EQ,buy,false,10,1500.00,1001,1,2026-10-01T09:20:00
INFY,INE009A01021,2026-10-03,NSE,EQ,EQ,buy,false,10,1520.00,1002,2,2026-10-03T10:00:00
INFY,INE009A01021,2026-10-10,NSE,EQ,EQ,sell,false,15,1600.00,1003,3,2026-10-10T14:00:00
INFY,INE009A01021,2026-10-12,NSE,EQ,EQ,sell,false,5,1580.00,1004,4,2026-10-12T14:00:00
TCS,INE467B01029,2026-10-05,NSE,EQ,EQ,buy,false,2,3000.00,2001,5,2026-10-05T09:30:00
NIFTY26OCTFUT,,2026-10-05,NFO,FO,,buy,false,50,25000,3001,6,2026-10-05T09:30:00
HDFCBANK,INE040A01034,2026-10-06,NSE,EQ,EQ,sell,false,5,800.00,4001,7,2026-10-06T09:30:00`;

test("Zerodha tradebook → FIFO round trips", () => {
  const { fills, skippedSegment } = parseTradebook(CSV);
  assert.equal(skippedSegment, 1); // F&O row skipped
  const r = buildTrades(fills);
  assert.equal(r.closed, 1);
  assert.equal(r.open, 1);
  assert.equal(r.skippedShort, 1); // sell with no position
  const infy = r.trades.find((t) => t.symbol === "INFY");
  assert.equal(infy.status, "closed");
  assert.equal(infy.avgEntry, 1510);
  // FIFO: 10@1500→1600 (+1000), 5@1520→1600 (+400), 5@1520→1580 (+300)
  assert.equal(infy.pnl, 1700);
  assert.equal(infy.exits.length, 2);
  const tcs = r.trades.find((t) => t.symbol === "TCS");
  assert.equal(tcs.status, "open");
  assert.equal(tcs.remainingQty, 2);
});

test("re-importing the same file adds nothing", () => {
  const { fills } = parseTradebook(CSV);
  const first = buildTrades(fills);
  const ids = new Set(first.trades.flatMap((t) => t.importIds));
  const again = buildTrades(fills, ids);
  assert.equal(again.trades.length, 0);
  assert.equal(again.duplicates, 5);   // every equity fill that was imported
  assert.equal(again.skippedShort, 1); // the short sell is skipped again, never imported
});

test("rejects files that aren't a tradebook", () => {
  assert.throws(() => parseTradebook("a,b,c\n1,2,3"), /Zerodha tradebook/);
});
