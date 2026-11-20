// Mutual fund analytics from monthly history: [YYYY-MM, first NAV of month, last NAV of month].
// Pure functions (no I/O) — used by the fund page and covered by tests/fundmath.test.mjs.

const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
export const RISK_FREE = 0.065; // ~ Indian T-bill / liquid-fund yield, per year

/** Month-on-month returns keyed by YYYY-MM (last NAV vs previous month's last NAV). */
export function monthlyReturns(months) {
  const out = {};
  for (let i = 1; i < months.length; i++) out[months[i][0]] = months[i][2] / months[i - 1][2] - 1;
  return out;
}

/** Every calendar year: return, and whether it's a part year (launch year or the current year). */
export function calendarYears(months) {
  if (!months?.length) return [];
  const byYear = {};
  for (const [ym, , last] of months) byYear[ym.slice(0, 4)] = { last, lastMonth: ym };
  const first = months[0], years = Object.keys(byYear).sort();
  return years.map((y, i) => {
    const prev = i > 0 ? byYear[years[i - 1]].last : first[1];
    const partStart = i === 0 && first[0] !== `${y}-01`;
    const partEnd = byYear[y].lastMonth !== `${y}-12`;
    return { year: +y, ret: r1((byYear[y].last / prev - 1) * 100), part: partStart ? "from " + first[0] : partEnd ? "to date" : null };
  });
}

/** Years × months grid of monthly returns (%). */
export function monthGrid(months) {
  const mr = monthlyReturns(months), grid = {};
  for (const [ym, v] of Object.entries(mr)) (grid[ym.slice(0, 4)] ||= Array(12).fill(null))[+ym.slice(5, 7) - 1] = r1(v * 100);
  return Object.entries(grid).sort((a, b) => b[0] - a[0]).map(([y, cells]) => ({ year: +y, cells }));
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };

/**
 * Risk-adjusted numbers over the last `n` months (default 36), against the index fund when given.
 * Sharpe / Sortino on monthly returns, annualised; beta and alpha vs the index fund;
 * up / down capture = how much of the index fund's rising / falling months the fund caught.
 */
export function riskStats(months, bench = null, n = 36) {
  const mr = monthlyReturns(months), keys = Object.keys(mr).sort().slice(-n);
  if (keys.length < 24) return null;
  const f = keys.map(k => mr[k]), rfm = RISK_FREE / 12;
  const annRet = Math.pow(f.reduce((a, x) => a * (1 + x), 1), 12 / f.length) - 1;
  const vol = sd(f) * Math.sqrt(12);
  const down = f.map(x => Math.min(0, x - rfm)), dd = Math.sqrt(down.reduce((a, x) => a + x * x, 0) / down.length) * Math.sqrt(12);
  const out = { months: keys.length, from: keys[0], ret: r1(annRet * 100), vol: r1(vol * 100),
    sharpe: vol ? r2((annRet - RISK_FREE) / vol) : null, sortino: dd ? r2((annRet - RISK_FREE) / dd) : null,
    posMonths: Math.round((f.filter(x => x > 0).length / f.length) * 100) };
  if (bench) {
    const bm = monthlyReturns(bench), pairs = keys.filter(k => bm[k] != null).map(k => [mr[k], bm[k]]);
    if (pairs.length >= 24) {
      const fx = pairs.map(p => p[0]), bx = pairs.map(p => p[1]), mf = mean(fx), mb = mean(bx);
      const cov = pairs.reduce((a, [x, y]) => a + (x - mf) * (y - mb), 0) / (pairs.length - 1), varB = sd(bx) ** 2;
      const beta = varB ? cov / varB : null;
      const bAnn = Math.pow(bx.reduce((a, x) => a * (1 + x), 1), 12 / bx.length) - 1;
      const fAnn = Math.pow(fx.reduce((a, x) => a * (1 + x), 1), 12 / fx.length) - 1;
      const up = pairs.filter(p => p[1] > 0), dn = pairs.filter(p => p[1] < 0);
      const cap = (ps) => (ps.length ? (mean(ps.map(p => p[0])) / mean(ps.map(p => p[1]))) * 100 : null);
      Object.assign(out, { beta: r2(beta), alpha: beta != null ? r1((fAnn - (RISK_FREE + beta * (bAnn - RISK_FREE))) * 100) : null,
        upCapture: r1(cap(up)), downCapture: r1(cap(dn)), benchRet: r1(bAnn * 100) });
    }
  }
  return out;
}

