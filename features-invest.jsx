// Invest / journal panels: fund expense ratio & AUM, category money flows, risk-return map,
// IPO subscription by category, watchlist as an index, announcements for your stocks.
import { useState, useEffect, useMemo, Fragment } from "react";
import { C, card, head, note, mono, pct, pcol, fmtDay, cr, median, MON, Head, Loading, Fail, SymBtn, Chips, AsOf, useJson, getJson } from "./features.jsx";

export const useFundFacts = () => useJson("/fund_facts.json", 6 * 3600e3);
const monthEnd = (ym) => { if (!ym) return null; const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const terMonthIso = (t) => { const m = String(t || "").match(/^(\d{2})-(\d{4})$/); return m ? `${m[2]}-${m[1]}-01` : null; };

/** Small "TER 0.62%" tag for fund lists. */
export function TerTag({ code }) {
  const { data } = useFundFacts();
  const t = data?.ter?.[code]?.[0];
  return t != null ? <span title="Direct-plan expense ratio (AMFI)"> · TER {t.toFixed(2)}%</span> : null;
}

/** Expense ratio, fund size and how both compare with the category. */
export function FundFacts({ code, catCodes }) {
  const { data, err } = useFundFacts();
  if (!data) return err ? null : <div style={card}><Loading what="costs and size" /></div>;
  const t = data.ter?.[code], aum = data.aum?.[code];
  if (!t && aum == null) return null;
  const peers = (catCodes || []).map((c) => data.ter?.[c]?.[0]).filter((v) => v != null);
  const cheaper = t?.[0] != null && peers.length > 4 ? Math.round((peers.filter((v) => v > t[0]).length / peers.length) * 100) : null;
  const sizes = (catCodes || []).map((c) => data.aum?.[c]).filter((v) => v != null).sort((a, b) => b - a);
  const sizeRank = aum != null && sizes.length > 4 ? sizes.indexOf(aum) + 1 : null;
  const saved = t?.[0] != null && t?.[1] != null ? t[1] - t[0] : null;
  const cell = (l, v, sub) => (
    <div style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 10px", minWidth: 0 }}>
      <div style={{ fontSize: 9.5, color: "var(--text3)", letterSpacing: "0.08em" }}>{l}</div>
      <div style={{ ...mono, fontSize: 15, fontWeight: 700 }}>{v}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text3)" }}>{sub}</div>}
    </div>
  );
  return (
    <div style={card}>
      <Head date={data.ter_date || null} src={data.ter_date ? "AMFI" : `AMFI · ${MON[+(data.ter_month || "1-").split("-")[0] - 1] || ""} ${(data.ter_month || "").split("-")[1] || ""} TER`} staleDays={45}>COST & SIZE</Head>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        {cell("EXPENSE RATIO", t?.[0] != null ? `${t[0].toFixed(2)}%` : "—", "direct plan / year")}
        {cell("REGULAR PLAN", t?.[1] != null ? `${t[1].toFixed(2)}%` : "—", saved != null ? `${saved.toFixed(2)}% more` : "")}
        {cell("FUND SIZE", aum != null ? cr(aum) : "—", sizeRank ? `#${sizeRank} of ${sizes.length} in category` : "avg AUM")}
      </div>
      {cheaper != null && <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 8 }}>Cheaper than <b style={{ color: cheaper >= 60 ? C.pos : cheaper <= 30 ? C.warn : "var(--text)" }}>{cheaper}%</b> of the {peers.length} direct plans in its category (median {median(peers)?.toFixed(2)}%).{saved != null && saved > 0 ? ` On ₹10 lakh, the direct plan saves about ₹${Math.round(saved * 1e4).toLocaleString("en-IN")} a year vs regular.` : ""}</div>}
      <div style={note}>Expense ratio (TER) is taken from the fund's NAV every day — returns shown are already after it. AUM is the quarterly average for {data.aum_period || "the last quarter"}, all plans together.</div>
    </div>
  );
}

