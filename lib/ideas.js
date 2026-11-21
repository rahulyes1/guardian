// "My ideas" vault — pure logic (no React), shared by the UI and the tests.
// An idea: { id, sym, thesis, lo, hi, stop, target, status, tags, date, updatedAt, triggeredAt? }
//   lo–hi = entry zone (lo may equal hi), long trades only: stop < lo ≤ hi < target.

export const IDEA_STATUSES = ["watching", "triggered", "taken", "dropped"];
export const IDEA_TAGS = ["breakout", "pullback", "results-play"];
export const IDEA_MAX = 1000;
// idea tag → the journal's setup type
export const TAG_SETUP = { breakout: "Breakout", pullback: "Pullback", "results-play": "EP" };

const num = (v) => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const r2 = (x) => Math.round(x * 100) / 100;

/** Entry = middle of the zone. R:R = reward ÷ risk from there. riskPct = % from entry to stop. */
export function ideaMath({ lo, hi, stop, target }) {
  lo = num(lo); hi = num(hi); stop = num(stop); target = num(target);
  if (lo == null || hi == null || stop == null || target == null) return null;
  const entry = (lo + hi) / 2, risk = entry - stop, reward = target - entry;
  if (!(risk > 0) || !(reward > 0)) return null;
  const rTop = hi - stop, rrTop = rTop > 0 && target > hi ? Math.round(((target - hi) / rTop) * 10) / 10 : null;
  return { entry: r2(entry), risk: r2(risk), reward: r2(reward), rr: Math.round((reward / risk) * 10) / 10, riskPct: Math.round((risk / entry) * 1000) / 10, rrTop };
}

/** Returns a list of problems with the form values (empty = valid). */
export function validateIdea(f) {
  const errs = [];
  const sym = String(f.sym || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9&-]{0,19}$/.test(sym)) errs.push("Enter an NSE symbol, like MCX");
  const lo = num(f.lo), hi = num(f.hi ?? f.lo), stop = num(f.stop), target = num(f.target);
  if (lo == null || !(lo > 0)) errs.push("Enter the entry price");
  if (hi != null && lo != null && hi < lo) errs.push("Entry 'to' must be at or above entry 'from'");
  if (stop == null || !(stop > 0)) errs.push("Enter the stop loss");
  else if (lo != null && stop >= lo) errs.push("Stop loss must be below the entry zone");
  if (target == null || !(target > 0)) errs.push("Enter the target");
  else if (hi != null && target <= hi) errs.push("Target must be above the entry zone");
  return errs;
}

/** Non-blocking typo check: levels that are possible but very unusual for a swing trade. */
export function ideaWarnings({ lo, hi, stop, target }) {
  lo = num(lo); hi = num(hi) ?? lo; stop = num(stop); target = num(target);
  const w = [];
  if (lo > 0 && hi > 0 && hi > lo * 1.2) w.push("The entry zone is over 20% wide");
  if (lo > 0 && stop > 0 && stop < lo * 0.7) w.push("The stop is more than 30% below the entry");
  if (hi > 0 && target > 0 && target > hi * 3) w.push("The target is more than 3× the entry");
  return w;
}

/** Clean a stored idea (drops anything malformed). */
export function normalizeIdea(x) {
  if (!x || typeof x !== "object") return null;
  const sym = String(x.sym || "").trim().toUpperCase();
  const lo = num(x.lo), hi = num(x.hi) ?? lo, stop = num(x.stop), target = num(x.target);
  if (!sym || lo == null || stop == null || target == null) return null;
  return {
    id: String(x.id || `${sym}-${lo}-${hi ?? lo}-${stop}-${target}-${Date.parse(x.date) || 0}`),
    sym, thesis: String(x.thesis || "").slice(0, 240),
    lo, hi: Math.max(lo, hi), stop, target,
    status: IDEA_STATUSES.includes(x.status) ? x.status : "watching",
    tags: Array.isArray(x.tags) ? [...new Set(x.tags.filter((t) => IDEA_TAGS.includes(t)))] : [],
    date: typeof x.date === "string" ? x.date : new Date().toISOString(),
    updatedAt: typeof x.updatedAt === "string" ? x.updatedAt : null,
    triggeredAt: typeof x.triggeredAt === "string" ? x.triggeredAt : null,
  };
}

/** Where the price sits relative to the idea: in the zone, above / below it, or through the stop. */
export function zoneState(idea, price) {
  if (!(price > 0)) return { where: "unknown", text: "No price yet" };
  const pct = (a, b) => Math.round(((a - b) / b) * 1000) / 10;
  if (price <= idea.stop) return { where: "stopped", text: `At or below the stop (${pct(price, idea.stop)}%)` };
  if (price >= idea.lo && price <= idea.hi) return { where: "in", text: "In the entry zone" };
  if (price > idea.hi) return { where: "above", text: `${pct(price, idea.hi)}% above the zone` };
  return { where: "below", text: `${Math.abs(pct(price, idea.lo))}% below the zone` };
}

/** Ideas that should flip from watching to triggered given today's prices ({ SYM: price }). */
export function newlyTriggered(ideas, prices, isFresh = () => true) {
  return (ideas || []).filter((i) => i.status === "watching" && isFresh(i.sym) && zoneState(i, prices?.[i.sym]).where === "in").map((i) => i.id);
}

/** True when a quote's timestamp falls on today's date in India (a Friday close seen on Saturday is not fresh). */
export function quoteIsToday(asOf, now = Date.now()) {
  const t = Date.parse(asOf || "");
  if (!Number.isFinite(t)) return false;
  const ist = (ms) => new Date(ms + 19800000).toISOString().slice(0, 10);
  return ist(t) === ist(now);
}
