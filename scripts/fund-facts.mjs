// Builds public/fund_facts.json from AMFI (run monthly by .github/workflows/fund-facts.yml, or by hand):
//   ter   { amfiCode: [directTER, regularTER] }   — expense ratio % (latest day AMFI lists this month)
//   aum   { amfiCode: ₹ crore }                   — the whole scheme's quarterly average AUM (all plans together)
//   flows { months: ["2025-11", ...], groups: [{ name, cats: [{ name, net: [₹ cr per month], aum }] }] } — AMFI monthly report
// Usage: node scripts/fund-facts.mjs [--only=flows|ter|aum]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readXls } from "../lib/xls.js";
import { readXlsx } from "../lib/xlsx.js";
import { parseAmfi } from "../api/mf.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "fund_facts.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7);
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { json = true, tries = 4, timeout = 45000 } = {}) {
  for (let k = 1; k <= tries; k++) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
      const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: json ? "application/json" : "*/*", Referer: "https://www.amfiindia.com/" } });
      clearTimeout(t);
      if (r.ok) return json ? await r.json() : Buffer.from(await r.arrayBuffer());
      if (r.status === 404) return null;
      log(`  ${r.status} ${url.slice(0, 110)} (try ${k})`);
      if (r.status === 429) { await sleep(20000 * k); continue; } // AMFI rate limit: back off hard
    } catch (e) { log(`  ${e.name} ${url.slice(0, 110)} (try ${k})`); }
    await sleep(1500 * k);
  }
  return null;
}

// "Parag Parikh Flexi Cap Fund - Direct Plan - Growth" → "paragparikhflexicap"
export function baseKey(name) {
  return String(name || "").toLowerCase()
    .split(/\s+-\s+(?=(direct|regular|growth|idcw|dividend|bonus|plan|option))/)[0]
    .replace(/&/g, "and").replace(/\b(fund|plan|scheme|the|direct|regular|growth|option)\b/g, "").replace(/[^a-z0-9]/g, "");
}

// Category names changed with SEBI's 2026 recategorisation — compare on a normalised key
export function groupKey(g) {
  const x = String(g || "").toLowerCase();
  return /debt|income/.test(x) ? "Debt" : /equity|growth/.test(x) ? "Equity" : /hybrid/.test(x) ? "Hybrid" : /index/.test(x) ? "Index funds"
    : /exchange|etf/.test(x) ? "ETFs" : /solution/.test(x) ? "Solution-oriented" : /life ?cycle/.test(x) ? "Life cycle" : "Other";
}
const CAT_ALIAS = { elss: "elsstaxsaver", floater: "floatinginterestrates", giltwith10yearconstantduration: "10yearconstantmaturitygilt",
  dynamicassetallocationbalancedadvantage: "balancedadvantagedynamicassetallocation", otheretfs: "equityetf", goldetfs: "goldetf", indexfunds: "equity" };
export function catKey(c) {
  const k = String(c || "").toLowerCase().replace(/&/g, "and").replace(/\bfunds?\b/g, "").replace(/[^a-z0-9]/g, "");
  return CAT_ALIAS[k] || k;
}

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// One AMFI monthly report → { month, rows: [{ group, name, net, aum }] }
export function parseMonthlyReport(rows, month) {
  const out = [];
  let group = null;
  for (const r of rows) {
    const sr = String(r[0] ?? "").trim(), name = String(r[1] ?? "").trim().replace(/\s+/g, " ");
    if (!name) continue;
    if (/^[IVX]+$/.test(sr) && typeof r[2] !== "number") { group = name.replace(/\*+/g, "").trim(); continue; }
    if (/^[A-C]$/.test(sr) && !/open/i.test(name)) break; // only open-ended schemes
    if (!group || /total/i.test(name) || typeof r[6] !== "number") continue;
    if (/^[ivx]+$/i.test(sr)) out.push({ group: groupKey(group), key: catKey(name), name, net: Math.round(r[6]), aum: typeof r[7] === "number" ? Math.round(r[7]) : null });
  }
  return { month, rows: out };
}

async function flows() {
  const now = new Date();
  const reports = [];
  for (let back = 1; back <= 14 && reports.length < 12; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const tag = `${MON[d.getUTCMonth()]}${d.getUTCFullYear()}`;
    const buf = await get(`https://portal.amfiindia.com/spages/am${tag}repo.xls`, { json: false, tries: 2 });
    if (!buf || buf.length < 5000) { log(`  flows: no report for ${tag}`); continue; }
    try {
      const rep = parseMonthlyReport(readXls(buf), d.toISOString().slice(0, 7));
      if (rep.rows.length > 20) reports.push(rep); else log(`  flows: ${tag} parsed only ${rep.rows.length} rows`);
    } catch (e) { log(`  flows: ${tag} unreadable (${e.message})`); }
  }
  if (!reports.length) return null;
  reports.reverse(); // oldest first
  const latest = reports[reports.length - 1];
  const groups = [];
  for (const r of latest.rows) {
    let g = groups.find((x) => x.name === r.group);
    if (!g) groups.push((g = { name: r.group, cats: [] }));
    g.cats.push({ name: r.name, aum: r.aum, net: reports.map((rep) => rep.rows.find((x) => x.group === r.group && x.key === r.key)?.net ?? null) });
  }
  log(`flows: ${reports.length} months (${reports[0].month} → ${latest.month}), ${latest.rows.length} categories`);
  return { months: reports.map((r) => r.month), groups };
}

