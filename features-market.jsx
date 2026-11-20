// Market-page panels: styles & size race, who moved the Nifty, market map, index entry watch, 5-year-high club,
// signal calendar, market replay, promoter / big-holder filings, superinvestors, ETF premium, results season.
import { useState, useEffect, useMemo, useRef, Fragment } from "react";
import { C, SIG_COL, card, head, note, mono, pct, pcol, fmtDay, fmtQ, cr, median, MON, Head, Loading, Fail, SymBtn, Chips, AsOf, useJson, getJson, nseDay } from "./features.jsx";

const PERIODS = [["w", "1W"], ["m", "1M"], ["q", "3M"], ["y", "1Y"]];
const STYLE_IDX = [
  ["Momentum", "Nifty200 Momentum 30", "stocks that have risen most"],
  ["Quality", "NIFTY200 Quality 30", "high return on equity, low debt"],
  ["Value", "Nifty200 Value 30", "cheapest on earnings and book"],
  ["Low volatility", "Nifty100 Low Volatility 30", "calmest large caps"],
  ["Alpha", "Nifty Alpha 50", "biggest beat vs the market"],
  ["High dividend", "Nifty Dividend Opportunities 50", "high dividend yield"],
  ["Equal weight", "Nifty500 Equal Weight", "every Nifty 500 stock the same size"],
];
const SIZE_IDX = [["Large", "Nifty 100"], ["Mid", "Nifty Midcap 150"], ["Small", "Nifty Smallcap 250"], ["Micro", "Nifty Microcap 250"]];
const findIx = (S, name) => S[name] || S[Object.keys(S).find((k) => k.toLowerCase() === name.toLowerCase())];

/** Which investing style and which size band is winning — NSE factor and size indices. */
export function StyleScoreboard() {
  const { data, err } = useJson("/api/nse?type=styles", 15 * 60e3);
  const [p, setP] = useState(() => { try { return localStorage.getItem("td_style_p") || "q"; } catch (_) { return "q"; } });
  const pick = (k) => { setP(k); try { localStorage.setItem("td_style_p", k); } catch (_) {} };
  if (!data) return <div style={card}><Head>STYLE SCOREBOARD</Head>{err ? <Fail err={err} /> : <Loading what="NSE factor indices" />}</div>;
  const S = data.indices, base = findIx(S, "Nifty 500");
  const rows = STYLE_IDX.map(([l, ix, why]) => ({ l, ix, why, v: findIx(S, ix)?.[p], pe: findIx(S, ix)?.pe })).filter((r) => r.v != null);
  const b = base?.[p];
  const rel = rows.map((r) => ({ ...r, rel: b == null ? null : r.v - b })).sort((x, y) => y.v - x.v);
  const span = Math.max(1, ...rel.map((r) => Math.abs(r.rel ?? 0)));
  const lead = rel[0], lag = rel[rel.length - 1];
  const sizes = SIZE_IDX.map(([l, ix]) => ({ l, ix, o: findIx(S, ix) })).filter((x) => x.o);
  const gap = (k) => { const s = findIx(S, "Nifty Smallcap 250")?.[k], l = findIx(S, "Nifty 100")?.[k]; return s != null && l != null ? s - l : null; };
  const pl = PERIODS.find(([k]) => k === p)[1];
  return (
    <>
      <div style={card}>
        <Head date={data.date} src="NSE indices">STYLE SCOREBOARD</Head>
        <Chips items={PERIODS} value={p} onChange={pick} />
        {lead && lag && b != null && <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: 10, lineHeight: 1.5 }}>{lead.rel >= 0 ? <>Over {pl}, <b style={{ color: C.pos }}>{lead.l}</b> leads ({pct(lead.v)}, {pct(lead.rel)} vs Nifty 500) and <b style={{ color: pcol(lag.rel) }}>{lag.l}</b> trails ({pct(lag.v)}). The market is rewarding {lead.why}.</> : <>Over {pl}, <b>every style trailed the Nifty 500</b> ({pct(b)}) — the biggest stocks did the lifting. <b>{lead.l}</b> held up best ({pct(lead.v)}); <b style={{ color: C.neg }}>{lag.l}</b> lagged most ({pct(lag.v)}).</>}</div>}
        {rel.map((r) => (
          <div key={r.l} style={{ display: "grid", gridTemplateColumns: "92px 1fr 52px", gap: 8, alignItems: "center", padding: "4px 0" }} title={`${r.ix} · P/E ${r.pe ?? "—"}`}>
            <span style={{ fontSize: 12 }}>{r.l}</span>
            <div style={{ position: "relative", height: 14 }}>
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--border2)" }} />
              {r.rel != null && <div style={{ position: "absolute", top: 2, height: 10, borderRadius: 3, background: pcol(r.rel), opacity: 0.8, left: r.rel >= 0 ? "50%" : `${50 - (Math.abs(r.rel) / span) * 50}%`, width: `${(Math.abs(r.rel) / span) * 50}%` }} />}
            </div>
            <span style={{ ...mono, fontSize: 12, textAlign: "right", color: pcol(r.v) }}>{pct(r.v)}</span>
          </div>
        ))}
        <div style={{ display: "grid", gridTemplateColumns: "92px 1fr 52px", gap: 8, padding: "4px 0", borderTop: "1px solid var(--border)", marginTop: 4, fontSize: 12 }}><span style={{ color: "var(--text3)" }}>Nifty 500</span><span style={{ fontSize: 10, color: "var(--text3)", alignSelf: "center" }}>bars = gap vs Nifty 500</span><span style={{ ...mono, textAlign: "right", color: pcol(b) }}>{pct(b)}</span></div>
        <div style={note}>Returns of NSE's factor indices (each holds 30–50 stocks picked by that style). {pl} back = {fmtDay(data.dates?.[p])}.</div>
      </div>
      <div style={card}>
        <Head date={data.date} src="NSE indices">SIZE RACE · LARGE VS MID VS SMALL VS MICRO</Head>
        <div style={{ display: "grid", gridTemplateColumns: "56px repeat(4, 1fr) 46px", columnGap: 6, rowGap: 4, fontSize: 12, alignItems: "baseline" }}>
          <span />{PERIODS.map(([k, l]) => <span key={k} style={{ fontSize: 9.5, color: k === p ? "var(--text)" : "var(--text3)", textAlign: "right", fontWeight: k === p ? 700 : 400 }}>{l}</span>)}<span style={{ fontSize: 9.5, color: "var(--text3)", textAlign: "right" }}>P/E</span>
          {sizes.map((x) => (
            <Fragment key={x.l}>
              <span title={x.ix}>{x.l}</span>
              {PERIODS.map(([k]) => <span key={k} style={{ ...mono, textAlign: "right", color: pcol(x.o[k]), fontWeight: k === p ? 700 : 400 }}>{pct(x.o[k])}</span>)}
              <span style={{ ...mono, textAlign: "right", color: "var(--text2)" }}>{x.o.pe?.toFixed(0) ?? "—"}</span>
            </Fragment>
          ))}
          <span style={{ color: "var(--text3)", borderTop: "1px solid var(--border)", paddingTop: 4, fontSize: 11 }}>Small − large</span>
          {PERIODS.map(([k]) => <span key={k} style={{ ...mono, textAlign: "right", color: pcol(gap(k)), borderTop: "1px solid var(--border)", paddingTop: 4, fontSize: 11 }}>{gap(k) == null ? "—" : `${gap(k) > 0 ? "+" : ""}${gap(k).toFixed(1)}`}</span>)}
          <span style={{ borderTop: "1px solid var(--border)" }} />
        </div>
        {gap(p) != null && <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 8 }}>{gap(p) > 2 ? `Small caps are running ahead of large caps over ${pl} — risk appetite is high.` : gap(p) < -2 ? `Small caps are lagging large caps over ${pl} — money is hiding in the big names.` : `Small and large caps are moving together over ${pl}.`}</div>}
        <div style={note}>Large = Nifty 100, Mid = Midcap 150, Small = Smallcap 250, Micro = Microcap 250. P/E from NSE's index file — small caps usually trade at a premium.</div>
      </div>
    </>
  );
}

