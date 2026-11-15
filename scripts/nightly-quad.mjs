#!/usr/bin/env node
// Nightly Market Quadrant job (GitHub Actions, after NSE publishes ~6 pm IST).
// Runs the same calculation the app runs, verifies the closes against NSE's bhavcopy,
// and publishes the result to Supabase so every visitor loads an already-verified
// result instantly — even if nobody opened the app after the close.
//
//   APP_URL=https://… SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… node scripts/nightly-quad.mjs
//   DRY_RUN=1 node scripts/nightly-quad.mjs      # compute + print, don't publish
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { setApiBase, loadMarketQuadrant, isVerified, setPriorPicks, setPickStats, computeLongBacktest, loadMicrocapScans } from "../marketQuadrant.js";

const APP = (process.env.APP_URL || "https://guardian-swart-theta.vercel.app").replace(/\/$/, "");
const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const DRY = process.env.DRY_RUN === "1";

// The module caches in localStorage in the browser; give it an in-memory one here.
const mem = {};
globalThis.localStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };

const summary = [];
const log = (m) => { console.log(m); summary.push(m); };
const finish = (code) => {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Nightly QUAD\n\n${summary.map((s) => `- ${s}`).join("\n")}\n`);
  process.exit(code);
};

setApiBase(APP);
// Supabase first: earlier evenings' picks feed the forward test
const sb = SB_URL && SB_KEY ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
if (sb) {
  const { error: authErr } = await sb.auth.signInAnonymously();
  if (authErr) { log(`❌ Supabase sign-in failed: ${authErr.message}`); finish(1); }
  const { data: prior, error: pErr } = await sb.from("market_quadrant").select("as_of, picks:data->picks").order("as_of", { ascending: false }).limit(60);
  if (pErr) log(`⚠️ Couldn't read earlier picks: ${pErr.message}`);
  const list = (prior || []).map(x => x.picks).filter(p => p?.d && Array.isArray(p.rows));
  setPriorPicks(list);
  log(`Forward test: ${list.length} earlier evenings of picks loaded`);
}
// 5-year records first: they decide which lists tonight's forward-test picks come from
let longBt = null;
try {
  longBt = await computeLongBacktest();
  setPickStats(longBt.scan_stats);
  log(`5-year records: ${longBt.from} → ${longBt.to}, ${longBt.stocks} stocks`);
} catch (e) { log(`⚠️ 5-year records skipped: ${e.message}`); }
let r;
try {
  r = await loadMarketQuadrant({ force: true });
  if (longBt) r.long_bt = longBt;
} catch (e) {
  log(`❌ Calculation failed: ${e.message}`);
  finish(1);
}
const v = r.verification;
log(`Computed ${r.as_of}: ${r.overall} · ${r.environment?.name} · ${r.total} stocks · follow-through ${r.follow_through?.rate ?? "—"}%`);
log(v ? `NSE check: ${v.checked} stocks checked against the ${v.date} bhavcopy — ${v.matched} matched, ${v.filled ?? 0} missing on Yahoo (filled from NSE, ${v.volumes_filled ?? 0} volumes), ${v.corrected} wrong on Yahoo (corrected)` : "NSE bhavcopy not available yet");

if (!r.final || !isVerified(r)) {
  log(`⚠️ Not published: result is ${r.final ? "not yet verified against NSE (bhavcopy for " + r.as_of + " not out)" : "intraday"}. The 22:00 IST run will retry.`);
  finish(0);
}
// Extras published with the result (each optional — a failure doesn't block publishing)
try { r.micro = await loadMicrocapScans({ force: true }); log(`Microcap 250: ${r.micro.total} stocks computed`); }
catch (e) { log(`⚠️ Microcap scans skipped: ${e.message}`); }
if (r.forward) log(`Forward test: ${r.forward.done} scored, avg ${r.forward.avg ?? "—"}%, vs average stock ${r.forward.vs ?? "—"}`);
if (DRY) { log("Dry run — not published."); finish(0); }
if (!SB_URL || !SB_KEY) {
  log("⚠️ Not published: add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY as GitHub Actions secrets to enable nightly publishing.");
  finish(0);
}

const { error } = await sb.from("market_quadrant").upsert(
  { as_of: r.as_of, data: r, computed_at: r.updated_at },
  { onConflict: "as_of" }
);
if (error) { log(`❌ Publish failed: ${error.message}`); finish(1); }
log(`✅ Published verified result for ${r.as_of} (${Math.round(JSON.stringify(r).length / 1024)} KB)`);
finish(0);
