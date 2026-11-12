// Run: npm test   (node --test tests/*.test.mjs)
// Guards against the data traps we've hit or can foresee: the day after a holiday,
// special/half-day sessions, new listings, NSE placeholder symbols, bad quotes,
// disagreeing sources and missing bars.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  previousSessionClose, quoteIssues, parseIndexCloseCsv, parseBhavFullCsv, parseAllIndices,
  reconcileIndex, verifyAgainstBhav, isPlaceholderSymbol, recentWeekdays, parseNseDate, istDay,
} from "../lib/marketChecks.js";
import { alignByDate, applyNseCloses, computeFromAligned, signalOnDate, computeFollowThrough } from "../marketQuadrant.js";

// Unix seconds for an IST wall-clock time
const ist = (s) => Math.floor((Date.parse(s + "Z") - 19800 * 1000) / 1000);

// The real ^NSEI response (interval=1d, range=5d) on 12 Nov 2026, after the 10 Nov holiday
const NSEI_12NOV = {
  meta: { regularMarketPrice: 25299.35, chartPreviousClose: 24536.6, regularMarketTime: ist("2026-11-12T15:31:25") },
  timestamp: ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-11", "2026-11-12"].map((d) => ist(`${d}T09:15:00`)),
  indicators: { quote: [{ close: [24536.6, 25030.35, 25044.65, 25255.05, 25299.35] }] },
};

test("previous close after a holiday comes from the bars, not Yahoo's chartPreviousClose", () => {
  assert.equal(previousSessionClose(NSEI_12NOV), 25255.05); // NSE: +0.18%, not +1.02%
});

test("previous close during the session ignores today's partial bar", () => {
  const r = structuredClone(NSEI_12NOV);
  r.meta.regularMarketTime = ist("2026-11-12T11:02:00");
  assert.equal(previousSessionClose(r), 25255.05);
});

test("special weekend session (e.g. Muhurat trading) counts as a session", () => {
  const r = {
    meta: { regularMarketTime: ist("2026-11-09T15:30:00") },
    timestamp: [ist("2026-11-06T09:15:00"), ist("2026-11-08T18:00:00"), ist("2026-11-09T09:15:00")],
    indicators: { quote: [{ close: [100, 101, 102] }] },
  };
  assert.equal(previousSessionClose(r), 101);
});

test("new listing with only today's bar has no previous close (never invented)", () => {
  const r = { meta: { regularMarketTime: ist("2026-11-12T15:30:00") }, timestamp: [ist("2026-11-12T09:15:00")], indicators: { quote: [{ close: [500] }] } };
  assert.equal(previousSessionClose(r), null);
});

test("quote sanity checks", () => {
  const now = Date.parse("2026-11-12T05:30:00Z"); // 11:00 IST, session hours
  assert.deepEqual(quoteIssues({ price: 100, prevClose: 99, quoteTimeMs: now - 60000, nowMs: now }), []);
  assert.ok(quoteIssues({ price: 0, prevClose: 99, nowMs: now }).includes("bad_price"));
  assert.ok(quoteIssues({ price: 100, prevClose: null, nowMs: now }).includes("bad_prev"));
  assert.ok(quoteIssues({ price: 112, prevClose: 100, isIndex: true, nowMs: now }).includes("big_move"));
  assert.deepEqual(quoteIssues({ price: 119.9, prevClose: 100, nowMs: now }), []); // 20% circuit is legal
  assert.ok(quoteIssues({ price: 125, prevClose: 100, nowMs: now }).includes("big_move"));
  assert.ok(quoteIssues({ price: 100, prevClose: 99, quoteTimeMs: now - 20 * 60000, nowMs: now }).includes("stale"));
  const evening = Date.parse("2026-11-12T14:30:00Z"); // 20:00 IST, closed
  assert.deepEqual(quoteIssues({ price: 100, prevClose: 99, quoteTimeMs: evening - 4 * 3600000, nowMs: evening }), []);
});

test("parses NSE's index close file (real 12 Nov rows)", () => {
  const csv = [
    "Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield",
    "Nifty 50,12-11-2026,25213.5,25384.8,25142.95,25299.35,44.3,.18,349198003,33608.35,20.62,3.1,1.39",
    "Nifty 500,12-11-2026,23775.6,23940.8,23712.6,23865.8,86.5,.36,2515042184,101933.59,22.32,3.34,1.22",
  ].join("\r\n");
  const p = parseIndexCloseCsv(csv);
  assert.equal(p.date, "2026-11-12");
  assert.equal(p.indices["Nifty 50"].close, 25299.35);
  assert.equal(p.indices["Nifty 50"].changePct, 0.18);
  assert.equal(p.indices["Nifty 50"].prevClose, 25255.05);
  assert.equal(parseIndexCloseCsv("<html>Access denied</html>"), null);
});