// free-float weights from yesterday's close → index points each stock added today
function contributions(ix) {
  const xs = (ix?.stocks || []).filter((s) => s.ffmc && s.chg != null);
  const prevCap = xs.map((s) => s.ffmc / (1 + s.chg / 100)), tot = prevCap.reduce((a, b) => a + b, 0);
  const base = ix.prev || (ix.last && ix.chg != null ? ix.last / (1 + ix.chg / 100) : null);
  return xs.map((s, i) => ({ ...s, w: prevCap[i] / tot, pts: base ? (prevCap[i] / tot) * (s.chg / 100) * base : null })).sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0));
}

/** Points each stock added to or took from the Nifty 50 today. */
export function NiftyMovers({ onPickStock }) {
  const { data, err } = useJson("/api/nse?type=index&index=NIFTY%2050", 60e3);
  if (!data) return <div style={card}><Head>WHO MOVED THE NIFTY</Head>{err ? <Fail err={err} /> : <Loading what="Nifty 50 constituents" />}</div>;
  if (data.approx && !data.stocks.some((s) => s.ffmc)) return <div style={card}><Head>WHO MOVED THE NIFTY</Head><Fail err="index weights unavailable" /></div>;
  const cs = contributions(data), sum = cs.reduce((a, s) => a + (s.pts || 0), 0);
  const tot = data.last != null && data.prev != null ? data.last - data.prev : sum; // the index's own point change
  const up = cs.filter((s) => s.pts > 0).slice(0, 6), dn = cs.filter((s) => s.pts < 0).slice(-6).reverse();
  const big = Math.max(1, ...cs.map((s) => Math.abs(s.pts || 0)));
  const top3 = (tot >= 0 ? up : dn).slice(0, 3), t3 = top3.reduce((a, s) => a + s.pts, 0);
  const bar = (s) => (
    <div key={s.sym} style={{ display: "grid", gridTemplateColumns: "84px 1fr 46px 48px", gap: 6, alignItems: "center", fontSize: 12, padding: "3px 0" }}>
      <SymBtn sym={s.sym} onPick={onPickStock} style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }} />
      <div style={{ height: 10, background: "var(--bg3)", borderRadius: 3, overflow: "hidden" }}><div style={{ height: "100%", width: `${(Math.abs(s.pts) / big) * 100}%`, background: pcol(s.pts), opacity: 0.8 }} /></div>
      <span style={{ ...mono, textAlign: "right", color: pcol(s.pts), fontWeight: 700 }}>{s.pts > 0 ? "+" : ""}{s.pts.toFixed(0)}</span>
      <span style={{ ...mono, textAlign: "right", color: "var(--text3)", fontSize: 10.5 }}>{pct(s.chg)}</span>
    </div>
  );
  return (
    <div style={card}>
      <Head date={data.approx ? data.date : nseDay(data.time)} src={data.approx ? "NSE · approx" : "NSE"} staleDays={3}>WHO MOVED THE NIFTY</Head>
      <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: 8, lineHeight: 1.5 }}>Nifty 50 <b style={{ color: pcol(data.chg) }}>{tot > 0 ? "+" : ""}{tot.toFixed(0)} pts ({pct(data.chg, 2)})</b>{top3.length ? <>. {top3.map((s) => s.sym).join(", ")} {tot >= 0 ? "added" : "took off"} <b>{Math.abs(t3).toFixed(0)}</b> of those points.</> : "."}</div>
      {up.length > 0 && <div style={{ ...head, margin: "4px 0" }}>PUSHED UP</div>}
      {up.map(bar)}
      {dn.length > 0 && <div style={{ ...head, margin: "8px 0 4px" }}>DRAGGED DOWN</div>}
      {dn.map(bar)}
      <div style={note}>{data.approx ? "Approximate: NSE's live weights were unavailable, so weights use full market cap (Yahoo) and moves are end-of-day closes." : <>Points = stock's weight (free-float market cap at yesterday's close) × its % move × yesterday's Nifty. Updates through the day · {data.time}.</>}</div>
    </div>
  );
}

