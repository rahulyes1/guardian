#!/usr/bin/env node
// Daily data audit: compares what the LIVE app serves against NSE's official files.
// Exits 1 (so GitHub Actions emails you) if anything shown in the app is wrong.
//
//   node scripts/audit-data.mjs                       # audit production
//   APP_URL=https://... node scripts/audit-data.mjs   # audit another deployment
//   AUDIT_DATE=2026-11-12 node scripts/audit-data.mjs # audit a past session
//
// Checks
//   1. Index closes  — app /api/quote, /api/nse (file + live) vs NSE ind_close_all
//   2. Stock closes  — app /api/spark last bar for every Nifty 500 stock vs NSE bhavcopy
//   3. Breadth math  — QUAD computation vs an independent naive recount on the same data
//   4. Index list    — app /nifty500.json vs NSE's current Nifty 500 constituents
import fs from "node:fs";
import {
  parseIndexCloseCsv, parseBhavFullCsv, nseFileDate, istParts, isPlaceholderSymbol, INDEX_KEYS,
} from "../lib/marketChecks.js";
import { alignByDate, applyNseCloses, computeFromAligned } from "../marketQuadrant.js";

const APP = (process.env.APP_URL || "https://guardian-swart-theta.vercel.app").replace(/\/$/, "");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const DAY = process.env.AUDIT_DATE || istParts().day;

const failures = [], warnings = [], notes = [];
const fail = (m) => { failures.push(m); console.log("FAIL  " + m); };
const warn = (m) => { warnings.push(m); console.log("WARN  " + m); };
const note = (m) => { notes.push(m); console.log("ok    " + m); };

async function get(url, { json = false, timeout = 20000, retries = 2 } = {}) {
  for (let a = 0; a <= retries; a++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: json ? "application/json" : "*/*", Referer: "https://www.nseindia.com/" } });
      if (r.status === 404) return { status: 404 };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { status: 200, body: json ? await r.json() : await r.text() };
    } catch (e) {
      if (a === retries) return { status: 0, error: e.message };
      await new Promise((res) => setTimeout(res, 1500 * (a + 1)));
    } finally { clearTimeout(t); }
  }
}
const pctDiff = (a, b) => Math.abs(a / b - 1) * 100;