/** Rolling `years`-year returns (CAGR, %), monthly steps; with the index fund's alongside when given. */
export function rollingReturns(months, bench = null, years = 3) {
  const n = years * 12, bmap = bench ? Object.fromEntries(bench.map(m => [m[0], m[2]])) : null, out = [];
  for (let i = n; i < months.length; i++) {
    const f = Math.pow(months[i][2] / months[i - n][2], 1 / years) - 1;
    let b = null;
    if (bmap && bmap[months[i][0]] != null && bmap[months[i - n][0]] != null) b = Math.pow(bmap[months[i][0]] / bmap[months[i - n][0]], 1 / years) - 1;
    out.push({ ym: months[i][0], fund: r1(f * 100), bench: b == null ? null : r1(b * 100) });
  }
  if (!out.length) return null;
  const fs = out.map(x => x.fund).sort((a, b) => a - b), both = out.filter(x => x.bench != null);
  return { years, points: out, min: fs[0], median: fs[fs.length >> 1], max: fs[fs.length - 1],
    beat: both.length ? Math.round((both.filter(x => x.fund > x.bench).length / both.length) * 100) : null, compared: both.length,
    below: Math.round((fs.filter(v => v < 0).length / fs.length) * 100) };
}

/** XIRR of [ms, amount] flows (investments negative). */
export function xirr(flows) {
  if (flows.length < 2 || !flows.some(f => f[1] < 0) || !flows.some(f => f[1] > 0)) return null;
  const t0 = Math.min(...flows.map(f => f[0]));
  const npv = (r) => flows.reduce((a, [ms, cf]) => a + cf / Math.pow(1 + r, (ms - t0) / (365.25 * 864e5)), 0);
  let lo = -0.99, hi = 10; if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 120; i++) { const mid = (lo + hi) / 2; if (npv(mid) > 0) lo = mid; else hi = mid; }
  return r1(((lo + hi) / 2) * 100);
}

/**
 * SIP (monthly, bought at the month's first NAV) and/or a lump sum at the start, valued at the latest NAV.
 * stepUp = yearly % increase in the SIP amount.
 */
export function investCalc(months, { sip = 0, lump = 0, start, stepUp = 0 }) {
  const rows = months.filter(m => m[0] >= start);
  if (!rows.length) return null;
  const last = months[months.length - 1], ms = (ym) => Date.parse(ym + "-01T00:00:00Z");
  let units = 0, invested = 0, amt = sip; const flows = [];
  if (lump > 0) { units += lump / rows[0][1]; invested += lump; flows.push([ms(rows[0][0]), -lump]); }
  rows.forEach((m, i) => {
    if (sip > 0) {
      if (i > 0 && i % 12 === 0) amt = amt * (1 + stepUp / 100);
      units += amt / m[1]; invested += amt; flows.push([ms(m[0]), -amt]);
    }
  });
  const value = units * last[2];
  flows.push([ms(last[0]) + 27 * 864e5, value]);
  return { invested: Math.round(invested), value: Math.round(value), gain: Math.round(value - invested), xirr: xirr(flows), months: rows.length, from: rows[0][0] };
}

/** ₹1 lakh invested at the first NAV in the history. */
export function sinceLaunch(months, amount = 100000) {
  if (!months?.length) return null;
  const first = months[0], last = months[months.length - 1];
  const yrs = (Date.parse(last[0] + "-15") - Date.parse(first[0] + "-01")) / (365.25 * 864e5);
  const value = amount * (last[2] / first[1]);
  return { from: first[0], value: Math.round(value), multiple: r1(value / amount), cagr: yrs >= 1 ? r1((Math.pow(value / amount, 1 / yrs) - 1) * 100) : null };
}