// squarified treemap
function squarify(items, x, y, w, h) {
  const out = [], tot = items.reduce((a, b) => a + b.v, 0);
  if (!tot || w <= 0 || h <= 0) return out;
  const scale = (w * h) / tot, xs = items.map((it) => ({ ...it, a: it.v * scale }));
  const worst = (row, len) => { const s = row.reduce((a, b) => a + b.a, 0), mx = Math.max(...row.map((r) => r.a)), mn = Math.min(...row.map((r) => r.a)); return Math.max((len * len * mx) / (s * s), (s * s) / (len * len * mn)); };
  let i = 0;
  while (i < xs.length) {
    const len = Math.min(w, h), row = [xs[i++]];
    while (i < xs.length && worst([...row, xs[i]], len) <= worst(row, len)) row.push(xs[i++]);
    const s = row.reduce((a, b) => a + b.a, 0);
    if (w >= h) { const rw = s / h; let yy = y; for (const r of row) { const rh = r.a / rw; out.push({ ...r, x, y: yy, w: rw, h: rh }); yy += rh; } x += rw; w -= rw; }
    else { const rh = s / w; let xx = x; for (const r of row) { const rw = r.a / rh; out.push({ ...r, x: xx, y, w: rw, h: rh }); xx += rw; } y += rh; h -= rh; }
  }
  return out;
}

/** Nifty 500 as a map: box size = free-float market cap, colour = move, grouped by sector. */
export function MarketMap({ mq, onPickStock }) {
  const { data: raw, err: rawErr } = useJson("/api/nse?type=index&index=NIFTY%20500", 2 * 60e3);
  const [caps, setCaps] = useState(null), [capErr, setCapErr] = useState(null);
  // fallback data has no free-float caps: size boxes by Yahoo market cap, 50 stocks per request
  useEffect(() => {
    if (!raw?.approx || caps) return;
    let alive = true;
    const syms = raw.stocks.map((s) => s.sym), chunks = [];
    for (let i = 0; i < syms.length; i += 50) chunks.push(syms.slice(i, i + 50));
    const got = {};
    let k = 0;
    Promise.all([0, 1, 2].map(async () => { while (k < chunks.length) { const c = chunks[k++]; try { Object.assign(got, (await getJson(`/api/nse?type=val&symbols=${c.join(",")}`, 12 * 3600e3)).val); } catch (_) {} } }))
      .then(() => { if (!alive) return; if (Object.keys(got).length) setCaps(got); else setCapErr("market caps unavailable"); });
    return () => { alive = false; };
  }, [raw]);
  const data = raw?.approx ? (caps ? { ...raw, stocks: raw.stocks.map((s) => ({ ...s, ffmc: caps[s.sym]?.mcap ?? null })) } : null) : raw;
  const err = rawErr || capErr;
  const [p, setP] = useState("d");
  const [sel, setSel] = useState(null);
  const W = 340, H = 430;
  const tiles = useMemo(() => {
    const xs = (data?.stocks || []).filter((s) => s.ffmc > 0);
    if (!xs.length) return null;
    const groups = {};
    for (const s of xs) (groups[mq?.sector_of?.[s.sym] || s.ind || "Other"] ||= []).push(s);
    const secs = Object.entries(groups).map(([name, ss]) => ({ name, v: ss.reduce((a, b) => a + b.ffmc, 0), ss: ss.sort((a, b) => b.ffmc - a.ffmc) })).sort((a, b) => b.v - a.v);
    const out = [];
    for (const r of squarify(secs, 0, 0, W, H)) {
      const pad = r.w > 30 && r.h > 30 ? 11 : 0;
      out.push({ sector: true, ...r });
      for (const t of squarify(r.ss.map((s) => ({ ...s, v: s.ffmc })), r.x + 1, r.y + pad + 1, r.w - 2, r.h - pad - 2)) out.push({ ...t, sec: r.name });
    }
    return out;
  }, [data, mq]);
  const val = (s) => (p === "d" ? s.chg : s.r1y);
  const colr = (v) => { if (v == null) return "var(--bg3)"; const a = Math.min(1, Math.abs(v) / (p === "d" ? 3 : 40)); return v >= 0 ? `rgba(22,163,74,${0.18 + a * 0.72})` : `rgba(220,38,38,${0.18 + a * 0.72})`; };
  const secAgg = useMemo(() => {
    if (!tiles) return [];
    return tiles.filter((t) => t.sector).map((t) => { const tot = t.ss.reduce((a, b) => a + b.ffmc, 0); return { name: t.name, v: t.ss.reduce((a, s) => a + (val(s) ?? 0) * s.ffmc, 0) / tot }; }).sort((a, b) => b.v - a.v);
  }, [tiles, p]);
  return (
    <div style={card}>
      <Head date={data?.approx ? data.date : nseDay(data?.time)} src={data?.approx ? "NSE · Yahoo caps" : "NSE"} staleDays={3}>MARKET MAP · NIFTY 500</Head>
      {!raw?.approx && <Chips items={[["d", "Today"], ["y", "1 year"]]} value={p} onChange={setP} />}
      {!tiles ? (err ? <Fail err={err} /> : <Loading what="500 stocks" />) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", borderRadius: 8, overflow: "hidden" }} role="img" aria-label="Market map of the Nifty 500 by sector">
            {tiles.map((t, i) => t.sector ? (
              <g key={"s" + i}>
                <rect x={t.x} y={t.y} width={t.w} height={t.h} fill="var(--bg)" stroke="var(--bg)" strokeWidth="1.5" />
                {t.w > 30 && t.h > 30 && <text x={t.x + 3} y={t.y + 9} fontSize="8" fontWeight="700" fill="var(--text2)">{t.name.length * 4.6 > t.w ? t.name.slice(0, Math.max(3, Math.floor(t.w / 4.8))) : t.name}</text>}
              </g>
            ) : (
              <g key={t.sym} onClick={() => setSel(t)} style={{ cursor: "pointer" }}>
                <rect x={t.x} y={t.y} width={Math.max(0, t.w - 0.6)} height={Math.max(0, t.h - 0.6)} fill={colr(val(t))} />
                {t.w > 26 && t.h > 13 && <text x={t.x + t.w / 2} y={t.y + t.h / 2 + (t.h > 24 ? -1 : 3)} fontSize={Math.min(11, Math.max(6.5, t.w / 6.5))} textAnchor="middle" fill="var(--text)" fontWeight="700">{t.sym.length * 6 > t.w ? t.sym.slice(0, Math.floor(t.w / 6)) : t.sym}</text>}
                {t.w > 30 && t.h > 24 && <text x={t.x + t.w / 2} y={t.y + t.h / 2 + 10} fontSize="7.5" textAnchor="middle" fill="var(--text)" opacity="0.85" fontFamily="var(--mono)">{pct(val(t))}</text>}
              </g>
            ))}
          </svg>
          {sel && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg3)", fontSize: 12 }}>
              <b>{sel.sym}</b><span style={{ color: "var(--text3)" }}>{sel.sec}</span><span style={{ ...mono, color: pcol(val(sel)) }}>{pct(val(sel))}</span><span style={{ ...mono, color: "var(--text3)" }}>{cr(sel.ffmc)} ff</span>
              <span style={{ flex: 1 }} /><button className="chip chip-sm" onClick={() => onPickStock?.(sel.sym)}>Open ›</button>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            {secAgg.slice(0, 4).map((s) => <span key={s.name} style={{ fontSize: 10.5, color: C.pos }}>▲ {s.name} {pct(s.v)}</span>)}
            {secAgg.slice(-3).reverse().map((s) => <span key={s.name} style={{ fontSize: 10.5, color: C.neg }}>▼ {s.name} {pct(s.v)}</span>)}
          </div>
          <div style={note}>Box size = {data.approx ? "market cap (Yahoo)" : "free-float market cap"}; colour = {p === "d" ? "today's move (full colour at ±3%)" : "1-year return (full colour at ±40%)"}. Tap a box for the stock. Sector figures are cap-weighted.</div>
        </>
      )}
    </div>
  );
}