test("parses NSE's bhavcopy and keeps only equity series", () => {
  const csv = [
    "SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER",
    "RELIANCE, EQ, 12-Nov-2026, 1335.40, 1335.40, 1342.50, 1330.90, 1339.70, 1339.70, 1336.33, 13807921, 184519.26, 186654, 7358525, 53.29",
    "21STCENMGM, BE, 12-Nov-2026, 56.58, 55.45, 58.39, 54.20, 55.00, 55.04, 55.97, 12850, 7.19, 129, -, -",
    "SGBJUN28, GB, 12-Nov-2026, 14200.00, 14100.01, 14100.01, 13862.00, 13862.00, 13882.54, 13896.30, 513, 71.51, 84, -, -",
  ].join("\n");
  const p = parseBhavFullCsv(csv);
  assert.equal(p.date, "2026-11-12");
  assert.deepEqual(p.closes.RELIANCE, { prev: 1335.4, close: 1339.7 });
  assert.ok(p.closes["21STCENMGM"]);
  assert.equal(p.closes.SGBJUN28, undefined);
});

test("parses NSE's live allIndices feed", () => {
  const p = parseAllIndices({ timestamp: "12-Nov-2026 15:30", data: [{ index: "NIFTY 50", last: 25299.35, previousClose: 25255.05, percentChange: 0.18 }] });
  assert.equal(p.date, "2026-11-12");
  assert.equal(p.time, "15:30");
  assert.equal(p.indices["NIFTY 50"].last, 25299.35);
  assert.equal(parseNseDate("bad"), null);
});

test("index reconciliation prefers NSE and flags disagreement", () => {
  const live = { date: "2026-11-12", time: "15:30", last: 25299.35, prevClose: 25255.05, changePct: 0.18 };
  const eod = { date: "2026-11-12", close: 25299.35, prevClose: 25255.05, changePct: 0.18 };
  const yahooBug = { price: 25299.35, changePct: 1.02, issues: [] };

  let r = reconcileIndex({ live, eod, yahoo: yahooBug });
  assert.equal(r.source, "nse-live"); assert.equal(r.changePct, 0.18); assert.ok(r.verified);

  r = reconcileIndex({ live: null, eod, yahoo: yahooBug }); // live feed down
  assert.equal(r.source, "nse-eod"); assert.equal(r.changePct, 0.18);

  r = reconcileIndex({ live: { ...live, date: "2026-11-11" }, eod }); // live feed stuck on an older day
  assert.equal(r.source, "nse-eod");

  r = reconcileIndex({ live, yahoo: { price: 25400, changePct: 0.6, issues: [] } });
  assert.match(r.warning, /off NSE/);

  r = reconcileIndex({ yahoo: { price: 25299.35, changePct: 0.18, issues: [] } }); // NSE unreachable
  assert.equal(r.source, "yahoo"); assert.equal(r.verified, false); assert.match(r.warning, /Unverified/);

  assert.equal(reconcileIndex({ yahoo: { price: 30000, changePct: null, issues: ["big_move"] } }), null); // never show a bad number
});

test("bhavcopy verification corrects wrong and missing closes", () => {
  const axis = ["2026-11-11", "2026-11-12"];
  const aligned = { "A.NS": [10, 11], "B.NS": [20, 25], "C.NS": [30, null], "D.NS": [1, 2] };
  const bhav = { date: "2026-11-12", closes: { A: { prev: 10, close: 11 }, B: { prev: 20, close: 21 }, C: { prev: 30, close: 31 } } };
  const v = verifyAgainstBhav(axis, aligned, bhav);
  assert.deepEqual([v.checked, v.matched, v.corrected, v.missing], [3, 1, 2, 1]);
  assert.equal(aligned["B.NS"][1], 21);
  assert.equal(aligned["C.NS"][1], 31);
  assert.equal(verifyAgainstBhav(axis, aligned, { ...bhav, date: "2026-11-13" }), null);
});

test("a session Yahoo hasn't published yet is added from NSE", () => {
  const axis = ["2026-11-11"];
  const aligned = { "A.NS": [10], "B.NS": [20] };
  const v = applyNseCloses(axis, aligned, { date: "2026-11-12", closes: { A: { prev: 10, close: 12 } } });
  assert.deepEqual(axis, ["2026-11-11", "2026-11-12"]);
  assert.deepEqual(aligned["A.NS"], [10, 12]);
  assert.deepEqual(aligned["B.NS"], [20, null]);
  assert.ok(v.appended);
});

test("date alignment handles new listings and stray bars", () => {
  const data = {};
  for (let i = 0; i < 10; i++) data[`S${i}.NS`] = { "2026-11-09": 1, "2026-11-11": 2, "2026-11-12": 3 };
  data["NEW.NS"] = { "2026-11-12": 50 };                       // listed today
  data["S0.NS"]["2026-11-10"] = 9;                              // stray bar on a holiday (1 of 11 stocks)
  const { axis, aligned } = alignByDate(data);
  assert.deepEqual(axis, ["2026-11-09", "2026-11-11", "2026-11-12"]);
  assert.deepEqual(aligned["NEW.NS"], [null, null, 50]);
  assert.deepEqual(aligned["S0.NS"], [1, 2, 3]);
});