async function aum() {
  const meta = await get("https://www.amfiindia.com/api/average-aum-fundwise?fyId=1");
  const period = meta?.data?.periods?.[0];
  if (!period) return null;
  const amcs = await get("https://www.amfiindia.com/api/populate-te-rdata-revised?MF_ID=All&Month=" + monthTag(1) + "&strCat=-1&strType=-1&page=1&pageSize=1");
  void amcs;
  const out = {}, names = {};
  let n = 0;
  for (let id = 1; id <= 80; id++) { // AMC ids are small integers; unknown ones come back empty
    const j = await get(`https://www.amfiindia.com/api/average-aum-schemewise?strType=Categorywise&MF_ID=${id}&fyId=1&periodId=${period.id}`, { tries: 2 });
    const cats = Array.isArray(j?.data) ? j.data : [];
    if (!cats.length) continue;
    n++;
    for (const c of cats) {
      const byScheme = {};
      for (const s of c.schemes || []) {
        const v = Number(s.AverageAumForTheMonth?.ExcludingFundOfFundsDomesticButIncludingFundOfFundsOverseas || 0) + Number(s.AverageAumForTheMonth?.FundOfFundsDomestic || 0);
        const k = baseKey(s.SchemeNAVName);
        (byScheme[k] ||= { lakh: 0, codes: [] }).lakh += v;
        byScheme[k].codes.push(s.AMFI_Code);
        names[s.AMFI_Code] = k;
      }
      for (const { lakh, codes } of Object.values(byScheme)) for (const code of codes) out[code] = Math.round(lakh / 100); // ₹ lakh → ₹ crore
    }
    await sleep(250);
  }
  log(`aum: ${n} fund houses, ${Object.keys(out).length} plan codes, period ${period.period}`);
  return { aum: out, names, period: period.period };
}

function monthTag(back = 0) {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
}

// the whole month's daily TER disclosure as one Excel file (the JSON API is paged 100 rows at a time and slow)
export function latestTer(rows) {
  const h = (rows[0] || []).map((x) => String(x).toLowerCase());
  const iN = h.indexOf("scheme name"), iD = h.indexOf("ter date"), iR = h.findIndex((x) => /^regular plan - total ter/.test(x)), iX = h.findIndex((x) => /^direct plan - total ter/.test(x));
  if (iN < 0 || iD < 0 || iR < 0 || iX < 0) throw new Error("unexpected TER columns: " + h.join(" | ").slice(0, 200));
  const latest = {};
  for (const r of rows.slice(1)) {
    const k = baseKey(r[iN]), dt = Number(r[iD]);
    if (!k || !Number.isFinite(dt)) continue;
    if (!latest[k] || dt >= latest[k].date) latest[k] = { date: dt, d: parseFloat(r[iX]), r: parseFloat(r[iR]) };
  }
  return latest;
}

async function ter(names) {
  for (const back of [0, 1]) {
    const month = monthTag(back);
    const buf = await get(`https://www.amfiindia.com/api/populate-te-rdata-revised?MF_ID=All&Month=${month}&strCat=-1&strType=-1&page=1&pageSize=100&excel=true`, { json: false, tries: 3, timeout: 180000 });
    if (!buf || buf.length < 10000) { log(`  ter ${month}: no file`); continue; }
    let latest;
    try { latest = latestTer(readXlsx(buf)); } catch (e) { log(`  ter ${month}: unreadable (${e.message})`); continue; }
    const out = {};
    let hit = 0;
    for (const [code, k] of Object.entries(names)) {
      const t = latest[k];
      if (t && (Number.isFinite(t.d) || Number.isFinite(t.r))) { out[code] = [Number.isFinite(t.d) ? t.d : null, Number.isFinite(t.r) ? t.r : null]; hit++; }
    }
    const maxSerial = Math.max(...Object.values(latest).map((t) => t.date));
    const date = Number.isFinite(maxSerial) ? new Date(Date.UTC(1899, 11, 30) + maxSerial * 864e5).toISOString().slice(0, 10) : null; // Excel day number → ISO
    log(`ter: ${month} (to ${date}), ${Object.keys(latest).length} schemes, matched ${hit} plan codes`);
    if (hit) return { ter: out, month, date };
  }
  return null;
}

async function main() {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (_) {}
  const out = { ...prev, updated: new Date().toISOString().slice(0, 10) };
  if (!only || only === "flows") { const f = await flows(); if (f) out.flows = f; }
  if (!only || only === "aum" || only === "ter") {
    const a = await aum();
    if (a) { out.aum = a.aum; out.aum_period = a.period; }
    if (a && (!only || only === "ter")) { const t = await ter(a.names); if (t) { out.ter = t.ter; out.ter_month = t.month; out.ter_date = t.date; } }
  }
  // keep only the Direct-Growth plans the app lists (AMFI's NAV file) — a fraction of all plan codes
  try {
    const nav = await get("https://www.amfiindia.com/spages/NAVAll.txt", { json: false });
    const keep = new Set(parseAmfi(nav.toString("utf8")).funds.map((f) => String(f[0])));
    if (keep.size > 500) for (const k of ["ter", "aum"]) if (out[k]) out[k] = Object.fromEntries(Object.entries(out[k]).filter(([c]) => keep.has(c)));
  } catch (e) { log(`  could not trim to listed funds (${e.message})`); }
  fs.writeFileSync(OUT, JSON.stringify(out));
  log(`wrote ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