/** Rough guide to Nifty 50 entry / exit candidates by free-float market cap. */
export function IndexWatch({ onPickStock }) {
  const a = useJson("/api/nse?type=index&index=NIFTY%2050", 30 * 60e3), b = useJson("/api/nse?type=index&index=NIFTY%20NEXT%2050", 30 * 60e3);
  if (!a.data || !b.data) return <div style={card}><Head>INDEX ENTRY WATCH</Head>{a.err || b.err ? <Fail err={a.err || b.err} /> : <Loading what="Nifty 50 and Next 50" />}</div>;
  const approx = a.data.approx || b.data.approx;
  const all = [...a.data.stocks.map((s) => ({ ...s, inN: true })), ...b.data.stocks.map((s) => ({ ...s, inN: false }))].filter((s) => s.ffmc).sort((x, y) => y.ffmc - x.ffmc).map((s, i) => ({ ...s, rank: i + 1 }));
  const cands = all.filter((s) => !s.inN && s.rank <= 50).slice(0, 6), risk = all.filter((s) => s.inN && s.rank > 50).slice(-6).reverse();
  const near = all.filter((s) => !s.inN).slice(0, 5), weak = all.filter((s) => s.inN).slice(-5).reverse();
  const row = (s) => (
    <div key={s.sym} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12, padding: "3px 0", borderTop: "1px solid var(--border)" }}>
      <span style={{ ...mono, color: "var(--text3)", width: 28 }}>#{s.rank}</span><SymBtn sym={s.sym} onPick={onPickStock} style={{ flex: 1 }} /><span style={{ ...mono, color: "var(--text2)" }}>{cr(s.ffmc)}</span>
    </div>
  );
  const cut = all[49]?.ffmc;
  return (
    <div style={card}>
      <Head date={approx ? a.data.date : null} src={approx ? "full caps · approx" : "NSE free-float caps"}>INDEX ENTRY WATCH · NIFTY 50</Head>
      <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: 8, lineHeight: 1.5 }}>Ranking all 100 Nifty 50 + Next 50 stocks by today's {approx ? "full" : "free-float"} market cap. The 50th is {cut ? cr(cut) : "—"}.{cands.length ? ` ${cands.length} Next 50 stock${cands.length > 1 ? "s rank" : " ranks"} inside the top 50.` : " No Next 50 stock ranks inside the top 50 right now."}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div><div style={{ ...head, color: C.pos, marginBottom: 2 }}>{cands.length ? "COULD ENTER" : "CLOSEST TO ENTERING"}</div>{(cands.length ? cands : near).map(row)}</div>
        <div><div style={{ ...head, color: C.neg, marginBottom: 2 }}>{risk.length ? "AT RISK OF EXIT" : "SMALLEST IN NIFTY 50"}</div>{(risk.length ? risk : weak).map(row)}</div>
      </div>
      {approx && <div style={{ fontSize: 11.5, color: C.warn, marginTop: 8 }}>NSE's free-float caps weren't available, so this ranks by full market cap — companies with large promoter stakes (little free float) look bigger here than NSE will count them.</div>}
      <div style={note}>A rough guide only. NSE uses the 6-month average free-float cap, requires F&O trading, and reviews in February and August (changes take effect at the end of March and September).</div>
    </div>
  );
}

/** Stocks at their highest close in 5 years (nightly) — or today's 52-week highs until that's published. */
export function HighClub({ mq, onPickStock }) {
  const five = mq?.long_bt?.high5;
  const list = five || mq?.high_list || [];
  const [sec, setSec] = useState(null);
  const bySec = {};
  for (const x of list) (bySec[x.sector || mq?.sector_of?.[x.sym] || "Other"] ||= []).push(x);
  const secs = Object.entries(bySec).sort((a, b) => b[1].length - a[1].length);
  const shown = sec ? bySec[sec] || [] : list;
  return (
    <div style={card}>
      <Head date={five ? mq.long_bt.to : mq?.as_of} src="TRADESK">{five ? "5-YEAR-HIGH CLUB" : "52-WEEK-HIGH CLUB"} · {list.length}</Head>
      <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: 8 }}>{list.length ? <>{list.length} Nifty 500 stock{list.length > 1 ? "s" : ""} {five ? "closed within 2% of their highest close in five years" : "closed at a 52-week high"}{secs[0] ? <> — most in <b>{secs[0][0]}</b> ({secs[0][1].length})</> : ""}.</> : "No stock is at its high today."}</div>
      {secs.length > 1 && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>{secs.slice(0, 8).map(([s, xs]) => <button key={s} className="chip chip-sm" aria-pressed={sec === s} onClick={() => setSec(sec === s ? null : s)}>{s} <span style={{ ...mono, opacity: 0.7 }}>{xs.length}</span></button>)}</div>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{shown.slice(0, 40).map((x) => <button key={x.sym} className="chip chip-sm" onClick={() => onPickStock?.(x.sym)}>{x.sym}{x.off != null ? <span style={{ ...mono, opacity: 0.7 }}> {x.off.toFixed(1)}%</span> : x.chg != null ? <span style={{ ...mono, color: pcol(x.chg) }}> {pct(x.chg)}</span> : null}</button>)}</div>
      <div style={note}>{five ? "From the nightly 5-year price history (Yahoo goes back 5 years here, so this is often — not always — an all-time high). Figure = % below the 5-year high." : "The 5-year version appears after the next nightly update. Today's change shown."}</div>
    </div>
  );
}

