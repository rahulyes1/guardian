// New information panels: stock deep data, market styles / size race / map / movers, holders, ETFs,
// results season, signal calendar, replay, fund facts & flows, IPO subscription, watchlist index.
// Self-contained: only React + the app's CSS variables.
import { useState, useEffect, useMemo, useRef, Fragment } from "react";

const THEME = (() => { try { return localStorage.getItem("td_theme") === "light" ? "light" : "dark"; } catch (_) { return "dark"; } })();
const C = THEME === "light"
  ? { pos: "#15803D", neg: "#C8102E", warn: "#B45309", lime: "#4D7C0F", muted: "#6E685C", blue: "#1D4ED8" }
  : { pos: "#4ADE80", neg: "#DC143C", warn: "#F59E0B", lime: "#A3E635", muted: "#A39C89", blue: "#60A5FA" };
const SIG_COL = { INVEST: C.pos, SELECTIVE: C.warn, CASH: C.neg };
const card = { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14, padding: 14, marginBottom: 14 };
const head = { fontSize: 10, color: "var(--text3)", letterSpacing: "0.14em", fontWeight: 700 };
const note = { fontSize: 10.5, color: "var(--text3)", marginTop: 6, lineHeight: 1.45 };
const mono = { fontFamily: "var(--mono)" };
const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const pcol = (v) => (v == null ? "var(--text3)" : v >= 0 ? C.pos : C.neg);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (iso) => { if (!iso) return "—"; const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${+d} ${MON[+m - 1]}${y !== String(new Date().getFullYear()) ? ` ${y}` : ""}`; };
const fmtQ = (iso) => { const [y, m] = String(iso).split("-"); return `${MON[+m - 1]} ${y.slice(2)}`; };
const cr = (v) => (v == null ? "—" : `${v < 0 ? "−" : ""}${Math.abs(v) >= 1e5 ? `₹${(Math.abs(v) / 1e5).toFixed(2)}L cr` : `₹${Math.round(Math.abs(v)).toLocaleString("en-IN")} cr`}`);
const istToday = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const median = (xs) => { const a = xs.filter(Number.isFinite).sort((p, q) => p - q); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// ── data: deduplicated, cached JSON fetches ──
const _cache = new Map(), _inflight = new Map();
export function getJson(url, ttl = 10 * 60e3) {
  const c = _cache.get(url);
  if (c && Date.now() - c.at < ttl) return Promise.resolve(c.data);
  if (_inflight.has(url)) return _inflight.get(url);
  const p = fetch(url).then(async (r) => {
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.error) throw new Error(j?.error || `HTTP ${r.status}`);
    _cache.set(url, { at: Date.now(), data: j });
    return j;
  }).finally(() => _inflight.delete(url));
  _inflight.set(url, p);
  return p;
}
export function useJson(url, ttl) {
  const [s, setS] = useState(() => ({ data: _cache.get(url)?.data || null, err: null }));
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setS({ data: _cache.get(url)?.data || null, err: null });
    getJson(url, ttl).then((d) => alive && setS({ data: d, err: null })).catch((e) => alive && setS((p) => ({ data: p.data, err: e.message })));
    return () => { alive = false; };
  }, [url]);
  return s;
}
const useStyles = () => useJson("/api/nse?type=styles", 15 * 60e3);

// ── freshness badge: "as of 20 Nov · NSE"; amber when older than `staleDays` ──
export function AsOf({ date, src, staleDays = 4, style }) {
  if (!date && !src) return null;
  const iso = date ? String(date).slice(0, 10) : null;
  const age = iso ? (Date.parse(istToday()) - Date.parse(iso)) / 864e5 : 0;
  const stale = iso && age > staleDays;
  return (
    <span title={stale ? `Last updated ${Math.round(age)} days ago` : "Data date"} style={{ fontSize: 9.5, letterSpacing: 0, fontWeight: 600, color: stale ? C.warn : "var(--text3)", border: `1px solid ${stale ? C.warn + "66" : "var(--border)"}`, borderRadius: 6, padding: "1px 5px", whiteSpace: "nowrap", ...style }}>
      {iso ? `as of ${fmtDay(iso)}` : ""}{iso && src ? " · " : ""}{src || ""}
    </span>
  );
}
const Head = ({ children, date, src, staleDays, right }) => (
  <div style={{ ...head, marginBottom: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
    <span style={{ flex: 1, minWidth: 0 }}>{children}</span>{right}<AsOf date={date} src={src} staleDays={staleDays} />
  </div>
);
const Loading = ({ what }) => <div style={{ fontSize: 12, color: "var(--text3)", padding: "6px 0" }}>Loading {what}…</div>;
const Fail = ({ err }) => <div style={{ fontSize: 12, color: C.warn, padding: "6px 0" }}>Couldn't load this right now ({err}). It retries next time you open the page.</div>;
const SymBtn = ({ sym, onPick, style }) => (
  <button onClick={() => onPick?.(sym)} style={{ background: "none", border: "none", padding: 0, cursor: onPick ? "pointer" : "default", color: "var(--text)", font: "inherit", fontWeight: 700, textAlign: "left", textDecoration: onPick ? "underline dotted" : "none", textUnderlineOffset: 3, ...style }}>{sym}</button>
);
const Chips = ({ items, value, onChange }) => (
  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
    {items.map(([k, l]) => <button key={k} className="chip chip-sm" aria-pressed={value === k} onClick={() => onChange(k)} style={value === k ? { borderColor: "var(--text)", color: "var(--text)" } : {}}>{l}</button>)}
  </div>
);
function Collapse({ id, title, sub, children, defaultOpen = false }) {
  const key = `td_fold_${id}`;
  const [open, setOpen] = useState(() => { try { const v = localStorage.getItem(key); return v == null ? defaultOpen : v === "1"; } catch (_) { return defaultOpen; } });
  const toggle = () => setOpen((v) => { try { localStorage.setItem(key, v ? "0" : "1"); } catch (_) {} return !v; });
  return (
    <div style={{ marginBottom: 12 }}>
      <button onClick={toggle} aria-expanded={open} className="card" style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, textAlign: "left", cursor: "pointer", color: "var(--text)", marginBottom: open ? 10 : 0 }}>
        <span style={{ flex: 1 }}><span style={{ display: "block", fontSize: 13, fontWeight: 700 }}>{title}</span>{sub && <span style={{ display: "block", fontSize: 11, color: "var(--text3)", marginTop: 2 }}>{sub}</span>}</span>
        <span aria-hidden="true" style={{ color: "var(--text3)" }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && children}
    </div>
  );
}

// ═══════════════════════════════ STOCK PAGE ═══════════════════════════════

export const SECTOR_INDEX = {
  Financials: "Nifty Financial Services", "Capital Goods": "Nifty Capital Goods", "Cement & Materials": "Nifty Cement", Power: "Nifty Power",
  FMCG: "Nifty FMCG", Chemicals: "Nifty Chemicals", Healthcare: "Nifty Healthcare Index", Metals: "Nifty Metal", Services: "Nifty Services Sector",
  "Oil & Gas": "Nifty Oil & Gas", Realty: "Nifty Realty", Construction: "Nifty Infrastructure", IT: "Nifty IT", Auto: "Nifty Auto",
  "Consumer Durables": "Nifty Consumer Durables", "Consumer Services": "Nifty Consumer Services", Telecommunication: "Nifty Telecommunications",
  Media: "Nifty Media", Utilities: "Nifty Power",
};
export const useStockDeep = (symbol) => useJson(symbol ? `/api/nse?type=stock&symbol=${encodeURIComponent(symbol)}` : null, 60 * 60e3);
export const useVal = (symbols) => useJson(symbols?.length ? `/api/nse?type=val&symbols=${encodeURIComponent(symbols.join(","))}` : null, 60 * 60e3);

// quarter-on-year-ago growth from a list of quarters [{ q, rev, profit }]
function yoyOf(qs, i, k) {
  const cur = qs[i], y = qs.find((x) => x.q.slice(5) === cur.q.slice(5) && +x.q.slice(0, 4) === +cur.q.slice(0, 4) - 1);
  if (!y || cur[k] == null || y[k] == null || y[k] === 0) return null;
  return ((cur[k] - y[k]) / Math.abs(y[k])) * 100;
}

/** Plain-language summary of everything known about the stock. */
export function StockStory({ symbol, d, mq, deep, val, styles }) {
  const lines = [];
  const n = d.closes.length - 1, c = d.closes[n];
  const s50 = d.s50?.[n], s200 = d.s200?.[n];
  if (s50 && s200) {
    const t = c > s50 && c > s200 ? (s50 > s200 ? ["Uptrend", "above its 50- and 200-day averages, with the 50 above the 200", C.pos] : ["Recovering", "above both averages, but the 50-day is still under the 200-day", C.lime])
      : c < s50 && c < s200 ? ["Downtrend", "below its 50- and 200-day averages", C.neg] : c > s200 ? ["Pullback in an uptrend", "above the 200-day average but below the 50-day", C.warn] : ["Bouncing in a downtrend", "above the 50-day but below the 200-day average", C.warn];
    lines.push(["📈", <><b style={{ color: t[2] }}>{t[0]}</b> — {t[1]}.</>]);
  }
  const hi = Math.max(...d.closes.slice(-252)), off = (c / hi - 1) * 100;
  lines.push(["🏔️", off > -2 ? <>At or near its <b>52-week high</b>.</> : <>{Math.abs(off).toFixed(0)}% below its 52-week high.</>]);
  const rs = mq?.rs_of?.[symbol];
  if (rs != null) lines.push(["💪", <>Stronger than <b>{rs}%</b> of Nifty 500 stocks over the past year (RS {rs}).</>]);
  const sector = mq?.sector_of?.[symbol], sec = sector ? (mq.sectors || []).find((s) => s.name === sector) : null;
  if (sec) lines.push(["🏭", <>{sector} is <b>{String(sec.status).toLowerCase()}</b>{sec.ret3m != null ? ` (${pct(sec.ret3m)} over 3 months)` : ""}.</>]);
  const qs = deep?.quarters || [];
  if (qs.length) {
    const i = qs.length - 1, g = yoyOf(qs, i, "profit"), gr = yoyOf(qs, i, "rev");
    if (g != null || gr != null) lines.push(["🧾", <>Last quarter ({fmtQ(qs[i].q)}): revenue {gr == null ? "—" : <b style={{ color: pcol(gr) }}>{pct(gr, 0)}</b>}, profit {g == null ? "—" : <b style={{ color: pcol(g) }}>{pct(g, 0)}</b>} vs a year earlier.</>]);
  }
  const sh = deep?.shareholding || [];
  if (sh.length >= 2) {
    const a = sh[Math.max(0, sh.length - 5)], b = sh[sh.length - 1], dp = b.promoter - a.promoter;
    lines.push(["👥", <>Promoters own <b>{b.promoter?.toFixed(1)}%</b>{Math.abs(dp) >= 0.1 ? <> — <b style={{ color: pcol(dp) }}>{dp > 0 ? "up" : "down"} {Math.abs(dp).toFixed(1)} pts</b> since {fmtQ(a.date)}</> : " — unchanged over the year"}.{deep.pledge?.pct > 0 ? ` ${deep.pledge.pct.toFixed(1)}% of their shares are pledged.` : ""}</>]);
  }
  const v = val?.[symbol], sp = sector && styles?.indices?.[SECTOR_INDEX[sector]]?.pe;
  if (v?.pe) lines.push(["🏷️", <>P/E <b>{v.pe}</b>{sp ? <> vs {sp.toFixed(0)} for {SECTOR_INDEX[sector]} — <b style={{ color: v.pe < sp * 0.85 ? C.pos : v.pe > sp * 1.15 ? C.warn : "var(--text)" }}>{v.pe < sp * 0.85 ? "cheaper than its sector" : v.pe > sp * 1.15 ? "pricier than its sector" : "in line with its sector"}</b></> : ""}.</>]);
  const big = (deep?.holders || []).filter((h) => Date.parse(h.date) > Date.now() - 90 * 864e5);
  if (big.length) { const b = big.filter((h) => h.side === "buy").length, s = big.length - b; lines.push(["🐋", <>{big.length} substantial-holder filing{big.length > 1 ? "s" : ""} in 90 days: <b style={{ color: C.pos }}>{b} buy</b>, <b style={{ color: C.neg }}>{s} sell</b>.</>]); }
  return (
    <div style={card}>
      <Head date={d.dates[n]} src="NSE · Yahoo">THE STORY SO FAR</Head>
      {lines.map(([ic, t], i) => <div key={i} style={{ display: "flex", gap: 8, fontSize: 12.5, lineHeight: 1.5, padding: "3px 0", color: "var(--text2)" }}><span aria-hidden="true">{ic}</span><span>{t}</span></div>)}
      <div style={note}>A summary of the numbers on this page — information, not a recommendation.</div>
    </div>
  );
}

/** Valuation vs the sector index and the market. */
export function StockValuation({ symbol, d, mq, val, styles }) {
  const v = val?.[symbol];
  const sector = mq?.sector_of?.[symbol], sIx = SECTOR_INDEX[sector], S = styles?.indices || {};
  const n = d.closes.length - 1, c = d.closes[n];
  const hi1 = Math.max(...d.closes.slice(-252)), hi2 = Math.max(...d.closes);
  const size = v?.mcap == null ? null : v.mcap >= 100000 ? "Large cap" : v.mcap >= 33000 ? "Mid cap" : v.mcap >= 5000 ? "Small cap" : "Micro cap";
  const cell = (l, x, sub, col) => (
    <div style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 10px", minWidth: 0 }}>
      <div style={{ fontSize: 9.5, color: "var(--text3)", letterSpacing: "0.08em" }}>{l}</div>
      <div style={{ ...mono, fontSize: 15, fontWeight: 700, color: col || "var(--text)" }}>{x}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 1 }}>{sub}</div>}
    </div>
  );
  const sp = S[sIx]?.pe, mp = S["Nifty 500"]?.pe;
  return (
    <div style={card}>
      <Head date={styles?.date} src="Yahoo · NSE">VALUATION VS SECTOR</Head>
      {!v && !styles ? <Loading what="valuation" /> : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {cell("P/E", v?.pe ?? "—", "trailing 12m", v?.pe && sp ? (v.pe < sp * 0.85 ? C.pos : v.pe > sp * 1.15 ? C.warn : null) : null)}
            {cell("SECTOR P/E", sp?.toFixed(1) ?? "—", sIx ? sIx.replace(/^Nifty /, "") : "—")}
            {cell("NIFTY 500 P/E", mp?.toFixed(1) ?? "—", "the market")}
            {cell("P/B", v?.pb ?? "—", S[sIx]?.pb ? `sector ${S[sIx].pb}` : "")}
            {cell("MARKET CAP", v?.mcap ? cr(v.mcap) : "—", size)}
            {cell("FROM HIGH", `${((c / hi1 - 1) * 100).toFixed(1)}%`, `1y · 2y ${((c / hi2 - 1) * 100).toFixed(1)}%`)}
          </div>
          {v?.pe && sp ? <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 8, lineHeight: 1.5 }}>Priced at <b>{(v.pe / sp).toFixed(2)}×</b> its sector's earnings multiple and {(v.pe / mp).toFixed(2)}× the market's.{v.pe < 0 || v.pe > 150 ? " (Very high or negative P/E — earnings are small or negative.)" : ""}</div> : null}
          <div style={note}>Stock P/E, P/B and market cap from Yahoo; sector and market P/E from NSE's index file. Size bands are approximate (SEBI ranks by 6-month average market cap).</div>
        </>
      )}
    </div>
  );
}

/** Quarterly results: revenue, profit, margin for up to 8 quarters, growth vs a year earlier. */
export function StockResults({ deep, err }) {
  const qs = deep?.quarters || [];
  return (
    <div style={card}>
      <Head date={qs.length ? qs[qs.length - 1].q : null} src={`NSE filings${deep?.basis ? ` · ${deep.basis}` : ""}`} staleDays={140}>QUARTERLY RESULTS</Head>
      {!deep ? (err ? <Fail err={err} /> : <Loading what="results" />) : !qs.length ? <div style={{ fontSize: 12, color: "var(--text3)" }}>No results filings found on NSE.</div> : (() => {
        const maxR = Math.max(...qs.map((x) => Math.abs(x.rev || 0)), 1), maxP = Math.max(...qs.map((x) => Math.abs(x.profit || 0)), 1);
        return (
          <>
            <svg viewBox={`0 0 ${qs.length * 40} 70`} width="100%" style={{ display: "block", marginBottom: 6 }} role="img" aria-label="Revenue and profit by quarter">
              {qs.map((x, i) => {
                const hr = ((x.rev || 0) / maxR) * 54, hp = (Math.abs(x.profit || 0) / maxP) * 54;
                return (
                  <g key={x.q}>
                    <rect x={i * 40 + 6} y={58 - hr} width="13" height={hr} rx="2" fill="var(--text3)" opacity="0.55" />
                    <rect x={i * 40 + 21} y={58 - hp} width="13" height={hp} rx="2" fill={(x.profit || 0) >= 0 ? C.pos : C.neg} />
                    <text x={i * 40 + 20} y="68" fontSize="7.5" textAnchor="middle" fill="var(--text3)">{fmtQ(x.q)}</text>
                  </g>
                );
              })}
            </svg>
            <div style={{ display: "flex", gap: 10, fontSize: 10, color: "var(--text3)", marginBottom: 8 }}><span><span style={{ display: "inline-block", width: 8, height: 8, background: "var(--text3)", opacity: 0.55, marginRight: 4 }} />Revenue</span><span><span style={{ display: "inline-block", width: 8, height: 8, background: C.pos, marginRight: 4 }} />Profit</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "48px 1fr 46px 1fr 46px 40px", columnGap: 6, rowGap: 3, fontSize: 11.5, alignItems: "baseline" }}>
              {["QTR", "REVENUE", "YOY", "PROFIT", "YOY", "MARGIN"].map((h, i) => <span key={i} style={{ fontSize: 9, color: "var(--text3)", textAlign: i ? "right" : "left" }}>{h}</span>)}
              {qs.slice().reverse().map((x) => {
                const i = qs.indexOf(x), gr = yoyOf(qs, i, "rev"), gp = yoyOf(qs, i, "profit"), m = x.rev ? (x.profit / x.rev) * 100 : null;
                return (
                  <Fragment key={x.q}>
                    <span style={{ color: "var(--text3)" }}>{fmtQ(x.q)}</span>
                    <span style={{ ...mono, textAlign: "right" }}>{x.rev == null ? "—" : Math.round(x.rev).toLocaleString("en-IN")}</span>
                    <span style={{ ...mono, textAlign: "right", color: pcol(gr), fontSize: 10.5 }}>{pct(gr, 0)}</span>
                    <span style={{ ...mono, textAlign: "right", color: (x.profit || 0) < 0 ? C.neg : "var(--text)" }}>{x.profit == null ? "—" : Math.round(x.profit).toLocaleString("en-IN")}</span>
                    <span style={{ ...mono, textAlign: "right", color: pcol(gp), fontSize: 10.5 }}>{pct(gp, 0)}</span>
                    <span style={{ ...mono, textAlign: "right", color: "var(--text2)", fontSize: 10.5 }}>{m == null ? "—" : `${m.toFixed(0)}%`}</span>
                  </Fragment>
                );
              })}
            </div>
            <div style={note}>₹ crore. Profit attributable to shareholders, from each quarter's XBRL filing on NSE ({deep.basis}). YoY needs the same quarter a year earlier, so the oldest rows show —. Banks report interest earned as revenue.</div>
          </>
        );
      })()}
    </div>
  );
}

/** Shareholding trend, pledge, substantial-holder and insider filings. */
export function StockHolders({ deep, err }) {
  const sh = deep?.shareholding || [];
  return (
    <div style={card}>
      <Head date={sh.length ? sh[sh.length - 1].date : null} src="NSE" staleDays={140}>WHO OWNS IT</Head>
      {!deep ? (err ? <Fail err={err} /> : <Loading what="shareholding" />) : (
        <>
          {sh.length ? (() => {
            const xs = sh.slice(-8), lo = Math.min(...xs.map((x) => x.promoter)), hi = Math.max(...xs.map((x) => x.promoter)), span = Math.max(1, hi - lo);
            const first = xs[0], last = xs[xs.length - 1], dp = last.promoter - first.promoter;
            return (
              <>
                <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: 6 }}>Promoters <b style={{ color: "var(--text)" }}>{last.promoter.toFixed(2)}%</b> · public {last.public?.toFixed(2)}%{last.trusts ? ` · employee trusts ${last.trusts}%` : ""}</div>
                <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 54, marginBottom: 4 }} role="img" aria-label="Promoter holding by quarter">
                  {xs.map((x) => (
                    <div key={x.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }} title={`${fmtQ(x.date)}: ${x.promoter}%`}>
                      <span style={{ ...mono, fontSize: 8.5, color: "var(--text3)" }}>{x.promoter.toFixed(1)}</span>
                      <div style={{ width: "100%", height: 8 + ((x.promoter - lo) / span) * 30, background: dp >= 0 ? C.pos : C.neg, opacity: 0.75, borderRadius: 3 }} />
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 4 }}>{xs.map((x) => <span key={x.date} style={{ flex: 1, textAlign: "center", fontSize: 8.5, color: "var(--text3)" }}>{fmtQ(x.date)}</span>)}</div>
                <div style={{ fontSize: 11.5, color: "var(--text2)", marginTop: 6 }}>{Math.abs(dp) < 0.05 ? "Promoter stake unchanged" : <>Promoter stake <b style={{ color: pcol(dp) }}>{dp > 0 ? "up" : "down"} {Math.abs(dp).toFixed(2)} pts</b></>} since {fmtQ(first.date)}.</div>
              </>
            );
          })() : <div style={{ fontSize: 12, color: "var(--text3)" }}>No shareholding filings found.</div>}
          {deep.pledge && <div style={{ fontSize: 11.5, marginTop: 6, color: deep.pledge.pct >= 10 ? C.warn : "var(--text2)" }}>Pledged: <b>{(deep.pledge.pct ?? 0).toFixed(2)}%</b> of promoter shares ({(deep.pledge.ofTotal ?? 0).toFixed(2)}% of all shares) as of {fmtQ(deep.pledge.date || "")}.{deep.pledge.pct >= 10 ? " A high pledge can force selling if the price falls." : ""}</div>}
          {(deep.holders || []).length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ ...head, marginBottom: 4 }}>BIG-HOLDER FILINGS (SAST)</div>
              {deep.holders.slice(0, 6).map((h, i) => (
                <div key={i} style={{ display: "flex", gap: 6, fontSize: 11.5, padding: "3px 0", borderTop: i ? "1px solid var(--border)" : "none" }}>
                  <span style={{ color: "var(--text3)", width: 46, flexShrink: 0 }}>{fmtDay(h.date)}</span>
                  <span style={{ fontWeight: 700, color: h.side === "buy" ? C.pos : C.neg, width: 30, flexShrink: 0 }}>{h.side}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{h.name}{h.promoter && <span style={{ color: C.warn, fontSize: 9.5 }}> PROMOTER</span>}</span>
                  <span style={{ ...mono, color: "var(--text2)" }}>{h.shares ? `${(h.shares / 1e5).toFixed(1)}L` : ""}</span>
                </div>
              ))}
            </div>
          )}
          {(deep.insiders || []).filter((h) => Date.parse(h.date) > Date.now() - 400 * 864e5).length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ ...head, marginBottom: 4 }}>PROMOTER & DIRECTOR TRADES (PIT) <AsOf date={deep.insiders[0].date} src="NSE" staleDays={60} /></div>
              {deep.insiders.slice(0, 5).map((h, i) => (
                <div key={i} style={{ display: "flex", gap: 6, fontSize: 11.5, padding: "3px 0", borderTop: i ? "1px solid var(--border)" : "none" }}>
                  <span style={{ color: "var(--text3)", width: 46, flexShrink: 0 }}>{fmtDay(h.date)}</span>
                  <span style={{ fontWeight: 700, color: /buy/i.test(h.side) ? C.pos : /sell/i.test(h.side) ? C.neg : "var(--text2)", width: 44, flexShrink: 0, fontSize: 10.5 }}>{h.side.slice(0, 8)}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{h.name} <span style={{ color: "var(--text3)", fontSize: 10 }}>{h.cat}</span></span>
                  <span style={{ ...mono, color: "var(--text2)" }}>{h.value ? cr(h.value / 1e7) : ""}</span>
                </div>
              ))}
            </div>
          )}
          <div style={note}>SAST filings: anyone holding 5%+ who changes their stake by 2%+, and promoter changes. NSE's insider (PIT) feed updates irregularly — check the date.</div>
        </>
      )}
    </div>
  );
}

/** Corporate announcements (last 120 days). */
export function StockAnnouncements({ deep, err }) {
  const [all, setAll] = useState(false);
  const xs = deep?.announcements || [];
  return (
    <div style={card}>
      <Head date={xs[0]?.dt} src="NSE" staleDays={60}>ANNOUNCEMENTS</Head>
      {!deep ? (err ? <Fail err={err} /> : <Loading what="announcements" />) : !xs.length ? <div style={{ fontSize: 12, color: "var(--text3)" }}>Nothing filed in the last 4 months.</div> : (
        <>
          {(all ? xs : xs.slice(0, 5)).map((a, i) => (
            <div key={i} style={{ padding: "6px 0", borderTop: i ? "1px solid var(--border)" : "none" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span style={{ fontSize: 10.5, color: "var(--text3)", flexShrink: 0 }}>{fmtDay(a.dt)}</span>
                <span style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>{a.desc}</span>
                {a.url && <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10.5, color: "var(--text2)" }}>PDF ↗</a>}
              </div>
              {a.text && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2, lineHeight: 1.4 }}>{a.text.replace(/^.*?has informed the Exchange (about|regarding)\s*/i, "")}</div>}
            </div>
          ))}
          {xs.length > 5 && <button className="chip chip-sm" style={{ marginTop: 6 }} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${xs.length}`}</button>}
        </>
      )}
    </div>
  );
}

