// "My ideas" vault: risk:reward maths, validation, zone checks, auto-trigger, stored-data cleaning (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ideaMath, validateIdea, normalizeIdea, zoneState, newlyTriggered } from "../lib/ideas.js";

test("R:R from the middle of the entry zone", () => {
  // MCX: zone 3,700–3,760 → entry 3,730; stop 3,500 → risk 230; target 4,300 → reward 570; 570/230 = 2.478 → 2.5
  const m = ideaMath({ lo: 3700, hi: 3760, stop: 3500, target: 4300 });
  assert.deepEqual(m, { entry: 3730, risk: 230, reward: 570, rr: 2.5, riskPct: 6.2 });
  // single-price entry
  assert.equal(ideaMath({ lo: 100, hi: 100, stop: 95, target: 115 }).rr, 3);
  // strings from form fields work, with commas
  assert.equal(ideaMath({ lo: "1,000", hi: "1,000", stop: "950", target: "1,100" }).rr, 2);
  // no risk or no reward → nothing (never a negative or infinite R:R)
  assert.equal(ideaMath({ lo: 100, hi: 100, stop: 100, target: 120 }), null);
  assert.equal(ideaMath({ lo: 100, hi: 100, stop: 90, target: 100 }), null);
});

test("validation: long trades only, stop below the zone, target above it", () => {
  assert.deepEqual(validateIdea({ sym: "mcx", lo: 3700, hi: 3760, stop: 3500, target: 4300 }), []);
  assert.match(validateIdea({ sym: "MCX", lo: 3700, hi: 3760, stop: 3720, target: 4300 })[0], /Stop loss must be below/);
  assert.match(validateIdea({ sym: "MCX", lo: 3700, hi: 3760, stop: 3500, target: 3750 })[0], /Target must be above/);
  assert.match(validateIdea({ sym: "MCX", lo: 3760, hi: 3700, stop: 3500, target: 4300 })[0], /Entry 'to'/);
  assert.match(validateIdea({ sym: "", lo: 1, stop: 0.5, target: 2 })[0], /NSE symbol/);
  assert.ok(validateIdea({ sym: "M&M", lo: "", stop: "", target: "" }).length >= 3);
});

test("zone: in, above, below, through the stop", () => {
  const i = { lo: 100, hi: 110, stop: 90, target: 140 };
  assert.equal(zoneState(i, 105).where, "in");
  assert.equal(zoneState(i, 110).where, "in");
  assert.equal(zoneState(i, 115).where, "above");
  assert.equal(zoneState(i, 115).text, "4.5% above the zone");
  assert.equal(zoneState(i, 95).where, "below");
  assert.equal(zoneState(i, 90).where, "stopped");
  assert.equal(zoneState(i, null).where, "unknown");
});

test("auto-trigger: only watching ideas whose price is in the zone", () => {
  const ideas = [
    { id: "a", sym: "A", status: "watching", lo: 100, hi: 110, stop: 90, target: 140 },
    { id: "b", sym: "B", status: "watching", lo: 100, hi: 110, stop: 90, target: 140 },
    { id: "c", sym: "C", status: "taken", lo: 100, hi: 110, stop: 90, target: 140 },
  ];
  assert.deepEqual(newlyTriggered(ideas, { A: 105, B: 120, C: 105 }), ["a"]);
});

test("stored ideas are cleaned: bad rows dropped, unknown status and tags reset", () => {
  assert.equal(normalizeIdea({ sym: "X" }), null);
  const n = normalizeIdea({ id: "1", sym: " mcx ", lo: "3700", hi: "3600", stop: 3500, target: 4300, status: "weird", tags: ["breakout", "breakout", "moon"], date: "2026-11-18T10:00:00Z" });
  assert.equal(n.sym, "MCX");
  assert.equal(n.hi, 3700); // zone never inverted
  assert.equal(n.status, "watching");
  assert.deepEqual(n.tags, ["breakout"]);
});