/** Every signal day as a calendar, plus how long each phase lasted. */
export function SignalCalendar({ mq }) {
  const days = useMemo(() => {
    const m = new Map();
    for (const [d, s] of mq?.long_bt?.sig_days || []) m.set(d, s);
    for (const h of mq?.history || []) if (h.sig) m.set(h.d, h.sig);
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-520);
  }, [mq]);
  if (days.length < 20) return null;
  const years = [...new Set(days.map(([d]) => d.slice(0, 4)))];
  const by = Object.fromEntries(days);
  const phases = [];
  for (const [d, s] of days) { const l = phases[phases.length - 1]; if (l && l.s === s) { l.to = d; l.n++; } else phases.push({ s, from: d, to: d, n: 1 }); }
  const cnt = (s) => days.filter(([, x]) => x === s).length;
  const cell = 5.4, gap = 0.9;
  return (
    <div style={card}>
      <Head date={days[days.length - 1][0]} src="TRADESK">SIGNAL CALENDAR · {days.length} SESSIONS</Head>
      <div style={{ display: "flex", gap: 10, fontSize: 11.5, marginBottom: 8, flexWrap: "wrap" }}>
        {["INVEST", "SELECTIVE", "CASH"].map((s) => <span key={s}><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: SIG_COL[s], marginRight: 4 }} />{s} <span style={{ ...mono, color: "var(--text3)" }}>{cnt(s)}d · {Math.round((cnt(s) / days.length) * 100)}%</span></span>)}
      </div>
      {years.map((y) => {
        const jan1 = Date.UTC(+y, 0, 1), off = (new Date(jan1).getUTCDay() + 6) % 7;
        const cells = [];
        for (let t = jan1; new Date(t).getUTCFullYear() === +y; t += 864e5) {
          const dt = new Date(t), dow = (dt.getUTCDay() + 6) % 7; if (dow > 4) continue;
          const iso = dt.toISOString().slice(0, 10), wk = Math.floor(((t - jan1) / 864e5 + off) / 7);
          cells.push(<rect key={iso} x={wk * (cell + gap)} y={dow * (cell + gap)} width={cell} height={cell} rx="1" fill={by[iso] ? SIG_COL[by[iso]] : "var(--bg3)"} opacity={by[iso] ? 0.85 : 0.5}><title>{iso}{by[iso] ? ` · ${by[iso]}` : ""}</title></rect>);
        }
        return (
          <div key={y} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 2 }}>{y}</div>
            <svg viewBox={`0 0 ${53 * (cell + gap)} ${5 * (cell + gap) + 8}`} width="100%" style={{ display: "block" }} role="img" aria-label={`Signal by day in ${y}`}>
              {cells}
              {MON.map((m, i) => <text key={m} x={((Date.UTC(+y, i, 1) - jan1) / 864e5 + off) / 7 * (cell + gap)} y={5 * (cell + gap) + 7} fontSize="5.5" fill="var(--text3)">{m[0]}</text>)}
            </svg>
          </div>
        );
      })}
      <div style={{ ...head, margin: "6px 0 4px" }}>RECENT PHASES</div>
      {phases.slice(-6).reverse().map((ph, i) => (
        <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, padding: "3px 0", borderTop: i ? "1px solid var(--border)" : "none" }}>
          <b style={{ color: SIG_COL[ph.s], width: 74 }}>{ph.s}</b><span style={{ flex: 1, color: "var(--text2)" }}>{fmtDay(ph.from)} → {i === 0 ? "now" : fmtDay(ph.to)}</span><span style={{ ...mono, color: "var(--text3)" }}>{ph.n} sessions</span>
        </div>
      ))}
      <div style={note}>Average phase: {(days.length / phases.length).toFixed(0)} sessions. Older days come from the nightly 5-year run.</div>
    </div>
  );
}