/** Same-sector stocks that are stronger right now. */
export function StrongerPeers({ symbol, mq, onPickStock }) {
  const sector = mq?.sector_of?.[symbol];
  if (!sector || !mq?.rs_of) return null;
  const me = mq.rs_of[symbol];
  const peers = Object.entries(mq.sector_of).filter(([s, sec]) => sec === sector && s !== symbol && mq.rs_of[s] != null).map(([s]) => ({ s, rs: mq.rs_of[s], chg: mq.chg_of?.[s] ?? null, q: mq.q_of?.[s] }));
  peers.sort((a, b) => b.rs - a.rs);
  const better = me == null ? peers.slice(0, 5) : peers.filter((p) => p.rs > me).slice(0, 5);
  return (
    <div style={card}>
      <Head date={mq.as_of} src="TRADESK">STRONGER PEERS · {sector.toUpperCase()}</Head>
      {me != null && !better.length ? <div style={{ fontSize: 12.5, color: C.pos }}>{symbol} is the strongest {sector} stock in the Nifty 500 right now (RS {me}).</div> : (
        <>
          <div style={{ fontSize: 12, color: "var(--text2)", marginBottom: 6 }}>{me != null ? <>{peers.filter((p) => p.rs > me).length} of {peers.length} sector peers have higher relative strength than {symbol} (RS {me}).</> : "Strongest in the sector:"}</div>
          {better.map((p) => (
            <div key={p.s} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "4px 0", borderTop: "1px solid var(--border)", fontSize: 12 }}>
              <SymBtn sym={p.s} onPick={onPickStock} style={{ flex: 1 }} />
              <span style={{ ...mono, color: p.rs >= 80 ? C.pos : "var(--text2)" }}>RS {p.rs}</span>
              <span style={{ ...mono, color: pcol(p.chg), width: 52, textAlign: "right" }}>{pct(p.chg)}</span>
            </div>
          ))}
        </>
      )}
      <div style={note}>RS = 1-year relative strength rank vs the Nifty 500 (99 best). Today's change on the right.</div>
    </div>
  );
}

