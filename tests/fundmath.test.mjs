// Mutual fund analytics (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarYears, monthGrid, riskStats, rollingReturns, investCalc, sinceLaunch, xirr } from "../lib/fundMath.js";
import { monthsOf, fallsOf } from "../api/mf.js";

// 6 years of months growing 1% a month from Mar 2020; a "bench" growing 0.8% a month
const mk = (g, start = 2020 * 12 + 2, n = 72, base = 10) => Array.from({ length: n }, (_, i) => {
  const t = start + i, ym = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`, v = base * Math.pow(1 + g, i);
  return [ym, v / (1 + g / 2), v];
});

test("calendar years: launch year marked as part, full years compound the monthly growth", () => {
  const y = calendarYears(mk(0.01));
  assert.equal(y[0].year, 2020);
  assert.match(y[0].part, /^from 2020-03/);
  assert.ok(Math.abs(y[1].ret - 12.7) < 0.2, `2021 ${y[1].ret}`); // 1.01^12 − 1
  assert.equal(y[y.length - 1].part, "to date");
});

test("month grid has 12 cells per year, newest year first", () => {
  const g = monthGrid(mk(0.01));
  assert.equal(g[0].year, 2026);
  assert.equal(g[1].cells.length, 12);
  assert.equal(g[1].cells[0], 1);
});

test("risk stats: beta ~1 and positive alpha when the fund beats a correlated index", () => {
  const wiggle = (g, k) => mk(g).map((m, i) => { const f = 1 + 0.03 * Math.sin(i * 1.3); return [m[0], m[1] * f, m[2] * f * (1 + k * Math.sin(i * 1.3))]; });
  const s = riskStats(wiggle(0.01, 0.002), wiggle(0.008, 0));
  assert.ok(s.beta > 0.8 && s.beta < 1.3, `beta ${s.beta}`);
  assert.ok(s.alpha > 0, `alpha ${s.alpha}`);
  assert.ok(s.sharpe != null && s.upCapture != null && s.downCapture != null);
});

test("rolling 3-year returns: fund beats the slower index every period", () => {
  const r = rollingReturns(mk(0.01), mk(0.008));
  assert.equal(r.beat, 100);
  assert.ok(Math.abs(r.median - 12.7) < 0.3);
});

test("SIP with step-up invests more each year; lump sum grows by the NAV ratio", () => {
  const m = mk(0.01);
  const flat = investCalc(m, { sip: 10000, start: "2021-01" }), up = investCalc(m, { sip: 10000, start: "2021-01", stepUp: 10 });
  assert.ok(up.invested > flat.invested);
  assert.ok(flat.xirr > 10 && flat.xirr < 14, `xirr ${flat.xirr}`);
  const l = investCalc(m, { lump: 100000, start: "2021-01" });
  assert.equal(l.invested, 100000);
  assert.ok(l.value > 100000);
  assert.ok(sinceLaunch(m).multiple > 1.9);
  assert.equal(xirr([[0, -100], [365.25 * 864e5, 110]]), 10);
});

test("monthly history and falls from daily NAVs", () => {
  const rows = [["2024-01-02", 10], ["2024-01-31", 11], ["2024-02-01", 12], ["2024-03-01", 9], ["2024-04-01", 12.5], ["2024-05-01", 13]];
  assert.deepEqual(monthsOf(rows)[0], ["2024-01", 10, 11]);
  const f = fallsOf(rows);
  assert.equal(f.length, 1);
  assert.equal(f[0].depth, -25);
  assert.equal(f[0].recovered, "2024-04-01");
});