/** Step the breadth readings and the sector map back through recent sessions. */
export function MarketReplay({ mq }) {
  const h = (mq?.history || []).slice(-20);
  const [i, setI] = useState(h.length - 1);
  const [play, setPlay] = useState(false);
  useEffect(() => { setI(h.length - 1); }, [h.length]);
  useEffect(() => {
    if (!play) return;
    const t = setInterval(() => setI((k) => { if (k >= h.length - 1) { setPlay(false); return k; } return k + 1; }), 750);
    return () => clearInterval(t);
  }, [play, h.length]);
  if (h.length < 5) return null;
  const day = h[Math.min(i, h.length - 1)];
  const secs = Object.entries(mq.sector_history || {}).map(([name, xs]) => { const x = [...xs].reverse().find((e) => e.d <= day.d) || xs[0]; return { name, p50: x?.p50, r: x?.ret1m, d: x?.d }; }).filter((s) => s.p50 != null).sort((a, b) => b.p50 - a.p50);
  const bars = [["Above 10-day", day.p10], ["Above 50-day", day.p50], ["Above 200-day", day.p200]];
  const startPlay = () => { if (i >= h.length - 1) setI(0); setPlay(true); };
  return (
    <div style={card}>
      <Head date={day.d} src="TRADESK">MARKET REPLAY · LAST {h.length} SESSIONS</Head>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <button className="chip chip-sm" onClick={() => (play ? setPlay(false) : startPlay())} aria-label={play ? "Pause" : "Play"}>{play ? "❚❚ Pause" : "▶ Play"}</button>
        <input type="range" min="0" max={h.length - 1} value={i} onChange={(e) => { setPlay(false); setI(+e.target.value); }} aria-label="Session" style={{ flex: 1 }} />
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>{fmtDay(day.d)}</b>
        <span style={{ fontSize: 12, fontWeight: 800, color: SIG_COL[day.sig] }}>{day.sig}</span>
        <span style={{ fontSize: 11, color: "var(--text3)" }}>{day.b} · trend {String(day.t || "").toLowerCase()} · net new highs {day.nnh}</span>
      </div>
      {bars.map(([l, v]) => (
        <div key={l} style={{ display: "grid", gridTemplateColumns: "88px 1fr 40px", gap: 8, alignItems: "center", fontSize: 11.5, padding: "2px 0" }}>
          <span style={{ color: "var(--text2)" }}>{l}</span>
          <div style={{ height: 9, background: "var(--bg3)", borderRadius: 3, overflow: "hidden" }}><div style={{ height: "100%", width: `${v}%`, background: v >= 60 ? C.pos : v >= 40 ? C.warn : C.neg, transition: "width .4s" }} /></div>
          <span style={{ ...mono, textAlign: "right" }}>{v?.toFixed(0)}%</span>
        </div>
      ))}
      {secs.length > 0 && <>
        <div style={{ ...head, margin: "10px 0 4px" }}>SECTORS · % ABOVE 50-DAY <span style={{ fontWeight: 400, letterSpacing: 0 }}>(weekly, {fmtDay(secs[0].d)})</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 12 }}>
          {secs.map((s) => (
            <div key={s.name} style={{ display: "grid", gridTemplateColumns: "1fr 46px", gap: 4, alignItems: "center", fontSize: 10.5, padding: "1.5px 0" }}>
              <div style={{ position: "relative", height: 13, background: "var(--bg3)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ position: "absolute", inset: 0, width: `${s.p50}%`, background: s.p50 >= 60 ? C.pos : s.p50 >= 40 ? C.warn : C.neg, opacity: 0.45, transition: "width .4s" }} />
                <span style={{ position: "relative", paddingLeft: 4, whiteSpace: "nowrap" }}>{s.name}</span>
              </div>
              <span style={{ ...mono, textAlign: "right", color: pcol(s.r) }}>{pct(s.r, 0)}</span>
            </div>
          ))}
        </div>
      </>}
      <div style={note}>Breadth is daily; the sector map steps weekly (figure on the right = sector's 1-month return). Press play to watch money rotate.</div>
    </div>
  );
}

// well-known individual and boutique investors (matched on the filer / client name)
const SUPER = [
  ["Rakesh Jhunjhunwala estate / Rare", /jhunjhunwala|rare enterprises|rare investments/i],
  ["Radhakishan Damani", /radhakishan|damani|derive trading|bright star invest/i],
  ["Ashish Kacholia", /kacholia|bengal finance/i],
  ["Vijay Kedia", /vijay kishanlal kedia|kedia securities|vijay kedia/i],
  ["Dolly Khanna", /dolly khanna|rajiv khanna/i],
  ["Mukul Agrawal", /mukul (mahavir )?agrawal|param capital/i],
  ["Sunil Singhania / Abakkus", /sunil singhania|abakkus/i],
  ["Porinju Veliyath", /porinju|equity intelligence/i],
  ["Madhusudan Kela", /madhusudan.*kela|singularity/i],
  ["Ashish Dhawan", /ashish dhawan/i],
  ["Nemish Shah", /nemish|enam/i],
  ["Anil Kumar Goel", /anil kumar goel/i],
  ["Akash Bhanshali", /bhanshali/i],
  ["Manish Jain", /manish jain/i],
  ["Shankar Sharma", /shankar sharma|first global/i],
  ["Satpal Khattar", /khattar/i],
];
const whoOf = (name) => SUPER.find(([, re]) => re.test(name || ""))?.[0] || null;

/** Promoters and big investors buying or selling — SAST Reg 29 filings, last 30 days. */
export function HolderFilings({ mq, onPickStock }) {
  const { data, err } = useJson("/api/nse?type=holders&days=30", 30 * 60e3);
  const [only500, setOnly500] = useState(true);
  const [tab, setTab] = useState("pbuy");
  if (!data) return <div style={card}><Head>PROMOTER & BIG-HOLDER MOVES</Head>{err ? <Fail err={err} /> : <Loading what="30 days of NSE filings" />}</div>;
  const in500 = (s) => !only500 || !mq?.sector_of || s in mq.sector_of;
  const rows = data.rows.filter((r) => in500(r.sym) && !/inter.?se|gift|transmission|inheritance/i.test(r.mode || ""));
  const pick = { pbuy: (r) => r.promoter && r.side === "buy", psell: (r) => r.promoter && r.side === "sell", ibuy: (r) => !r.promoter && r.side === "buy", isell: (r) => !r.promoter && r.side === "sell" }[tab];
  const grouped = {};
  for (const r of rows.filter(pick)) { const g = (grouped[r.sym] ||= { sym: r.sym, co: r.co, n: 0, shares: 0, names: new Set(), last: r.date }); g.n++; g.shares += r.shares || 0; g.names.add(r.name); if (r.date > g.last) g.last = r.date; }
  const list = Object.values(grouped).sort((a, b) => (b.last < a.last ? -1 : b.last > a.last ? 1 : b.n - a.n));
  const counts = { pbuy: 0, psell: 0, ibuy: 0, isell: 0 };
  for (const r of rows) counts[(r.promoter ? "p" : "i") + r.side] = (counts[(r.promoter ? "p" : "i") + r.side] || 0) + 1;
  return (
    <div style={card}>
      <Head date={data.rows[0]?.date} src="NSE SAST" staleDays={5}>PROMOTER & BIG-HOLDER MOVES · 30 DAYS</Head>
      <Chips items={[["pbuy", `Promoters buy · ${counts.pbuy}`], ["psell", `Promoters sell · ${counts.psell}`], ["ibuy", `Big holders buy · ${counts.ibuy}`], ["isell", `Big holders sell · ${counts.isell}`]]} value={tab} onChange={setTab} />
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5, color: "var(--text2)", marginBottom: 6 }}><input type="checkbox" checked={only500} onChange={(e) => setOnly500(e.target.checked)} /> Nifty 500 only</label>
      {!list.length ? <div style={{ fontSize: 12, color: "var(--text3)" }}>None in the last 30 days.</div> : list.slice(0, 15).map((g) => (
        <div key={g.sym} style={{ padding: "5px 0", borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12 }}>
            <SymBtn sym={g.sym} onPick={onPickStock} /><span style={{ flex: 1, color: "var(--text3)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.co}</span>
            <span style={{ ...mono, color: "var(--text2)" }}>{g.shares ? `${(g.shares / 1e5).toFixed(1)}L sh` : ""}</span><span style={{ fontSize: 10.5, color: "var(--text3)" }}>{fmtDay(g.last)}</span>
          </div>
          <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[...g.names].slice(0, 3).join(" · ")}{g.n > 1 ? ` · ${g.n} filings` : ""}</div>
        </div>
      ))}
      <div style={note}>SAST Regulation 29 filings: promoters' trades and anyone with 5%+ who moves their stake by 2%+. Inter-se transfers and gifts left out. Promoters buying in the open market is often read as confidence.</div>
    </div>
  );
}