/** How the stock typically behaves (last ~250 sessions vs the Nifty 500). */
export function StockDNA({ d }) {
  const x = useMemo(() => {
    const n = d.closes.length, from = Math.max(1, n - 250);
    const r = [], ri = [], days = [];
    for (let i = from; i < n; i++) {
      const a = d.closes[i - 1], b = d.closes[i], ia = d.idx?.[i - 1], ib = d.idx?.[i];
      if (a && b) { r.push(b / a - 1); days.push(d.dates[i]); ri.push(ia && ib ? ib / ia - 1 : null); }
    }
    if (r.length < 60) return null;
    const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((v) => (v - m) ** 2))); };
    const pairs = r.map((v, i) => [v, ri[i]]).filter(([, w]) => w != null);
    const ms = mean(pairs.map((p) => p[0])), mi = mean(pairs.map((p) => p[1]));
    const cov = mean(pairs.map(([a, b]) => (a - ms) * (b - mi))), vi = mean(pairs.map(([, b]) => (b - mi) ** 2));
    const corr = cov / (sd(pairs.map((p) => p[0])) * Math.sqrt(vi) || 1);
    let bi = 0, wi = 0; r.forEach((v, i) => { if (v > r[bi]) bi = i; if (v < r[wi]) wi = i; });
    let pk = 0, dd = 0; for (let i = n - r.length - 1; i < n; i++) { const c = d.closes[i]; if (c) { pk = Math.max(pk, c); dd = Math.min(dd, c / pk - 1); } }
    let gaps = 0; for (let i = 1; i < r.length; i++) if (Math.abs(r[i]) > 3 * sd(r)) gaps++;
    return { avg: mean(r.map(Math.abs)) * 100, vol: sd(r) * Math.sqrt(250) * 100, volIx: Math.sqrt(vi) * Math.sqrt(250) * 100, beta: vi ? cov / vi : null, corr,
      up: (r.filter((v) => v > 0).length / r.length) * 100, best: [r[bi] * 100, days[bi]], worst: [r[wi] * 100, days[wi]], dd: dd * 100, shocks: gaps, n: r.length };
  }, [d]);
  if (!x) return null;
  const tile = (l, v, sub, col) => (
    <div style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 10px", minWidth: 0 }}>
      <div style={{ fontSize: 9.5, color: "var(--text3)", letterSpacing: "0.08em" }}>{l}</div>
      <div style={{ ...mono, fontSize: 15, fontWeight: 700, color: col || "var(--text)" }}>{v}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text3)" }}>{sub}</div>}
    </div>
  );
  const rel = x.vol / (x.volIx || x.vol);
  const kind = rel > 2.5 ? "a wild mover" : rel > 1.4 ? "livelier than the market" : rel < 0.8 ? "calmer than the market" : "about as lively as the market";
  return (
    <div style={card}>
      <Head date={d.dates[d.dates.length - 1]} src="Yahoo · NSE">STOCK DNA · LAST {x.n} SESSIONS</Head>
      <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: 8, lineHeight: 1.5 }}>Typically moves <b>{x.avg.toFixed(1)}%</b> a day — <b>{kind}</b> ({rel.toFixed(1)}× the Nifty 500's swings). It {x.corr > 0.6 ? "tracks the index closely" : x.corr > 0.35 ? "partly follows the index" : "mostly ignores the index"} (correlation {x.corr.toFixed(2)}).</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        {tile("AVG DAY", `${x.avg.toFixed(1)}%`, "up or down")}
        {tile("VOLATILITY", `${x.vol.toFixed(0)}%`, `index ${x.volIx.toFixed(0)}%`)}
        {tile("BETA", x.beta?.toFixed(2) ?? "—", "1 = moves with index")}
        {tile("UP DAYS", `${x.up.toFixed(0)}%`, `of ${x.n} sessions`)}
        {tile("BEST DAY", pct(x.best[0]), fmtDay(x.best[1]), C.pos)}
        {tile("WORST DAY", pct(x.worst[0]), fmtDay(x.worst[1]), C.neg)}
        {tile("DEEPEST FALL", `${x.dd.toFixed(0)}%`, "peak to low, 1y", x.dd < -30 ? C.neg : null)}
        {tile("SHOCK DAYS", x.shocks, "moves over 3× normal")}
        {tile("CORRELATION", x.corr.toFixed(2), "with Nifty 500")}
      </div>
      <div style={note}>Volatility is annualised from daily closes. A stock with twice the market's swings needs about half the position size for the same risk.</div>
    </div>
  );
}

