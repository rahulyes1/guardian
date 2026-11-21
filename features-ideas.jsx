// "My ideas" vault: your own trade ideas with entry zone, stop, target, auto R:R and status;
// a TODAY card for ideas sitting in their entry zone; "Convert to trade" pre-fills Plan a trade.
import { useState, useEffect, useMemo, Fragment } from "react";
import { C, card, head, note, mono, fmtDay } from "./features.jsx";
import { IDEA_STATUSES, IDEA_TAGS, IDEA_MAX, TAG_SETUP, ideaMath, ideaWarnings, validateIdea, normalizeIdea, zoneState, newlyTriggered, quoteIsToday } from "./lib/ideas.js";

const STATUS = {
  watching: { label: "Watching", col: "#60A5FA" },
  triggered: { label: "Triggered", col: C.pos },
  taken: { label: "Taken", col: C.lime },
  dropped: { label: "Dropped", col: C.muted },
};
const WHERE_COL = { in: C.pos, above: C.warn, below: "var(--text3)", stopped: C.neg, unknown: "var(--text3)" };
const fmtP = (v) => (v == null ? "—" : v >= 1000 ? Math.round(v).toLocaleString("en-IN") : (+v).toFixed(v >= 100 ? 1 : 2).replace(/\.0+$/, ""));

/** Latest prices for the ideas' stocks (refreshed every 2 minutes while shown). */
function useIdeaPrices(symbols, getPrices) {
  const key = [...new Set(symbols)].sort().join(",");
  const [prices, setPrices] = useState({});
  const [asOf, setAsOf] = useState({});
  useEffect(() => {
    if (!key || !getPrices) return;
    let alive = true;
    const load = () => getPrices(key.split(",")).then((q) => {
      if (!alive || !q) return;
      const out = {}, when = {};
      for (const [s, v] of Object.entries(q)) if (v?.price > 0) { out[s] = v.price; when[s] = v.asOf || null; }
      setPrices((p) => ({ ...p, ...out }));
      setAsOf((p) => ({ ...p, ...when }));
    }).catch(() => {});
    load();
    const t = setInterval(load, 120000);
    return () => { alive = false; clearInterval(t); };
  }, [key]);
  return { prices, asOf };
}
const priceDay = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? fmtDay(new Date(t + 19800000).toISOString().slice(0, 10)) : null; };

/** Flip watching → triggered when the price enters the zone (saved, so it survives a refresh). */
function useAutoTrigger(ideas, setIdeas, prices, asOf) {
  useEffect(() => {
    const ids = newlyTriggered(ideas, prices, (sym) => quoteIsToday(asOf?.[sym])); // a stale close (e.g. Friday's, seen on Saturday) never triggers
    if (!ids.length) return;
    const now = new Date().toISOString();
    setIdeas((xs) => xs.map((x) => (ids.includes(x.id) && x.status === "watching" ? { ...x, status: "triggered", triggeredAt: now, updatedAt: now } : x)));
  }, [prices, asOf, ideas.map((i) => `${i.id}:${i.status}:${i.lo}:${i.hi}`).join("|")]); // re-check when a zone is edited too
}