/** Well-known investors' disclosed moves: 6 months of SAST filings + today's bulk / block deals. */
export function Superinvestors({ onPickStock }) {
  const s = useJson("/api/nse?type=holders&days=180", 3 * 3600e3), dl = useJson("/api/nse?type=deals", 30 * 60e3);
  if (!s.data) return <div style={card}><Head>SUPERINVESTOR TRACKER</Head>{s.err ? <Fail err={s.err} /> : <Loading what="6 months of filings" />}</div>;
  const moves = [];
  for (const r of s.data.rows) { const w = whoOf(r.name); if (w) moves.push({ who: w, sym: r.sym, side: r.side, date: r.date, shares: r.shares, src: "SAST" }); }
  for (const r of dl.data?.deals || []) { const w = whoOf(r.client); if (w) moves.push({ who: w, sym: r.sym, side: /buy/i.test(r.side) ? "buy" : "sell", date: dl.data.date, shares: r.qty, src: r.kind }); }
  const by = {};
  const seenM = new Set();
  for (const m of moves) { const k = `${m.who}|${m.sym}|${m.side}|${m.date}`; if (seenM.has(k)) continue; seenM.add(k); (by[m.who] ||= []).push(m); }
  const ppl = Object.entries(by).sort((a, b) => (b[1][0].date > a[1][0].date ? 1 : -1));
  return (
    <div style={card}>
      <Head date={s.data.rows[0]?.date} src="NSE" staleDays={5}>SUPERINVESTOR TRACKER · 6 MONTHS</Head>
      {!ppl.length ? <div style={{ fontSize: 12, color: "var(--text3)" }}>No disclosed moves by the tracked investors in the last 6 months.</div> : ppl.map(([who, ms]) => (
        <div key={who} style={{ padding: "6px 0", borderTop: "1px solid var(--border)" }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 3 }}>{who} <span style={{ fontWeight: 400, fontSize: 10.5, color: "var(--text3)" }}>{ms.length} move{ms.length > 1 ? "s" : ""}</span></div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ms.sort((a, b) => (b.date > a.date ? 1 : -1)).slice(0, 8).map((m, i) => <button key={i} className="chip chip-sm" onClick={() => onPickStock?.(m.sym)} title={`${m.src} · ${m.date}`}><b style={{ color: m.side === "buy" ? C.pos : C.neg }}>{m.side === "buy" ? "▲" : "▼"}</b> {m.sym} <span style={{ opacity: 0.6 }}>{fmtDay(m.date)}</span></button>)}
          </div>
        </div>
      ))}
      <div style={note}>Only what the law makes them disclose: stakes of 5%+ changing by 2%+ (SAST) and today's bulk/block deals. Smaller buys don't show up. Tracked: {SUPER.map((x) => x[0].split(" /")[0]).join(", ")}.</div>
    </div>
  );
}

/** ETFs trading away from their NAV. */
export function EtfPremium({ onPickStock }) {
  const { data, err } = useJson("/api/nse?type=etf", 5 * 60e3);
  const [all, setAll] = useState(false);
  if (!data) return <div style={card}><Head>ETF PREMIUM / DISCOUNT</Head>{err ? <Fail err={err} /> : <Loading what="NSE ETFs" />}</div>;
  const xs = data.etfs.filter((e) => e.prem != null && e.val > 0).sort((a, b) => b.val - a.val);
  const shown = all ? xs.slice(0, 60) : xs.slice(0, 15);
  const off = xs.slice(0, 60).filter((e) => Math.abs(e.prem) >= 1);
  const navDay = nseDay(data.navDate);
  return (
    <div style={card}>
      <Head date={navDay} src="NSE" staleDays={4}>ETF PREMIUM / DISCOUNT TO NAV</Head>
      <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: 8, lineHeight: 1.5 }}>{off.length ? <><b>{off.length}</b> of the 60 most-traded ETFs closed 1% or more away from their NAV{off[0] ? <> — e.g. <b>{off.sort((a, b) => Math.abs(b.prem) - Math.abs(a.prem))[0].sym}</b> at {pct(off[0].prem, 2)}</> : ""}.</> : "The most-traded ETFs closed within 1% of their NAV — no unusual premiums."}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 64px 64px 58px", columnGap: 8, rowGap: 3, fontSize: 11.5, alignItems: "baseline" }}>
        {["ETF", "CLOSE", "NAV", "VS NAV"].map((h, i) => <span key={h} style={{ fontSize: 9, color: "var(--text3)", textAlign: i ? "right" : "left" }}>{h}</span>)}
        {shown.map((e) => (
          <Fragment key={e.sym}>
            <span style={{ minWidth: 0, overflow: "hidden" }}><SymBtn sym={e.sym} onPick={onPickStock} style={{ fontSize: 11.5 }} /><span style={{ display: "block", fontSize: 9.5, color: "var(--text3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.asset}</span></span>
            <span style={{ ...mono, textAlign: "right" }}>{e.prev ?? "—"}</span>
            <span style={{ ...mono, textAlign: "right", color: "var(--text2)" }}>{e.nav?.toFixed(2)}</span>
            <span style={{ ...mono, textAlign: "right", fontWeight: 700, color: Math.abs(e.prem) >= 1 ? (e.prem > 0 ? C.warn : C.blue) : "var(--text2)" }}>{pct(e.prem, 2)}</span>
          </Fragment>
        ))}
      </div>
      {xs.length > 15 && <button className="chip chip-sm" style={{ marginTop: 8 }} onClick={() => setAll(!all)}>{all ? "Fewer" : "Top 60 by value traded"}</button>}
      <div style={note}>Previous close vs the fund's NAV for the same day ({data.navDate}). A premium means you'd pay more than the holdings are worth; a discount, less. Sorted by value traded.</div>
    </div>
  );
}

