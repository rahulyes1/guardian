// Vercel Node.js serverless function — official NSE data (source of truth)
//   /api/nse?type=indices  latest ind_close_all file  → { date, indices: { "Nifty 50": {...}, "Nifty 500": {...} } }
//   /api/nse?type=bhav     latest sec_bhavdata_full   → { date, closes: { SYMBOL: [prev, close, volume, delivery%, series ("" = EQ), high] } }
//   /api/nse?type=live     NSE allIndices feed        → { date, time, indices: { "NIFTY 50": {...}, ... } }
//   /api/nse?type=flows    FII/DII cash market activity (latest day)  → { date, fii: {buy,sell,net}, dii: {...} }  (₹ crore)
//   /api/nse?type=deals    bulk + block deals (latest day)            → { date, deals: [{ sym, client, side, qty, price, kind }] }
//   /api/nse?type=surv     F&O ban, ASM/GSM, narrow price bands → { ban: [SYM], asm: {SYM: stage}, gsm: {...}, band: {SYM: %}, ok }
//   /api/nse?type=pastresults&symbol=X  results dates in the last ~2 years → { dates: [...] }
//   /api/nse?type=events   NSE board-meeting calendar → { from, to, results: { SYMBOL: ["YYYY-MM-DD", ...] } }
//                          (financial results only; 10 days back to 21 days ahead)
// Errors return { error } with a non-200 status and are never cached.
import { parseResultXbrl } from "../lib/xbrl.js";
import { parseIndexCloseCsv, parseBhavFullCsv, parseAllIndices, recentWeekdays, nseFileDate, istParts, parseNseDate } from "../lib/marketChecks.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const KEEP_INDICES = ["Nifty 50", "Nifty 500"];
const DEADLINE_MS = 8500; // stay under Vercel's 10s
const num = (v) => { if (v == null) return null; const n = parseFloat(String(v).replace(/,/g, "").trim()); return Number.isFinite(n) ? n : null; };

const rowsOf = (r) => (r?.status === 200 ? (Array.isArray(r.body) ? r.body : Array.isArray(r.body?.data) ? r.body.data : []) : []);
const dmyIst = (ms) => { const d = new Date(ms + 19800000); return String(d.getUTCDate()).padStart(2, "0") + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + d.getUTCFullYear(); };