async function main() {
  console.log(`Auditing ${APP} for NSE session ${DAY}\n`);

  // ── NSE truth ──
  const idxFile = await get(`https://nsearchives.nseindia.com/content/indices/ind_close_all_${nseFileDate(DAY)}.csv`);
  if (idxFile.status === 404) {
    const { dow, mins } = istParts();
    const msg = `NSE has no index close file for ${DAY} (weekend, holiday, or not published yet) — nothing to audit.`;
    if (dow >= 1 && dow <= 5 && mins > 20 * 60 && !process.env.AUDIT_DATE) warn(msg + " If today was a trading day, NSE is late.");
    else note(msg);
    return;
  }
  if (idxFile.status !== 200) { fail(`Could not download NSE index close file: ${idxFile.error}`); return; }
  const nseIdx = parseIndexCloseCsv(idxFile.body);
  const bhavRes = await get(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${nseFileDate(DAY)}.csv`, { timeout: 60000 });
  const bhav = bhavRes.status === 200 ? parseBhavFullCsv(bhavRes.body) : null;
  if (!nseIdx) { fail("NSE index close file could not be parsed"); return; }
  if (!bhav) fail(`NSE bhavcopy for ${DAY} unavailable (${bhavRes.status || bhavRes.error}) — stock checks skipped`);

  // ── 1. Index closes ──
  const appEod = await get(`${APP}/api/nse?type=indices`, { json: true });
  const appLive = await get(`${APP}/api/nse?type=live`, { json: true });
  for (const [key, k] of Object.entries(INDEX_KEYS)) {
    const truth = nseIdx.indices[k.nseFile];
    if (!truth) { fail(`${k.nseFile} missing from NSE file`); continue; }
    const q = await get(`${APP}/api/quote?symbol=${encodeURIComponent(k.yahoo)}`, { json: true });
    if (q.status !== 200) fail(`${k.nseFile}: app /api/quote failed (${q.status || q.error})`);
    else {
      const p = q.body;
      if (pctDiff(p.price, truth.close) > 0.05) fail(`${k.nseFile}: app quote price ${p.price} ≠ NSE close ${truth.close}`);
      else if (p.changePct == null || Math.abs(p.changePct - truth.changePct) > 0.02) fail(`${k.nseFile}: app quote change ${p.changePct}% ≠ NSE ${truth.changePct}%`);
      else note(`${k.nseFile}: app quote ${p.price} (${p.changePct.toFixed(2)}%) matches NSE`);
    }
    const e = appEod.body?.indices?.[k.nseFile];
    if (appEod.status !== 200 || !e) fail(`${k.nseFile}: app /api/nse?type=indices unavailable (${appEod.status || appEod.error})`);
    else if (appEod.body.date !== DAY) fail(`${k.nseFile}: app /api/nse?type=indices serves ${appEod.body.date}, expected ${DAY}`);
    else if (e.close !== truth.close || e.changePct !== truth.changePct) fail(`${k.nseFile}: app NSE close ${e.close}/${e.changePct}% ≠ NSE ${truth.close}/${truth.changePct}%`);
    else note(`${k.nseFile}: app NSE-close endpoint matches`);
    const l = appLive.body?.indices?.[k.nseLive];
    if (appLive.status !== 200 || !l) warn(`${k.nseFile}: NSE live feed not reachable from the app — header falls back to the close file / Yahoo`);
    else if (appLive.body.date === DAY && pctDiff(l.last, truth.close) > 0.05) fail(`${k.nseFile}: app live feed ${l.last} ≠ NSE close ${truth.close}`);
    else note(`${k.nseFile}: app live feed ${l.last} consistent`);
  }

  // ── 4. Index membership (also gives us the symbol list) ──
  const listRes = await get(`${APP}/nifty500.json`, { json: true });
  const appList = listRes.status === 200 && Array.isArray(listRes.body) ? listRes.body : [];
  if (!appList.length) fail("app /nifty500.json unavailable");
  const placeholders = appList.filter(isPlaceholderSymbol);
  if (placeholders.length) fail(`app stock list contains NSE placeholder symbols: ${placeholders.join(", ")}`);
  const nseList = await get("https://archives.nseindia.com/content/indices/ind_nifty500list.csv");
  if (nseList.status === 200) {
    const cur = new Set(nseList.body.split(/\r?\n/).slice(1).map((l) => l.split(",")[2]?.trim()).filter((s) => s && !isPlaceholderSymbol(s)));
    const added = [...cur].filter((s) => !appList.includes(s)), removed = appList.filter((s) => !cur.has(s));
    if (added.length || removed.length) fail(`Nifty 500 list is out of date — NSE added: ${added.join(" ") || "none"}; removed: ${removed.join(" ") || "none"}. Update public/nifty500.json and public/nifty500_sectors.json.`);
    else note(`Nifty 500 list matches NSE (${appList.length} stocks)`);
  } else warn("Could not download NSE's Nifty 500 constituent list");

  if (!bhav || !appList.length) return;

  // ── 2. Stock closes via the app's /api/spark ──
  const tickers = appList.filter((s) => !isPlaceholderSymbol(s)).map((s) => `${s}.NS`);
  const allData = {};
  for (let pass = 0; pass < 4; pass++) {
    const todo = tickers.filter((t) => !allData[t]);
    if (!todo.length) break;
    for (let i = 0; i < todo.length; i += 50) {
      const r = await get(`${APP}/api/spark?symbols=${encodeURIComponent(todo.slice(i, i + 50).join(","))}&range=2y&interval=1d`, { json: true, timeout: 30000 });
      for (const item of r.body?.spark?.result ?? []) {
        const x = item.response[0]; const byDay = {};
        x.timestamp.forEach((t, j) => { const c = x.indicators.quote[0].close[j]; if (c != null) byDay[new Date((t + 19800) * 1000).toISOString().slice(0, 10)] = c; });
        allData[item.symbol] = byDay;
      }
    }
  }
  const got = tickers.filter((t) => allData[t]).length;
  if (got < tickers.length * 0.95) fail(`Only ${got}/${tickers.length} stocks returned by app /api/spark`);
  let compared = 0; const wrong = [], missingToday = [];
  for (const t of tickers) {
    const sym = t.replace(/\.NS$/, ""), b = bhav.closes[sym], y = allData[t];
    if (!b || !y) continue;
    compared++;
    if (y[DAY] == null) missingToday.push(sym);
    else if (pctDiff(y[DAY], b.close) > 0.1) wrong.push(`${sym} app=${y[DAY]} NSE=${b.close}`);
  }
  if (wrong.length) fail(`${wrong.length}/${compared} stock closes differ from NSE by >0.1% (QUAD corrects these, but Yahoo is drifting): ${wrong.slice(0, 10).join("; ")}`);
  else note(`All ${compared - missingToday.length} stock closes for ${DAY} match NSE within 0.1%`);
  if (missingToday.length > compared * 0.02) fail(`${missingToday.length} stocks have no ${DAY} bar on Yahoo: ${missingToday.slice(0, 15).join(" ")}`);
  else if (missingToday.length) note(`${missingToday.length} stocks lack a ${DAY} Yahoo bar (filled from NSE by QUAD): ${missingToday.join(" ")}`);

  // ── 3. Breadth: app computation vs naive recount on the same NSE-verified data ──
  const { axis, aligned } = alignByDate(allData);
  const v = applyNseCloses(axis, aligned, bhav);
  const sectors = (await get(`${APP}/nifty500_sectors.json`, { json: true })).body || {};
  const result = computeFromAligned(axis, aligned, sectors, Date.now(), v);
  if (result.as_of !== DAY) fail(`QUAD as_of ${result.as_of}, expected ${DAY}`);
  const last = axis.length - 1;
  const naive = (n) => {
    let above = 0, tot = 0;
    for (const series of Object.values(aligned)) {
      if (series.filter((c) => c != null).length < 150) continue; // same universe rule as the app
      const w = series.slice(last - n + 1, last + 1).filter((c) => c != null);
      const c = series[last];
      if (c == null || w.length < Math.ceil(n * 0.75)) continue;
      tot++; if (c > w.reduce((a, b) => a + b, 0) / w.length) above++;
    }
    return (above / tot) * 100;
  };
  for (const [n, key] of [[200, "pct_above_200"], [50, "pct_above_50"], [10, "pct_above_10"]]) {
    const ref = naive(n), app = result[key];
    if (Math.abs(ref - app) > 1) fail(`QUAD % above ${n}-SMA = ${app}, independent recount = ${ref.toFixed(1)}`);
    else note(`QUAD % above ${n}-SMA ${app}% (recount ${ref.toFixed(1)}%)`);
  }
  note(`QUAD for ${DAY}: ${result.overall} · ${result.total} stocks · verification ${v ? `${v.checked} checked, ${v.corrected} corrected` : "none"}`);

  // The shared result users load — must be NSE-verified and agree with the recomputation
  const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (sbUrl && sbKey) {
    const r = await fetch(`${sbUrl}/rest/v1/market_quadrant?as_of=eq.${DAY}&select=data`, { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }).then((x) => x.json()).catch(() => null);
    const shared = Array.isArray(r) ? r[0]?.data : null;
    if (!shared) warn(`No shared QUAD result saved for ${DAY} yet (nobody opened QUAD after the close)`);
    else if (shared.overall !== result.overall || Math.abs(shared.pct_above_50 - result.pct_above_50) > 1) fail(`Shared QUAD result (${shared.overall}, ${shared.pct_above_50}%) disagrees with audit (${result.overall}, ${result.pct_above_50}%)`);
    else note(`Shared QUAD result for ${DAY} agrees (${shared.overall})`);
  }
}

try {
  await main();
} catch (e) {
  fail(`Audit crashed: ${e.stack || e.message}`);
}

const summary = [
  `## Data audit — NSE session ${DAY}`,
  failures.length ? `### ❌ ${failures.length} problem(s)\n${failures.map((f) => `- ${f}`).join("\n")}` : "### ✅ Everything the app shows matches NSE",
  warnings.length ? `### ⚠️ Warnings\n${warnings.map((w) => `- ${w}`).join("\n")}` : "",
  notes.length ? `### Checks passed\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
].filter(Boolean).join("\n\n");
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
console.log(`\n${failures.length ? "FAILED" : "PASSED"} — ${failures.length} failures, ${warnings.length} warnings`);
process.exit(failures.length ? 1 : 0);