const RS_KEY = "td_results_season_v1";
/** Results season: who grew profit vs a year earlier, by sector, and the biggest surprises. */
export function ResultsSeason({ mq, onPickStock }) {
  const [st, setSt] = useState(() => { try { const j = JSON.parse(localStorage.getItem(RS_KEY) || "null"); return j && Object.keys(j.results || {}).length && Date.now() - j.at < 12 * 3600e3 ? { ...j, done: true } : null; } catch (_) { return null; } });
  const [busy, setBusy] = useState(false);
  const rep = useJson("/api/nse?type=reported&days=60", 3 * 3600e3);
  const universe = mq?.sector_of ? Object.keys(mq.sector_of) : [];
  const todo = rep.data ? universe.filter((s) => rep.data.reported[s]).sort() : [];
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async () => {
    setBusy(true);
    setSt({ results: {}, n: todo.length, progress: 0, at: Date.now(), done: false });
    const results = {}, chunks = [];
    for (let i = 0; i < todo.length; i += 10) chunks.push(todo.slice(i, i + 10));
    let k = 0, done = 0;
    await Promise.all([0, 1, 2].map(async () => {
      while (k < chunks.length && alive.current) {
        const ch = chunks[k++];
        try { const j = await getJson(`/api/nse?type=qresults&symbols=${ch.join(",")}`, 12 * 3600e3); Object.assign(results, j.results); } catch (_) {}
        done++; if (alive.current) setSt({ results: { ...results }, n: todo.length, progress: done / chunks.length, at: Date.now(), done: false });
      }
    }));
    const fin = { results, n: todo.length, at: Date.now() };
    if (Object.keys(results).length) try { localStorage.setItem(RS_KEY, JSON.stringify(fin)); } catch (_) {}
    if (alive.current) { setSt({ ...fin, done: true }); setBusy(false); }
  };
  const res = st?.results || {};
  const rows = Object.entries(res).map(([sym, r]) => ({ sym, ...r, sec: mq?.sector_of?.[sym] || "Other", g: r.profitY != null && r.profitY > 0 && r.profit != null ? ((r.profit - r.profitY) / r.profitY) * 100 : null, gr: r.revY ? ((r.rev - r.revY) / Math.abs(r.revY)) * 100 : null })).filter((r) => r.g != null || r.gr != null);
  const secs = {};
  for (const r of rows) { const s = (secs[r.sec] ||= { name: r.sec, n: 0, up: 0, gs: [], rs: [] }); if (r.g != null) { s.n++; if (r.g > 0) s.up++; s.gs.push(r.g); } if (r.gr != null) s.rs.push(r.gr); }
  const secList = Object.values(secs).filter((s) => s.n >= 2).sort((a, b) => b.up / b.n - a.up / a.n);
  const withG = rows.filter((r) => r.g != null && r.profitY >= 10);
  const tops = [...withG].sort((a, b) => b.g - a.g).slice(0, 5), flops = [...withG].sort((a, b) => a.g - b.g).slice(0, 5);
  const allUp = withG.filter((r) => r.g > 0).length;
  return (
    <div style={card}>
      <Head date={st?.at ? new Date(st.at + 19800000).toISOString().slice(0, 10) : null} src="NSE filings">RESULTS SEASON SCOREBOARD</Head>
      {!rep.data ? (rep.err ? <Fail err={rep.err} /> : <Loading what="who reported" />) : !st || (!st.done && !busy) ? (
        <>
          <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: 8 }}><b>{todo.length}</b> Nifty 500 companies held results meetings in the last 60 days. Read every filing and compare each with the same quarter last year?</div>
          <button className="btn-primary" style={{ padding: "8px 14px", fontSize: 12 }} onClick={run} disabled={!todo.length || busy}>Build the scoreboard ›</button>
          <div style={note}>Reads each company's XBRL results from NSE — about {Math.ceil(todo.length / 10)} requests; takes 20–60 seconds the first time, then it's cached for 12 hours.</div>
        </>
      ) : (
        <>
          {!st.done && <div style={{ height: 3, background: "var(--border)", borderRadius: 3, overflow: "hidden", marginBottom: 8 }}><div style={{ height: "100%", width: `${Math.round((st.progress || 0) * 100)}%`, background: "var(--text2)" }} /></div>}
          <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: 8, lineHeight: 1.5 }}><b>{allUp}</b> of <b>{withG.length}</b> companies grew profit vs a year earlier ({withG.length ? Math.round((allUp / withG.length) * 100) : 0}%). Median profit growth <b style={{ color: pcol(median(withG.map((r) => r.g))) }}>{pct(median(withG.map((r) => r.g)), 0)}</b>, revenue <b>{pct(median(rows.map((r) => r.gr)), 0)}</b>.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 52px 1fr 46px", columnGap: 8, rowGap: 3, fontSize: 11.5, alignItems: "center" }}>
            {["SECTOR", "PROFIT ↑", "", "MEDIAN"].map((h, i) => <span key={i} style={{ fontSize: 9, color: "var(--text3)", textAlign: i === 1 || i === 3 ? "right" : "left" }}>{h}</span>)}
            {secList.map((s) => (
              <Fragment key={s.name}>
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
                <span style={{ ...mono, textAlign: "right" }}>{s.up}/{s.n}</span>
                <div style={{ height: 8, background: "var(--bg3)", borderRadius: 3, overflow: "hidden" }}><div style={{ height: "100%", width: `${(s.up / s.n) * 100}%`, background: s.up / s.n >= 0.6 ? C.pos : s.up / s.n >= 0.4 ? C.warn : C.neg }} /></div>
                <span style={{ ...mono, textAlign: "right", color: pcol(median(s.gs)) }}>{pct(median(s.gs), 0)}</span>
              </Fragment>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 10 }}>
            {[["BIGGEST JUMPS", tops], ["BIGGEST DROPS", flops]].map(([l, xs]) => (
              <div key={l}><div style={{ ...head, marginBottom: 3 }}>{l}</div>{xs.map((r) => <div key={r.sym} style={{ display: "flex", gap: 6, fontSize: 11.5, padding: "2px 0" }}><SymBtn sym={r.sym} onPick={onPickStock} style={{ flex: 1, fontSize: 11.5 }} /><span style={{ ...mono, color: pcol(r.g) }}>{pct(r.g, 0)}</span></div>)}</div>
            ))}
          </div>
          {st.done && <button className="chip chip-sm" style={{ marginTop: 8 }} onClick={run} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</button>}
          <div style={note}>Latest quarter's profit (to shareholders) vs the same quarter a year earlier, from NSE XBRL filings; consolidated where filed. Jumps/drops need ₹10 cr+ profit a year ago. {Object.keys(res).length} of {st.n} read.</div>
        </>
      )}
    </div>
  );
}