/** Where investors put money: AMFI monthly net inflows by category. */
export function CategoryFlows() {
  const { data, err } = useFundFacts();
  const [g, setG] = useState("Equity");
  const F = data?.flows;
  if (!F) return err ? null : <div style={card}><Head>MONEY FLOWS BY CATEGORY</Head><Loading what="AMFI monthly data" /></div>;
  const grp = F.groups.find((x) => x.name === g) || F.groups[0];
  const L = F.months.length - 1, last6 = F.months.slice(-6);
  const cats = [...grp.cats].sort((a, b) => (b.net[L] ?? -1e9) - (a.net[L] ?? -1e9));
  const span = Math.max(1, ...cats.flatMap((c) => c.net.slice(-6).map((v) => Math.abs(v ?? 0))));
  const tot = (i) => grp.cats.reduce((a, c) => a + (c.net[i] ?? 0), 0);
  const top = cats[0], bot = cats[cats.length - 1];
  const mLabel = (ym) => `${MON[+ym.slice(5) - 1]}`;
  return (
    <div style={card}>
      <Head date={monthEnd(F.months[L])} src="AMFI" staleDays={50}>MONEY FLOWS BY CATEGORY</Head>
      <Chips items={F.groups.filter((x) => x.cats.some((c) => c.net[L] != null)).map((x) => [x.name, x.name])} value={grp.name} onChange={setG} />
      <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: 8, lineHeight: 1.5 }}>In {mLabel(F.months[L])} {F.months[L].slice(0, 4)}, {grp.name.toLowerCase()} funds took a net <b style={{ color: pcol(tot(L)) }}>{cr(tot(L))}</b>{tot(L - 1) ? ` (${cr(tot(L - 1))} the month before)` : ""}. Most money: <b>{top.name}</b> ({cr(top.net[L])}){bot.net[L] < 0 ? <>; biggest outflow: <b>{bot.name}</b> ({cr(bot.net[L])})</> : ""}.</div>
      <div style={{ display: "grid", gridTemplateColumns: `minmax(0,1fr) repeat(${last6.length}, 22px) 60px`, columnGap: 4, rowGap: 3, fontSize: 11, alignItems: "center" }}>
        <span style={{ fontSize: 9, color: "var(--text3)" }}>CATEGORY</span>
        {last6.map((m) => <span key={m} style={{ fontSize: 8.5, color: "var(--text3)", textAlign: "center" }}>{mLabel(m)[0]}</span>)}
        <span style={{ fontSize: 9, color: "var(--text3)", textAlign: "right" }}>{mLabel(F.months[L]).toUpperCase()}</span>
        {cats.map((c) => (
          <Fragment key={c.name}>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={c.name}>{c.name.replace(/ Funds?$/, "")}</span>
            {c.net.slice(-6).map((v, i) => <span key={i} title={v == null ? "category didn't exist under this name" : `${last6[i]}: ${cr(v)}`} style={{ height: 14, display: "flex", alignItems: v != null && v < 0 ? "flex-start" : "flex-end", justifyContent: "center" }}><span style={{ width: 12, height: v == null ? 1 : Math.max(1.5, (Math.abs(v) / span) * 14), background: v == null ? "var(--border)" : v >= 0 ? C.pos : C.neg, borderRadius: 2, opacity: 0.8 }} /></span>)}
            <span style={{ ...mono, textAlign: "right", color: pcol(c.net[L]), fontSize: 10.5 }}>{c.net[L] == null ? "—" : Math.round(c.net[L]).toLocaleString("en-IN")}</span>
          </Fragment>
        ))}
      </div>
      <div style={note}>Net inflow = money in minus money out, ₹ crore, from AMFI's monthly report (open-ended schemes). Bars show the last 6 months. SEBI renamed several categories in 2026, so some have only recent months.</div>
    </div>
  );
}