function IdeaForm({ initial, portfolio, riskPct, sizeFor, onSave, onCancel }) {
  const [f, setF] = useState(() => initial ? { ...initial, lo: String(initial.lo), hi: String(initial.hi), stop: String(initial.stop), target: String(initial.target) }
    : { sym: "", thesis: "", lo: "", hi: "", stop: "", target: "", tags: [], status: "watching" });
  const [tried, setTried] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const vals = { ...f, hi: f.hi === "" ? f.lo : f.hi };
  const errs = validateIdea(vals);
  const m = errs.length ? null : ideaMath(vals);
  const topEntry = m ? +(vals.hi || vals.lo) : null;
  const size = m && sizeFor ? sizeFor({ entry: topEntry, stop: +f.stop }, portfolio, riskPct) : null;
  const save = () => {
    setTried(true);
    if (errs.length) return;
    const now = new Date().toISOString();
    // a changed zone must be re-checked: Triggered goes back to Watching
    const zoneMoved = initial && (+vals.lo !== initial.lo || +(vals.hi || vals.lo) !== initial.hi);
    const reset = zoneMoved && initial.status === "triggered" ? { status: "watching", triggeredAt: null } : {};
    onSave(normalizeIdea({ ...vals, ...reset, id: initial?.id || `${vals.sym.trim().toUpperCase()}-${Date.now()}`, date: initial?.date || now, updatedAt: now }));
  };
  const box = { width: "100%", marginTop: 3 };
  const lab = { fontSize: 11, color: "var(--text3)" };
  return (
    <div style={{ ...card, border: `1px solid ${C.pos}55` }}>
      <div style={{ ...head, marginBottom: 8 }}>{initial ? `EDIT IDEA · ${initial.sym}` : "NEW IDEA"}</div>
      <label style={lab}>Stock (NSE symbol)<input value={f.sym} onChange={(e) => setF((x) => ({ ...x, sym: e.target.value.toUpperCase() }))} placeholder="MCX" autoCapitalize="characters" style={box} disabled={!!initial} /></label>
      <label style={{ ...lab, display: "block", marginTop: 8 }}>Thesis (1–2 lines)
        <textarea value={f.thesis} onChange={set("thesis")} rows={2} maxLength={240} placeholder="Why this, why now" style={{ ...box, resize: "vertical", font: "inherit", fontSize: 13 }} />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
        <label style={lab}>Entry from ₹<input type="number" inputMode="decimal" value={f.lo} onChange={set("lo")} style={box} /></label>
        <label style={lab}>Entry to ₹ <span style={{ opacity: 0.7 }}>(optional)</span><input type="number" inputMode="decimal" value={f.hi} onChange={set("hi")} placeholder={f.lo || ""} style={box} /></label>
        <label style={lab}>Stop loss ₹<input type="number" inputMode="decimal" value={f.stop} onChange={set("stop")} style={box} /></label>
        <label style={lab}>Target ₹<input type="number" inputMode="decimal" value={f.target} onChange={set("target")} style={box} /></label>
      </div>
      <div style={{ ...mono, fontSize: 12, marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border)", lineHeight: 1.6 }}>
        {m ? <>R:R <b style={{ color: m.rr >= 2 ? C.pos : m.rr >= 1 ? C.warn : C.neg }}>{m.rr}</b> from mid-zone ₹{fmtP(m.entry)}{m.rrTop != null && m.rrTop !== m.rr ? <> · {m.rrTop} if filled at the top</> : ""} · risk {m.riskPct}%<br />
          {size ? <>Size at today's {riskPct}% rule, buying at the top of the zone: <b>{size.qty} sh</b> ≈ ₹{Math.round(size.value).toLocaleString("en-IN")}</> : riskPct == null ? "Size shows once today's market data loads" : riskPct === 0 ? "Market rules say no new entries today" : "One share risks more than today's risk budget"}</>
          : <span style={{ color: "var(--text3)" }}>Fill in entry, stop and target to see risk:reward.</span>}
      </div>
      <div style={{ ...lab, marginTop: 10 }}>Tags</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
        {IDEA_TAGS.map((t) => { const on = f.tags.includes(t); return <button key={t} className="chip chip-sm" aria-pressed={on} onClick={() => setF((x) => ({ ...x, tags: on ? x.tags.filter((y) => y !== t) : [...x.tags, t] }))} style={on ? { borderColor: "var(--text)", color: "var(--text)" } : {}}>{t}</button>; })}
      </div>
      {!errs.length && ideaWarnings(vals).length > 0 && <div style={{ fontSize: 11.5, color: C.warn, marginTop: 8 }}>Check for a typo: {ideaWarnings(vals).join("; ").toLowerCase()}. You can still save it.</div>}
      {tried && errs.length > 0 && <div role="alert" style={{ fontSize: 12, color: C.neg, marginTop: 8 }}>{errs[0]}.</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn-primary" style={{ flex: 1 }} onClick={save}>{initial ? "Save changes" : "Save idea"}</button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function IdeaCard({ idea, price, priceAsOf, portfolio, riskPct, sizeFor, onEdit, onStatus, onDelete, onConvert, onOpenStock }) {
  const m = ideaMath(idea), z = zoneState(idea, price), st = STATUS[idea.status];
  const size = m && sizeFor ? sizeFor({ entry: idea.hi, stop: idea.stop }, portfolio, riskPct) : null; // sized where Convert enters
  const stale = price > 0 && !quoteIsToday(priceAsOf);
  const [converted, setConverted] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const active = idea.status === "watching" || idea.status === "triggered";
  return (
    <div style={{ ...card, marginBottom: 10, borderColor: active && z.where === "in" ? `${C.pos}88` : "var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={() => onOpenStock?.(idea.sym)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", fontFamily: "var(--display)", fontWeight: 700, fontSize: 15, textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{idea.sym}</button>
        {price > 0 && <span style={{ ...mono, fontSize: 12, color: "var(--text2)" }}>₹{fmtP(price)}{stale && priceDay(priceAsOf) ? <span style={{ fontSize: 10.5, color: "var(--text3)" }}> · {priceDay(priceAsOf)} close</span> : ""}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, fontWeight: 700, color: st.col, border: `1px solid ${st.col}66`, borderRadius: 6, padding: "1px 7px" }}>{st.label}</span>
      </div>
      {idea.thesis && <div style={{ fontSize: 12.5, color: "var(--text2)", marginTop: 5, lineHeight: 1.45 }}>{idea.thesis}</div>}
      <div style={{ ...mono, fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>
        Entry ₹{fmtP(idea.lo)}{idea.hi !== idea.lo ? `–${fmtP(idea.hi)}` : ""} · SL ₹{fmtP(idea.stop)} · T ₹{fmtP(idea.target)}<br />
        R:R <b style={{ color: m?.rr >= 2 ? C.pos : m?.rr >= 1 ? C.warn : C.neg }}>{m?.rr ?? "—"}</b>{m?.rrTop != null && m.rrTop !== m.rr ? ` (${m.rrTop} at top)` : ""} · risk {m?.riskPct ?? "—"}%{size ? ` · ${size.qty} sh ≈ ₹${Math.round(size.value).toLocaleString("en-IN")}` : ""}
      </div>
      {active && <div style={{ fontSize: 11.5, marginTop: 4, color: WHERE_COL[z.where] }}>{z.where === "stopped" ? "Price is through your stop — the idea is broken. Drop it or edit the levels." : z.text}{stale && z.where !== "unknown" ? " (last close)" : ""}</div>}
      {converted && idea.status !== "taken" && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>Opened in Plan a trade — this idea becomes Taken when you save the trade to your journal.</div>}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        {idea.tags.map((t) => <span key={t} style={{ fontSize: 10.5, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: 6, padding: "0 6px" }}>{t}</span>)}
        <span style={{ fontSize: 10.5, color: "var(--text3)" }}>{fmtDay(idea.date)}</span>
        <span style={{ flex: 1 }} />
        {idea.status !== "taken" && idea.status !== "dropped" && z.where !== "stopped" && <button className="btn-primary" style={{ padding: "5px 10px", fontSize: 11.5, borderRadius: 8 }} onClick={() => { setConverted(true); onConvert(idea); }}>Convert to trade</button>}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
        <select value={idea.status} onChange={(e) => onStatus(idea, e.target.value)} aria-label={`Status of ${idea.sym}`} style={{ fontSize: 12, padding: "3px 6px" }}>
          {IDEA_STATUSES.map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <button className="chip chip-sm" onClick={() => onEdit(idea)}>Edit</button>
        {confirmDel ? <><button className="chip chip-sm" style={{ color: C.neg, borderColor: `${C.neg}88` }} onClick={() => onDelete(idea)}>Delete for good</button><button className="chip chip-sm" onClick={() => setConfirmDel(false)}>Keep</button></>
          : <button className="chip chip-sm" onClick={() => setConfirmDel(true)}>Delete</button>}
      </div>
    </div>
  );
}

/** STOCKS › My ideas */
export function MyIdeasPage({ ideas, setIdeas, portfolio, riskPct, sizeFor, getPrices, onPlan, onOpenStock }) {
  const [editing, setEditing] = useState(null); // null | "new" | idea
  const [filter, setFilter] = useState(() => { try { return localStorage.getItem("td_ideas_filter") || "active"; } catch (_) { return "active"; } });
  const pick = (k) => { setFilter(k); try { localStorage.setItem("td_ideas_filter", k); } catch (_) {} };
  const { prices, asOf } = useIdeaPrices(ideas.filter((i) => i.status === "watching" || i.status === "triggered").map((i) => i.sym), getPrices);
  useAutoTrigger(ideas, setIdeas, prices, asOf);
  const full = ideas.length >= IDEA_MAX;
  const count = (s) => ideas.filter((i) => i.status === s).length;
  const rank = { in: 0, above: 1, below: 2, unknown: 3, stopped: 4 };
  const shown = ideas.filter((i) => (filter === "active" ? i.status === "watching" || i.status === "triggered" : i.status === filter))
    .sort((a, b) => (rank[zoneState(a, prices[a.sym]).where] - rank[zoneState(b, prices[b.sym]).where]) || (b.date > a.date ? 1 : -1));
  const save = (idea) => { setIdeas((xs) => (xs.some((x) => x.id === idea.id) ? xs.map((x) => (x.id === idea.id ? idea : x)) : [idea, ...xs])); setEditing(null); };
  const setStatus = (idea, status) => { const now = new Date().toISOString(); setIdeas((xs) => xs.map((x) => (x.id === idea.id ? { ...x, status, updatedAt: now, triggeredAt: status === "triggered" ? x.triggeredAt || now : x.triggeredAt } : x))); };
  // opens Plan a trade; the idea becomes Taken only when the trade is saved (see App)
  const convert = (idea) => onPlan?.({ symbol: idea.sym, entry: idea.hi, stop: idea.stop, target: idea.target, ideaId: idea.id,
    setupType: TAG_SETUP[idea.tags.find((t) => TAG_SETUP[t])] || undefined, notes: idea.thesis ? `Idea: ${idea.thesis}` : undefined });
  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div className="section-title" style={{ flex: 1 }}>My ideas</div>
        {editing !== "new" && !full && <button className="btn-primary" style={{ padding: "7px 12px", fontSize: 12, borderRadius: 10 }} onClick={() => { setEditing("new"); window.scrollTo(0, 0); }}>+ Add idea</button>}
      </div>
      <div style={{ fontSize: 13, color: "var(--text3)", margin: "0 0 12px" }}>Your own trade ideas — saved on this phone and backed up with your trades.</div>
      {full && <div style={{ fontSize: 12, color: C.warn, marginBottom: 10 }}>You have {IDEA_MAX} ideas, the most the vault holds. Delete some dropped or taken ones to add more.</div>}
      {editing && <IdeaForm key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? null : editing} portfolio={portfolio} riskPct={riskPct} sizeFor={sizeFor} onSave={save} onCancel={() => setEditing(null)} />}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {[["active", `Active ${count("watching") + count("triggered")}`], ["triggered", `Triggered ${count("triggered")}`], ["taken", `Taken ${count("taken")}`], ["dropped", `Dropped ${count("dropped")}`]].map(([k, l]) => (
          <button key={k} className="chip chip-sm" aria-pressed={filter === k} onClick={() => pick(k)} style={filter === k ? { borderColor: "var(--text)", color: "var(--text)" } : {}}>{l}</button>
        ))}
      </div>
      {!ideas.length && !editing ? (
        <div className="card" style={{ textAlign: "center", padding: "24px 16px" }}>
          <div style={{ fontSize: 14, color: "var(--text2)", marginBottom: 4 }}>Start your ideas vault</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 12 }}>Write down a stock, why you like it, and the entry, stop and target. TODAY flags it when the price reaches your zone.</div>
          <button className="btn-primary" onClick={() => setEditing("new")}>Add your first idea</button>
        </div>
      ) : !shown.length ? <div style={{ fontSize: 12, color: "var(--text3)", padding: "8px 0" }}>Nothing here.</div>
        : shown.map((i) => <IdeaCard key={i.id} idea={i} price={prices[i.sym]} priceAsOf={asOf[i.sym]} portfolio={portfolio} riskPct={riskPct} sizeFor={sizeFor}
            onEdit={(x) => { setEditing(x); window.scrollTo(0, 0); }} onStatus={setStatus} onDelete={(x) => setIdeas((xs) => xs.filter((y) => y.id !== x.id))} onConvert={convert} onOpenStock={onOpenStock} />)}
      <div style={note}>R:R is measured from the middle of your entry zone; share size assumes you buy at the top of it (where Convert to trade enters). Watching ideas switch to Triggered when today's price enters the zone. Prices refresh every 2 minutes while this page is open. Information only — your plan, your call.</div>
    </div>
  );
}

/** Morning brief: your active ideas in or within 2% of their entry zone, at the last price. */
export function MorningIdeas({ ideas, getPrices, onOpenStock }) {
  const active = ideas.filter((i) => i.status === "watching" || i.status === "triggered");
  const { prices } = useIdeaPrices(active.map((i) => i.sym), getPrices);
  if (!active.length) return null;
  const rows = active.map((i) => ({ i, p: prices[i.sym], z: zoneState(i, prices[i.sym]) }))
    .filter(({ i, p, z }) => z.where === "in" || (z.where === "above" && p <= i.hi * 1.02) || (z.where === "below" && p >= i.lo * 0.98));
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.08em" }}>YOUR IDEAS NEAR ENTRY</div>
      {rows.length ? rows.slice(0, 5).map(({ i, p, z }) => (
        <div key={i.id} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12, padding: "3px 0", borderTop: "1px solid var(--border)" }}>
          <button onClick={() => onOpenStock?.(i.sym)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", fontWeight: 700, font: "inherit" }}>{i.sym}</button>
          <span style={{ ...mono, color: "var(--text2)" }}>₹{fmtP(p)}</span>
          <span style={{ flex: 1, ...mono, color: "var(--text3)", fontSize: 11 }}>zone ₹{fmtP(i.lo)}{i.hi !== i.lo ? `–${fmtP(i.hi)}` : ""}</span>
          <span style={{ fontSize: 11, color: z.where === "in" ? C.pos : C.warn }}>{z.where === "in" ? "in zone" : z.text.replace(" the zone", "")}</span>
        </div>
      )) : <div style={{ fontSize: 11.5, color: "var(--text3)", padding: "3px 0" }}>{Object.keys(prices).length ? `None of your ${active.length} active idea${active.length > 1 ? "s is" : " is"} within 2% of its zone.` : "Checking prices…"}</div>}
    </div>
  );
}

/** TODAY: ideas whose price is in the entry zone right now (in-app only, no notifications). */
export function TodayIdeasCard({ ideas, setIdeas, getPrices, onOpenIdeas, onOpenStock }) {
  const active = ideas.filter((i) => i.status === "watching" || i.status === "triggered");
  const { prices, asOf } = useIdeaPrices(active.map((i) => i.sym), getPrices);
  useAutoTrigger(ideas, setIdeas, prices, asOf);
  if (!active.length) return null;
  const inZone = active.filter((i) => zoneState(i, prices[i.sym]).where === "in");
  const near = active.filter((i) => { const z = zoneState(i, prices[i.sym]); return z.where === "above" && prices[i.sym] <= i.hi * 1.02; });
  return (
    <div className="card" style={{ marginBottom: 14, paddingTop: 12, borderColor: inZone.length ? `${C.pos}88` : "var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="label" style={{ flex: 1 }}>My ideas</div>
        {inZone.length > 0 && <span style={{ fontSize: 10.5, fontWeight: 700, color: C.pos, border: `1px solid ${C.pos}66`, borderRadius: 6, padding: "1px 7px" }}>{inZone.length} in entry zone</span>}
        <button className="chip" style={{ fontSize: 10 }} onClick={onOpenIdeas}>All ›</button>
      </div>
      {inZone.length || near.length ? [...inZone, ...near].slice(0, 5).map((i) => (
        <div key={i.id} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12, padding: "5px 0", borderTop: "1px solid var(--border)", marginTop: 4 }}>
          <button onClick={() => onOpenStock?.(i.sym)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", fontWeight: 700, font: "inherit" }}>{i.sym}</button>
          <span style={{ ...mono, color: "var(--text2)" }}>₹{fmtP(prices[i.sym])}</span>
          <span style={{ flex: 1, ...mono, color: "var(--text3)", fontSize: 11 }}>zone ₹{fmtP(i.lo)}{i.hi !== i.lo ? `–${fmtP(i.hi)}` : ""}</span>
          <span style={{ fontSize: 11, color: inZone.includes(i) ? C.pos : C.warn }}>{inZone.includes(i) ? "in zone" : "near"}</span>
        </div>
      )) : <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>{Object.keys(prices).length ? `None of your ${active.length} active idea${active.length > 1 ? "s are" : " is"} at its entry zone yet.` : "Checking prices…"}</div>}
    </div>
  );
}
