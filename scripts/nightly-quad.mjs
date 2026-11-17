#!/usr/bin/env node
// Nightly Market Quadrant job (GitHub Actions, after NSE publishes ~6 pm IST).
// Runs the same calculation the app runs, verifies the closes against NSE's bhavcopy,
// and publishes the result to Supabase so every visitor loads an already-verified
// result instantly — even if nobody opened the app after the close.
//
// Order matters: the verified result is computed and published FIRST. The heavy optional extras
// (Microcap 250, 5-year records) run afterwards and are added with a second publish, so a Yahoo
// rate-limit on the extras can never stop the main result from going out.
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
process.on("unhandledRejection", (e) => { log(`❌ Unexpected error: ${e?.stack || e}`); finish(1); });

setApiBase(APP);

// 1 · Supabase: earlier evenings' picks (forward test) and the last 5-year records (to choose tonight's picks)
const sb = SB_URL && SB_KEY ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
if (sb) {
  const { error: authErr } = await sb.auth.signInAnonymously();
  if (authErr) { log(`❌ Supabase sign-in failed: ${authErr.message}`); finish(1); }
  const { data: prior, error: pErr } = await sb.from("market_quadrant").select("as_of, picks:data->picks, lstats:data->long_bt->scan_stats").order("as_of", { ascending: false }).limit(60);
  if (pErr) log(`⚠️ Couldn't read earlier picks: ${pErr.message}`);
  const list = (prior || []).map(x => x.picks).filter(p => p?.d && Array.isArray(p.rows));
  setPriorPicks(list);
  const lastStats = (prior || []).find(x => x.lstats)?.lstats;
  if (lastStats) setPickStats(lastStats);
  log(`Forward test: ${list.length} earlier evenings of picks loaded${lastStats ? "; picks chosen by the 5-year records" : "; picks chosen by the 1-year records (no 5-year records published yet)"}`);
}

// 2 · The verified result — the part that must always go out
let r;
try {
  r = await loadMarketQuadrant({ force: true });
} catch (e) {
  log(`❌ Calculation failed: ${e.message}`);
  finish(1);
}
const v = r.verification;
log(`Computed ${r.as_of}: ${r.overall} · ${r.environment?.name} · ${r.total} stocks · follow-through ${r.follow_through?.rate ?? "—"}%`);
log(v ? `NSE check: ${v.checked} stocks checked against the ${v.date} bhavcopy — ${v.matched} matched, ${v.filled ?? 0} missing on Yahoo (filled from NSE, ${v.volumes_filled ?? 0} volumes), ${v.corrected} wrong on Yahoo (corrected)` : "NSE bhavcopy not available yet");
if (r.forward) log(`Forward test: ${r.forward.done} scored, avg ${r.forward.avg ?? "—"}%, vs average stock ${r.forward.vs ?? "—"}`);

if (!r.final || !isVerified(r)) {
  log(`⚠️ Not published: result is ${r.final ? "not yet verified against NSE (bhavcopy for " + r.as_of + " not out)" : "intraday"}. The 22:00 IST run will retry.`);
  finish(0);
}
const canPublish = !DRY && sb;
if (!DRY && !sb) log("⚠️ Not published: add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY as GitHub Actions secrets to enable nightly publishing.");
const publish = async (what) => {
  const { error } = await sb.from("market_quadrant").upsert({ as_of: r.as_of, data: r, computed_at: r.updated_at }, { onConflict: "as_of" });
  if (error) { log(`❌ Publish (${what}) failed: ${error.message}`); return false; }
  log(`✅ Published ${what} for ${r.as_of} (${Math.round(JSON.stringify(r).length / 1024)} KB)`);
  return true;
};
if (canPublish && !(await publish("verified result"))) finish(1);

// 3 · Optional extras, added with a second publish (a failure here never undoes step 2)
let extras = 0;
try { r.micro = await loadMicrocapScans({ force: true }); extras++; log(`Microcap 250: ${r.micro.total} stocks computed`); }
catch (e) { log(`⚠️ Microcap scans skipped: ${e.message}`); }
try {
  r.long_bt = await computeLongBacktest();
  extras++;
  log(`5-year records: ${r.long_bt.from} → ${r.long_bt.to}, ${r.long_bt.stocks} stocks`);
} catch (e) { log(`⚠️ 5-year records skipped: ${e.message}`); }
if (DRY) { log("Dry run — not published."); finish(0); }
if (canPublish && extras) await publish("result with extras");
finish(0);