test("NSE placeholder symbols are never treated as stocks", () => {
  assert.ok(isPlaceholderSymbol("DUMMYHEG"));
  assert.ok(!isPlaceholderSymbol("HEG"));
});

test("weekday helper skips weekends", () => {
  const days = recentWeekdays(Date.parse("2026-11-16T06:00:00Z"), 3); // Monday
  assert.deepEqual(days, ["2026-11-16", "2026-11-13", "2026-11-12"]);
  assert.equal(istDay(ist("2026-11-12T23:59:00")), "2026-11-12");
});

test("signal on a holiday is the previous session's signal", () => {
  const data = { history: [{ d: "2026-11-09", sig: "CASH" }, { d: "2026-11-11", sig: "INVEST" }] };
  assert.equal(signalOnDate(data, "2026-11-10T06:00:00Z"), "CASH");
  assert.equal(signalOnDate(data, "2026-11-11T06:00:00Z"), "INVEST");
  assert.equal(signalOnDate(data, "2020-01-01"), null);
});

test("breadth math: steady uptrend → 100% above all SMAs and INVEST; downtrend → CASH", () => {
  const axis = Array.from({ length: 260 }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  const make = (dir) => Object.fromEntries(Array.from({ length: 60 }, (_, s) => [`S${s}.NS`, axis.map((_, i) => 100 + dir * (i + s * 0.1))]));
  const up = computeFromAligned(axis, make(1), {}, Date.parse("2026-01-01"));
  assert.equal(up.pct_above_200, 100); assert.equal(up.pct_above_50, 100); assert.equal(up.pct_above_10, 100);
  assert.equal(up.new_highs, 60); assert.equal(up.overall, "INVEST");
  const down = computeFromAligned(axis, make(-0.2), {}, Date.parse("2026-01-01"));
  assert.equal(down.pct_above_50, 0); assert.equal(down.overall, "CASH");
});

// ── Market Quadrant framework rules ──
const days = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10));

test("bias only flips after 20 sessions on the other side of 50% (turning before that)", () => {
  const axis = days(300);
  // 290 sessions of decline, then a sharp 10-session rally that lifts every stock above its 200-SMA
  const series = (s) => axis.map((_, i) => (i < 290 ? 300 - i * 0.6 + s * 0.01 : 126 + (i - 289) * 12));
  const data = Object.fromEntries(Array.from({ length: 60 }, (_, s) => [`S${s}.NS`, series(s)]));
  const r = computeFromAligned(axis, data, {}, Date.parse("2026-01-01"));
  assert.equal(r.pct_above_200, 100);
  assert.equal(r.bias, "BEAR");                 // not yet sustained
  assert.equal(r.bias_turning, true);
  assert.ok(r.bias_days < 20);
  assert.equal(r.environment.lockout, true);    // bear + 10-day breadth from washed-out to stretched
});

test("environment: steady uptrend is EASY MONEY, steady downtrend is NO MONEY", () => {
  const axis = days(260);
  const make = (dir) => Object.fromEntries(Array.from({ length: 60 }, (_, s) => [`S${s}.NS`, axis.map((_, i) => 100 + dir * (i + s * 0.1))]));
  const up = computeFromAligned(axis, make(1), {}, Date.parse("2026-01-01"));
  assert.deepEqual([up.bias, up.trend, up.swing_state, up.environment.name], ["BULL", "UP", "UPSWING", "EASY MONEY"]);
  const down = computeFromAligned(axis, make(-0.2), {}, Date.parse("2026-01-01"));
  assert.deepEqual([down.bias, down.trend, down.swing_state, down.environment.name], ["BEAR", "DOWN", "DOWNSWING", "NO MONEY"]);
  assert.equal(down.momentum_sign === "POSITIVE", false);
});

test("follow-through counts pocket pivots that hold above their breakout close", () => {
  const axis = days(80);
  const aligned = {}, volumes = {};
  for (let s = 0; s < 60; s++) {
    // flat at 100 on volume 1000, then a +6% pivot on 3x volume 5 sessions ago
    const c = axis.map(() => 100), v = axis.map(() => 1000);
    c[74] = 106; v[74] = 3000;
    for (let i = 75; i < 80; i++) c[i] = s < 45 ? 110 : 101; // 45 of 60 keep going, 15 fall back below 106
    aligned[`S${s}.NS`] = c; volumes[`S${s}.NS`] = v;
  }
  const ft = computeFollowThrough(axis, aligned, volumes);
  assert.equal(ft.events, 60);
  assert.equal(ft.rate, 75);
  assert.equal(ft.label, "STRONG");
  assert.equal(computeFollowThrough(axis, aligned, null), null); // no volume → no gauge, never a guess
});