/** Every fund in the category: 3-year return (up) against volatility (across). */
export function RiskReturnMap({ rows, onOpen, bench }) {
  const [sel, setSel] = useState(null);
  const pts = (rows || []).filter((r) => r.y3 != null && r.vol != null);
  if (pts.length < 5) return null;
  const W = 340, H = 220, P = 26;
  const xs = pts.map((r) => r.vol), ys = pts.map((r) => r.y3);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys, bench?.ret?.y3 ?? Infinity), y1 = Math.max(...ys, bench?.ret?.y3 ?? -Infinity);
  const X = (v) => P + ((v - x0) / (x1 - x0 || 1)) * (W - P - 8), Y = (v) => 8 + (1 - (v - y0) / (y1 - y0 || 1)) * (H - 8 - P);
  const mx = median(xs), my = median(ys);
  const s = sel && pts.find((r) => r.code === sel);
  const best = [...pts].sort((a, b) => (b.y3 - my) / (b.vol || 1) - (a.y3 - my) / (a.vol || 1)).slice(0, 3).map((r) => r.code);
  return (
    <div style={{ ...card, marginTop: 12 }}>
      <Head src="mfapi.in">RISK vs RETURN · {pts.length} FUNDS</Head>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img" aria-label="Scatter of 3-year return against volatility">
        <rect x={P} y="8" width={X(mx) - P} height={Y(my) - 8} fill={C.pos} opacity="0.07" />
        <line x1={X(mx)} x2={X(mx)} y1="8" y2={H - P} stroke="var(--border2)" strokeDasharray="3 3" />
        <line x1={P} x2={W - 8} y1={Y(my)} y2={Y(my)} stroke="var(--border2)" strokeDasharray="3 3" />
        {bench?.ret?.y3 != null && <><line x1={P} x2={W - 8} y1={Y(bench.ret.y3)} y2={Y(bench.ret.y3)} stroke="var(--violet)" strokeWidth="1" opacity="0.7" /><text x={W - 10} y={Y(bench.ret.y3) - 3} fontSize="8" textAnchor="end" fill="var(--violet)">{bench.index} index fund</text></>}
        {pts.map((r) => <circle key={r.code} cx={X(r.vol)} cy={Y(r.y3)} r={r.code === sel ? 5 : best.includes(r.code) ? 4 : 3} fill={r.code === sel ? "var(--text)" : best.includes(r.code) ? C.pos : "var(--text3)"} opacity={r.code === sel ? 1 : 0.75} onClick={() => setSel(r.code)} style={{ cursor: "pointer" }} />)}
        <text x={P + 3} y="18" fontSize="8.5" fill={C.pos} fontWeight="700">higher return, calmer</text>
        <text x={W / 2} y={H - 6} fontSize="9" textAnchor="middle" fill="var(--text3)">volatility → (yearly swings, %)</text>
        <text x="8" y={H / 2} fontSize="9" textAnchor="middle" fill="var(--text3)" transform={`rotate(-90 8 ${H / 2})`}>3Y return / yr →</text>
        {[x0, x1].map((v, i) => <text key={i} x={X(v)} y={H - P + 10} fontSize="8" textAnchor={i ? "end" : "start"} fill="var(--text3)" fontFamily="var(--mono)">{v.toFixed(0)}%</text>)}
        {[y0, y1].map((v, i) => <text key={i} x={P - 3} y={Y(v) + 3} fontSize="8" textAnchor="end" fill="var(--text3)" fontFamily="var(--mono)">{v.toFixed(0)}</text>)}
      </svg>
      {s ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg3)" }}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><b>{s.name}</b></span>
          <span style={{ ...mono, color: pcol(s.y3) }}>{pct(s.y3)}</span><span style={{ ...mono, color: "var(--text3)" }}>vol {s.vol.toFixed(0)}%</span>
          <button className="chip chip-sm" onClick={() => onOpen(s.code)}>Open ›</button>
        </div>
      ) : <div style={{ fontSize: 11.5, color: "var(--text2)" }}>Tap a dot. Green dots: the 3 funds with the most return above the category median per unit of swing.</div>}
      <div style={note}>Dashed lines are the category medians. Top-left (shaded) = more return with less bumpiness than the typical fund over 3 years.</div>
    </div>
  );
}

/** IPO subscription by investor category (QIB / big HNI / retail / employees). */
export function IpoSubscription({ sym, sme }) {
  const [open, setOpen] = useState(false);
  const { data, err } = useJson(open ? `/api/nse?type=ipodetail&symbol=${encodeURIComponent(sym)}&series=${sme ? "SME" : "EQ"}` : null, 15 * 60e3);
  const label = (c) => /qualified/i.test(c) ? "QIBs (institutions)" : /non institutional/i.test(c) ? "HNIs (non-institutional)" : /retail/i.test(c) ? "Retail" : /employee/i.test(c) ? "Employees" : /shareholder/i.test(c) ? "Shareholders" : /total/i.test(c) ? "Total" : c;
  if (!open) return <button className="chip chip-sm" style={{ marginTop: 4 }} onClick={() => setOpen(true)}>Who subscribed ›</button>;
  const cats = data?.cats || [];
  const max = Math.max(1, ...cats.map((c) => c.times || 0));
  return (
    <div style={{ marginTop: 6, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg3)" }}>
      {!data ? (err ? <div style={{ fontSize: 11, color: C.warn }}>Category data not available ({err}).</div> : <Loading what="subscription by category" />) : !cats.length ? <div style={{ fontSize: 11, color: "var(--text3)" }}>NSE hasn't published the category breakdown.</div> : cats.map((c) => (
        <div key={c.cat} style={{ display: "grid", gridTemplateColumns: "120px 1fr 52px", gap: 6, alignItems: "center", fontSize: 11, padding: "2px 0", fontWeight: /total/i.test(c.cat) ? 700 : 400 }}>
          <span>{label(c.cat)}</span>
          <div style={{ height: 8, background: "var(--bg2)", borderRadius: 3, overflow: "hidden" }}><div style={{ height: "100%", width: `${((c.times || 0) / max) * 100}%`, background: (c.times || 0) >= 1 ? C.pos : C.warn }} /></div>
          <span style={{ ...mono, textAlign: "right" }}>{c.times != null ? `${c.times.toFixed(1)}×` : "—"}</span>
        </div>
      ))}
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>Times the shares reserved for each group were bid for. Heavy QIB demand is usually read as the strongest signal.</div>
    </div>
  );
}

