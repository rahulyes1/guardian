// MBI breadth, green light, quality gate, fund flow and IPO lifecycle (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFromAligned } from "../marketQuadrant.js";

// 80 trending stocks with 300 sessions of closes and volumes, plus one recent listing
function universe() {
  const axis = [];
  let t = Date.parse("2025-06-02T00:00:00Z");
  while (axis.length < 300) { const d = new Date(t); if (d.getUTCDay() % 6) axis.push(d.toISOString().slice(0, 10)); t += 86400000; }
  const aligned = {}, volumes = {};
  for (let k = 0; k < 80; k++) {
    const c = [], v = [];
    let p = 100 + k;
    for (let i = 0; i < 300; i++) {
      p *= 1 + 0.001 * ((k % 5) - 1) + 0.025 * Math.sin(i * 0.7 + k); // some fast movers, some slow
      c.push(+p.toFixed(2)); v.push(200000 + ((i * 37 + k * 11) % 50000));
    }
    if (k === 0) { for (let i = 280; i < 285; i++) v[i] = 3000000; } // a heavy-volume week
    aligned[`S${k}.NS`] = c; volumes[`S${k}.NS`] = v;
  }
  const ipo = axis.map((_, i) => (i < 240 ? null : 50 + (i - 240) * 0.5));
  ipo[299] = ipo[298] * 1.06;
  aligned["NEWCO.NS"] = ipo; volumes["NEWCO.NS"] = axis.map((_, i) => (i < 240 ? null : i === 299 ? 900000 : 300000));
  return { axis, aligned, volumes };
}

test("MBI rows: ratios, seven boxes and a day colour that follows the box score", () => {
  const { axis, aligned, volumes } = universe();
  const r = computeFromAligned(axis, aligned, {}, Date.now(), null, volumes);
  const last = r.mbi.rows[r.mbi.rows.length - 1];
  assert.equal(last.boxes.length, 7);
  const score = last.boxes.reduce((a, b) => a + b, 0);
  assert.equal(last.score, score);
  assert.equal(last.color, score >= 3 ? "GREEN" : score <= -3 ? "RED" : "NEUTRAL");
  assert.ok(last.r20 > 0 && last.r50 > 0);
  assert.ok("green" in r.mbi.bt && "red" in r.mbi.bt);
});

test("quality gate: turnover in ₹ crore and a liquidity-only flag for quiet setups", () => {
  const { axis, aligned, volumes } = universe();
  const r = computeFromAligned(axis, aligned, {}, Date.now(), null, volumes);
  const q = r.q_of.S1;
  assert.ok(q.to > 0 && q.to < 10); // ~₹100 × 2.2 lakh shares ≈ ₹2 cr a day
  assert.equal(q.liq, false);
  assert.equal(q.pass, false);
  const micro = computeFromAligned(axis, aligned, {}, Date.now(), null, volumes, null, null, { microcap: true });
  assert.ok(micro.q_of.S120 === undefined && micro.q_of.S79.to >= 3 === micro.q_of.S79.liq);
});

test("green light maps follow-through to an EM-scale band and a size multiplier", () => {
  const { axis, aligned, volumes } = universe();
  const r = computeFromAligned(axis, aligned, {}, Date.now(), null, volumes);
  const g = r.green_light;
  if (g && g.em != null) {
    const band = g.em >= 25 ? "FULL" : g.em >= 15 ? "NORMAL" : g.em >= 9 ? "HALF" : "SMALL";
    assert.equal(g.band, band);
    assert.equal(g.mult, { FULL: 1, NORMAL: 1, HALF: 0.5, SMALL: 0.5 }[band]);
  }
  assert.ok(Array.isArray(r.scans.fundflow));
});

test("IPO lifecycle: a 60-session-old listing above its 50-SMA with a 6% pop qualifies", () => {
  const { axis, aligned, volumes } = universe();
  const r = computeFromAligned(axis, aligned, {}, Date.now(), null, volumes);
  const x = r.scans.ipo.find(y => y.sym === "NEWCO");
  assert.ok(x, "NEWCO listed");
  assert.equal(x.stage, "50–100d");
  assert.equal(x.ma, 50);
  assert.ok(x.pop && x.pop.chg >= 4.5);
});

test("green light doesn't depend on how many stocks downloaded; MBI infinities stay out of the maths", () => {
  const { axis, aligned, volumes } = universe();
  const full = computeFromAligned(axis, aligned, {}, Date.now(), null, volumes);
  const part = Object.fromEntries(Object.entries(aligned).filter((_, k) => k % 10 !== 3));
  const r = computeFromAligned(axis, part, {}, Date.now(), null, volumes);
  if (full.green_light?.em != null && r.green_light?.em != null) assert.ok(Math.abs(full.green_light.em - r.green_light.em) <= 3);
  for (const row of full.mbi.rows) {
    for (const k of ["r45", "r20", "r50"]) assert.ok(row[k] == null || Number.isFinite(row[k]));
    if (row.inf?.r45) assert.equal(row.c45, null);
  }
});

test("forward test: a pick that fills and closes 10 sessions later is scored against the average stock", () => {
  const { axis, aligned, volumes } = universe();
  const t0 = axis.length - 15, c = aligned["S2.NS"];
  const prior = [{ d: axis[t0], rows: [{ sym: "S2", entry: c[t0 + 1] * 0.99, stop: Math.min(...c.slice(t0, t0 + 13)) * 0.9, from: "leaders" }, { sym: "S3", entry: 1e9, stop: 1, from: "tight" }] }];
  const r = computeFromAligned(axis, aligned, {}, Date.now(), null, volumes, null, null, { priorPicks: prior });
  assert.equal(r.forward.picks, 2);
  assert.equal(r.forward.done, 1);
  assert.equal(r.forward.nofill, 1);
  const s2 = r.forward.rows.find(x => x.sym === "S2");
  assert.equal(s2.status, "closed");
  assert.ok(Number.isFinite(s2.ret) && Number.isFinite(s2.vs));
  assert.ok(Array.isArray(r.picks.rows) && r.picks.d === axis[axis.length - 1]);
});