/** Price zones where the most shares traded over the past year (volume at price). */
export function PriceLevels({ d }) {
  const x = useMemo(() => {
    const n = d.closes.length, from = Math.max(0, n - 250);
    const hs = d.highs, ls = d.lows;
    const lo = Math.min(...d.closes.slice(from).map((c, i) => ls?.[from + i] ?? c).filter(Boolean)), hi = Math.max(...d.closes.slice(from).map((c, i) => hs?.[from + i] ?? c).filter(Boolean));
    if (!(hi > lo)) return null;
    const B = 28, w = (hi - lo) / B, bins = new Array(B).fill(0);
    let used = 0;
    for (let i = from; i < n; i++) {
      const v = d.vols?.[i], c = d.closes[i]; if (!v || !c) continue;
      const h = hs?.[i] ?? c, l = ls?.[i] ?? c; used++;
      const b0 = Math.min(B - 1, Math.max(0, Math.floor((l - lo) / w))), b1 = Math.min(B - 1, Math.max(0, Math.floor((h - lo) / w)));
      for (let b = b0; b <= b1; b++) bins[b] += v / (b1 - b0 + 1);
    }
    if (used < 60) return null;
    const max = Math.max(...bins);
    // the three busiest zones, not next to each other
    const order = bins.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]), picked = [];
    for (const [, i] of order) { if (picked.every((j) => Math.abs(j - i) > 2)) picked.push(i); if (picked.length === 3) break; }
    const c = d.closes[n - 1];
    const zones = picked.map((i) => ({ lo: lo + i * w, hi: lo + (i + 1) * w, i })).sort((a, b) => b.lo - a.lo);
    return { bins, max, lo, hi, w, zones, c, B };
  }, [d]);
  if (!x) return null;
  const H = 168, rowH = H / x.B, Y = (p) => H - ((p - x.lo) / (x.hi - x.lo)) * H;
  const below = x.zones.filter((z) => z.hi < x.c).sort((a, b) => b.hi - a.hi)[0], above = x.zones.filter((z) => z.lo > x.c).sort((a, b) => a.lo - b.lo)[0];
  const f = (v) => (v >= 1000 ? Math.round(v).toLocaleString("en-IN") : v.toFixed(v >= 100 ? 0 : 1));
  return (
    <div style={card}>
      <Head date={d.dates[d.dates.length - 1]} src="Yahoo volumes">PRICE LEVELS · VOLUME AT PRICE (1Y)</Head>
      <svg viewBox={`0 0 340 ${H + 4}`} width="100%" style={{ display: "block" }} role="img" aria-label="Volume traded at each price level over the past year">
        {x.zones.map((z) => <rect key={z.i} x="0" y={Y(z.hi)} width="340" height={rowH} fill={z.hi < x.c ? C.pos : z.lo > x.c ? C.neg : C.warn} opacity="0.12" />)}
        {x.bins.map((v, i) => <rect key={i} x="52" y={H - (i + 1) * rowH + 0.5} width={(v / x.max) * 250} height={Math.max(1, rowH - 1)} rx="1.5" fill={x.zones.some((z) => z.i === i) ? "var(--text2)" : "var(--text3)"} opacity={x.zones.some((z) => z.i === i) ? 0.9 : 0.45} />)}
        <line x1="0" x2="340" y1={Y(x.c)} y2={Y(x.c)} stroke="var(--text)" strokeDasharray="4 3" strokeWidth="1" />
        <text x="306" y={Y(x.c) - 3} fontSize="9" fill="var(--text)" textAnchor="end" fontFamily="var(--mono)">now ₹{f(x.c)}</text>
        {[x.hi, (x.hi + x.lo) / 2, x.lo].map((p, k) => <text key={k} x="0" y={Math.min(H, Math.max(8, Y(p) + 3))} fontSize="8.5" fill="var(--text3)" fontFamily="var(--mono)">₹{f(p)}</text>)}
      </svg>
      <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 6, lineHeight: 1.5 }}>
        {below ? <>Busiest zone below the price: <b style={{ color: C.pos }}>₹{f(below.lo)}–{f(below.hi)}</b> (possible support). </> : "No heavy-volume zone below the price — little support from past trading. "}
        {above ? <>Above: <b style={{ color: C.neg }}>₹{f(above.lo)}–{f(above.hi)}</b> (possible resistance).</> : "No heavy-volume zone above — open air to the 1-year high."}
      </div>
      <div style={note}>Each day's volume is spread across its high–low range. Prices where many shares changed hands often act as support or resistance — a guide, not a rule.</div>
    </div>
  );
}