/** Your watchlist as an equal-weight index vs the Nifty 500, from the day each stock was added. */
export function WatchIndex({ watchlist, onPickStock }) {
  const syms = (watchlist || []).map((w) => w.sym).filter(Boolean).slice(0, 49);
  const url = syms.length ? `/api/spark?symbols=${encodeURIComponent([...syms.map((s) => s + ".NS"), "^CRSLDX"].join(","))}&range=2y&interval=1d` : null;
  const { data, err } = useJson(url, 30 * 60e3);
  const x = useMemo(() => {
    if (!data) return null;
    const ser = {};
    for (const it of data.spark?.result || []) {
      const r = it.response?.[0], ts = r?.timestamp, cl = r?.indicators?.quote?.[0]?.close; if (!ts || !cl) continue;
      const m = {}; ts.forEach((t, i) => { if (cl[i] != null) m[new Date((t + 19800) * 1000).toISOString().slice(0, 10)] = cl[i]; });
      ser[it.symbol.replace(/\.NS$/, "")] = m;
    }
    const ix = ser["^CRSLDX"]; if (!ix) return null;
    const added = Object.fromEntries((watchlist || []).map((w) => [w.sym, String(w.addedAt || "").slice(0, 10)]));
    const days = Object.keys(ix).sort();
    const start = days.find((d) => syms.some((s) => added[s] && added[s] <= d && ser[s]?.[d] != null));
    if (!start) return null;
    const axis = days.filter((d) => d >= start);
    let w = 100, n = 100;
    const line = [[axis[0], 100, 100]];
    for (let k = 1; k < axis.length; k++) {
      const a = axis[k - 1], b = axis[k];
      const rs = syms.filter((s) => added[s] && added[s] <= a && ser[s]?.[a] && ser[s]?.[b]).map((s) => ser[s][b] / ser[s][a] - 1);
      if (rs.length) w *= 1 + rs.reduce((p, q) => p + q, 0) / rs.length;
      n *= ix[b] / ix[a];
      line.push([b, w, n]);
    }
    const per = syms.map((s) => {
      const d0 = Object.keys(ser[s] || {}).sort().find((d) => d >= (added[s] || "9999")); const d1 = Object.keys(ser[s] || {}).sort().pop();
      if (!d0 || !d1) return null;
      const i0 = Object.keys(ix).sort().find((d) => d >= d0), i1 = Object.keys(ix).sort().pop();
      const r = (ser[s][d1] / ser[s][d0] - 1) * 100, ri = i0 ? (ix[i1] / ix[i0] - 1) * 100 : null;
      return { s, from: d0, r, vs: ri == null ? null : r - ri };
    }).filter(Boolean).sort((a, b) => (b.vs ?? -1e9) - (a.vs ?? -1e9));
    return { line, per, start };
  }, [data]);
  if (!syms.length) return null;
  const W = 340, H = 110;
  return (
    <div style={card}>
      <Head date={x?.line?.[x.line.length - 1]?.[0]} src="Yahoo">YOUR WATCHLIST AS AN INDEX</Head>
      {!x ? (err ? <Fail err={err} /> : <Loading what="watchlist history" />) : (() => {
        const L = x.line, vals = L.flatMap(([, a, b]) => [a, b]), lo = Math.min(...vals), hi = Math.max(...vals);
        const X = (i) => (i / Math.max(1, L.length - 1)) * (W - 40), Y = (v) => 6 + (1 - (v - lo) / (hi - lo || 1)) * (H - 14);
        const path = (k) => L.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p[k]).toFixed(1)}`).join("");
        const last = L[L.length - 1], edge = last[1] - last[2];
        const beat = x.per.filter((p) => p.vs > 0).length;
        return (
          <>
            <div style={{ fontSize: 12.5, color: "var(--text2)", marginBottom: 6, lineHeight: 1.5 }}>Since {fmtDay(x.start)}, an equal-weight basket of your watchlist (each stock counted from the day you added it) is <b style={{ color: pcol(last[1] - 100) }}>{pct(last[1] - 100)}</b> vs <b>{pct(last[2] - 100)}</b> for the Nifty 500 — <b style={{ color: pcol(edge) }}>{edge >= 0 ? "ahead" : "behind"} by {Math.abs(edge).toFixed(1)} pts</b>. {beat} of {x.per.length} picks beat the index since added.</div>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img" aria-label="Watchlist index versus Nifty 500">
              <line x1="0" x2={W - 40} y1={Y(100)} y2={Y(100)} stroke="var(--border)" strokeDasharray="3 3" />
              <path d={path(2)} fill="none" stroke="var(--text3)" strokeWidth="1.3" />
              <path d={path(1)} fill="none" stroke={edge >= 0 ? C.pos : C.neg} strokeWidth="1.8" />
              <text x={W - 36} y={Y(last[1]) + 3} fontSize="9" fill={edge >= 0 ? C.pos : C.neg} fontFamily="var(--mono)">You</text>
              <text x={W - 36} y={Y(last[2]) + 3} fontSize="9" fill="var(--text3)" fontFamily="var(--mono)">N500</text>
            </svg>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 56px 60px 64px", columnGap: 8, rowGap: 2, fontSize: 11.5, marginTop: 8 }}>
              {["STOCK", "ADDED", "SINCE", "VS INDEX"].map((h, i) => <span key={h} style={{ fontSize: 9, color: "var(--text3)", textAlign: i ? "right" : "left" }}>{h}</span>)}
              {x.per.slice(0, 20).map((p) => (
                <Fragment key={p.s}>
                  <SymBtn sym={p.s} onPick={onPickStock} style={{ fontSize: 11.5 }} />
                  <span style={{ textAlign: "right", color: "var(--text3)", fontSize: 10.5 }}>{fmtDay(p.from)}</span>
                  <span style={{ ...mono, textAlign: "right", color: pcol(p.r) }}>{pct(p.r)}</span>
                  <span style={{ ...mono, textAlign: "right", color: pcol(p.vs), fontWeight: 700 }}>{p.vs == null ? "—" : `${p.vs > 0 ? "+" : ""}${p.vs.toFixed(1)}`}</span>
                </Fragment>
              ))}
            </div>
            <div style={note}>Information only: shows whether the stocks you chose to watch went on to beat the market. Stocks you removed aren't counted; price history goes back 2 years.</div>
          </>
        );
      })()}
    </div>
  );
}

/** Today's and recent announcements for your open positions and watchlist. */
export function YourAnnouncements({ symbols, onOpenStock }) {
  const syms = [...new Set(symbols || [])].slice(0, 80).sort();
  const { data, err } = useJson(syms.length ? `/api/nse?type=ann&symbols=${encodeURIComponent(syms.join(","))}` : null, 10 * 60e3);
  if (!syms.length) return null;
  const xs = data?.items || [];
  return (
    <div style={card}>
      <Head date={xs[0]?.dt} src="NSE" staleDays={4}>ANNOUNCEMENTS FOR YOUR STOCKS · 3 DAYS</Head>
      {!data ? (err ? <Fail err={err} /> : <Loading what="announcements" />) : !xs.length ? <div style={{ fontSize: 12, color: "var(--text3)" }}>Nothing filed by your {syms.length} stocks in the last 3 days.</div> : xs.slice(0, 15).map((a, i) => (
        <div key={i} style={{ padding: "6px 0", borderTop: i ? "1px solid var(--border)" : "none" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12 }}>
            <SymBtn sym={a.sym} onPick={onOpenStock} /><span style={{ flex: 1, fontWeight: 600 }}>{a.desc}</span>
            {a.url && <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10.5, color: "var(--text2)" }}>PDF ↗</a>}
          </div>
          {a.text && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2, lineHeight: 1.4 }}>{a.text.replace(/^.*?has informed the Exchange (about|regarding)\s*/i, "")}</div>}
          <div style={{ fontSize: 10, color: "var(--text3)" }}>{a.dt}</div>
        </div>
      ))}
      <div style={note}>Filings to NSE by your open positions and watchlist. Newspaper notices and trading-window notes left out.</div>
    </div>
  );
}
