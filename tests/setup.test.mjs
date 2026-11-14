// Strength rank, setup grade and trade plan helpers (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { rsScore, rsRating, gradeSetup, tradePlan } from "../marketQuadrant.js";

test("RS rating maps a score through percentile cut-offs to 1–99", () => {
  const breaks = Array.from({ length: 98 }, (_, k) => k / 100); // 0.00 … 0.97
  assert.equal(rsRating(-1, breaks), 1);
  assert.equal(rsRating(0.5, breaks), 52);
  assert.equal(rsRating(5, breaks), 99);
  assert.equal(rsRating(null, breaks), null);
});

test("RS score weights the latest quarter most", () => {
  const flatThenUp = Array.from({ length: 260 }, (_, i) => (i < 197 ? 100 : 100 + (i - 196)));
  const upThenFlat = Array.from({ length: 260 }, (_, i) => (i < 63 ? 100 + i : 163));
  assert.ok(rsScore(flatThenUp) > rsScore(upThenFlat) * 0.5);
  assert.equal(rsScore([1, 2, 3]), null); // not enough history
});

test("setup grade: tight leader near highs in a hot sector grades A; broken stock grades C", () => {
  const up = Array.from({ length: 260 }, (_, i) => 100 + i * 0.5);
  for (let i = 250; i < 260; i++) up[i] = 229 + (i % 2) * 0.5; // tight last 10 closes near the high
  const vols = Array.from({ length: 260 }, (_, i) => (i >= 250 ? 500 : 1000)); // drying up
  const a = gradeSetup({ closes: up, vols, s50: 210, s200: 180, rs: 92, sectorStatus: "HOT", envOk: true });
  assert.equal(a.grade, "A");
  const down = up.map((v, i) => 300 - i * 0.6);
  const c = gradeSetup({ closes: down, vols: null, s50: 200, s200: 250, rs: 12, sectorStatus: "COLD", envOk: false });
  assert.equal(c.grade, "C");
  assert.equal(c.of, 6); // volume unknown → graded on the 6 known checks
});

test("trade plan: entry above the 10-day closing high, stop under recent closes, risk capped at 8%", () => {
  const closes = [100, 101, 102, 103, 104, 105, 104, 103, 104, 103];
  const p = tradePlan(closes);
  assert.equal(p.breaking, false);
  assert.equal(p.entry, +(105 * 1.002).toFixed(2));
  assert.equal(p.stop, +(103 * 0.99).toFixed(2));
  const wide = tradePlan([100, 120, 140, 160, 180, 200, 150, 120, 110, 100]);
  assert.ok(wide.riskPct <= 8.01);
  assert.match(wide.note, /capped/);
});