// Yahoo trailing P/E, P/B and market cap (₹ crore) for a list of NSE symbols, 10 at a time, within the deadline
async function yahooVal(syms, started) {
  const p2 = Math.floor(Date.now() / 1000), p1 = p2 - 20 * 86400, out = {};
  let i = 0;
  const worker = async () => {
    while (i < syms.length && Date.now() - started < DEADLINE_MS - 800) {
      const sym = syms[i++];
      const r = await get(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}.NS?type=trailingPeRatio,trailingPbRatio,trailingMarketCap&period1=${p1}&period2=${p2}`, { json: true, timeout: 3500 });
      const last = (k) => { const res = r.body?.timeseries?.result?.find(x => x?.meta?.type?.[0] === k); const a = res?.[k]?.filter(Boolean); return a?.length ? a[a.length - 1].reportedValue?.raw ?? null : null; };
      if (r.status === 200) {
        const pe = last("trailingPeRatio"), pb = last("trailingPbRatio"), mc = last("trailingMarketCap");
        out[sym] = { pe: pe != null ? Math.round(pe * 10) / 10 : null, pb: pb != null ? Math.round(pb * 100) / 100 : null, mcap: mc != null ? Math.round(mc / 1e7) : null };
      }
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  return out;
}

async function get(url, { json = false, timeout = 4000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: json ? "application/json" : "text/csv,*/*", Referer: "https://www.nseindia.com/" },
    });
    if (!r.ok) return { status: r.status };
    return { status: 200, body: json ? await r.json() : await r.text() };
  } catch (e) {
    return { status: 0, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

// Newest weekday file that exists (NSE publishes ~6pm IST; holidays have no file)
async function latestArchive(makeUrl, parse, started) {
  const tried = [];
  for (const day of recentWeekdays(Date.now(), 6)) {
    if (Date.now() - started > DEADLINE_MS) break;
    const url = makeUrl(nseFileDate(day));
    const r = await get(url, { timeout: 5000 });
    tried.push(`${day}:${r.status}`);
    if (r.status === 200) {
      const parsed = parse(r.body);
      if (parsed) return { parsed, tried };
    }
  }
  return { parsed: null, tried };
}

// Cache longer once today's file is in; retry often while waiting for it
function cacheFor(date) {
  const { day, mins } = istParts();
  if (date === day) return 6 * 3600;
  return mins >= 16 * 60 && mins <= 21 * 60 ? 600 : 1800;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const type = String(req.query.type || "");
  const started = Date.now();
  const fail = (status, error, extra = {}) => {
    res.setHeader("Cache-Control", "no-store");
    return res.status(status).json({ error, ...extra });
  };

  try {
    if (type === "indices") {
      const { parsed, tried } = await latestArchive(
        (d) => `https://nsearchives.nseindia.com/content/indices/ind_close_all_${d}.csv`, parseIndexCloseCsv, started);
      if (!parsed) return fail(502, "NSE index close file unavailable", { tried });
      const indices = Object.fromEntries(KEEP_INDICES.filter((k) => parsed.indices[k]).map((k) => [k, parsed.indices[k]]));
      res.setHeader("Cache-Control", `public, max-age=300, s-maxage=${cacheFor(parsed.date)}`);
      return res.json({ source: "nse-ind_close_all", date: parsed.date, indices });
    }

    if (type === "bhav") {
      const { parsed, tried } = await latestArchive(
        (d) => `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}.csv`, parseBhavFullCsv, started);
      if (!parsed) return fail(502, "NSE bhavcopy unavailable", { tried });
      const closes = {};
      for (const [s, v] of Object.entries(parsed.closes)) closes[s] = [v.prev, v.close, v.vol, v.deliv, v.series === "EQ" ? "" : v.series, v.high];
      res.setHeader("Cache-Control", `public, max-age=300, s-maxage=${cacheFor(parsed.date)}`);
      return res.json({ source: "nse-sec_bhavdata_full", date: parsed.date, closes });
    }

    if (type === "live") {
      const r = await get("https://www.nseindia.com/api/allIndices", { json: true, timeout: 5000 });
      const parsed = r.status === 200 ? parseAllIndices(r.body) : null;
      if (!parsed) return fail(502, `NSE live feed unavailable (${r.status || r.error})`);
      const keep = ["NIFTY 50", "NIFTY 500"];
      const indices = Object.fromEntries(keep.filter((k) => parsed.indices[k]).map((k) => [k, parsed.indices[k]]));
      res.setHeader("Cache-Control", "public, max-age=15, s-maxage=20");
      return res.json({ source: "nse-allIndices", date: parsed.date, time: parsed.time, indices });
    }

    if (type === "flows") {
      const r = await get("https://www.nseindia.com/api/fiidiiTradeReact", { json: true, timeout: 6000 });
      const rows = r.status === 200 && Array.isArray(r.body) ? r.body : null;
      if (!rows?.length) return fail(502, `NSE FII/DII data unavailable (${r.status || r.error})`);
      const pick = (re) => rows.find((x) => re.test(x.category || ""));
      const conv = (x) => (x ? { buy: Number(x.buyValue), sell: Number(x.sellValue), net: Number(x.netValue) } : null);
      res.setHeader("Cache-Control", "public, max-age=900, s-maxage=1800");
      return res.json({ source: "nse-fiidii", date: parseNseDate(rows[0].date), fii: conv(pick(/FII|FPI/i)), dii: conv(pick(/DII/i)) });
    }

    if (type === "deals") {
      const r = await get("https://www.nseindia.com/api/snapshot-capital-market-largedeal", { json: true, timeout: 7000 });
      const b = r.status === 200 ? r.body : null;
      if (!b) return fail(502, `NSE deals data unavailable (${r.status || r.error})`);
      const take = (arr, kind) => (Array.isArray(arr) ? arr : []).map((x) => ({
        sym: x.symbol, client: x.clientName, side: x.buySell, qty: Number(x.qty), price: Number(x.watp), kind,
      })).filter((x) => x.sym && Number.isFinite(x.qty));
      res.setHeader("Cache-Control", "public, max-age=900, s-maxage=1800");
      return res.json({ source: "nse-largedeal", date: parseNseDate(b.as_on_date), deals: [...take(b.BLOCK_DEALS_DATA, "block"), ...take(b.BULK_DEALS_DATA, "bulk")] });
    }

    if (type === "events") {
      const dmy = (ms) => { const d = new Date(ms + 19800000); return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`; };
      const from = dmy(Date.now() - 10 * 86400000), to = dmy(Date.now() + 21 * 86400000);
      const r = await get(`https://www.nseindia.com/api/event-calendar?index=equities&from_date=${from}&to_date=${to}`, { json: true, timeout: 7000 });
      const rows = r.status === 200 ? (Array.isArray(r.body) ? r.body : r.body?.data || []) : null;
      if (!rows) return fail(502, `NSE event calendar unavailable (${r.status || r.error})`);
      const results = {};
      for (const e of rows) {
        if (!e?.symbol || !/result/i.test(e.purpose || "")) continue;
        const day = parseNseDate(e.date);
        if (day) (results[e.symbol] ||= []).includes(day) || results[e.symbol].push(day);
      }
      res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=7200");
      return res.json({ source: "nse-event-calendar", from, to, results });
    }

    // Surveillance: F&O ban list (archives CSV), ASM / GSM stages (NSE API), narrow price bands (sec_list.csv)
    if (type === "surv") {
      const [ban, asm, gsm, bands] = await Promise.all([
        get("https://nsearchives.nseindia.com/content/fo/fo_secban.csv", { timeout: 5000 }),
        get("https://www.nseindia.com/api/reportASM", { json: true, timeout: 6000 }),
        get("https://www.nseindia.com/api/reportGSM", { json: true, timeout: 6000 }),
        get("https://nsearchives.nseindia.com/content/equities/sec_list.csv", { timeout: 6000 }),
      ]);
      const out = { ban: [], asm: {}, gsm: {}, band: {}, ok: {} };
      if (ban.status === 200) {
        out.ok.ban = true;
        for (const l of String(ban.body).split(/\r?\n/).slice(1)) {
          const sym = l.split(",").map(x => x.trim()).find(x => /^[A-Z][A-Z0-9&-]+$/.test(x));
          if (sym) out.ban.push(sym);
        }
      }
      const stages = (body, into) => {
        const rows = [body?.longterm?.data, body?.shortterm?.data, body?.data, Array.isArray(body) ? body : null].filter(Array.isArray).flat();
        for (const x of rows) if (x?.symbol) into[x.symbol] = String(x.asmSurvIndicator || x.gsmSurvIndicator || x.survCode || x.stage || "listed").slice(0, 24);
      };
      if (asm.status === 200) { out.ok.asm = true; stages(asm.body, out.asm); }
      if (gsm.status === 200) { out.ok.gsm = true; stages(gsm.body, out.gsm); }
      if (bands.status === 200) {
        const lines = String(bands.body).split(/\r?\n/);
        const h = (lines[0] || "").toUpperCase().split(",").map(x => x.trim());
        const iS = h.indexOf("SYMBOL"), iB = h.findIndex(x => /BAND/.test(x));
        if (iS >= 0 && iB >= 0) {
          out.ok.band = true;
          for (const l of lines.slice(1)) { const c = l.split(","); const b = parseFloat(c[iB]); if (c[iS] && b > 0 && b <= 10) out.band[c[iS].trim()] = b; }
        }
      }
      res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
      return res.json({ source: "nse-surveillance", ...out });
    }

    // Past results dates for one stock (board meetings whose purpose mentions results, ~2 years)
    if (type === "pastresults") {
      const sym = String(req.query.symbol || "").toUpperCase().replace(/[^A-Z0-9&-]/g, "");
      if (!sym) return fail(400, "symbol required");
      const dmy = (ms) => { const d = new Date(ms + 19800000); return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`; };
      const url = `https://www.nseindia.com/api/event-calendar?index=equities&symbol=${encodeURIComponent(sym)}&from_date=${dmy(Date.now() - 730 * 86400000)}&to_date=${dmy(Date.now())}`;
      const r = await get(url, { json: true, timeout: 7000 });
      const rows = r.status === 200 ? (Array.isArray(r.body) ? r.body : r.body?.data || []) : null;
      if (!rows) return fail(502, `NSE event calendar unavailable (${r.status || r.error})`);
      const dates = [...new Set(rows.filter(e => e?.symbol === sym && /result/i.test(e.purpose || "")).map(e => parseNseDate(e.date)).filter(Boolean))].sort();
      res.setHeader("Cache-Control", "public, max-age=21600, s-maxage=43200");
      return res.json({ source: "nse-event-calendar", symbol: sym, dates });
    }

    // Latest NSE closes for SME (Emerge) stocks — Yahoo doesn't carry them. { date, closes: { SYM: close } }
    if (type === "smeclose") {
      const { parsed, tried } = await latestArchive(
        (d) => `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}.csv`,
        (text) => {
          const lines = String(text || "").split(/\r?\n/); if (lines.length < 2) return null;
          const h = lines[0].split(",").map(x => x.trim().toUpperCase());
          const iS = h.indexOf("SYMBOL"), iSer = h.indexOf("SERIES"), iC = h.indexOf("CLOSE_PRICE"), iD = h.indexOf("DATE1");
          if (iS < 0 || iSer < 0 || iC < 0) return null;
          const closes = {}; let date = null;
          for (const l of lines.slice(1)) {
            const c = l.split(",").map(x => x.trim());
            // every non-EQ series (SME stocks trade as SM / ST / SZ and similar); the app only looks up SME symbols
            const ser = c[iSer] || ""; if (!ser || ser === "EQ") continue;
            const v = parseFloat(c[iC]); if (!c[iS] || !(v > 0)) continue;
            if (!(c[iS] in closes) || /^S/.test(ser)) closes[c[iS]] = v;
            date = date || parseNseDate(c[iD]);
          }
          return date ? { date, closes } : null;
        }, started);
      if (!parsed) return fail(502, "NSE bhavcopy unavailable", { tried });
      res.setHeader("Cache-Control", `public, max-age=900, s-maxage=${cacheFor(parsed.date)}`);
      return res.json({ source: "nse-sec_bhavdata_full (SME series)", ...parsed });
    }

    // IPOs: past issues (last ~400 days), open now, upcoming — straight from NSE's public issue pages
    if (type === "ipos") {
      const [past, cur, up] = await Promise.all([
        get("https://www.nseindia.com/api/public-past-issues", { json: true, timeout: 7000 }),
        get("https://www.nseindia.com/api/ipo-current-issue", { json: true, timeout: 6000 }),
        get("https://www.nseindia.com/api/all-upcoming-issues?category=ipo", { json: true, timeout: 6000 }),
      ]);
      const rowsOf = (r) => (r.status === 200 ? (Array.isArray(r.body) ? r.body : r.body?.data || []) : null);
      const P = rowsOf(past);
      if (!P) return fail(502, `NSE past issues unavailable (${past.status || past.error})`);
      const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : null; };
      // "Rs.259 to Rs.272" → [259, 272] (the dot after "Rs" must not start a number)
      const band = (s) => { const xs = String(s || "").replace(/,/g, "").match(/\d+(?:\.\d+)?/g)?.map(Number).filter(n => Number.isFinite(n) && n > 0) || []; return xs.length ? [Math.min(...xs), Math.max(...xs)] : null; };
      const price = (s) => band(s)?.[1] ?? null; // the final issue price, or the top of a band
      const cutoff = new Date(Date.now() - 372 * 86400000).toISOString().slice(0, 10);
      const listed = P.map(x => ({
        sym: x.symbol, name: x.companyName || x.company, sme: /sme/i.test(x.securityType || ""), type: x.securityType || null,
        listed: parseNseDate(x.listingDate), open: parseNseDate(x.ipoStartDate), close: parseNseDate(x.ipoEndDate),
        price: price(x.issuePrice), band: band(x.priceRange),
      })).filter(x => x.sym && x.listed && x.listed >= cutoff && /^(equity|sme)$/i.test(x.type || "") && !/PP\d*$/.test(x.sym) && !/^\d/.test(x.sym)) // no debt / InvIT / REIT / partly-paid / SME bonds (digit-led symbols)
        .map(x => (x.band && (!x.price || x.price < x.band[0] * 0.8 || x.price > x.band[1] * 1.2) ? { ...x, price: x.band[1] } : x)) // a stray value outside the band → top of band
        .sort((a, b) => (a.listed < b.listed ? 1 : -1));
      const live = (rowsOf(cur) || []).map(x => ({
        sym: x.symbol, name: x.companyName, sme: /sme/i.test(x.series || x.segment || ""), band: band(x.issuePrice),
        open: parseNseDate(x.issueStartDate), close: parseNseDate(x.issueEndDate), status: x.status || null,
        subscribed: num(x.noOfTime) != null ? Math.round(num(x.noOfTime) * 100) / 100 : null, size: num(x.issueSize),
      })).filter(x => x.sym);
      const upcoming = (rowsOf(up) || []).map(x => ({ sym: x.symbol, name: x.companyName, sme: /sme/i.test(x.series || x.segment || ""), band: band(x.issuePrice), open: parseNseDate(x.issueStartDate), close: parseNseDate(x.issueEndDate) })).filter(x => x.sym);
      if (req.query.raw === "1") return res.json({ types: [...new Set(P.map(x => x.securityType))], sample: P.slice(0, 2), live: rowsOf(cur)?.slice(0, 1) });
      res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=3600, stale-while-revalidate=86400");
      return res.json({ source: "nse-public-issues", listed, live, upcoming });
    }

    // ── stock deep data: quarterly results (NSE XBRL), shareholding, pledge, announcements, big-holder & insider filings ──
    if (type === "stock") {
      const sym = String(req.query.symbol || "").toUpperCase().replace(/[^A-Z0-9&-]/g, "");
      if (!sym) return fail(400, "symbol required");
      const enc = encodeURIComponent(sym);
      const now = Date.now();
      const [fil, shp, pledge, ann, sast, pit] = await Promise.all([
        get(`https://www.nseindia.com/api/integrated-filing-results?index=equities&type=Integrated%20Filing-%20Financials&symbol=${enc}`, { json: true, timeout: 5000 }),
        get(`https://www.nseindia.com/api/corporate-share-holdings-master?index=equities&symbol=${enc}`, { json: true, timeout: 5000 }),
        get(`https://www.nseindia.com/api/corporate-pledgedata?index=equities&symbol=${enc}`, { json: true, timeout: 5000 }),
        get(`https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${enc}&from_date=${dmyIst(now - 120 * 864e5)}&to_date=${dmyIst(now)}`, { json: true, timeout: 5000 }),
        get(`https://www.nseindia.com/api/corporate-sast-reg29?index=equities&symbol=${enc}`, { json: true, timeout: 5000 }),
        get(`https://www.nseindia.com/api/corporates-pit?index=equities&symbol=${enc}`, { json: true, timeout: 5000 }),
      ]);
      // quarterly results: latest 8 quarters, consolidated when the company files it
      const filings = rowsOf(fil).filter(x => x?.xbrl && /financ/i.test(x.type || "") && x.qe_Date);
      const byQ = {};
      for (const x of filings) {
        const q = parseNseDate(x.qe_Date); if (!q) continue;
        const cons = /^consolidated/i.test(x.consolidated || "");
        const cur = byQ[q];
        if (!cur || (cons && !cur.cons)) byQ[q] = { url: x.xbrl.replace("nsearchives.nseindia.in", "nsearchives.nseindia.com"), cons };
      }
      const qs = Object.keys(byQ).sort().slice(-8);
      const basisCons = qs.length ? byQ[qs[qs.length - 1]].cons : false; // one basis for every quarter
      const left = Math.max(1500, DEADLINE_MS - (Date.now() - started) - 700);
      const quarters = (await Promise.all(qs.map(async (q) => {
        if (byQ[q].cons !== basisCons) return null;
        const r = await get(byQ[q].url, { timeout: left });
        const v = r.status === 200 ? parseResultXbrl(r.body) : null;
        return v && v.quarterly ? { q: v.to || q, ...v } : null; // the filing's own period wins; half-year / annual files dropped
      }))).filter(Boolean).filter((x, i, a) => a.findIndex(y => y.q === x.q) === i).sort((a, b) => (a.q < b.q ? -1 : 1));
      const shpRows = rowsOf(shp).filter(x => x?.date && x.pr_and_prgrp != null)
        .map(x => ({ date: parseNseDate(x.date), promoter: num(x.pr_and_prgrp), public: num(x.public_val), trusts: num(x.employeeTrusts) }))
        .filter(x => x.date).sort((a, b) => (a.date < b.date ? -1 : 1));
      const seen = new Set();
      const shareholding = shpRows.filter(x => (seen.has(x.date) ? false : seen.add(x.date))).slice(-12);
      const pl = rowsOf(pledge)[0];
      const announcements = rowsOf(ann).filter(x => x?.desc && !/newspaper|trading window|loss of share|duplicate share/i.test(x.desc)).slice(0, 25).map(x => ({
        dt: String(x.sort_date || "").slice(0, 16), desc: x.desc, text: String(x.attchmntText || "").slice(0, 260), url: x.attchmntFile || null,
      }));
      const holders = rowsOf(sast).map(x => ({
        date: parseNseDate(String(x.timestamp || x.sysTime || "").slice(0, 11)), name: x.acquirerName, side: /sale/i.test(x.acqSaleType || "") ? "sell" : "buy",
        promoter: x.promoterType === "Y", shares: num(x.noOfShareAcq) ?? num(x.noOfShareSale), after: num(x.noOfShareAft), mode: x.acquisitionMode || null,
      })).filter(x => x.name && x.date).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 12);
      const insiders = rowsOf(pit).map(x => ({
        date: parseNseDate(String(x.date || "").slice(0, 11)), name: x.acqName, cat: x.personCategory, side: String(x.tdpTransactionType || ""), mode: x.acqMode, value: num(x.secVal), shares: num(x.secAcq),
      })).filter(x => x.date && x.name && /promoter|director|kmp|key managerial/i.test(x.cat || "")).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 12);
      res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=21600, stale-while-revalidate=86400");
      return res.json({
        source: "nse", symbol: sym, basis: basisCons ? "consolidated" : "standalone", quarters, shareholding,
        pledge: pl ? { pct: num(pl.percPromoterShares), ofTotal: num(pl.percTotShares), date: parseNseDate(pl.shp) } : null,
        announcements, holders, insiders,
      });
    }

    // ── substantial-holder filings (SAST Reg 29) across the market, last N days (promoters and big investors) ──
    if (type === "holders") {
      const days = Math.min(180, Math.max(7, parseInt(req.query.days, 10) || 30));
      const now = Date.now(), step = 10;
      const wins = []; for (let b = 0; b < days; b += step) wins.push([now - Math.min(days, b + step) * 864e5, now - b * 864e5]);
      const got = await Promise.all(wins.map(([a, z]) => get(`https://www.nseindia.com/api/corporate-sast-reg29?index=equities&from_date=${dmyIst(a)}&to_date=${dmyIst(z)}`, { json: true, timeout: 7000 })));
      if (got.every(r => r.status !== 200)) return fail(502, `NSE SAST filings unavailable (${got[0].status || got[0].error})`);
      const seen = new Set(), out = [];
      for (const r of got) for (const x of rowsOf(r)) {
        const id = x?.application_no || `${x?.symbol}|${x?.acquirerName}|${x?.timestamp}`;
        if (!x?.symbol || seen.has(id)) continue; seen.add(id);
        out.push({ sym: x.symbol, co: x.company, date: parseNseDate(String(x.timestamp || x.sysTime || "").slice(0, 11)), name: x.acquirerName,
          side: /sale/i.test(x.acqSaleType || "") ? "sell" : "buy", promoter: x.promoterType === "Y", shares: num(x.noOfShareAcq) ?? num(x.noOfShareSale), after: num(x.noOfShareAft), mode: x.acquisitionMode || null });
      }
      out.sort((a, b) => (a.date < b.date ? 1 : -1));
      res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=10800, stale-while-revalidate=86400");
      return res.json({ source: "nse-sast-reg29", days, rows: out });
    }

    // ── ETFs: last price vs NSE's indicative NAV (premium / discount) ──
    if (type === "etf") {
      const r = await get("https://www.nseindia.com/api/etf", { json: true, timeout: 7000 });
      const rows = r.status === 200 ? r.body?.data : null;
      if (!Array.isArray(rows)) return fail(502, `NSE ETF data unavailable (${r.status || r.error})`);
      const etfs = rows.map(x => {
        // NAV is for navDate (the previous session), so compare it with that session's close, not today's price
        const ltp = num(x.ltP), nav = num(x.nav), prev = num(x.prevClose);
        return { sym: x.symbol, asset: String(x.assets || "").slice(0, 60), ltp, prev, nav, prem: prev && nav ? Math.round(((prev - nav) / nav) * 1e4) / 100 : null, chg: num(x.per), val: num(x.trdVal), r1y: num(x.perChange365d) };
      }).filter(x => x.sym && x.ltp);
      res.setHeader("Cache-Control", "public, max-age=120, s-maxage=300");
      return res.json({ source: "nse-etf", time: r.body?.timestamp || null, navDate: r.body?.navDate || null, etfs });
    }

    // ── index constituents with free-float market cap and today's move ──
    if (type === "index") {
      const name = String(req.query.index || "NIFTY 50").toUpperCase().replace(/[^A-Z0-9 &-]/g, "").slice(0, 40);
      const r = await get(`https://www.nseindia.com/api/equity-stockIndices?index=${encodeURIComponent(name)}`, { json: true, timeout: 7000 });
      const rows = r.status === 200 ? r.body?.data : null;
      if (!Array.isArray(rows)) {
        const file = { "NIFTY 50": "ind_nifty50list", "NIFTY NEXT 50": "ind_niftynext50list", "NIFTY 500": "ind_nifty500list" }[name];
        if (!file) return fail(502, `NSE index constituents unavailable (${r.status || r.error})`);
        const [list, bh, ai] = await Promise.all([
          get(`https://nsearchives.nseindia.com/content/indices/${file}.csv`, { timeout: 5000 }),
          latestArchive((d) => `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}.csv`, parseBhavFullCsv, started),
          get("https://www.nseindia.com/api/allIndices", { json: true, timeout: 5000 }),
        ]);
        const lines = list.status === 200 ? String(list.body).split(/\r?\n/).slice(1).map(l => l.split(",")).filter(c => c[2]) : [];
        const closes = bh.parsed?.closes || {};
        if (!lines.length || !bh.parsed) return fail(502, `NSE index constituents unavailable (${r.status || r.error}; fallback ${list.status})`);
        const caps = name === "NIFTY 500" ? {} : await yahooVal(lines.map(c => c[2].trim()), started);
        const stocks = lines.map(c => {
          const sym = c[2].trim(), b = closes[sym];
          return { sym, ltp: b?.close ?? null, prev: b?.prev ?? null, chg: b?.close && b?.prev ? Math.round((b.close / b.prev - 1) * 1e4) / 100 : null, ffmc: caps[sym]?.mcap ?? null, ind: c[1]?.trim() || null, nearHigh: null, r1y: null };
        });
        const live = ai.status === 200 ? parseAllIndices(ai.body)?.indices?.[name] : null;
        res.setHeader("Cache-Control", "public, max-age=300, s-maxage=900");
        return res.json({ source: "nse-index-list+bhavcopy", approx: true, capBasis: name === "NIFTY 500" ? null : "full", index: name, date: bh.parsed.date, time: null,
          last: live?.last ?? null, prev: live?.prevClose ?? null, chg: live?.changePct ?? null, stocks });
      }
      const isHead = (x) => x.priority === 1 || String(x.symbol).toUpperCase() === name;
      const stocks = rows.filter(x => x.symbol && !isHead(x)).map(x => ({
        sym: x.symbol, ltp: num(x.lastPrice), prev: num(x.previousClose), chg: num(x.pChange), ffmc: num(x.ffmc), ind: x.meta?.industry || null, nearHigh: num(x.nearWKH), r1y: num(x.perChange365d),
      }));
      const head = rows.find(isHead);
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=120");
      return res.json({ source: "nse-equity-stockIndices", index: name, time: r.body?.timestamp || null, last: num(head?.lastPrice), prev: num(head?.previousClose), chg: num(head?.pChange), stocks });
    }

    // ── investing styles and size bands: index returns over 1w / 1m / 3m / 1y from NSE's daily index files ──
    if (type === "styles") {
      const tryDay = async (ms, back = 5) => {
        for (const day of recentWeekdays(ms, back)) {
          const r = await get(`https://nsearchives.nseindia.com/content/indices/ind_close_all_${nseFileDate(day)}.csv`, { timeout: 4000 });
          if (r.status === 200) { const p = parseIndexCloseCsv(r.body); if (p) return p; }
        }
        return null;
      };
      const latest = await tryDay(Date.now(), 6);
      if (!latest) return fail(502, "NSE index close file unavailable");
      const t0 = Date.parse(latest.date + "T12:00:00Z");
      const [w, m, q, y] = await Promise.all([7, 30, 91, 365].map(d => tryDay(t0 - d * 864e5)));
      const low = (o) => Object.fromEntries(Object.entries(o?.indices || {}).map(([k, v]) => [k.toLowerCase(), v]));
      const W = low(w), M = low(m), Q = low(q), Y = low(y);
      const indices = {};
      for (const [k, v] of Object.entries(latest.indices)) {
        const lk = k.toLowerCase();
        const ret = (P) => (P[lk]?.close && v.close ? Math.round((v.close / P[lk].close - 1) * 1000) / 10 : null);
        indices[k] = { close: v.close, chg: v.changePct, pe: v.pe ?? null, pb: v.pb ?? null, dy: v.dy ?? null, w: ret(W), m: ret(M), q: ret(Q), y: ret(Y) };
      }
      res.setHeader("Cache-Control", `public, max-age=900, s-maxage=${cacheFor(latest.date)}`);
      return res.json({ source: "nse-ind_close_all", date: latest.date, dates: { w: w?.date || null, m: m?.date || null, q: q?.date || null, y: y?.date || null }, indices });
    }

    // ── IPO subscription by investor category ──
    if (type === "ipodetail") {
      const sym = String(req.query.symbol || "").toUpperCase().replace(/[^A-Z0-9&-]/g, "");
      if (!sym) return fail(400, "symbol required");
      const series = /sme/i.test(String(req.query.series || "")) ? "SME" : "EQ";
      const r = await get(`https://www.nseindia.com/api/ipo-detail?symbol=${encodeURIComponent(sym)}&series=${series}`, { json: true, timeout: 7000 });
      if (r.status !== 200 || !r.body) return fail(502, `NSE IPO detail unavailable (${r.status || r.error})`);
      const cats = (r.body.bidDetails || []).filter(x => x?.category && (/^\d+$/.test(String(x.srNo || "").trim()) || /^total$/i.test(String(x.category).trim())))
        .map(x => ({ cat: String(x.category).replace(/\s*\(.*$/, "").trim(), offered: num(x.noOfSharesOffered), bid: num(x.noOfsharesBid ?? x.noOfshareBid), times: num(x.noOfTime) }))
        .map(x => ({ ...x, times: x.times || (x.offered && x.bid != null ? Math.round((x.bid / x.offered) * 100) / 100 : null) }));
      res.setHeader("Cache-Control", "public, max-age=900, s-maxage=3600");
      return res.json({ source: "nse-ipo-detail", symbol: sym, cats });
    }

    // ── the last few days' announcements for a list of stocks (watchlist / holdings) ──
    if (type === "ann") {
      const syms = new Set(String(req.query.symbols || "").toUpperCase().split(",").map(s => s.replace(/[^A-Z0-9&-]/g, "")).filter(Boolean).slice(0, 80));
      if (!syms.size) return fail(400, "symbols required");
      const r = await get(`https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=${dmyIst(Date.now() - 3 * 864e5)}&to_date=${dmyIst(Date.now())}`, { json: true, timeout: 8000 });
      if (r.status !== 200) return fail(502, `NSE announcements unavailable (${r.status || r.error})`);
      const items = rowsOf(r).filter(x => syms.has(x.symbol) && !/newspaper|trading window|loss of share|duplicate share/i.test(x.desc || ""))
        .map(x => ({ sym: x.symbol, dt: String(x.sort_date || "").slice(0, 16), desc: x.desc, text: String(x.attchmntText || "").slice(0, 220), url: x.attchmntFile || null }));
      res.setHeader("Cache-Control", "public, max-age=600, s-maxage=900");
      return res.json({ source: "nse-announcements", items });
    }

    // ── which companies held results board meetings in the last N days ──
    if (type === "reported") {
      const days = Math.min(75, Math.max(7, parseInt(req.query.days, 10) || 50));
      const r = await get(`https://www.nseindia.com/api/event-calendar?index=equities&from_date=${dmyIst(Date.now() - days * 864e5)}&to_date=${dmyIst(Date.now())}`, { json: true, timeout: 7000 });
      if (r.status !== 200) return fail(502, `NSE event calendar unavailable (${r.status || r.error})`);
      const out = {};
      for (const e of rowsOf(r)) if (e?.symbol && /result/i.test(e.purpose || "")) { const d = parseNseDate(e.date); if (d && (!out[e.symbol] || d > out[e.symbol])) out[e.symbol] = d; }
      res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=10800");
      return res.json({ source: "nse-event-calendar", days, reported: out });
    }

    // ── latest quarter vs a year earlier for up to 10 stocks (results-season scoreboard) ──
    if (type === "qresults") {
      const syms = String(req.query.symbols || "").toUpperCase().split(",").map(s => s.replace(/[^A-Z0-9&-]/g, "")).filter(Boolean).slice(0, 10);
      if (!syms.length) return fail(400, "symbols required");
      const out = {};
      await Promise.all(syms.map(async (sym) => {
        const f = await get(`https://www.nseindia.com/api/integrated-filing-results?index=equities&type=Integrated%20Filing-%20Financials&symbol=${encodeURIComponent(sym)}`, { json: true, timeout: 4000 });
        const byQ = {};
        for (const x of rowsOf(f)) {
          if (!x?.xbrl || !/financ/i.test(x.type || "")) continue;
          const q = parseNseDate(x.qe_Date); if (!q) continue;
          const cons = /^consolidated/i.test(x.consolidated || "");
          if (!byQ[q] || (cons && !byQ[q].cons)) byQ[q] = { url: x.xbrl.replace("nsearchives.nseindia.in", "nsearchives.nseindia.com"), cons };
        }
        const qs = Object.keys(byQ).sort();
        const last = qs[qs.length - 1]; if (!last) return;
        const yAgo = qs.find(q => q.slice(5) === last.slice(5) && +q.slice(0, 4) === +last.slice(0, 4) - 1 && byQ[q].cons === byQ[last].cons);
        const left = Math.max(1200, DEADLINE_MS - (Date.now() - started) - 600);
        const [a, b] = await Promise.all([last, yAgo].map(q => (q ? get(byQ[q].url, { timeout: left }) : null)));
        const pa = a?.status === 200 ? parseResultXbrl(a.body) : null, pb = b?.status === 200 ? parseResultXbrl(b.body) : null;
        const A = pa?.quarterly ? pa : null, B = pb?.quarterly && pa && pb.to?.slice(5) === pa.to?.slice(5) ? pb : null;
        if (A) out[sym] = { q: last, rev: A.rev, profit: A.profit, revY: B?.rev ?? null, profitY: B?.profit ?? null, basis: byQ[last].cons ? "c" : "s" };
      }));
      res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=43200, stale-while-revalidate=86400");
      return res.json({ source: "nse-xbrl", results: out });
    }

    // ── valuation from Yahoo: trailing P/E, P/B and market cap (₹ crore) for up to 60 stocks ──
    if (type === "val") {
      const syms = String(req.query.symbols || "").toUpperCase().split(",").map(s => s.replace(/[^A-Z0-9&-]/g, "")).filter(Boolean).slice(0, 60);
      if (!syms.length) return fail(400, "symbols required");
      const out = await yahooVal(syms, started);
      const ok = Object.keys(out).length;
      res.setHeader("Cache-Control", ok >= syms.length * 0.8 ? "public, max-age=3600, s-maxage=43200, stale-while-revalidate=86400" : "no-store");
      return res.json({ source: "yahoo-fundamentals", val: out, missing: syms.filter(s => !out[s]) });
    }

    return fail(400, "unknown type");
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
