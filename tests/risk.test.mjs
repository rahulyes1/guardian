// Fixes from the QA review: position risk, R-multiples, idea sizing / triggering / typo checks (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { openRisk, tradeR } from "../lib/risk.js";
import { ideaMath, newlyTriggered, quoteIsToday, ideaWarnings, normalizeIdea } from "../lib/ideas.js";

test("risk: a stop at or above entry is zero risk, never negative or mirrored", () => {
  assert.equal(openRisk(3450, 3300, 2), 300);
  assert.equal(openRisk(3450, 3500, 2), 0); // trailed into profit (was counted as ₹100 of risk)
  assert.equal(openRisk(3450, 3450, 2), 0);
  assert.equal(openRisk(100, 95, 0), 0);
});

test("risk after a partial exit and an add is on the shares still held", () => {
  // buy 100 @100 (stop 95), sell 50, add 20 @110 → 70 shares, avg of all entries 101.67
  const avg = (100 * 100 + 20 * 110) / 120;
  assert.equal(Math.round(openRisk(avg, 95, 70)), 467); // was 120 × (avg − 95) = ₹800, using every share ever bought
});

test("R-multiple uses the risk the trade started with", () => {
  assert.equal(tradeR({ pnl: 600, initialRisk: 300, riskAmount: 0 }), 2); // closed trade: riskAmount is 0, R still known
  assert.equal(tradeR({ pnl: 600, riskAmount: 300 }), 2); // older trades without initialRisk
  assert.equal(tradeR({ pnl: 600, riskAmount: 0 }), null);
});

test("idea R:R is also shown from the top of the zone (where Convert enters)", () => {
  const m = ideaMath({ lo: 3500, hi: 3560, stop: 3400, target: 3900 });
  assert.equal(m.rr, 2.8);    // from mid 3,530
  assert.equal(m.rrTop, 2.1); // (3900 − 3560) / (3560 − 3400) = 2.125
});

test("only today's price can trigger an idea", () => {
  const now = Date.parse("2026-11-21T03:00:00Z"); // Saturday 08:30 IST
  assert.equal(quoteIsToday("2026-11-20T10:00:00Z", now), false); // Friday's close
  assert.equal(quoteIsToday("2026-11-21T02:50:00Z", now), true);
  assert.equal(quoteIsToday(null, now), false);
  const ideas = [{ id: "a", sym: "A", status: "watching", lo: 100, hi: 110, stop: 90, target: 140 }];
  assert.deepEqual(newlyTriggered(ideas, { A: 105 }, () => false), []);
  assert.deepEqual(newlyTriggered(ideas, { A: 105 }, () => true), ["a"]);
});

test("typo warnings are advisory: wide zone, far stop, huge target", () => {
  assert.deepEqual(ideaWarnings({ lo: 3500, hi: 3560, stop: 3400, target: 3900 }), []);
  assert.equal(ideaWarnings({ lo: 3900, hi: 3900, stop: 3800, target: 39000 }).length, 1);
  assert.equal(ideaWarnings({ lo: 100, hi: 130, stop: 60, target: 140 }).length, 2);
});

test("legacy ideas without an id get distinct, stable ids", () => {
  const a = normalizeIdea({ sym: "MCX", lo: 3500, stop: 3400, target: 3900 }), b = normalizeIdea({ sym: "MCX", lo: 3600, stop: 3400, target: 3900 });
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, normalizeIdea({ sym: "MCX", lo: 3500, stop: 3400, target: 3900 }).id);
});
