#!/usr/bin/env node
// Sends Web Push alerts to subscribed devices — works even when the app is closed.
//   intraday (default): every 15 min in market hours — open-trade stop hit, watchlist level crossed
//   MODE=signal:        after the nightly publish — overall signal changed vs the previous session
// Each alert is sent at most once per user per day (recorded in push_sent).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (reads every user's subscriptions + app state),
//          VAPID_PRIVATE_KEY. APP_URL for live quotes.
import fs from "node:fs";
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

const APP = (process.env.APP_URL || "https://guardian-swart-theta.vercel.app").replace(/\/$/, "");
const VAPID_PUBLIC = "BOfMpRJYlyp46brGiuduUaTZc64NIIgi0f3JriXHejdrDsEz8zbEF_4MeeYSmQ9TuMG32Myfu0umK_2MPL4nNLQ";
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PRIVATE_KEY } = process.env;
const MODE = process.env.MODE || "intraday";
const DRY = process.env.DRY_RUN === "1";

const lines = [];
const log = (m) => { console.log(m); lines.push(m); };
const finish = (code = 0) => {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Push alerts (${MODE})\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
  process.exit(code);
};
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !VAPID_PRIVATE_KEY) {
  log("⚠️ Push not configured: add SUPABASE_SERVICE_ROLE_KEY and VAPID_PRIVATE_KEY secrets (SUPABASE_URL is already set).");
  finish(0);
}
webpush.setVapidDetails("https://guardian-swart-theta.vercel.app", VAPID_PUBLIC, VAPID_PRIVATE_KEY);
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);

const { data: subs, error: subErr } = await sb.from("push_subscriptions").select("endpoint, user_id, subscription");
if (subErr) { log(`❌ Reading subscriptions failed: ${subErr.message}`); finish(1); }
if (!subs.length) { log("No devices subscribed yet."); finish(0); }
const users = [...new Set(subs.map((s) => s.user_id))];

// Build the alerts per user
const alertsByUser = new Map();
if (MODE === "signal") {
  const { data: rows } = await sb.from("market_quadrant").select("as_of, data").order("as_of", { ascending: false }).limit(1);
  const d = rows?.[0]?.data, h = d?.history || [];
  const prev = h.length >= 2 ? h[h.length - 2].sig : null;
  if (d && prev && prev !== d.overall) {
    for (const u of users) alertsByUser.set(u, [{ key: `signal:${d.as_of}`, title: `Market signal: ${prev} → ${d.overall}`, body: `${d.environment?.name || ""} · ${d.bias} / ${d.trend} / ${d.swing_state}. Open TRADESK for today's rule.` }]);
  } else log(`Signal unchanged (${d?.overall ?? "—"}) — nothing to send.`);
} else {
  const { data: states } = await sb.from("app_state").select("user_id, payload").in("user_id", users);
  const watch = new Map(), syms = new Set();
  for (const s of states || []) {
    const p = s.payload || {};
    const items = [];
    for (const w of p.watchlist || []) if (w.level > 0) { items.push({ kind: "level", sym: w.sym, level: w.level }); syms.add(w.sym); }
    for (const t of p.trades || []) {
      const stop = t.currentStop || t.stop;
      if ((t.status === "open" || t.status === "partial") && stop > 0) { items.push({ kind: "stop", sym: String(t.symbol).toUpperCase(), level: stop }); syms.add(String(t.symbol).toUpperCase()); }
    }
    watch.set(s.user_id, items);
  }
  const prices = {};
  await Promise.all([...syms].map(async (sym) => {
    try { const r = await fetch(`${APP}/api/quote?symbol=${encodeURIComponent(sym)}`).then((x) => x.json()); if (Number.isFinite(r.price) && !(r.issues || []).includes("stale")) prices[sym] = r.price; } catch (_) {}
  }));
  log(`Checked ${syms.size} symbols for ${watch.size} users (${Object.keys(prices).length} live prices).`);
  for (const [u, items] of watch) {
    const out = [];
    for (const it of items) {
      const px = prices[it.sym]; if (px == null) continue;
      if (it.kind === "stop" && px <= it.level) out.push({ key: `stop:${it.sym}:${it.level}`, title: `⛔ ${it.sym} at/below your stop`, body: `₹${px.toFixed(2)} ≤ stop ₹${it.level}. Decide now.` });
      if (it.kind === "level" && px >= it.level) out.push({ key: `level:${it.sym}:${it.level}`, title: `🔔 ${it.sym} crossed ₹${it.level}`, body: `Now ₹${px.toFixed(2)}.` });
    }
    if (out.length) alertsByUser.set(u, out);
  }
}

// Drop alerts already sent today, then send
let sent = 0, gone = 0;
for (const [u, alerts] of alertsByUser) {
  const { data: done } = await sb.from("push_sent").select("alert").eq("user_id", u).eq("day", today);
  const seen = new Set((done || []).map((r) => r.alert));
  const fresh = alerts.filter((a) => !seen.has(a.key));
  if (!fresh.length) continue;
  const payload = fresh.length === 1 ? fresh[0] : { title: `${fresh.length} TRADESK alerts`, body: fresh.map((a) => a.title.replace(/^\S+ /, "")).join(" · ") };
  for (const s of subs.filter((x) => x.user_id === u)) {
    if (DRY) { log(`[dry] → ${u.slice(0, 8)}…: ${payload.title}`); continue; }
    try { await webpush.sendNotification(s.subscription, JSON.stringify({ ...payload, tag: "tradesk-alert" })); sent++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint); gone++; }
      else log(`⚠️ Send failed (${e.statusCode || e.message})`);
    }
  }
  if (!DRY) await sb.from("push_sent").upsert(fresh.map((a) => ({ user_id: u, alert: a.key, day: today })), { onConflict: "user_id,alert,day" });
}
log(`Sent ${sent} notification(s)${gone ? `, removed ${gone} expired device(s)` : ""}.`);
finish(0);