/** Month-by-month returns for up to 10 years. */
export function Seasonality({ symbol }) {
  const { data, err } = useJson(`/api/spark?symbols=${encodeURIComponent(symbol + ".NS")}&range=10y&interval=1mo`, 6 * 3600e3);
  const x = useMemo(() => {
    const it = data?.spark?.result?.[0]?.response?.[0];
    const ts = it?.timestamp, cl = it?.indicators?.quote?.[0]?.close;
    if (!ts || !cl) return null;
    const pts = ts.map((t, i) => [new Date((t + 19800) * 1000), cl[i]]).filter(([, c]) => c != null);
    const grid = {};
    for (let i = 1; i < pts.length; i++) {
      const [dt, c] = pts[i], p = pts[i - 1][1], y = dt.getUTCFullYear(), m = dt.getUTCMonth();
      (grid[y] ||= {})[m] = (c / p - 1) * 100;
    }
    const years = Object.keys(grid).map(Number).sort((a, b) => b - a).slice(0, 10);
    const stats = MON.map((_, m) => { const vs = years.map((y) => grid[y][m]).filter((v) => v != null); return vs.length ? { avg: vs.reduce((a, b) => a + b, 0) / vs.length, up: (vs.filter((v) => v > 0).length / vs.length) * 100, n: vs.length } : null; });
    return { grid, years, stats };
  }, [data]);
  const shade = (v) => { if (v == null) return "transparent"; const a = Math.min(1, Math.abs(v) / 12); return v >= 0 ? `rgba(34,197,94,${0.12 + a * 0.6})` : `rgba(220,20,60,${0.12 + a * 0.6})`; };
  const best = x ? x.stats.map((s, m) => [s, m]).filter(([s]) => s && s.n >= 4).sort((a, b) => b[0].avg - a[0].avg) : [];
  return (
    <div style={card}>
      <Head src="Yahoo monthly">SEASONALITY · MONTHLY RETURNS</Head>
      {!x ? (err ? <Fail err={err} /> : <Loading what="10 years of monthly prices" />) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "30px repeat(12, minmax(22px, 1fr))", gap: 2, fontSize: 9, minWidth: 300 }}>
              <span />
              {MON.map((m) => <span key={m} style={{ textAlign: "center", color: "var(--text3)" }}>{m[0]}</span>)}
              {x.years.map((y) => (
                <Fragment key={y}>
                  <span style={{ color: "var(--text3)", ...mono }}>{String(y).slice(2)}</span>
                  {MON.map((_, m) => { const v = x.grid[y][m]; return <span key={m} title={v == null ? "" : `${MON[m]} ${y}: ${pct(v)}`} style={{ background: shade(v), borderRadius: 3, textAlign: "center", padding: "3px 0", ...mono, color: v == null ? "transparent" : "var(--text)", fontSize: 8.5 }}>{v == null ? "·" : Math.round(v)}</span>; })}
                </Fragment>
              ))}
              <span style={{ color: "var(--text2)", fontWeight: 700 }}>avg</span>
              {x.stats.map((s, m) => <span key={m} style={{ textAlign: "center", ...mono, fontWeight: 700, color: pcol(s?.avg), fontSize: 8.5 }}>{s ? s.avg.toFixed(1) : "—"}</span>)}
              <span style={{ color: "var(--text3)" }}>up%</span>
              {x.stats.map((s, m) => <span key={m} style={{ textAlign: "center", ...mono, color: "var(--text3)", fontSize: 8.5 }}>{s ? Math.round(s.up) : "—"}</span>)}
            </div>
          </div>
          {best.length >= 2 && <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 8 }}>Best month on average: <b style={{ color: C.pos }}>{MON[best[0][1]]}</b> ({pct(best[0][0].avg)}, up {Math.round(best[0][0].up)}% of years). Worst: <b style={{ color: C.neg }}>{MON[best[best.length - 1][1]]}</b> ({pct(best[best.length - 1][0].avg)}).</div>}
          <div style={note}>% change each calendar month (the current month is partial). Patterns across 10 or fewer years are weak evidence — use as context only.</div>
        </>
      )}
    </div>
  );
}

// NSE timestamps like "20-Nov-2026 16:00:00" → "2026-11-20"
export const nseDay = (s) => { const m = String(s || "").match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/); if (!m) return null; const k = MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()); return k < 0 ? null : `${m[3]}-${String(k + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`; };
export { C, SIG_COL, card, head, note, mono, pct, pcol, fmtDay, fmtQ, cr, median, MON, Head, Loading, Fail, SymBtn, Chips, Collapse };
