import { useState, useEffect, useRef, Fragment, Component } from "react";
import { getSupabaseClient } from "./supabaseClient.js";
import {
  MQ_SIGNALS, loadMarketQuadrant, getLastMarketQuadrant, subscribeProgress, signalOnDate, configureSharedStore,
  FT_BANDS, FT_CALIBRATION, smaSeries, historyOnDate, istDayKey, fetchResultsCalendar, upcomingResults, loadMicrocapScans,
  rsScore, rsRating, gradeSetup, tradePlan,
} from "./marketQuadrant.js";
import { INDEX_KEYS, reconcileIndex } from "./lib/marketChecks.js";
import { parseTradebook, buildTrades } from "./lib/tradeImport.js";
import { useSyncedAppState } from "./appStateSync.js";
// ─── THEME & CONSTANTS ───────────────────────────────────────────────────────
// Light/dark: accents are picked per theme for contrast (vivid on dark, deeper on light).
// Switching theme reloads the page so every colour is recomputed.
const THEME = (() => { try { return localStorage.getItem("td_theme") === "light" ? "light" : "dark"; } catch (_) { return "dark"; } })();
if (typeof document !== "undefined") document.documentElement.dataset.theme = THEME;
const C = THEME === "light"
  ? { pos: "#15803D", neg: "#C8102E", warn: "#B45309", lime: "#4D7C0F", muted: "#6E685C" }
  : { pos: "#4ADE80", neg: "#DC143C", warn: "#F59E0B", lime: "#A3E635", muted: "#A39C89" };
const REGIME_CONFIG = {
  bull:     { label: "BULL", color: C.pos, glow: "0 0 0 rgba(0,0,0,0)", bg: "rgba(74,222,128,0.06)", text: "Trend is constructive. Stay selective, press clean strength, and let quality setups do the work." },
  bear:     { label: "BEAR", color: C.neg, glow: "0 0 0 rgba(0,0,0,0)", bg: "rgba(220,20,60,0.06)", text: "Flames consume the careless. Stay defensive. Only high-conviction cuts through the smoke." },
  sideways: { label: "SIDEWAYS", color: "#2DD4BF", glow: "0 0 0 rgba(0,0,0,0)", bg: "rgba(45,212,191,0.06)", text: "Range-bound conditions. Stay patient, stay light, and wait for decisive expansion before committing." },
};

const THEME_TOKENS = {
  selectorInactiveBorder: "#2A2A2A",
  selectorInactiveText: C.muted,
  portfolioValue: "#D4CCB6",
  openRiskValue: "#D4CCB6",
  heatNeutral: "var(--text)",
  heatWarm: C.warn,
  heatHot: C.neg,
};

const SETUP_TYPES = ["Breakout", "Pullback", "U&R", "Range Break", "Momentum", "EP", "IPO base", "Coiling"];
const SEARCH_API_DEBOUNCE_MS = 300;
const SEARCH_RESULT_LIMIT = 10;
const LIVE_REFRESH_INTERVAL_MS = 15000;
const CLOSED_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const PRICE_CACHE_TTL_MS = 15000;
const NIFTY_CACHE_KEY = "td_nifty_strip_cache_v3"; // v3: values carry source/verified (v2 could hold a wrong % change)
const LOCAL_SYMBOLS_URL = "/nse_symbols.min.json";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MARKET_OPEN_MINUTES = 9 * 60 + 15;
const MARKET_CLOSE_MINUTES = 15 * 60 + 30;
const SEARCH_API_TIMEOUT_MS = 9000;
const QUOTES_API_TIMEOUT_MS = 10000;
const INDICES_API_TIMEOUT_MS = 10000;
const LOCAL_SYMBOLS_TIMEOUT_MS = 1800;
const QUOTE_FALLBACK_TIMEOUT_MS = 3000;
const SUGGESTION_PRICE_REFRESH_MS = 8000;
const SELECTED_SYMBOL_REFRESH_MS = 15000;
const YAHOO_RETRY_ATTEMPTS = 2;
const LIVE_SOURCE_POLICY = "hybrid_api_first"; // browser_yahoo_only | hybrid_api_first

function formatINR(val) {
  if (!val && val !== 0) return "—";
  const n = Number(val);
  if (isNaN(n)) return "—";
  const sg = n < 0 ? "−" : "", a = Math.abs(n);
  if (a >= 10000000) return `${sg}₹${(a / 10000000).toFixed(2)}Cr`;
  if (a >= 100000) return `${sg}₹${(a / 100000).toFixed(2)}L`;
  return `${sg}₹${a.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function pct(a, b) {
  if (!b || b === 0) return null;
  return ((a / b) * 100).toFixed(2);
}

function getHeatColor(heat) {
  const value = Number(heat);
  if (value > 10) return THEME_TOKENS.heatHot;
  if (value >= 5) return THEME_TOKENS.heatWarm;
  return THEME_TOKENS.heatNeutral;
}

let _localSymbols = null;
let _localSymbolsPromise = null;

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase().replace(/\.NS$/i, "");
}

function getIstNow() {
  const now = new Date();
  return new Date(now.getTime() + now.getTimezoneOffset() * 60000 + IST_OFFSET_MS);
}

function isMarketOpenAt(istDate) {
  const day = istDate.getDay();
  if (day === 0 || day === 6) return false;
  const mins = istDate.getHours() * 60 + istDate.getMinutes();
  return mins >= MARKET_OPEN_MINUTES && mins <= MARKET_CLOSE_MINUTES;
}

function isMarketOpen() {
  return isMarketOpenAt(getIstNow());
}

function getNextOpenIstDate(baseIst) {
  const next = new Date(baseIst);
  next.setSeconds(0, 0);
  while (true) {
    const day = next.getDay();
    const mins = next.getHours() * 60 + next.getMinutes();
    if (day === 0) {
      next.setDate(next.getDate() + 1);
      next.setHours(9, 15, 0, 0);
      continue;
    }
    if (day === 6) {
      next.setDate(next.getDate() + 2);
      next.setHours(9, 15, 0, 0);
      continue;
    }
    if (mins < MARKET_OPEN_MINUTES) {
      next.setHours(9, 15, 0, 0);
      return next;
    }
    if (mins > MARKET_CLOSE_MINUTES) {
      next.setDate(next.getDate() + 1);
      next.setHours(9, 15, 0, 0);
      continue;
    }
    return next;
  }
}

function getRefreshDelayMs(openMs = LIVE_REFRESH_INTERVAL_MS, closedMs = CLOSED_REFRESH_INTERVAL_MS) {
  const nowIst = getIstNow();
  if (isMarketOpenAt(nowIst)) return openMs;
  const nextOpen = getNextOpenIstDate(nowIst);
  const untilNextOpen = Math.max(5000, nextOpen.getTime() - nowIst.getTime());
  return Math.min(closedMs, untilNextOpen);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = QUOTES_API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── YAHOO FINANCE ───────────────────────────────────────────────────────────
const _priceCache = new Map(); // ticker → { result, ts }

function parseQuoteFromApi(symbol, rawQuote) {
  if (!rawQuote || typeof rawQuote !== "object") return null;
  if (!Number.isFinite(rawQuote.price)) return null;
  return {
    price: rawQuote.price,
    name: rawQuote.name || symbol,
    changePct: Number.isFinite(rawQuote.change_pct) ? rawQuote.change_pct : null,
    asOf: rawQuote.asOf || null,
    issues: rawQuote.issues || [],
  };
}

async function fetchQuoteFromNode(symbol) {
  // Fast Node.js /api/quote endpoint — same pattern as TRADR, no Python cold-start
  const data = await fetchJsonWithTimeout(
    `/api/quote?symbol=${encodeURIComponent(symbol)}`,
    { headers: { Accept: "application/json" } },
    QUOTES_API_TIMEOUT_MS,
  );
  if (!data || data.price == null) return null;
  return {
    price: data.price,
    prevClose: data.prevClose ?? null,
    name: symbol,
    change_pct: Number.isFinite(data.changePct) ? data.changePct : null, // null = unknown, never a fake 0
    asOf: data.asOf || null,
    issues: Array.isArray(data.issues) ? data.issues : [],
  };
}

async function fetchQuotesFromApi(symbols) {
  if (LIVE_SOURCE_POLICY === "browser_yahoo_only") return {};
  const unique = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
  if (unique.length === 0) return {};
  // Call /api/quote for each symbol in parallel (same pattern as TRADR)
  const pairs = await Promise.all(
    unique.map(async (sym) => [sym, await fetchQuoteFromNode(sym)])
  );
  const out = {};
  pairs.forEach(([sym, result]) => { if (result) out[sym] = result; });
  return out;
}

async function fetchStockPrice(symbol, options = {}) {
  const { force = false, skipApi = false } = options;
  const normalized = normalizeSymbol(symbol);
  if (!normalized || (normalized.length < 2 && !normalized.startsWith("^"))) return null;

  const cached = _priceCache.get(normalized);
  if (!force && cached && Date.now() - cached.ts < PRICE_CACHE_TTL_MS) return cached.result;

  if (!skipApi) {
    const apiQuotes = await fetchQuotesFromApi([normalized]);
    const fromApi = parseQuoteFromApi(normalized, apiQuotes[normalized]);
    if (fromApi) {
      _priceCache.set(normalized, { result: fromApi, ts: Date.now() });
      return fromApi;
    }
  }

  const ticker = normalized.startsWith("^") || /\./.test(normalized) ? normalized : `${normalized}.NS`;
  const yUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`;
  const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(yUrl)}`;
  const proxy2 = `https://api.allorigins.win/raw?url=${encodeURIComponent(yUrl)}`;
  const urls = [proxyUrl, proxy2, yUrl];

  for (let attempt = 0; attempt < YAHOO_RETRY_ATTEMPTS; attempt += 1) {
    for (const url of urls) {
      const data = await fetchJsonWithTimeout(
        url,
        { headers: { Accept: "application/json" } },
        QUOTE_FALLBACK_TIMEOUT_MS,
      );
      const q = data?.quoteResponse?.result?.[0];
      if (q && Number.isFinite(q.regularMarketPrice)) {
        const result = {
          price: q.regularMarketPrice,
          name: q.shortName || q.longName || normalized,
          changePct: Number.isFinite(q.regularMarketChangePercent) ? q.regularMarketChangePercent : 0,
          isEod: false,
        };
        _priceCache.set(normalized, { result, ts: Date.now() });
        return result;
      }
    }
    if (attempt < YAHOO_RETRY_ATTEMPTS - 1) {
      await waitMs(120 * (attempt + 1));
    }
  }
  // Live fetch failed — fall back to stale cache entry so the UI always shows something
  const staleEntry = _priceCache.get(normalized);
  if (staleEntry?.result) return { ...staleEntry.result, isEod: true };
  return null;
}

async function fetchQuotes(symbols, options = {}) {
  const { force = false } = options;
  const unique = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
  if (unique.length === 0) return {};

  const results = {};
  const missing = [];
  unique.forEach((symbol) => {
    const cached = _priceCache.get(symbol);
    if (!force && cached && Date.now() - cached.ts < PRICE_CACHE_TTL_MS) {
      results[symbol] = cached.result;
    } else {
      missing.push(symbol);
    }
  });

  if (missing.length > 0) {
    const apiQuotes = await fetchQuotesFromApi(missing);
    const unresolved = [];
    missing.forEach((symbol) => {
      const parsed = parseQuoteFromApi(symbol, apiQuotes[symbol]);
      if (parsed) {
        results[symbol] = parsed;
        _priceCache.set(symbol, { result: parsed, ts: Date.now() });
      } else {
        unresolved.push(symbol);
      }
    });

    if (unresolved.length > 0) {
      const fetched = await Promise.all(unresolved.map(async (symbol) => [symbol, await fetchStockPrice(symbol, { force: true, skipApi: true })]));
      fetched.forEach(([symbol, value]) => {
        if (value) results[symbol] = value;
      });
    }
  }

  return results;
}

// ─── TRADE NORMALIZATION (backwards compat) ──────────────────────────────────
function normalizeTrade(t) {
  if (t.entries) return t; // already new format
  const isOldClosed = t.status === "closed";
  const qty = t.qty || 0;
  return {
    ...t,
    entries: [{ price: t.entry || 0, qty, riskAmount: t.riskAmount || 0, date: t.date, notes: "" }],
    currentStop: t.stop || 0,
    targets: [t.target || null, null, null],
    exits: isOldClosed
      ? [{ price: t.exitPrice || 0, qty, pnl: t.pnl || 0, date: t.date, notes: "", reason: "Manual" }]
      : [],
    avgEntry: t.entry || 0,
    totalQty: qty,
    remainingQty: isOldClosed ? 0 : qty,
    pnl: t.pnl || 0,
    entry: t.entry || 0,
    stop: t.stop || 0,
    riskAmount: t.riskAmount || 0,
  };
}

// ─── STORAGE ────────────────────────────────────────────────────────────────
function useStorage(key, def) {
  const [val, setVal] = useState(() => {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : def; }
    catch { return def; }
  });
  const save = (v) => { setVal(v); try { localStorage.setItem(key, JSON.stringify(v)); } catch {} };
  return [val, save];
}

// ─── MARKET UTILS ────────────────────────────────────────────────────────────
async function fetchIndicesData() {
  // Three sources in parallel. NSE (live feed, then official close file) is the truth;
  // Yahoo is a cross-check and the last-resort fallback, shown as unverified.
  const nseGet = (type) => fetchJsonWithTimeout(`/api/nse?type=${type}`, { headers: { Accept: "application/json" } }, INDICES_API_TIMEOUT_MS)
    .then(d => (d && !d.error ? d : null)).catch(() => null);
  const yahooGet = async (symbols) => {
    for (const s of symbols) {
      const q = LIVE_SOURCE_POLICY !== "browser_yahoo_only" ? await fetchQuoteFromNode(s) : null;
      if (q?.price != null) return { price: q.price, prevClose: q.prevClose, changePct: q.change_pct, asOf: q.asOf, issues: q.issues };
    }
    for (const s of symbols) { // browser fallback (local dev / API down)
      const q = await fetchStockPrice(s, { force: true, skipApi: true });
      if (q?.price != null) return { price: q.price, changePct: q.changePct, asOf: null, issues: [] };
    }
    return null;
  };

  const [live, eod, y50, y500] = await Promise.all([
    nseGet("live"), nseGet("indices"),
    yahooGet([INDEX_KEYS.nifty50.yahoo]), yahooGet([INDEX_KEYS.nifty500.yahoo, "^CNX500"]),
  ]);
  const pick = (key, yahoo) => {
    const k = INDEX_KEYS[key];
    const l = live?.indices?.[k.nseLive];
    const e = eod?.indices?.[k.nseFile];
    return reconcileIndex({
      live: l ? { ...l, date: live.date, time: live.time } : null,
      eod: e ? { ...e, date: eod.date } : null,
      yahoo,
    });
  };
  const nifty50 = pick("nifty50", y50), nifty500 = pick("nifty500", y500);
  if (!nifty50 && !nifty500) return null;
  for (const [name, v] of [["NIFTY 50", nifty50], ["NIFTY 500", nifty500]]) {
    if (v?.warning) console.warn(`[indices] ${name}: ${v.warning}`);
  }
  return {
    nifty50, nifty500,
    as_of: new Date().toISOString(),
    is_live: isMarketOpen(),
  };
}

// ─── SYMBOL SEARCH ───────────────────────────────────────────────────────────
async function searchSymbolsFromApi(query) {
  if (LIVE_SOURCE_POLICY === "browser_yahoo_only") return [];
  const data = await fetchJsonWithTimeout(
    `/api/search?q=${encodeURIComponent(query)}`,
    { headers: { Accept: "application/json" } },
    SEARCH_API_TIMEOUT_MS,
  );
  return Array.isArray(data) ? data : [];
}

function rankLocalSymbolMatch(record, query) {
  const symbol = record.symbol.toLowerCase();
  const name = record.name.toLowerCase();
  if (symbol === query) return [0, symbol];
  if (symbol.startsWith(query)) return [1, symbol];
  if (name.startsWith(query)) return [2, symbol];
  if (symbol.includes(query)) return [3, symbol];
  return [4, symbol];
}

async function loadLocalSymbols() {
  if (_localSymbols) return _localSymbols;
  if (_localSymbolsPromise) return _localSymbolsPromise;
  _localSymbolsPromise = (async () => {
    try {
      const raw = await fetchJsonWithTimeout(
        LOCAL_SYMBOLS_URL,
        { headers: { Accept: "application/json" } },
        LOCAL_SYMBOLS_TIMEOUT_MS,
      );
      if (!Array.isArray(raw)) return [];
      const records = raw.map((item) => {
        if (Array.isArray(item)) {
          return { symbol: normalizeSymbol(item[0]), name: String(item[1] || item[0] || "").trim() };
        }
        const symbol = normalizeSymbol(item?.symbol || item?.s);
        const name = String(item?.name || item?.n || symbol || "").trim();
        return { symbol, name };
      }).filter((record) => record.symbol && record.name);
      _localSymbols = records;
      return records;
    } catch {
      return [];
    } finally {
      _localSymbolsPromise = null;
    }
  })();
  return _localSymbolsPromise;
}

async function searchSymbolsFallback(query) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return [];
  const records = await loadLocalSymbols();
  const matches = records.filter((record) => record.symbol.toLowerCase().includes(q) || record.name.toLowerCase().includes(q));
  matches.sort((a, b) => {
    const [ar, as] = rankLocalSymbolMatch(a, q);
    const [br, bs] = rankLocalSymbolMatch(b, q);
    if (ar !== br) return ar - br;
    return as.localeCompare(bs);
  });
  return matches.slice(0, SEARCH_RESULT_LIMIT).map((record) => ({
    symbol: record.symbol,
    name: record.name,
    ltp: null,
    from_watchlist: false,
  }));
}

async function searchSymbols(query, options = {}) {
  const { enrichPrices = false } = options;
  if (!query || query.length < 2) return [];

  const fallback = await searchSymbolsFallback(query);
  if (LIVE_SOURCE_POLICY === "browser_yahoo_only") {
    if (!enrichPrices || fallback.length === 0) return fallback;
    const quotes = await fetchQuotes(fallback.map((item) => item.symbol), { force: true });
    return fallback.map((item) => ({
      ...item,
      ltp: quotes[normalizeSymbol(item.symbol)]?.price ?? item.ltp,
    }));
  }

  const apiResults = await searchSymbolsFromApi(query);
  const base = apiResults.length > 0 ? apiResults : fallback;
  if (base.length === 0) return [];

  const withCached = base.map((item) => {
    const normalized = normalizeSymbol(item.symbol);
    const cached = _priceCache.get(normalized);
    const cachedPrice = cached && Date.now() - cached.ts < PRICE_CACHE_TTL_MS
      ? cached.result?.price
      : null;
    return {
      ...item,
      ltp: Number.isFinite(item.ltp) ? item.ltp : (Number.isFinite(cachedPrice) ? cachedPrice : null),
    };
  });

  if (!enrichPrices) return withCached;

  const missingSymbols = [...new Set(withCached.filter((item) => !Number.isFinite(item.ltp)).map((item) => item.symbol))];
  if (missingSymbols.length === 0) return withCached;
  const quotes = await fetchQuotes(missingSymbols, { force: true });
  return withCached.map((item) => ({
    ...item,
    ltp: Number.isFinite(item.ltp) ? item.ltp : (quotes[normalizeSymbol(item.symbol)]?.price ?? null),
  }));
}

function formatSuggestionLtp(ltp) {
  return typeof ltp === "number" && Number.isFinite(ltp) ? `₹${ltp.toFixed(2)}` : "—";
}

function SymbolSuggestions({ suggestions, onSelect, visible }) {
  if (!visible || suggestions.length === 0) return null;
  return (
    <div style={{
      position: "absolute", top: "100%", left: 0, right: 0, zIndex: 300,
      background: "var(--bg2)", border: "1px solid var(--border2)",
      borderRadius: 14, overflow: "hidden", marginTop: 6,
      boxShadow: "0 12px 28px rgba(0,0,0,0.35)",
    }}>
      {suggestions.map((s, i) => (
        <div key={i}
          onMouseDown={(e) => { e.preventDefault(); onSelect(s); }}
          style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            gap: 12, padding: "10px 12px", cursor: "pointer",
            borderBottom: i < suggestions.length - 1 ? "1px solid var(--border)" : "none",
            transition: "background 0.1s",
          }}
          onMouseEnter={e => e.currentTarget.style.background = "var(--bg4)"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
        >
          <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
            {s.from_watchlist ? (
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: "#30D158", flex: "0 0 auto",
              }} />
            ) : null}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: "var(--display)", fontSize: 15, fontWeight: 700, letterSpacing: "0.01em", color: "var(--text)" }}>
                {s.symbol}
              </div>
              <div style={{
                fontSize: 11, color: "var(--text3)", fontFamily: "var(--body)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {s.name}
              </div>
            </div>
          </div>
          <span style={{ fontSize: 11, color: "var(--text2)", fontFamily: "var(--mono)", flex: "0 0 auto" }}>
            {formatSuggestionLtp(s.ltp)}
          </span>
        </div>
      ))}
    </div>
  );
}

function useSymbolLookup({ onSymbolChange, onSymbolInfo, onLtpSelect }) {
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [fetchingSym, setFetchingSym] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const containerRef = useRef(null);
  const debounceRef = useRef(null);
  const latestQueryRef = useRef("");
  const suggestionsRef = useRef([]);
  const onSymbolInfoRef = useRef(onSymbolInfo);
  const onLtpSelectRef = useRef(onLtpSelect);

  useEffect(() => { suggestionsRef.current = suggestions; }, [suggestions]);
  useEffect(() => { onSymbolInfoRef.current = onSymbolInfo; }, [onSymbolInfo]);
  useEffect(() => { onLtpSelectRef.current = onLtpSelect; }, [onLtpSelect]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const handleSymbolChange = (value) => {
    const sym = value.toUpperCase();
    latestQueryRef.current = sym;
    setSelectedSymbol("");
    onSymbolChange(sym);
    onSymbolInfo(null);
    setSuggestions([]);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (sym.length < 2) {
      setFetchingSym(false);
      setShowSuggestions(false);
      return;
    }

    setFetchingSym(true);
    setShowSuggestions(true);
    debounceRef.current = setTimeout(async () => {
      // Step 1: show local results immediately (no API wait)
      const localResults = await searchSymbolsFallback(sym);
      if (latestQueryRef.current !== sym) return;
      if (localResults.length > 0) {
        setSuggestions(localResults);
        setShowSuggestions(true);
        setFetchingSym(false);
      }

      // Step 2: fetch prices from API in background — both search API (has prices
      // built-in) and quotes API run in parallel; whichever arrives first wins
      const [apiResults, quoteMap] = await Promise.all([
        searchSymbolsFromApi(sym),
        fetchQuotes(localResults.map((r) => r.symbol), { force: true }),
      ]);
      if (latestQueryRef.current !== sym) return;

      // API search results take priority (richer data); merge prices
      const base = apiResults.length > 0 ? apiResults : localResults;
      setSuggestions(base.map((item) => {
        const q = quoteMap[normalizeSymbol(item.symbol)];
        const ltp = Number.isFinite(item.ltp) ? item.ltp : (q?.price ?? null);
        return { ...item, ltp };
      }));
      setShowSuggestions(base.length > 0);
      setFetchingSym(false);
    }, SEARCH_API_DEBOUNCE_MS);
  };

  const selectSuggestion = async (suggestion) => {
    const normalized = normalizeSymbol(suggestion.symbol);
    setSelectedSymbol(normalized);
    onSymbolChange(suggestion.symbol);
    setSuggestions([]);
    setShowSuggestions(false);

    if (typeof suggestion.ltp === "number" && Number.isFinite(suggestion.ltp)) {
      onSymbolInfo({
        name: suggestion.name,
        price: suggestion.ltp,
        changePct: null,
      });
      if (onLtpSelect) onLtpSelect(suggestion.ltp);
    }

    setFetchingSym(true);
    const result = await fetchStockPrice(suggestion.symbol, { force: true });
    setFetchingSym(false);
    if (result) {
      onSymbolInfo({ ...result, name: result.name || suggestion.name });
      if (onLtpSelect && typeof result.price === "number") onLtpSelect(result.price);
    }
  };

  useEffect(() => {
    if (!showSuggestions) return;
    let cancelled = false;
    let timerId = null;

    const run = async () => {
      const list = suggestionsRef.current;
      if (list.length > 0) {
        const queryToken = latestQueryRef.current;
        const symbols = [...new Set(list.map((item) => item.symbol).filter(Boolean))];
        const quoteMap = await fetchQuotes(symbols, { force: true });
        if (cancelled || latestQueryRef.current !== queryToken) return;
        setSuggestions((prev) => prev.map((item) => {
          const next = quoteMap[normalizeSymbol(item.symbol)];
          if (!next || !Number.isFinite(next.price)) return item;
          return { ...item, ltp: next.price, name: item.name || next.name };
        }));
      }
      if (cancelled) return;
      timerId = setTimeout(run, SUGGESTION_PRICE_REFRESH_MS);
    };

    run();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [showSuggestions]);

  useEffect(() => {
    if (!selectedSymbol) return;
    let cancelled = false;
    let timerId = null;

    const run = async () => {
      const result = await fetchStockPrice(selectedSymbol, { force: true });
      if (cancelled) return;
      if (result) {
        onSymbolInfoRef.current({ ...result, name: result.name || selectedSymbol });
        if (onLtpSelectRef.current && typeof result.price === "number") {
          onLtpSelectRef.current(result.price);
        }
      }
      if (cancelled) return;
      timerId = setTimeout(run, getRefreshDelayMs(SELECTED_SYMBOL_REFRESH_MS, CLOSED_REFRESH_INTERVAL_MS));
    };

    run();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [selectedSymbol]);

  return {
    containerRef,
    fetchingSym,
    handleInputFocus: () => suggestions.length > 0 && setShowSuggestions(true),
    handleInputKeyDown: (event) => {
      if (event.key === "Escape") {
        setShowSuggestions(false);
        event.currentTarget.blur();
      }
    },
    handleSymbolChange,
    pinSelectedSymbol: (symbol) => setSelectedSymbol(normalizeSymbol(symbol)),
    selectSuggestion,
    showSuggestions,
    suggestions,
  };
}

// ─── DAYS HELD UTILS ─────────────────────────────────────────────────────────
function calcDaysHeld(trade) {
  const entryDate = trade.entries?.[0]?.date || trade.date;
  if (!entryDate) return 1;
  const now = new Date();
  const entry = new Date(entryDate);
  return Math.max(1, Math.floor((now - entry) / (1000 * 60 * 60 * 24)) + 1);
}

function getDaysHeldStatus(setupType, days) {
  const rules = {
    "Breakout":    { greenMax: 3, amberMax: 5, redMin: 6 },
    "Pullback":    { greenMax: 4, amberMax: 6, redMin: 7 },
    "U&R":         { greenMax: 2, amberMax: 3, redMin: 4 },
    "Momentum":    { greenMax: 5, amberMax: 7, redMin: 8 },
    "Range Break": { greenMax: 3, amberMax: 5, redMin: 6 },
  };
  const rule = rules[setupType] || rules["Breakout"];
  if (days >= rule.redMin) return { color: C.neg, label: `Day ${days} · Decision needed` };
  if (days > rule.greenMax) return { color: C.warn, label: `Day ${days} · Watch closely` };
  return { color: C.pos, label: `Day ${days}` };
}

function DaysHeldBadge({ trade }) {
  const days = calcDaysHeld(trade);
  const { color, label } = getDaysHeldStatus(trade.setupType, days);
  return (
    <span className="tag" style={{ background: `${color}15`, color, border: `1px solid ${color}33`, fontSize: 10 }}>
      {label}
    </span>
  );
}

// ─── NIFTY STRIP ─────────────────────────────────────────────────────────────
function useIndicesTicker() {
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(NIFTY_CACHE_KEY);
      if (!raw) return { nsei: null, cnx500: null, asOf: null, stale: false };
      const parsed = JSON.parse(raw);
      return {
        nsei: parsed?.nsei || null,
        cnx500: parsed?.cnx500 || null,
        asOf: parsed?.asOf || null,
        stale: true,
      };
    } catch {
      return { nsei: null, cnx500: null, asOf: null, stale: false };
    }
  });

  useEffect(() => {
    let cancelled = false;
    let timerId = null;

    const run = async () => {
      const data = await fetchIndicesData();
      if (cancelled) return;

      if (data?.nifty50 || data?.nifty500) {
        setState((prev) => {
          // { price, changePct, source, verified, asOf, warning } — see reconcileIndex()
          const next = {
            nsei: data?.nifty50 || prev.nsei,
            cnx500: data?.nifty500 || prev.cnx500,
            asOf: data?.as_of || new Date().toISOString(),
            stale: false,
          };
          try { localStorage.setItem(NIFTY_CACHE_KEY, JSON.stringify(next)); } catch {}
          return next;
        });
      } else {
        setState((prev) => ({ ...prev, stale: Boolean(prev.nsei || prev.cnx500) }));
      }

      timerId = setTimeout(run, getRefreshDelayMs(LIVE_REFRESH_INTERVAL_MS, CLOSED_REFRESH_INTERVAL_MS));
    };

    run();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, []);

  return state;
}

// Small trust mark next to an index value: ✓ = NSE official, ? = Yahoo only (unverified), ⚠ = sources disagree
function IdxMark({ v, size = 9 }) {
  if (!v) return null;
  const label = v.source === "nse-live" ? `NSE live · ${v.asOf || ""}` : v.source === "nse-eod" ? `NSE official · ${v.asOf || ""}` : `Yahoo · not verified against NSE`;
  const title = v.warning ? `${label} — ${v.warning}` : label;
  const [sym, color] = !v.verified ? ["?", "var(--amber)"] : v.warning ? ["⚠", "var(--amber)"] : ["✓", "var(--text3)"];
  return <span title={title} aria-label={title} style={{ color, fontSize: size, opacity: 0.85, cursor: "help" }}>{sym}</span>;
}

function NiftyStrip({ data }) {
  const nsei = data?.nsei || null;
  const cnx500 = data?.cnx500 || null;
  const stale = data?.stale || false;
  const asOf = data?.asOf || null;
  const fmtPrice = (v) => v?.toLocaleString("en-IN", { maximumFractionDigits: 2 }) ?? "—";
  const fmtPct = (v) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "";
  const pctColor = (v) => v >= 0 ? "var(--green)" : "var(--red)";
  const open = isMarketOpen();
  const hasData = Boolean(nsei || cnx500);

  return (
    <div style={{
      position: "sticky", top: 49, zIndex: 99,
      background: "var(--bar)", backdropFilter: "blur(12px)",
      borderBottom: "1px solid var(--border2)",
      boxShadow: "none",
      padding: "5px 16px", display: "flex", alignItems: "center", gap: 16,
      fontFamily: "var(--mono)", fontSize: 11, overflowX: "auto", whiteSpace: "nowrap",
    }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span style={{ color: "var(--text3)" }}>NIFTY 50</span>
        {!open && nsei && <span style={{ color: "var(--text3)", fontSize: 9, opacity: 0.7 }}>EOD</span>}
        {nsei ? (
          <>
            <span style={{ color: "var(--text)" }}>{fmtPrice(nsei.price)}</span>
            <span style={{ color: pctColor(nsei.changePct) }}>{fmtPct(nsei.changePct)}</span>
            <IdxMark v={nsei} />
          </>
        ) : (
          <span style={{ color: "var(--text3)" }}>—</span>
        )}
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span style={{ color: "var(--text3)" }}>NIFTY 500</span>
        {!open && cnx500 && <span style={{ color: "var(--text3)", fontSize: 9, opacity: 0.7 }}>EOD</span>}
        {cnx500 ? (
          <>
            <span style={{ color: "var(--text)" }}>{fmtPrice(cnx500.price)}</span>
            <span style={{ color: pctColor(cnx500.changePct) }}>{fmtPct(cnx500.changePct)}</span>
            <IdxMark v={cnx500} />
          </>
        ) : (
          <span style={{ color: "var(--text3)" }}>—</span>
        )}
      </span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5 }}>
        {nsei && (
          <span style={{ color: nsei.verified ? "var(--text3)" : "var(--amber)", fontSize: 9 }}
            title={nsei.verified ? "Index values from NSE's official feed / close file" : "NSE unreachable — showing Yahoo, not verified"}>
            {nsei.source === "nse-live" ? `NSE ${nsei.asOf ? nsei.asOf.split(" ").pop() : ""}` : nsei.source === "nse-eod" ? "NSE close" : "UNVERIFIED"}
          </span>
        )}
        {open ? (
          <>
            <span className="pulse-dot" style={{ background: "var(--green)", display: "inline-block" }} />
            <span style={{ color: "var(--green)", fontWeight: 600 }}>OPEN</span>
          </>
        ) : (
          <span style={{ color: "var(--text3)" }}>CLOSED</span>
        )}
        {stale && hasData && <span style={{ color: "var(--amber)", fontSize: 10 }}>STALE</span>}
        {asOf && <span style={{ color: "var(--text3)", fontSize: 9 }}>{new Date(asOf).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>}
      </span>
    </div>
  );
}
// ─── GLOBAL STYLES ──────────────────────────────────────────────────────────
const GlobalStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      /* ── Demon Slayer void backgrounds ── */
      --bg:      #0A0A0A;
      --bg2:     #141414;
      --bg3:     #101010;
      --bg4:     #1A1A1A;
      /* ── Violet-edge borders ── */
      --border:  #2A2A2A;
      --border2: #343434;
      /* ── Text: pale lavender → deep muted ── */
      --text:    #D4CCB6;
      --text2:   #A39C89;
      --text3:   #7E7767;
      /* ── Water Breathing teal-green (profit) ── */
      --green:   #4ADE80;
      --green2:  #22C55E;
      /* ── Flame orange-red (loss / Rengoku) ── */
      --red:     #DC143C;
      /* ── Thunder gold (caution / Zenitsu) ── */
      --amber:   #F59E0B;
      /* ── Void violet (primary accent) ── */
      --blue:    #1D4ED8;
      --violet:  #3B82F6;
      --mono:    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --display: 'Inter', sans-serif;
      --body:    'Inter', sans-serif;
    }

    :root { --bar: rgba(10,10,10,0.96); }
    :root[data-theme="light"] {
      --bg: #F6F4EF; --bg2: #FFFFFF; --bg3: #F1EEE7; --bg4: #E9E5DC;
      --border: #DDD7CB; --border2: #CFC8BA;
      --text: #1D1B17; --text2: #4A463E; --text3: #6E685C;
      --green: #15803D; --green2: #166534; --red: #C8102E; --amber: #B45309;
      --blue: #1E3A8A; --violet: #1D4ED8; --bar: rgba(246,244,239,0.96);
      color-scheme: light;
    }
    .skel { background: linear-gradient(90deg, var(--bg3) 25%, var(--bg4) 50%, var(--bg3) 75%); background-size: 200% 100%; animation: skel 1.4s ease-in-out infinite; border-radius: 8px; }
    @keyframes skel { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) { .skel { animation: none; } }

    html, body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--body);
      min-height: 100vh;
      overflow-x: hidden;
    }

    input, select, textarea {
      background: var(--bg3);
      border: 1px solid var(--border2);
      color: var(--text);
      font-family: var(--body);
      font-size: 15px;
      padding: 12px 14px;
      border-radius: 12px;
      outline: none;
      width: 100%;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus, select:focus {
      border-color: var(--violet);
      box-shadow: 0 0 0 3px rgba(220, 20, 60, 0.15);
    }
    input::placeholder { color: var(--text3); }

    button {
      font-family: var(--body);
      cursor: pointer;
      border: none;
      outline: none;
      transition: all 0.15s ease;
    }
    button:active { transform: scale(0.96); }
    button:disabled { opacity: 0.5; cursor: default; }

    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 4px; }

    .fade-in {
      animation: fadeIn 0.35s ease forwards;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* Blade slash shimmer — sweeps across regime banner */
    @keyframes shimmer {
      0%   { transform: translateX(-100%) skewX(-15deg); }
      100% { transform: translateX(300%)  skewX(-15deg); }
    }

    /* Breathing glow for key numbers */
    @keyframes breathe {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.75; }
    }

    .pulse-dot {
      width: 8px; height: 8px; border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 0 0 currentColor; }
      50%       { opacity: 0.7; transform: scale(0.85); }
    }

    .card {
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 16px;
      box-shadow: none;
    }

    .card-sm {
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 12px 14px;
      box-shadow: none;
    }

    .label {
      font-family: var(--body);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.18em;
      color: var(--text2);
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .big-num {
      font-family: var(--display);
      font-size: 32px;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1;
    }

    .tag {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      font-family: var(--body);
    }

    .btn-primary {
      background: var(--violet);
      color: #fff;
      font-weight: 700;
      font-size: 14px;
      padding: 14px 24px;
      border-radius: 14px;
      letter-spacing: 0.04em;
      box-shadow: none;
      border: 1px solid rgba(220, 20, 60, 0.4);
    }
    .btn-primary:hover { background: var(--blue); filter: none; }

    .btn-ghost {
      background: var(--bg2);
      color: var(--text);
      font-size: 14px;
      padding: 12px 20px;
      border-radius: 14px;
      border: 1px solid var(--border);
    }
    .btn-ghost:hover { border-color: var(--violet); color: var(--text); box-shadow: none; }

    .btn-danger {
      background: transparent;
      color: var(--red);
      font-size: 13px;
      padding: 10px 16px;
      border-radius: 10px;
      border: 1px solid rgba(220, 20, 60, 0.35);
    }
    .btn-danger:hover { background: rgba(220, 20, 60, 0.08); border-color: var(--red); }

    .nav-tab {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      padding: 8px 4px 10px;
      background: none;
      color: var(--text2);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      border-top: 2px solid transparent;
      transition: all 0.2s;
    }
    .nav-tab.active {
      color: var(--violet);
      border-top-color: var(--violet);
      text-shadow: none;
    }
    .nav-tab svg { width: 20px; height: 20px; }

    .section-title {
      font-family: var(--display);
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.04em;
      line-height: 1;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .grid-3 {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 8px;
    }

    .divider {
      height: 1px;
      background: var(--border);
      margin: 16px 0;
    }

    .chip {
      padding: 6px 14px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: var(--bg2);
      color: var(--text2);
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s;
    }
    .topbar-idx { min-width: 0; overflow: hidden; }
    @media (max-width: 720px) { .topbar-idx { display: none !important; } }
    .chip { min-height: 36px; }
    .chip.chip-sm { min-height: 28px; padding: 3px 10px; font-size: 11px; }
    .chip[aria-pressed="true"] { border-color: var(--violet); color: var(--violet); background: rgba(59,130,246,0.10); }
    .chip.active {
      border-color: var(--violet);
      color: var(--violet);
      background: rgba(59, 130, 246, 0.10);
      box-shadow: none;
    }

    .result-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
    }
    .result-row:last-child { border-bottom: none; }
    .result-label { font-size: 13px; color: var(--text2); }
    .result-val { font-family: var(--mono); font-size: 14px; font-weight: 600; color: var(--text); }

    .trade-card {
      background: var(--bg2);
      border: 1px solid var(--border);
      border-left: 2px solid rgba(220, 20, 60, 0.2);
      border-radius: 18px;
      padding: 14px;
      margin-bottom: 10px;
      transition: border-color 0.25s, border-left-color 0.25s, box-shadow 0.25s;
      box-shadow: none;
    }
    .trade-card:hover {
      border-color: var(--border2);
      border-left-color: var(--violet);
      box-shadow: none;
    }

    .inline-form {
      background: var(--bg3);
      border: 1px solid var(--border2);
      border-radius: 16px;
      padding: 12px;
      margin-top: 10px;
    }

    @media (min-width: 640px) {
      .big-num { font-size: 40px; }
      .section-title { font-size: 36px; }
    }
  `}</style>
);

// ─── PRICE BADGE ─────────────────────────────────────────────────────────────
// Day change for a live stock price; never shows a % it can't vouch for
function LiveChange({ q }) {
  const stale = (q?.issues || []).includes("stale");
  if (!Number.isFinite(q?.changePct)) {
    return <div style={{ fontSize: 10, color: "var(--amber)" }} title="Change unavailable: price failed a sanity check">— {stale ? "STALE" : "unverified"}</div>;
  }
  return (
    <div style={{ fontSize: 11, color: q.changePct >= 0 ? "var(--green)" : "var(--red)" }} title={q.asOf ? `Yahoo · ${new Date(q.asOf).toLocaleString("en-IN")}` : "Yahoo"}>
      {q.changePct >= 0 ? "▲" : "▼"} {Math.abs(q.changePct).toFixed(2)}%{stale && <span style={{ color: "var(--amber)", fontSize: 9 }}> STALE</span>}
    </div>
  );
}

function PriceBadge({ info, loading }) {
  if (loading) return (
    <div style={{ fontSize: 12, color: "var(--text3)", fontFamily: "var(--mono)", marginTop: 6 }}>
      fetching price...
    </div>
  );
  if (!info) return null;
  const hasChange = typeof info.changePct === "number" && Number.isFinite(info.changePct);
  const up = hasChange ? info.changePct >= 0 : false;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
      <span style={{ fontSize: 12, color: "var(--text2)", fontFamily: "var(--mono)" }}>{info.name}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text)", fontWeight: 500 }}>
        ₹{info.price.toFixed(2)}
      </span>
      {hasChange ? (
        <span style={{ fontSize: 11, color: up ? "var(--green)" : "var(--red)", fontFamily: "var(--mono)" }}>
          {up ? "▲" : "▼"} {Math.abs(info.changePct).toFixed(2)}%
        </span>
      ) : null}
    </div>
  );
}

// ─── TOP BAR ────────────────────────────────────────────────────────────────
function TopBar({ regime, portfolio, page, indicesData, onSearch, onMenu }) {
  // The chip shows the same verdict as every other screen: the market signal (bias is one of its four readings)
  const { data: mq } = useMarketQuadrant();
  const sig = mq?.overall;
  const cfg = sig ? { label: sig, color: MQ_SIGNAL_COLOR[sig], bg: MQ_SIGNAL_BG[sig] } : REGIME_CONFIG[regime];
  const open = isMarketOpen();
  const nsei = indicesData?.nsei || null;
  const cnx500 = indicesData?.cnx500 || null;
  const fmtIdxPrice = (v) => v?.toLocaleString("en-IN", { maximumFractionDigits: 2 }) ?? "—";
  const fmtIdxPct = (v) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "";
  const pctColor = (v) => v >= 0 ? "var(--green)" : "var(--red)";
  return (
    <div style={{
      position: "sticky", top: 0, zIndex: 100,
      background: "var(--bar)", backdropFilter: "blur(24px)",
      borderBottom: "1px solid var(--border)",
      borderLeft: "0 solid transparent",
      padding: "10px 16px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 8,
    }}>
      {/* Left: brand + regime */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <div style={{
          fontFamily: "var(--display)", fontSize: 20, letterSpacing: "0.06em",
          color: "var(--violet)", lineHeight: 1,
        }}>
          TRADESK
        </div>
        <div style={{
          background: cfg.bg,
          border: `1px solid ${cfg.color}`,
          borderRadius: 6, padding: "2px 6px",
          fontSize: 9, fontFamily: "var(--mono)", fontWeight: 600,
          color: cfg.color, letterSpacing: "0.1em",
          textShadow: `0 0 8px ${cfg.color}88`,
        }}>
          {cfg.label}
        </div>
      </div>

      {/* Center: Nifty live prices (hidden on phones — the strip below shows them) */}
      <div className="topbar-idx" style={{
        display: "flex", alignItems: "center", gap: 10,
        fontFamily: "var(--mono)", fontSize: 10,
        flex: 1, justifyContent: "center",
      }}>
        {/* Nifty 50 */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
          <span style={{ color: "var(--text3)" }}>N50</span>
          {nsei ? (
            <>
              <span style={{ color: "var(--text)", fontWeight: 600 }}>{fmtIdxPrice(nsei.price)}</span>
              <span style={{ color: pctColor(nsei.changePct), fontSize: 9 }}>{fmtIdxPct(nsei.changePct)}</span>
              <IdxMark v={nsei} size={8} />
              {!open && <span style={{ color: "var(--text3)", fontSize: 9.5, opacity: 0.7 }}>EOD</span>}
            </>
          ) : (
            <span style={{ color: "var(--text3)" }}>—</span>
          )}
        </span>
        <span style={{ color: "var(--border2)" }}>|</span>
        {/* Nifty 500 */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
          <span style={{ color: "var(--text3)" }}>N500</span>
          {cnx500 ? (
            <>
              <span style={{ color: "var(--text)", fontWeight: 600 }}>{fmtIdxPrice(cnx500.price)}</span>
              <span style={{ color: pctColor(cnx500.changePct), fontSize: 9 }}>{fmtIdxPct(cnx500.changePct)}</span>
              <IdxMark v={cnx500} size={8} />
              {!open && <span style={{ color: "var(--text3)", fontSize: 9.5, opacity: 0.7 }}>EOD</span>}
            </>
          ) : (
            <span style={{ color: "var(--text3)" }}>—</span>
          )}
        </span>
        {/* live dot */}
        {open && (nsei || cnx500) && (
          <span className="pulse-dot" style={{ background: "var(--green)", display: "inline-block" }} />
        )}
      </div>

      {/* Right: portfolio value */}
      {onSearch && <button onClick={onSearch} aria-label="Search stocks, funds and IPOs" title="Search" style={{ background: "none", border: "1px solid var(--border)", borderRadius: 10, width: 36, height: 36, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--text2)", cursor: "pointer", flexShrink: 0 }}>
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
      </button>}
      <button onClick={onMenu} aria-label="Menu: trading capital, settings, tour" title="Menu" style={{
        background: "var(--bg3)", border: "1px solid var(--border2)",
        borderRadius: 10, padding: "5px 10px", minHeight: 36, cursor: "pointer",
        fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)",
        flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6,
      }}>
        {formatINR(portfolio)}<span aria-hidden="true" style={{ color: "var(--text3)" }}>☰</span>
      </button>
    </div>
  );
}

// ─── TODAY PAGE ─────────────────────────────────────────────────────────────
function TodayPage({ regime, setRegime, regimeSince, portfolio, setPortfolio, trades, setPage, watchlist, onOpenStock, onPlan, onOpenFund, onOpenIpos }) {
  const cfg = REGIME_CONFIG[regime];
  const openTrades = trades.filter(t => t.status === "open" || t.status === "partial").map(normalizeTrade);
  const totalRisk = openTrades.reduce((s, t) => s + (t.riskAmount || 0), 0);
  const heat = portfolio > 0 ? ((totalRisk / portfolio) * 100).toFixed(1) : "0.0";
  const openSymbols = [...new Set(openTrades.map(t => normalizeSymbol(t.symbol)).filter(Boolean))];
  const openSymbolsKey = openSymbols.join(",");

  const [livePrices, setLivePrices] = useState({});
  const [refreshing, setRefreshing] = useState(false);

  const refreshPrices = async (options = {}) => {
    const { force = false } = options;
    if (openSymbols.length === 0) {
      setLivePrices({});
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    const quotes = await fetchQuotes(openSymbols, { force });
    setLivePrices(quotes);
    setRefreshing(false);
  };

  useEffect(() => {
    let cancelled = false;
    let timerId = null;

    const run = async () => {
      await refreshPrices({ force: true });
      if (cancelled) return;
      timerId = setTimeout(run, getRefreshDelayMs(LIVE_REFRESH_INTERVAL_MS, CLOSED_REFRESH_INTERVAL_MS));
    };

    run();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [openSymbolsKey]);

  const today = new Date().toDateString();
  const closedTrades = trades.filter(t => t.status === "closed").map(normalizeTrade);
  const todayPnl = closedTrades
    .filter(t => {
      const lastExit = (t.exits || []).slice(-1)[0];
      return lastExit && new Date(lastExit.date).toDateString() === today;
    })
    .reduce((s, t) => s + (t.pnl || 0), 0);
  const overallPnl = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const hasTodayActivity = closedTrades.some(t => {
    const lastExit = (t.exits || []).slice(-1)[0];
    return lastExit && new Date(lastExit.date).toDateString() === today;
  });

  const totalUnrealized = openTrades.reduce((s, t) => {
    const lp = livePrices[normalizeSymbol(t.symbol)];
    if (!lp) return s;
    return s + (lp.price - t.avgEntry) * (t.remainingQty || t.totalQty || 0);
  }, 0);

  const secHead = (t, right) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "4px 0 10px" }}>
      <div className="section-title" style={{ fontSize: 20 }}>{t}</div>{right}
    </div>
  );
  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      {/* 1 · Market — signal, environment, today's rule, what changed */}
      <SectionBoundary name="Market brief">
        {isPreOpen() ? <MorningBrief trades={trades} watchlist={watchlist} onOpenStock={onOpenStock} />
          : <MarketBrief onOpenQuad={() => { setPage("quadrant"); window.scrollTo(0, 0); }} onOpenScan={() => { setPage("ideas"); window.scrollTo(0, 0); }} onOpenWrap={() => { setPage("wrap"); window.scrollTo(0, 0); }} />}
      </SectionBoundary>

      {/* 2 · Your book — what needs action first */}
      <SectionBoundary name="Your positions">
        {secHead("Your positions", (
          <div style={{ display: "flex", gap: 8 }}>
            {openTrades.length > 0 && (
              <button className="btn-ghost" style={{ padding: "8px 12px", fontSize: 12, borderRadius: 8 }} onClick={() => refreshPrices({ force: true })} disabled={refreshing}>
                {refreshing ? "..." : "↺"}
              </button>
            )}
            <button className="btn-ghost" style={{ padding: "8px 12px", fontSize: 12, borderRadius: 8 }} onClick={() => setPage("journal")}>Journal ›</button>
            <button className="btn-primary" style={{ padding: "8px 14px", fontSize: 12, borderRadius: 8 }} onClick={() => onPlan?.(null)}>+ Plan a trade</button>
          </div>
        ))}
        <div className="card" style={{ marginBottom: 10, padding: "10px 14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr", gap: 8, alignItems: "end" }}>
            <div>
              <div className="label">Portfolio</div>
              <button onClick={() => { const v = prompt("Enter portfolio value:", portfolio); if (v && !isNaN(v)) setPortfolio(Number(v)); }}
                title="Edit portfolio value" style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 17, color: "var(--text)", textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{formatINR(portfolio)}</button>
            </div>
            <div>
              <div className="label">Heat</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 17, color: getHeatColor(heat) }}>{heat}%</div>
            </div>
            <div>
              <div className="label">{Object.keys(livePrices).length ? "Open P&L" : "Open risk"}</div>
              {Object.keys(livePrices).length
                ? <div style={{ fontFamily: "var(--mono)", fontSize: 17, color: totalUnrealized >= 0 ? "var(--green)" : "var(--red)" }}>{totalUnrealized >= 0 ? "+" : ""}{formatINR(totalUnrealized)}</div>
                : <div style={{ fontFamily: "var(--mono)", fontSize: 17 }}>{formatINR(totalRisk)}</div>}
            </div>
          </div>
          {(hasTodayActivity || closedTrades.length > 0) && (
            <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 6 }}>
              {hasTodayActivity ? <>Closed today <b style={{ color: todayPnl >= 0 ? "var(--green)" : "var(--red)" }}>{todayPnl >= 0 ? "+" : ""}{formatINR(todayPnl)}</b> · </> : null}
              All closed trades <b style={{ color: overallPnl >= 0 ? "var(--green)" : "var(--red)" }}>{overallPnl >= 0 ? "+" : ""}{formatINR(overallPnl)}</b> ({closedTrades.length})
            </div>
          )}
        </div>
        {openTrades.length === 0 ? (
          <div className="card" style={{ textAlign: "center", padding: "22px 16px", marginBottom: 14 }}>
            <div style={{ color: "var(--text2)", fontSize: 14, marginBottom: 4 }}>Book is clear</div>
            <div style={{ color: "var(--text3)", fontSize: 12 }}>Pick from today's best setups below, or plan your own.</div>
          </div>
        ) : (
          <div style={{ marginBottom: 14 }}>
            {[...openTrades].sort((x, y) => (livePrices[normalizeSymbol(y.symbol)] ? 0 : 1) - (livePrices[normalizeSymbol(x.symbol)] ? 0 : 1)).map(t => (
              <OpenTradeCard key={t.id} trade={t} livePrice={livePrices[normalizeSymbol(t.symbol)]} />
            ))}
          </div>
        )}
      </SectionBoundary>

      {/* 3 · Best setups for today, sized for the current rule */}
      <SectionBoundary name="Best setups">
        <BestSetups watchlist={watchlist} portfolio={portfolio} onOpenStock={onOpenStock} onPlan={onPlan} onSeeAll={() => { setPage("ideas"); window.scrollTo(0, 0); }} />
      </SectionBoundary>
      <SectionBoundary name="Watchlist moves"><WatchAlertsCard watchlist={watchlist} onOpen={onOpenStock} /></SectionBoundary>
      {!isMarketHours() && <>
        <SectionBoundary name="Mutual funds"><FundsTodayCard onOpen={() => { setPage("funds"); window.scrollTo(0, 0); }} onOpenFund={onOpenFund} /></SectionBoundary>
        <SectionBoundary name="IPOs"><IpoTodayCard onOpen={onOpenIpos} /></SectionBoundary>
      </>}
      <Fold id="today_more" title="Global markets" sub="US futures, Asia, crude, gold and the rupee">
        <SectionBoundary name="Global markets"><GlobalBrief /></SectionBoundary>
      </Fold>
    </div>
  );
}

function OpenTradeCard({ trade, livePrice }) {
  const healthEl = <PositionHealth trade={trade} livePrice={livePrice} />;
  const unrealizedPnl = livePrice
    ? (livePrice.price - trade.avgEntry) * (trade.remainingQty || trade.totalQty || 0)
    : null;

  return (
    <div className="trade-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontFamily: "var(--display)", fontSize: 20, letterSpacing: "0.04em" }}>{trade.symbol}</div>
            {trade.status === "partial" && (
              <span className="tag" style={{ background: "rgba(59,130,246,0.10)", color: "var(--violet)", border: "1px solid rgba(59,130,246,0.3)", fontSize: 10 }}>PARTIAL</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
            {trade.paper && <span className="tag" style={{ background: "rgba(59,130,246,0.10)", color: "var(--violet)", border: "1px solid rgba(59,130,246,0.3)" }}>PAPER</span>}
            <span className="tag" style={{ background: "rgba(212,204,182,0.06)", color: "var(--text)", border: "1px solid rgba(212,204,182,0.14)" }}>
              {trade.setupType}
            </span>
            <DaysHeldBadge trade={trade} />
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          {livePrice ? (
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 15 }}>₹{livePrice.price.toFixed(2)}</div>
              {livePrice.isEod ? (
                <div style={{ fontSize: 10, color: "var(--text3)" }}>EOD</div>
              ) : (
                <LiveChange q={livePrice} />
              )}
            </div>
          ) : (
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 15 }}>₹{(trade.avgEntry || trade.entry || 0).toFixed(2)}</div>
              <div style={{ fontSize: 11, color: "var(--text3)" }}>Entry</div>
            </div>
          )}
        </div>
      </div>
      <div className="grid-2">
        <div className="card-sm">
          <div className="label">SL</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--red)" }}>₹{trade.currentStop || trade.stop}</div>
        </div>
        <div className="card-sm">
          <div className="label">{unrealizedPnl !== null ? "Unrealized" : "Risk ₹"}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: unrealizedPnl !== null ? (unrealizedPnl >= 0 ? "var(--green)" : "var(--red)") : "var(--amber)" }}>
            {unrealizedPnl !== null
              ? `${unrealizedPnl >= 0 ? "+" : ""}${formatINR(unrealizedPnl)}`
              : formatINR(trade.riskAmount)}
          </div>
        </div>
      </div>
      {trade.targets?.some(t => t) && (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {trade.targets.map((t, i) => t ? (
            <div key={i} style={{ flex: 1, textAlign: "center", background: "var(--bg3)", borderRadius: 8, padding: "4px 6px" }}>
              <div style={{ fontSize: 9, color: "var(--text3)", fontFamily: "var(--mono)", letterSpacing: "0.1em" }}>T{i+1}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--green)" }}>₹{t}</div>
            </div>
          ) : null)}
        </div>
      )}
      {healthEl}
    </div>
  );
}

// ─── CALCULATOR PAGE ─────────────────────────────────────────────────────────
function CalcPage({ portfolio, trades, onSendToJournal, onOpenQuadrant, prefillSymbol, onPrefillUsed }) {
  const planRef = useRef(null); // { symbol, entry, stop } from a stock page's suggested plan
  const [symbol, setSymbol] = useState("");
  const [symbolInfo, setSymbolInfo] = useState(null);

  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  // Start from today's suggested risk (the same number TODAY and IDEAS use)
  const todayRisk = suggestedRisk(getLastMarketQuadrant())?.pct;
  const [riskPct, setRiskPct] = useState(() => (todayRisk === 0 ? 0 : [0.5, 1, 1.5, 2].includes(todayRisk) ? todayRisk : 1));
  const [customRisk, setCustomRisk] = useState(() => (todayRisk > 0 && ![0.5, 1, 1.5, 2].includes(todayRisk) ? String(todayRisk) : ""));
  const [qty, setQty] = useState("");
  const [qtyMode, setQtyMode] = useState("auto");

  const r = Number(customRisk) > 0 ? Number(customRisk) : riskPct;
  const e = parseFloat(entry), s = parseFloat(stop), t = parseFloat(target);
  const valid = e > 0 && s > 0 && e > s;

  const riskBudget = (portfolio * r) / 100;
  const stopDist = valid ? e - s : null;
  const stopPct = valid ? ((stopDist / e) * 100).toFixed(2) : null;
  const liqCr = getLastMarketQuadrant()?.q_of?.[normalizeSymbol(symbol || "")]?.to ?? readMicro()?.q_of?.[normalizeSymbol(symbol || "")]?.to ?? null;
  const capped = valid ? capQty(Math.floor(riskBudget / (stopDist * GAP_BUFFER)), e, portfolio, liqCr) : { qty: 0, cap: null };
  const autoQty = capped.qty;
  const finalQty = qtyMode === "manual" && qty ? parseInt(qty) : autoQty;
  const posValue = valid ? e * finalQty : 0;
  const actualRisk = valid ? stopDist * finalQty : 0;
  const rr = t > e && valid ? ((t - e) / (e - s)).toFixed(2) : null;
  const brokerage = posValue * 0.0003;
  const stt = posValue * 0.001;
  const totalCharges = (brokerage + stt + posValue * 0.00015).toFixed(0);

  const {
    containerRef,
    fetchingSym,
    handleInputFocus,
    handleInputKeyDown,
    handleSymbolChange,
    pinSelectedSymbol,
    selectSuggestion,
    showSuggestions,
    suggestions,
  } = useSymbolLookup({
    onSymbolChange: (v) => { if (planRef.current && normalizeSymbol(v) !== normalizeSymbol(planRef.current.symbol)) planRef.current = null; setSymbol(v); },
    onSymbolInfo: setSymbolInfo,
    // A plan from a stock page keeps its entry; otherwise the live price becomes the entry
    onLtpSelect: (ltp) => { if (!planRef.current?.entry) setEntry(String(ltp.toFixed(2))); },
  });

  useEffect(() => {
    if (!showSuggestions && symbol && symbol.length >= 2) {
      pinSelectedSymbol(symbol);
    }
  }, [symbol, showSuggestions]);

  // Stock picked from QUAD: select it and fetch its live price as the entry
  useEffect(() => {
    if (!prefillSymbol) return;
    const p = typeof prefillSymbol === "string" ? { symbol: prefillSymbol } : prefillSymbol;
    planRef.current = p.entry ? p : null;
    if (p.entry) setEntry(String(p.entry));
    if (p.stop) setStop(String(p.stop));
    selectSuggestion({ symbol: p.symbol, name: p.symbol });
    onPrefillUsed?.();
  }, [prefillSymbol]);

  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      <div style={{ marginBottom: 16 }}>
        <div className="section-title">Calculator</div>
        <div style={{ fontSize: 13, color: "var(--text3)", marginTop: 4 }}>Plan the trade. Know the risk before entry.</div>
      </div>

      <MarketSignalBanner onOpen={onOpenQuadrant} />

      {/* Symbol */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Stock Symbol</div>
        <div ref={containerRef} style={{ position: "relative" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="e.g. RELIANCE, TATASTEEL" value={symbol}
              onChange={e => handleSymbolChange(e.target.value)}
              onFocus={handleInputFocus}
              onKeyDown={handleInputKeyDown}
              style={{ textTransform: "uppercase", fontFamily: "var(--display)", fontSize: 18, letterSpacing: "0.04em", flex: 1 }} />
            {symbolInfo && (
              <button className="btn-ghost" style={{ padding: "10px 14px", fontSize: 12, whiteSpace: "nowrap" }}
                onClick={() => setEntry(String(symbolInfo.price.toFixed(2)))}>
                Use ₹
              </button>
            )}
          </div>
          <SymbolSuggestions suggestions={suggestions} onSelect={selectSuggestion} visible={showSuggestions} />
        </div>
        <PriceBadge info={symbolInfo} loading={fetchingSym} />
        <ResultsWarning symbol={symbol && symbol.length >= 2 ? symbol : null} style={{ marginTop: 8 }} />
        <CalcStandDown />
        <CalcWarnings symbol={symbol} trades={trades} portfolio={portfolio} cap={capped.cap} />
      </div>

      {/* Risk % Selector */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Risk % Per Trade</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {[0.5, 1, 1.5, 2].map(v => (
            <button key={v} className={`chip ${riskPct === v && !customRisk ? "active" : ""}`}
              onClick={() => { setRiskPct(v); setCustomRisk(""); }}>
              {v}%
            </button>
          ))}
        </div>
        <input placeholder="Custom %" type="number" value={customRisk}
          onChange={e => setCustomRisk(e.target.value)}
          style={{ fontSize: 14 }} />
        <div style={{ marginTop: 8, fontFamily: "var(--mono)", fontSize: 12, color: "var(--text2)" }}>
          Risk Budget: <span style={{ color: "var(--amber)" }}>{formatINR(riskBudget)}</span>
        </div>
        <SizingAdvice portfolio={portfolio} trades={trades} riskPct={r} onApply={(v) => { setCustomRisk(""); if ([0.5, 1, 1.5, 2].includes(v)) setRiskPct(v); else setCustomRisk(String(v)); }} />
      </div>

      {/* Inputs */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 10 }}>Trade Setup</div>
        <div className="grid-2" style={{ marginBottom: 10 }}>
          <div>
            <div className="label">Entry Price</div>
            <input type="number" placeholder="0.00" value={entry} onChange={e => setEntry(e.target.value)} />
          </div>
          <div>
            <div className="label">Stop Loss</div>
            <input type="number" placeholder="0.00" value={stop} onChange={e => setStop(e.target.value)} />
          </div>
        </div>
        <div>
          <div className="label">Target <span style={{ color: "var(--text3)" }}>(optional)</span></div>
          <input type="number" placeholder="0.00" value={target} onChange={e => setTarget(e.target.value)} />
        </div>
      </div>

      {/* Qty Mode */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div className="label">Quantity</div>
          <div style={{ display: "flex", gap: 6 }}>
            {["auto", "manual"].map(m => (
              <button key={m} className={`chip ${qtyMode === m ? "active" : ""}`}
                style={{ padding: "4px 12px", fontSize: 12 }}
                onClick={() => setQtyMode(m)}>
                {m}
              </button>
            ))}
          </div>
        </div>
        {qtyMode === "manual" ? (
          <input type="number" placeholder="Enter qty" value={qty} onChange={e => setQty(e.target.value)} />
        ) : (
          <div style={{
            background: "var(--bg3)", border: "1.5px solid var(--border2)",
            borderRadius: 10, padding: "12px 14px",
            fontFamily: "var(--mono)", fontSize: 22,
            color: valid ? "var(--green)" : "var(--text3)",
          }}>
            {valid ? autoQty : "—"}
          </div>
        )}
      </div>

      {/* Results */}
      {valid && (
        <div className="card fade-in" style={{ marginBottom: 12 }}>
          <div className="label" style={{ marginBottom: 6 }}>Results</div>

          {rr && (
            <div style={{
              background: parseFloat(rr) >= 2 ? "rgba(212,204,182,0.06)" : "rgba(220,20,60,0.06)",
              border: `1px solid ${parseFloat(rr) >= 2 ? "rgba(212,204,182,0.16)" : "rgba(220,20,60,0.16)"}`,
              borderRadius: 10, padding: "12px 14px", marginBottom: 12,
              display: "flex", justifyContent: "space-between", alignItems: "center"
            }}>
              <div>
                <div className="label">Reward / Risk</div>
                <div style={{ fontFamily: "var(--display)", fontSize: 36,
                  color: parseFloat(rr) >= 2 ? "var(--green)" : "var(--amber)" }}>
                  {rr}:1
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "var(--text3)" }}>Target dist.</div>
                <div style={{ fontFamily: "var(--mono)", color: "var(--green)" }}>
                  {pct(t - e, e)}%
                </div>
              </div>
            </div>
          )}

          {[
            ["Position Value", formatINR(posValue)],
            ["Qty", finalQty],
            ["Risk Budget", formatINR(riskBudget)],
            ["Actual Risk", formatINR(actualRisk)],
            ["Stop Distance", `₹${stopDist?.toFixed(2)} (${stopPct}%)`],
            ["Est. Charges", formatINR(Number(totalCharges))],
          ].map(([l, v]) => (
            <div key={l} className="result-row">
              <span className="result-label">{l}</span>
              <span className="result-val">{v}</span>
            </div>
          ))}
        </div>
      )}

      {!valid && entry && stop && (
        <div style={{
          background: "rgba(220,20,60,0.08)", border: "1px solid rgba(220,20,60,0.2)",
          borderRadius: 10, padding: "12px 14px", marginBottom: 12,
          fontSize: 13, color: "var(--red)"
        }}>
          ⚠ Entry must be above Stop Loss
        </div>
      )}

      {valid && onSendToJournal && (
        <button className="btn-primary" style={{ width: "100%", marginBottom: 8 }}
          onClick={() => onSendToJournal({ symbol, entry, stop, target, qty: finalQty, riskAmount: actualRisk })}>
          → Send to Journal
        </button>
      )}
    </div>
  );
}

// ─── JOURNAL PAGE ────────────────────────────────────────────────────────────
function JournalPage({ trades, setTrades, prefill, setPrefill, onOpenStock }) {
  const [step, setStep] = useState(0); // 0=list, 1=form
  const [ticked, setTicked] = useState([]); // pre-trade checklist for the chosen setup

  const emptyForm = {
    symbol: "",
    setupType: "Breakout",
    entries: [{ price: "", qty: "" }],
    currentStop: "",
    targets: ["", "", ""],
    notes: "",
    conviction: 3,
    paper: false,
  };
  const [form, setForm] = useState(emptyForm);
  const [symbolInfo, setSymbolInfo] = useState(null);

  useEffect(() => {
    if (prefill) {
      setForm({
        ...emptyForm,
        symbol: prefill.symbol || "",
        entries: [{ price: prefill.entry ? String(prefill.entry) : "", qty: prefill.qty ? String(prefill.qty) : "" }],
        currentStop: prefill.stop ? String(prefill.stop) : "",
        targets: [prefill.target ? String(prefill.target) : "", "", ""],
      });
      if (prefill.symbol) {
        fetchStockPrice(prefill.symbol, { force: true }).then(r => setSymbolInfo(r));
      }
      setStep(1);
      setPrefill(null);
    }
  }, [prefill]);

  const {
    containerRef,
    fetchingSym,
    handleInputFocus,
    handleInputKeyDown,
    handleSymbolChange,
    pinSelectedSymbol,
    selectSuggestion,
    showSuggestions,
    suggestions,
  } = useSymbolLookup({
    onSymbolChange: (symbol) => setForm(f => ({ ...f, symbol })),
    onSymbolInfo: setSymbolInfo,
    onLtpSelect: (ltp) => setForm(f => ({
      ...f,
      entries: f.entries.map((entry, index) => index === 0 ? { ...entry, price: String(ltp.toFixed(2)) } : entry),
    })),
  });

  useEffect(() => {
    if (!showSuggestions && form.symbol && form.symbol.length >= 2) {
      pinSelectedSymbol(form.symbol);
    }
  }, [form.symbol, showSuggestions]);

  const updateEntry = (i, field, val) => {
    const entries = form.entries.map((e, idx) => idx === i ? { ...e, [field]: val } : e);
    setForm(f => ({ ...f, entries }));
  };

  const addEntryLeg = () => {
    if (form.entries.length >= 3) return;
    setForm(f => ({ ...f, entries: [...f.entries, { price: "", qty: "" }] }));
  };

  const removeEntryLeg = (i) => {
    setForm(f => ({ ...f, entries: f.entries.filter((_, idx) => idx !== i) }));
  };

  // Computed summary from form entries
  const validLegs = form.entries.filter(e => e.price && e.qty && parseFloat(e.price) > 0 && parseInt(e.qty) > 0);
  const formTotalQty = validLegs.reduce((s, e) => s + parseInt(e.qty), 0);
  const formAvgEntry = formTotalQty > 0
    ? validLegs.reduce((s, e) => s + parseFloat(e.price) * parseInt(e.qty), 0) / formTotalQty
    : 0;
  const formRisk = form.currentStop && formAvgEntry > 0
    ? Math.abs(formAvgEntry - parseFloat(form.currentStop)) * formTotalQty
    : 0;

  const submitTrade = () => {
    if (!form.symbol || validLegs.length === 0 || !form.currentStop) return;

    const entries = validLegs.map(e => ({
      price: parseFloat(e.price),
      qty: parseInt(e.qty),
      riskAmount: 0,
      date: new Date().toISOString(),
      notes: "",
    }));

    const totalQty = entries.reduce((s, e) => s + e.qty, 0);
    const avgEntry = entries.reduce((s, e) => s + e.price * e.qty, 0) / totalQty;
    const currentStop = parseFloat(form.currentStop);
    const riskAmount = Math.abs(avgEntry - currentStop) * totalQty;
    const targets = form.targets.map(t => t ? parseFloat(t) : null);

    const trade = {
      id: Date.now(),
      paper: !!form.paper || undefined, // practice trade: kept out of TODAY, heat and stats
      symbol: form.symbol,
      setupType: form.setupType,
      conviction: form.conviction,
      notes: form.notes,
      status: "open",
      date: new Date().toISOString(),
      marketSignal: currentMarketSignal(), // QUAD signal at entry (null if no recent data)
      marketTags: currentMarketTags(form.symbol), // signal, environment, follow-through, sector status at entry
      checklist: PLAYBOOK_SETUPS[form.setupType] ? { setup: form.setupType, ticked: [...ticked].sort(), total: PLAYBOOK_SETUPS[form.setupType].rules.length } : null,
      entries,
      currentStop,
      targets,
      exits: [],
      avgEntry,
      totalQty,
      remainingQty: totalQty,
      pnl: 0,
      // backwards compat fields
      entry: avgEntry,
      stop: currentStop,
      riskAmount,
    };
    setTrades([...trades, trade]);
    setForm(emptyForm);
    setTicked([]);
    setSymbolInfo(null);
    setStep(0);
  };

  const updateTrade = (id, updatedTrade) => {
    setTrades(trades.map(t => t.id === id ? updatedTrade : t));
  };
  const deleteTrade = (id) => setTrades(trades.filter(t => t.id !== id));

  const closedTrades = trades.filter(t => t.status === "closed").map(normalizeTrade);
  const openTrades = trades.filter(t => t.status === "open" || t.status === "partial").map(normalizeTrade);

  if (step === 1) return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button className="btn-ghost" style={{ padding: "8px 14px", fontSize: 12 }}
          onClick={() => { setStep(0); setSymbolInfo(null); }}>&lt; Back</button>
        <div className="section-title" style={{ fontSize: 22 }}>New Trade</div>
      </div>

      {/* Symbol */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Symbol</div>
        <div ref={containerRef} style={{ position: "relative" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="e.g. RELIANCE, TATASTEEL" value={form.symbol}
              onChange={e => handleSymbolChange(e.target.value)}
              onFocus={handleInputFocus}
              onKeyDown={handleInputKeyDown}
              style={{ textTransform: "uppercase", fontFamily: "var(--display)", fontSize: 20, letterSpacing: "0.04em", flex: 1 }} />
            {symbolInfo && (
              <button className="btn-ghost" style={{ padding: "10px 12px", fontSize: 12, whiteSpace: "nowrap" }}
                onClick={() => {
                  const entries = form.entries.map((e, i) => i === 0 ? { ...e, price: String(symbolInfo.price.toFixed(2)) } : e);
                  setForm(f => ({ ...f, entries }));
                }}>
                Use ₹
              </button>
            )}
          </div>
          <SymbolSuggestions suggestions={suggestions} onSelect={selectSuggestion} visible={showSuggestions} />
        </div>
        <PriceBadge info={symbolInfo} loading={fetchingSym} />
      </div>

      {/* Setup Type */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Setup Type</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {SETUP_TYPES.map(s => (
            <button key={s} className={`chip ${form.setupType === s ? "active" : ""}`}
              onClick={() => { setForm(f => ({ ...f, setupType: s })); setTicked([]); }}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <PreTradeChecklist setup={form.setupType} ticked={ticked}
        onToggle={(i) => setTicked(t => (t.includes(i) ? t.filter(x => x !== i) : [...t, i]))} />

      {/* Entry Legs */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div className="label">Entry Legs</div>
          {form.entries.length < 3 && (
            <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 11, borderRadius: 8 }}
              onClick={addEntryLeg}>
              + Add Leg
            </button>
          )}
        </div>
        {form.entries.map((leg, i) => (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: i < form.entries.length - 1 ? 10 : 0, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              {i === 0 && <div className="label">Entry Price</div>}
              <input type="number" placeholder="0.00" value={leg.price}
                onChange={e => updateEntry(i, "price", e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              {i === 0 && <div className="label">Qty</div>}
              <input type="number" placeholder="0" value={leg.qty}
                onChange={e => updateEntry(i, "qty", e.target.value)} />
            </div>
            {form.entries.length > 1 && (
              <button onClick={() => removeEntryLeg(i)}
                style={{ background: "none", color: "var(--text3)", fontSize: 18, padding: "12px 6px", lineHeight: 1 }}>
                ✕
              </button>
            )}
          </div>
        ))}
        {validLegs.length > 0 && (
          <div style={{ marginTop: 10, fontFamily: "var(--mono)", fontSize: 12, color: "var(--text2)", padding: "8px 10px", background: "var(--bg3)", borderRadius: 8 }}>
            Avg ₹{formAvgEntry.toFixed(2)} · Qty {formTotalQty}
            {formRisk > 0 && <> · Risk <span style={{ color: "var(--amber)" }}>{formatINR(formRisk)}</span></>}
          </div>
        )}
      </div>

      {/* Stop Loss */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Stop Loss</div>
        <input type="number" placeholder="0.00" value={form.currentStop}
          onChange={e => setForm(f => ({ ...f, currentStop: e.target.value }))} />
      </div>

      {/* Targets T1 T2 T3 */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 10 }}>Targets <span style={{ color: "var(--text3)" }}>(optional)</span></div>
        <div className="grid-3">
          {["T1", "T2", "T3"].map((label, i) => (
            <div key={i}>
              <div className="label">{label}</div>
              <input type="number" placeholder="0.00" value={form.targets[i]}
                onChange={e => {
                  const targets = [...form.targets];
                  targets[i] = e.target.value;
                  setForm(f => ({ ...f, targets }));
                }} />
            </div>
          ))}
        </div>
      </div>

      {/* Paper trade */}
      <div className="card" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
        <button className="chip" aria-pressed={!!form.paper} onClick={() => setForm(f => ({ ...f, paper: !f.paper }))}>{form.paper ? "✓ Paper trade" : "Paper trade"}</button>
        <span style={{ fontSize: 11, color: "var(--text3)", lineHeight: 1.4 }}>Practice without money: tracked in the journal and PLAYBOOK (Paper view), kept out of TODAY, open risk and your real stats.</span>
      </div>
      {/* Conviction */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Conviction <span style={{ fontFamily: "var(--mono)", color: "var(--amber)" }}>{form.conviction}/5</span></div>
        <div style={{ display: "flex", gap: 8 }}>
          {[1,2,3,4,5].map(v => (
            <button key={v} onClick={() => setForm(f => ({ ...f, conviction: v }))}
              style={{
                flex: 1, padding: "12px 0", borderRadius: 10, fontSize: 16,
                background: form.conviction >= v ? "rgba(220,20,60,0.08)" : "var(--bg3)",
                border: `1px solid ${form.conviction >= v ? "var(--violet)" : "var(--border2)"}`,
                color: form.conviction >= v ? "var(--violet)" : "var(--text3)",
              }}>
              ★
            </button>
          ))}
        </div>
      </div>

      {/* Notes */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="label" style={{ marginBottom: 8 }}>Trade Thesis</div>
        <textarea placeholder="Why this setup? What's the thesis? Where does the story break?" value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          rows={3}
          style={{ background: "var(--bg3)", border: "1.5px solid var(--border2)", color: "var(--text)", fontFamily: "var(--body)", fontSize: 14, padding: "12px 14px", borderRadius: 10, outline: "none", width: "100%", resize: "none" }} />
      </div>

      <button className="btn-primary" style={{ width: "100%" }}
        onClick={submitTrade}
        disabled={!form.symbol || validLegs.length === 0 || !form.currentStop}>
        Add to Book →
      </button>
    </div>
  );

  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div className="section-title">Journal</div>
        <button className="btn-primary" style={{ padding: "10px 18px", fontSize: 13 }}
          onClick={() => setStep(1)}>
          + New
        </button>
      </div>

      {openTrades.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="label" style={{ marginBottom: 8 }}>Open / Partial ({openTrades.length})</div>
          {openTrades.map(t => (
            <JournalTradeCard key={t.id} trade={t} onUpdateTrade={updateTrade} onDelete={deleteTrade} onOpenStock={onOpenStock} />
          ))}
        </div>
      )}

      {closedTrades.length > 0 && (
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Closed ({closedTrades.length})</div>
          {closedTrades.map(t => (
            <JournalTradeCard key={t.id} trade={t} onUpdateTrade={updateTrade} onDelete={deleteTrade} onOpenStock={onOpenStock} />
          ))}
        </div>
      )}

      {trades.length === 0 && (
        <div className="card" style={{ textAlign: "center", padding: "48px 20px" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📓</div>
          <div style={{ color: "var(--text2)", marginBottom: 8 }}>No trades yet</div>
          <div style={{ fontSize: 13, color: "var(--text3)" }}>Tap + New to log your first setup</div>
        </div>
      )}
    </div>
  );
}

// ─── JOURNAL TRADE CARD ───────────────────────────────────────────────────────
function JournalTradeCard({ trade, onUpdateTrade, onDelete, onOpenStock }) {
  const [mode, setMode] = useState(null); // null | "pyramid" | "updateSL" | "exit"
  const [pyramidForm, setPyramidForm] = useState({ price: "", qty: "", notes: "" });
  const [newSL, setNewSL] = useState("");
  const [exitForm, setExitForm] = useState({ qty: "", price: "", reason: "Manual", notes: "" });
  const [livePrice, setLivePrice] = useState(null);
  const [fetchingPrice, setFetchingPrice] = useState(false);

  const isActive = trade.status === "open" || trade.status === "partial";
  const pnlColor = (trade.pnl || 0) >= 0 ? "var(--green)" : "var(--red)";

  const entrySummary = trade.entries?.length > 1
    ? trade.entries.map(e => e.qty).join("+")
    : null;

  const unrealizedPnl = livePrice
    ? (livePrice.price - trade.avgEntry) * (trade.remainingQty || 0)
    : null;

  useEffect(() => {
    if (mode === "exit") {
      setExitForm(f => ({ ...f, qty: String(trade.remainingQty || trade.totalQty || 0) }));
    }
  }, [mode]);

  // Auto-fetch price on mount for active trades
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    let timerId = null;
    const run = async () => {
      const result = await fetchStockPrice(trade.symbol, { force: true });
      if (!cancelled && result) setLivePrice(result);
      timerId = setTimeout(run, getRefreshDelayMs(LIVE_REFRESH_INTERVAL_MS, CLOSED_REFRESH_INTERVAL_MS));
    };
    run();
    return () => { cancelled = true; if (timerId) clearTimeout(timerId); };
  }, [trade.symbol, isActive]);

  const handleRefreshPrice = async () => {
    setFetchingPrice(true);
    const result = await fetchStockPrice(trade.symbol, { force: true });
    setFetchingPrice(false);
    if (result) setLivePrice(result);
  };

  const handlePyramid = () => {
    if (!pyramidForm.price || !pyramidForm.qty) return;
    const newEntry = {
      price: parseFloat(pyramidForm.price),
      qty: parseInt(pyramidForm.qty),
      riskAmount: 0,
      date: new Date().toISOString(),
      notes: pyramidForm.notes,
    };
    const newEntries = [...(trade.entries || []), newEntry];
    const totalQty = newEntries.reduce((s, e) => s + e.qty, 0);
    const avgEntry = newEntries.reduce((s, e) => s + e.price * e.qty, 0) / totalQty;
    const addedQty = parseInt(pyramidForm.qty);
    const riskAmount = Math.abs(avgEntry - trade.currentStop) * totalQty;
    onUpdateTrade(trade.id, {
      ...trade,
      entries: newEntries,
      avgEntry,
      totalQty,
      remainingQty: (trade.remainingQty || 0) + addedQty,
      entry: avgEntry,
      riskAmount,
    });
    setPyramidForm({ price: "", qty: "", notes: "" });
    setMode(null);
  };

  const handleUpdateSL = () => {
    if (!newSL || isNaN(parseFloat(newSL))) return;
    const sl = parseFloat(newSL);
    const riskAmount = Math.abs(trade.avgEntry - sl) * (trade.remainingQty || trade.totalQty || 0);
    onUpdateTrade(trade.id, {
      ...trade,
      currentStop: sl,
      stop: sl,
      riskAmount,
    });
    setNewSL("");
    setMode(null);
  };

  const handleExit = () => {
    if (!exitForm.qty || !exitForm.price) return;
    const exitQty = Math.min(parseInt(exitForm.qty), trade.remainingQty || 0);
    const exitPrice = parseFloat(exitForm.price);
    const legPnl = (exitPrice - trade.avgEntry) * exitQty;
    const newExit = {
      price: exitPrice,
      qty: exitQty,
      pnl: legPnl,
      date: new Date().toISOString(),
      reason: exitForm.reason,
      notes: exitForm.notes,
    };
    const newExits = [...(trade.exits || []), newExit];
    const newRemainingQty = Math.max(0, (trade.remainingQty || 0) - exitQty);
    const totalPnl = newExits.reduce((s, e) => s + e.pnl, 0);
    const newStatus = newRemainingQty <= 0 ? "closed" : "partial";
    onUpdateTrade(trade.id, {
      ...trade,
      exits: newExits,
      remainingQty: newRemainingQty,
      pnl: totalPnl,
      status: newStatus,
      exitPrice,
      riskAmount: newRemainingQty > 0
        ? Math.abs(trade.avgEntry - trade.currentStop) * newRemainingQty
        : 0,
    });
    setExitForm({ qty: "", price: "", reason: "Manual", notes: "" });
    setMode(null);
  };

  // Expected P&L preview in exit form
  const exitPreviewPnl = exitForm.price && exitForm.qty
    ? (parseFloat(exitForm.price) - trade.avgEntry) * parseInt(exitForm.qty || 0)
    : null;

  return (
    <div className="trade-card">
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <div style={{ fontFamily: "var(--display)", fontSize: 22, letterSpacing: "0.04em" }}>{trade.symbol}</div>
              {onOpenStock && <button className="chip chip-sm" onClick={() => onOpenStock(normalizeSymbol(trade.symbol))}>Chart ›</button>}
            </div>
            {trade.status === "partial" && (
              <span className="tag" style={{ background: "rgba(59,130,246,0.10)", color: "var(--violet)", border: "1px solid rgba(59,130,246,0.3)" }}>PARTIAL</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
            <span className="tag" style={{ background: "rgba(212,204,182,0.06)", color: "var(--text)", border: "1px solid rgba(212,204,182,0.14)" }}>
              {trade.setupType}
            </span>
            <span className="tag" style={{ background: "var(--bg3)", color: "var(--text3)", border: "1px solid var(--border)" }}>
              {new Date(trade.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
            </span>
            {isActive && <DaysHeldBadge trade={trade} />}
            {"★".repeat(trade.conviction || 3).split("").map((_, i) =>
              <span key={i} style={{ color: "var(--amber)", fontSize: 10 }}>★</span>
            )}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          {isActive ? (
            livePrice ? (
              <div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 15 }}>₹{livePrice.price.toFixed(2)}</div>
                {livePrice.isEod ? (
                  <div style={{ fontSize: 10, color: "var(--text3)" }}>EOD</div>
                ) : (
                  <LiveChange q={livePrice} />
                )}
              </div>
            ) : (
              <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text3)" }}>
                ₹{(trade.avgEntry || trade.entry || 0).toFixed(2)}
                <div style={{ fontSize: 10, color: "var(--text3)" }}>Entry</div>
              </div>
            )
          ) : (
            <div style={{ fontFamily: "var(--mono)", fontSize: 16, color: pnlColor }}>
              {(trade.pnl || 0) >= 0 ? "+" : ""}{formatINR(trade.pnl || 0)}
            </div>
          )}
        </div>
      </div>

      {/* Core Metrics */}
      <div className="grid-2" style={{ marginBottom: 10 }}>
        <div className="card-sm">
          <div className="label">Avg Entry{entrySummary ? ` (${entrySummary})` : ""}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 14 }}>₹{(trade.avgEntry || 0).toFixed(2)}</div>
          {trade.totalQty > 0 && (
            <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>
              {isActive ? `${trade.remainingQty}/${trade.totalQty} shares` : `${trade.totalQty} shares`}
            </div>
          )}
        </div>
        <div className="card-sm">
          <div className="label">{isActive ? "Stop Loss" : "Exits"}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: isActive ? "var(--red)" : "var(--text2)" }}>
            {isActive ? `₹${trade.currentStop}` : `${(trade.exits || []).length} leg${(trade.exits || []).length !== 1 ? "s" : ""}`}
          </div>
          {isActive && trade.riskAmount > 0 && (
            <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>Risk {formatINR(trade.riskAmount)}</div>
          )}
        </div>
      </div>

      {/* Targets row */}
      {isActive && trade.targets?.some(t => t) && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {trade.targets.map((t, i) => t ? (
            <div key={i} className="card-sm" style={{ flex: 1, textAlign: "center", padding: "8px 6px" }}>
              <div className="label">T{i+1}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--green)" }}>₹{t}</div>
            </div>
          ) : null)}
        </div>
      )}

      {/* Unrealized P&L */}
      {isActive && unrealizedPnl !== null && (
        <div style={{
          padding: "8px 10px", borderRadius: 8, marginBottom: 10,
          background: unrealizedPnl >= 0 ? "rgba(212,204,182,0.06)" : "rgba(220,20,60,0.06)",
          border: `1px solid ${unrealizedPnl >= 0 ? "rgba(212,204,182,0.14)" : "rgba(220,20,60,0.14)"}`,
          display: "flex", justifyContent: "space-between", alignItems: "center"
        }}>
          <span style={{ fontSize: 12, color: "var(--text2)" }}>Unrealized P&L</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 500, color: unrealizedPnl >= 0 ? "var(--green)" : "var(--red)" }}>
            {unrealizedPnl >= 0 ? "+" : ""}{formatINR(unrealizedPnl)}
            {trade.avgEntry > 0 && (
              <span style={{ fontSize: 11, marginLeft: 6, opacity: 0.8 }}>
                ({((unrealizedPnl / (trade.avgEntry * (trade.remainingQty || 1))) * 100).toFixed(1)}%)
              </span>
            )}
          </span>
        </div>
      )}

      {/* Trade Notes */}
      {trade.notes && mode === null && (
        <div style={{ fontSize: 12, color: "var(--text3)", fontStyle: "italic", marginBottom: 10, padding: "8px 10px", background: "var(--bg3)", borderRadius: 8 }}>
          "{trade.notes}"
        </div>
      )}

      {/* Exit History (closed trades) */}
      {!isActive && (trade.exits || []).length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div className="label" style={{ marginBottom: 6 }}>Exit History</div>
          {(trade.exits || []).map((ex, i) => (
            <div key={i} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "7px 0",
              borderBottom: i < trade.exits.length - 1 ? "1px solid var(--border)" : "none"
            }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="tag" style={{ background: "var(--bg3)", color: "var(--text2)", border: "1px solid var(--border)", fontSize: 10, padding: "2px 7px" }}>
                  {ex.reason || "Exit"}
                </span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text2)" }}>
                  {ex.qty}sh @ ₹{(ex.price || 0).toFixed(2)}
                </span>
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 500, color: (ex.pnl || 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                {(ex.pnl || 0) >= 0 ? "+" : ""}{formatINR(ex.pnl || 0)}
              </span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, marginTop: 4, borderTop: "1px solid var(--border2)" }}>
            <span style={{ fontSize: 12, color: "var(--text2)" }}>Total P&L</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 14, fontWeight: 700, color: pnlColor }}>
              {(trade.pnl || 0) >= 0 ? "+" : ""}{formatINR(trade.pnl || 0)}
            </span>
          </div>
        </div>
      )}

      {/* Action Buttons — active trades, no mode */}
      {isActive && mode === null && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn-ghost" style={{ padding: "8px 11px", fontSize: 12, borderRadius: 10 }}
            onClick={handleRefreshPrice} disabled={fetchingPrice}>
            {fetchingPrice ? "..." : "↺ CMP"}
          </button>
          {(trade.entries?.length || 0) < 3 && (
            <button className="btn-ghost" style={{ padding: "8px 11px", fontSize: 12, borderRadius: 10 }}
              onClick={() => setMode("pyramid")}>
              + Leg
            </button>
          )}
          <button className="btn-ghost" style={{ padding: "8px 11px", fontSize: 12, borderRadius: 10 }}
            onClick={() => { setNewSL(String(trade.currentStop)); setMode("updateSL"); }}>
            SL ✎
          </button>
          <button className="btn-primary" style={{ flex: 1, padding: "8px 12px", fontSize: 13, borderRadius: 10 }}
            onClick={() => setMode("exit")}>
            Exit ↗
          </button>
          <button className="btn-ghost" style={{ padding: "8px 11px", fontSize: 13, borderRadius: 10, color: "var(--red)", borderColor: "rgba(220,20,60,0.2)" }}
            onClick={() => { if (confirm(`Delete ${trade.symbol}?`)) onDelete(trade.id); }}>
            🗑
          </button>
        </div>
      )}

      {/* Pyramid Form */}
      {mode === "pyramid" && (
        <div className="inline-form">
          <div className="label" style={{ marginBottom: 8 }}>Add to Position — {trade.symbol}</div>
          <div className="grid-2" style={{ marginBottom: 8 }}>
            <div>
              <div className="label">Price</div>
              <input type="number" placeholder="0.00" value={pyramidForm.price}
                onChange={e => setPyramidForm(f => ({ ...f, price: e.target.value }))} />
            </div>
            <div>
              <div className="label">Qty</div>
              <input type="number" placeholder="0" value={pyramidForm.qty}
                onChange={e => setPyramidForm(f => ({ ...f, qty: e.target.value }))} />
            </div>
          </div>
          <input placeholder="Notes (optional)" value={pyramidForm.notes}
            onChange={e => setPyramidForm(f => ({ ...f, notes: e.target.value }))}
            style={{ marginBottom: 8 }} />
          {pyramidForm.price && pyramidForm.qty && trade.entries?.length >= 1 && (() => {
            const allEntries = [...(trade.entries || [{ price: trade.avgEntry, qty: trade.totalQty }]), { price: parseFloat(pyramidForm.price), qty: parseInt(pyramidForm.qty) }];
            const tq = allEntries.reduce((s, e) => s + e.qty, 0);
            const ae = allEntries.reduce((s, e) => s + e.price * e.qty, 0) / tq;
            return (
              <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text2)", marginBottom: 8 }}>
                New avg: ₹{ae.toFixed(2)} · Total: {tq}sh
              </div>
            );
          })()}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary" style={{ flex: 1, padding: "10px" }} onClick={handlePyramid}>Add Entry</button>
            <button className="btn-ghost" style={{ padding: "10px 14px" }} onClick={() => setMode(null)}>✕</button>
          </div>
        </div>
      )}

      {/* Update SL Form */}
      {mode === "updateSL" && (
        <div className="inline-form">
          <div className="label" style={{ marginBottom: 8 }}>
            Update Stop Loss <span style={{ color: "var(--text3)" }}>(current: ₹{trade.currentStop})</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="number" placeholder="New SL price" value={newSL}
              onChange={e => setNewSL(e.target.value)} style={{ flex: 1 }} />
            <button className="btn-primary" style={{ padding: "10px 16px" }} onClick={handleUpdateSL}>✓</button>
            <button className="btn-ghost" style={{ padding: "10px 14px" }} onClick={() => setMode(null)}>✕</button>
          </div>
        </div>
      )}

      {/* Exit Form */}
      {mode === "exit" && (
        <div className="inline-form">
          <div className="label" style={{ marginBottom: 8 }}>
            Exit — {trade.symbol} <span style={{ color: "var(--text3)" }}>({trade.remainingQty} shares remaining)</span>
          </div>
          <div className="grid-2" style={{ marginBottom: 8 }}>
            <div>
              <div className="label">Qty to Exit</div>
              <input type="number" placeholder={String(trade.remainingQty)}
                value={exitForm.qty}
                onChange={e => setExitForm(f => ({ ...f, qty: e.target.value }))} />
            </div>
            <div>
              <div className="label">Exit Price</div>
              <input type="number" placeholder="0.00"
                value={exitForm.price}
                onChange={e => setExitForm(f => ({ ...f, price: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {["T1", "T2", "T3", "SL Hit", "Manual"].map(r => (
              <button key={r} className={`chip ${exitForm.reason === r ? "active" : ""}`}
                style={{ padding: "4px 10px", fontSize: 11 }}
                onClick={() => setExitForm(f => ({ ...f, reason: r }))}>
                {r}
              </button>
            ))}
          </div>
          <input placeholder="Exit notes (optional)" value={exitForm.notes}
            onChange={e => setExitForm(f => ({ ...f, notes: e.target.value }))}
            style={{ marginBottom: 8 }} />
          {exitPreviewPnl !== null && !isNaN(exitPreviewPnl) && (
            <div style={{
              fontSize: 12, fontFamily: "var(--mono)", marginBottom: 8,
              color: exitPreviewPnl >= 0 ? "var(--green)" : "var(--red)"
            }}>
              Expected: {exitPreviewPnl >= 0 ? "+" : ""}{formatINR(exitPreviewPnl)}
              {parseInt(exitForm.qty || 0) >= (trade.remainingQty || 0) ? " · Full Close" : ` · ${(trade.remainingQty || 0) - parseInt(exitForm.qty || 0)} shares remain`}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary" style={{ flex: 1, padding: "10px" }} onClick={handleExit}>
              {exitForm.qty && parseInt(exitForm.qty) >= (trade.remainingQty || 0) ? "Close Position" : "Partial Exit"}
            </button>
            <button className="btn-ghost" style={{ padding: "10px 14px" }} onClick={() => setMode(null)}>✕</button>
          </div>
        </div>
      )}

      {/* Remove button for closed trades */}
      {!isActive && mode === null && (
        <button onClick={() => onDelete(trade.id)}
          style={{ background: "none", color: "var(--text3)", fontSize: 12, padding: "4px 0", marginTop: 4 }}>
          Remove
        </button>
      )}
    </div>
  );
}

// ─── CSV EXPORT ──────────────────────────────────────────────────────────────
function exportTradesToCSV(trades, portfolio) {
  const closed = trades.filter(t => t.status === "closed").map(normalizeTrade);
  if (closed.length === 0) { alert("No closed trades to export."); return; }

  const headers = ["Date","Symbol","Setup Type","Entry","Stop","Target","Exit Price","Qty","Risk Amount","P&L","P&L%","Hold Days","Conviction","Notes"];

  const rows = closed.map(t => {
    const entryDate = new Date(t.date);
    const lastExit = (t.exits || []).slice(-1)[0];
    const exitDate = lastExit?.date ? new Date(lastExit.date) : entryDate;
    const holdDays = Math.max(0, Math.floor((exitDate - entryDate) / (1000 * 60 * 60 * 24)));
    const pnlPct = portfolio > 0 ? (((t.pnl || 0) / portfolio) * 100).toFixed(2) + "%" : "";
    const exitPrice = lastExit ? Number(lastExit.price).toFixed(2) : (t.exitPrice ? Number(t.exitPrice).toFixed(2) : "");
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    return [
      entryDate.toLocaleDateString("en-IN"),
      t.symbol,
      t.setupType || "",
      (t.avgEntry || t.entry || 0).toFixed(2),
      (t.currentStop || t.stop || ""),
      (t.targets?.[0] ?? ""),
      exitPrice,
      t.totalQty || "",
      (t.riskAmount || 0).toFixed(2),
      (t.pnl || 0).toFixed(2),
      pnlPct,
      holdDays,
      t.conviction || "",
      esc(t.notes || ""),
    ].join(",");
  });

  const csv = [headers.join(","), ...rows].join("\n");
  const date = new Date().toISOString().slice(0, 10);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `tradedesk-journal-${date}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ─── ANALYTICS PAGE ──────────────────────────────────────────────────────────
function AnalyticsPage({ trades, portfolio }) {
  const closed = trades.filter(t => t.status === "closed");
  const open = trades.filter(t => t.status === "open" || t.status === "partial");
  const wins = closed.filter(t => (t.pnl || 0) > 0);
  const losses = closed.filter(t => (t.pnl || 0) < 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const winRate = closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s,t)=>s+(t.pnl||0),0)/wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s,t)=>s+(t.pnl||0),0)/losses.length) : 0;
  const expectancy = closed.length > 0 ? totalPnl / closed.length : 0;

  const setupStats = SETUP_TYPES.map(st => {
    const ts = closed.filter(t => t.setupType === st);
    const w = ts.filter(t => (t.pnl || 0) > 0).length;
    return { name: st, total: ts.length, wins: w, wr: ts.length > 0 ? ((w/ts.length)*100).toFixed(0) : 0 };
  }).filter(s => s.total > 0);

  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      <div style={{ marginBottom: 16 }}>
        <div className="section-title">Analytics</div>
        <div style={{ fontSize: 13, color: "var(--text3)", marginTop: 4 }}>
          {closed.length} closed · {open.length} open
        </div>
      </div>

      {/* P&L Hero */}
      <div className="card" style={{
        marginBottom: 14,
        background: totalPnl >= 0 ? "rgba(212,204,182,0.06)" : "rgba(220,20,60,0.06)",
        border: `1px solid ${totalPnl >= 0 ? "rgba(212,204,182,0.14)" : "rgba(220,20,60,0.14)"}`,
      }}>
        <div className="label">Total P&L</div>
        <div className="big-num" style={{ color: totalPnl >= 0 ? "var(--green)" : "var(--red)", marginTop: 4 }}>
          {totalPnl >= 0 ? "+" : ""}{formatINR(totalPnl)}
        </div>
        <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>
          {pct(totalPnl, portfolio)}% of portfolio
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid-2" style={{ marginBottom: 14 }}>
        {[
          { l: "Win Rate", v: `${winRate}%`, c: parseFloat(winRate) > 50 ? "var(--green)" : "var(--red)" },
          { l: "Trades", v: closed.length, c: "var(--text)" },
          { l: "Avg Win", v: formatINR(avgWin), c: "var(--green)" },
          { l: "Avg Loss", v: formatINR(avgLoss), c: "var(--red)" },
        ].map(({ l, v, c }) => (
          <div key={l} className="card-sm">
            <div className="label">{l}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: c, marginTop: 4 }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Expectancy */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="result-row">
          <span className="result-label">Expectancy per trade</span>
          <span className="result-val" style={{ color: expectancy >= 0 ? "var(--green)" : "var(--red)" }}>
            {formatINR(expectancy)}
          </span>
        </div>
        <div className="result-row">
          <span className="result-label">Profit Factor</span>
          <span className="result-val">
            {avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : "—"}
          </span>
        </div>
      </div>

      <MarketContextStats closed={closed} />
      <DisciplineStats closed={closed} portfolio={portfolio} />
      <EquityRisk closed={closed} portfolio={portfolio} />
      <ExitReplay closed={closed} />

      {/* By Setup */}
      {setupStats.length > 0 && (
        <div className="card">
          <div className="label" style={{ marginBottom: 12 }}>By Setup Type</div>
          {setupStats.map(s => (
            <div key={s.name} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 13 }}>{s.name}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: parseFloat(s.wr) > 50 ? "var(--green)" : "var(--amber)" }}>
                  {s.wr}% ({s.wins}/{s.total})
                </span>
              </div>
              <div style={{ height: 4, background: "var(--border)", borderRadius: 2 }}>
                <div style={{ height: "100%", width: `${s.wr}%`, background: parseFloat(s.wr) > 50 ? "var(--green)" : "var(--amber)", borderRadius: 2, transition: "width 0.8s ease" }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {closed.length === 0 && (
        <div className="card" style={{ textAlign: "center", padding: "48px 20px" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📈</div>
          <div style={{ color: "var(--text2)", marginBottom: 8 }}>No closed trades yet</div>
          <div style={{ fontSize: 13, color: "var(--text3)" }}>Analytics will appear after you close trades</div>
        </div>
      )}

      {closed.length > 0 && (
        <button className="btn-ghost" style={{ width: "100%", marginTop: 4, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          onClick={() => exportTradesToCSV(trades, portfolio)}>
          ↓ Export CSV
        </button>
      )}
    </div>
  );
}

// ─── MARKET QUADRANT — UI (data/compute lives in marketQuadrant.js) ──────────
const MQ_SIGNAL_COLOR = { INVEST: C.pos, SELECTIVE: C.warn, CASH: C.neg };
const MQ_SIGNAL_BG    = { INVEST: "rgba(74,222,128,0.08)", SELECTIVE: "rgba(245,158,11,0.08)", CASH: "rgba(220,20,60,0.08)" };
const MQ_DIM_COLOR    = {
  BULL: C.pos, BEAR: C.neg, UP: C.pos, DOWN: C.neg, SIDEWAYS: C.warn,
  UPSWING: C.pos, DOWNSWING: C.neg, CHOPPY: C.muted,
  POSITIVE: C.pos, NEGATIVE: C.neg, IMPROVING: C.pos, WORSENING: C.neg,
  RISING: C.pos, FALLING: C.neg, HOT: C.pos, WARM: C.lime, COOL: C.muted, COLD: C.neg,
};
const MQ_ENV_COLOR = { "EASY MONEY": C.pos, "HARD MONEY": C.warn, "NO MONEY": C.neg };
// Breadth chart series — validated categorical palette for the #141414 surface (all checks pass)
const MQ_SERIES = [
  { key: "p200", label: "200-SMA", color: "#3987E5" },
  { key: "p50",  label: "50-SMA",  color: "#D9632B" },
  { key: "p10",  label: "10-SMA",  color: "#A06CD5" },
];
const MQ_POS_RULE = {
  INVEST: "Full size · all A-grade setups · sectors HOT/WARM",
  SELECTIVE: "Half size · highest RS only · skip COLD sectors",
  CASH: "No new entries · hold only if stop not hit",
};

configureSharedStore(getSupabaseClient);

function mqFmtDate(d) {
  try { return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }); }
  catch (_) { return d; }
}
// Days between an "YYYY-MM-DD" date and today (IST)
function mqAgeDays(asOf) {
  if (!asOf) return Infinity;
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  return Math.round((Date.parse(today) - Date.parse(asOf)) / 86400000);
}
/** Market signal to stamp on a trade opened now (null if no recent data). */
function currentMarketSignal() {
  const d = getLastMarketQuadrant();
  return d && mqAgeDays(d.as_of) <= 4 ? d.overall : null;
}

function useMarketQuadrant() {
  const [data, setData] = useState(() => getLastMarketQuadrant());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState({ msg: "Initialising…", pct: 0 });
  const alive = useRef(true);

  const run = async (force = false) => {
    setError(null);
    if (force) setRefreshing(true); else setLoading(true);
    try {
      const result = await loadMarketQuadrant({ force });
      if (alive.current) setData(result);
    } catch (e) {
      if (alive.current) setError(e.message || String(e));
    } finally {
      if (alive.current) { setLoading(false); setRefreshing(false); }
    }
  };

  useEffect(() => {
    alive.current = true;
    const unsub = subscribeProgress((msg, pct) => alive.current && setProgress({ msg, pct }));
    run();
    // During market hours, breadth is re-checked while the app is open (results older than
    // 20 minutes are recomputed; marked "intraday" until NSE's official close).
    const timer = setInterval(() => { if (isMarketOpen() && alive.current) run(false); }, 10 * 60 * 1000);
    return () => { alive.current = false; unsub(); clearInterval(timer); };
  }, []);

  return { data, loading, refreshing, error, progress, refresh: () => run(true), retry: () => run(false) };
}

function MqDelta({ cur, prev, digits = 1, unit = "" }) {
  if (cur == null || prev == null) return null;
  const d = +(cur - prev).toFixed(digits);
  if (d === 0) return <span style={{ color: "var(--text3)", fontSize: 10, fontFamily: "var(--mono)" }}> ±0</span>;
  return (
    <span style={{ color: d > 0 ? C.pos : C.neg, fontSize: 10, fontFamily: "var(--mono)", whiteSpace: "nowrap" }}>
      {" "}{d > 0 ? "▲ +" : "▼ "}{d}{unit}
    </span>
  );
}

function BreadthBar({ label, pct, prev, count, total }) {
  const fill = pct >= 50 ? C.pos : pct >= 30 ? C.muted : C.neg;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 8 }}>
        <span style={{ fontSize: 12, color: "var(--text2)" }}>{label}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)", textAlign: "right" }}>
          {pct.toFixed(1)}%<MqDelta cur={pct} prev={prev} /> <span style={{ color: "var(--text3)" }}>({count}/{total})</span>
        </span>
      </div>
      <div style={{ height: 4, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: fill, borderRadius: 4, transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}

function NNHBadge({ label, value }) {
  const color = value > 0 ? C.pos : value < 0 ? C.neg : "var(--text3)";
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 15, fontWeight: 700, color }}>
        {value > 0 ? "+" : ""}{value}
      </div>
    </div>
  );
}

const mqCardStyle = { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14, padding: 14, marginBottom: 14 };
const mqHeadStyle = { fontSize: 10, color: "var(--text3)", letterSpacing: "0.14em", fontWeight: 700 };

// Trading environment (easy / hard / no money), lockout-rally warning, momentum leaders
function MqEnvironment({ data }) {
  const env = data?.environment;
  if (!env) return null;
  const c = MQ_ENV_COLOR[env.name] || C.muted;
  return (
    <div style={{ ...mqCardStyle, borderColor: `${c}55`, background: `${c}0D` }}>
      <div style={{ ...mqHeadStyle, marginBottom: 6 }}>ENVIRONMENT</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: c, letterSpacing: "-0.01em" }}>{env.name}</div>
      <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 4, lineHeight: 1.45 }}>{env.text}</div>
      {env.lockout && (
        <div style={{ marginTop: 10, border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.08)", borderRadius: 10, padding: "8px 10px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.warn, letterSpacing: "0.08em", marginBottom: 3 }}>🔒 LOCKOUT RALLY</div>
          <div style={{ fontSize: 11, color: "var(--text2)", lineHeight: 1.45 }}>{env.lockout_text.replace(/^Lockout rally: (\w)/, (_, ch) => ch.toUpperCase())}</div>
        </div>
      )}
      {data.momentum_leaders?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 5 }}>Momentum leaders · sector avg 1-month return</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {data.momentum_leaders.map(m => (
              <span key={m.name} style={{ fontSize: 11, border: "1px solid var(--border)", borderRadius: 14, padding: "3px 9px", color: "var(--text)", background: "var(--bg2)" }}>
                {m.name} <span style={{ fontFamily: "var(--mono)", color: C.pos }}>+{m.ret1m}%</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const FT_COLOR = { STRONG: C.pos, MIXED: C.warn, WEAK: C.neg, "NO PIVOTS": C.muted };

// Do strong breakout days keep going? (pocket-pivot follow-through) + 52-week-lows check
function MqFollowThrough({ data }) {
  const ft = data?.follow_through;
  const lowsOk = data?.lows_ok;
  const c = FT_COLOR[ft?.label] || "var(--text3)";
  const hist = ft?.history || [];
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 8 }}>FOLLOW-THROUGH & RISK CHECKS</div>
      {ft ? (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 26, fontWeight: 800, color: c }}>{ft.rate ?? "—"}{ft.rate != null && <span style={{ fontSize: 13 }}>%</span>}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: c, letterSpacing: "0.08em" }}>{ft.label}</span>
            <span style={{ fontSize: 11, color: "var(--text3)" }}>{ft.events} breakouts in 10 sessions · avg {ft.avg_gain > 0 ? "+" : ""}{ft.avg_gain}% since</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 4, lineHeight: 1.45 }}>
            Share of recent pocket pivots (≥4.5% up on rising, above-average volume) still above their breakout close.
          </div>
          {/* last 40 sessions */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 34, marginTop: 10 }} aria-label="Follow-through, last 40 sessions">
            {hist.map(h => (
              <div key={h.d} title={`${mqFmtDate(h.d)}: ${h.rate ?? "—"}% of ${h.events}`}
                style={{ flex: 1, height: `${Math.max(4, h.rate ?? 0)}%`, borderRadius: 2,
                  background: h.rate == null ? "var(--border)" : h.rate >= FT_BANDS.strong ? C.pos : h.rate >= FT_BANDS.weak ? C.warn : C.neg, opacity: 0.8 }} />
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", marginTop: 3 }}>
            <span>{hist[0] ? mqFmtDate(hist[0].d) : ""}</span><span>now</span>
          </div>
          <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 8, lineHeight: 1.45 }}>
            Backtest ({FT_CALIBRATION.period}): at ≥{FT_BANDS.strong}%, new breakouts were higher 10 sessions later {FT_CALIBRATION.strongWin}% of the time (avg +{FT_CALIBRATION.strongRet}%); below that it was ≈{FT_CALIBRATION.otherWin}% — a coin flip.
          </div>
        </>
      ) : (
        <div style={{ fontSize: 11, color: "var(--text3)" }}>Volume data unavailable — tap ↻ Refresh.</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
        <span style={{ fontSize: 14 }}>{lowsOk ? "✅" : "⚠️"}</span>
        <div style={{ fontSize: 11, color: "var(--text2)" }}>
          <b style={{ color: lowsOk ? C.pos : C.warn }}>{data.new_lows} stocks at 52-week lows</b>
          {lowsOk ? ` — low enough for full size (≤ ${data.lows_ok_max}).` : ` — above ${data.lows_ok_max}: keep size reduced until lows dry up.`}
        </div>
      </div>
    </div>
  );
}

// Says whether today's closes were checked against NSE's official bhavcopy
function MqVerificationBadge({ data }) {
  const v = data?.verification;
  const verified = v && v.date === data.as_of;
  let color, text, detail;
  if (verified) {
    color = C.pos;
    text = `✓ Closes for ${mqFmtDate(v.date)} verified against NSE`;
    detail = `${v.checked} stocks checked against NSE's official bhavcopy` +
      (v.corrected ? ` · ${v.corrected} corrected to NSE values` : "") +
      (v.filled ? ` · ${v.filled} missing on Yahoo, filled from NSE` : "") +
      (!v.corrected && !v.filled ? " · all matched" : "") +
      (v.appended ? " · latest day added from NSE" : "") +
      (v.missing ? ` · ${v.missing} not in bhavcopy` : "");
  } else if (!data.final) {
    color = "var(--text3)";
    text = "Intraday — live prices, not yet official";
    detail = "Updates about every 20 minutes while the market is open; re-checked against NSE's official closes after ~6 pm IST.";
  } else {
    color = "var(--amber)";
    text = "Awaiting NSE's official closes";
    detail = v ? `Last verified ${mqFmtDate(v.date)}. NSE publishes the bhavcopy around 6 pm IST; this rechecks every 30 min.`
               : "NSE bhavcopy not reachable right now; using Yahoo closes. Rechecks every 30 min.";
  }
  return (
    <div style={{ ...mqCardStyle, padding: "10px 14px", borderColor: verified ? "rgba(74,222,128,0.25)" : "var(--border)" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color }}>{text}</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 3 }}>{detail}</div>
      {verified && v.examples?.length > 0 && (
        <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", marginTop: 6 }}>{v.examples.slice(0, 3).join(" · ")}</div>
      )}
    </div>
  );
}

// 52 weekly blocks, oldest → newest
function MqSignalTimeline({ history }) {
  const weeks = [];
  for (let i = history.length - 1; i >= 0 && weeks.length < 52; i -= 5) weeks.unshift(history[i]);
  const counts = { INVEST: 0, SELECTIVE: 0, CASH: 0 };
  weeks.forEach(w => { if (w.sig) counts[w.sig]++; });
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 10 }}>SIGNAL TIMELINE · {weeks.length} WEEKS</div>
      <div style={{ display: "flex", gap: 2, height: 22 }}>
        {weeks.map(w => (
          <div key={w.d} title={`Week of ${mqFmtDate(w.d)}: ${w.sig || "—"}`}
            style={{ flex: 1, borderRadius: 2, background: MQ_SIGNAL_COLOR[w.sig] || "var(--border)", opacity: 0.85 }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)" }}>
        <span>{weeks[0] ? mqFmtDate(weeks[0].d) : ""}</span>
        <span>now</span>
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 11, color: "var(--text2)", flexWrap: "wrap" }}>
        {MQ_SIGNALS.map(s => (
          <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: MQ_SIGNAL_COLOR[s] }} />
            {s} <span style={{ color: "var(--text3)", fontFamily: "var(--mono)" }}>{counts[s]}w</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// % of stocks above each SMA over the last ~12 months, with a daily signal strip underneath
function MqBreadthChart({ history }) {
  const pts = history.slice(-250);
  const [hover, setHover] = useState(null);
  const W = 340, H = 140, padL = 26, padR = 6, padT = 8, padB = 4, stripH = 6;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (i) => padL + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * plotW);
  const y = (v) => padT + (1 - v / 100) * plotH;
  const path = (key) => {
    let d = "", pen = false;
    pts.forEach((p, i) => {
      if (p[key] == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - padL) / plotW) * (pts.length - 1));
    setHover(Math.max(0, Math.min(pts.length - 1, i)));
  };
  const latest = pts[pts.length - 1] || {};
  const hp = hover != null ? pts[hover] : null;
  const tipLeftPct = hover != null ? (x(hover) / W) * 100 : 0;

  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 8 }}>BREADTH · % OF STOCKS ABOVE SMA · 12 MONTHS</div>
      {/* Legend with latest values (direct labels) */}
      <div style={{ display: "flex", gap: 14, marginBottom: 8, flexWrap: "wrap" }}>
        {MQ_SERIES.map(s => (
          <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text2)" }}>
            <span style={{ width: 12, height: 2, borderRadius: 1, background: s.color }} />
            {s.label} <span style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>{latest[s.key] ?? "—"}%</span>
          </span>
        ))}
      </div>
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H + stripH + 4}`} width="100%" style={{ display: "block", touchAction: "pan-y" }}
          onMouseMove={onMove} onMouseLeave={() => setHover(null)}
          onTouchStart={(e) => onMove(e.touches[0] ? { currentTarget: e.currentTarget, clientX: e.touches[0].clientX } : e)}
          onTouchMove={(e) => onMove(e.touches[0] ? { currentTarget: e.currentTarget, clientX: e.touches[0].clientX } : e)}
          onTouchEnd={() => setHover(null)}
          role="img" aria-label="Breadth history: percent of Nifty 500 stocks above their 200, 50 and 10 day moving averages">
          {[0, 50, 100].map(v => (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" strokeDasharray={v === 50 ? "3 3" : undefined} />
              <text x={padL - 4} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--text3)" fontFamily="var(--mono)">{v}</text>
            </g>
          ))}
          {MQ_SERIES.map(s => (
            <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {/* Daily signal strip */}
          {pts.map((p, i) => (
            <rect key={p.d} x={x(i) - plotW / pts.length / 2} y={H + 2} width={plotW / pts.length + 0.3} height={stripH}
              fill={MQ_SIGNAL_COLOR[p.sig] || "var(--border)"} opacity="0.75" />
          ))}
          {hp && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H} stroke="var(--text3)" strokeWidth="1" />
              {MQ_SERIES.map(s => hp[s.key] != null && (
                <circle key={s.key} cx={x(hover)} cy={y(hp[s.key])} r="3.5" fill={s.color} stroke="var(--bg2)" strokeWidth="2" />
              ))}
            </g>
          )}
        </svg>
        {hp && (
          <div style={{
            position: "absolute", top: 0, pointerEvents: "none",
            left: `${tipLeftPct}%`, transform: tipLeftPct > 55 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
            background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 8px",
            fontSize: 11, fontFamily: "var(--mono)", color: "var(--text)", whiteSpace: "nowrap", zIndex: 2,
          }}>
            <div style={{ color: "var(--text3)", marginBottom: 3 }}>{mqFmtDate(hp.d)}</div>
            {MQ_SERIES.map(s => (
              <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 2, background: s.color }} />
                <span style={{ color: "var(--text2)" }}>{s.label}</span>
                <span style={{ marginLeft: "auto" }}>{hp[s.key] ?? "—"}%</span>
              </div>
            ))}
            <div style={{ marginTop: 3, color: MQ_SIGNAL_COLOR[hp.sig] || "var(--text3)", fontWeight: 700 }}>{hp.sig || "—"}</div>
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)" }}>
        <span>{pts[0] ? mqFmtDate(pts[0].d) : ""}</span>
        <span>strip = daily signal</span>
        <span>{latest.d ? mqFmtDate(latest.d) : ""}</span>
      </div>
    </div>
  );
}

// Tap a sector → its strongest stocks appear at the top of the card (tap again to close)
function MqSectorGrid({ sectors, sectorStocks, selected, onSelect, onPickStock }) {
  const panelRef = useRef(null);
  useEffect(() => {
    if (selected && panelRef.current) panelRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selected]);
  if (!sectors?.length) return null;
  const sel = sectors.find(s => s.name === selected);
  const stocks = selected ? sectorStocks?.[selected] : null;
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>SECTOR BREADTH</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 10 }}>% of stocks above 50-SMA · change vs 20 days ago · tap a sector for its stocks</div>

      {sel && (
        <div ref={panelRef} style={{ border: `1px solid ${(MQ_DIM_COLOR[sel.status] || C.muted)}55`, borderRadius: 12, padding: "10px 12px", marginBottom: 10, background: "var(--bg3)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{sel.name}</span>
              <span style={{ fontSize: 10, color: MQ_DIM_COLOR[sel.status], fontWeight: 700, marginLeft: 6 }}>{sel.status}</span>
            </div>
            <button onClick={() => onSelect(null)} aria-label="Close sector stocks"
              style={{ background: "none", border: "none", color: "var(--text3)", fontSize: 16, cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
          </div>
          <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 6 }}>
            Strongest first: above 50-SMA, then 3-month return · tap a stock for its chart
          </div>
          {!stocks ? (
            <div style={{ fontSize: 11, color: "var(--amber)" }}>Tap ↻ Refresh below to load this sector's stocks.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 10, fontSize: 12 }}>
              {["STOCK", "1M", "3M", "HIGH"].map((hd, i) => (
                <span key={hd} style={{ fontSize: 9, color: "var(--text3)", paddingBottom: 4, textAlign: i ? "right" : "left" }}>{hd}</span>
              ))}
              {stocks.map(st => {
                const pctCell = (v) => (
                  <div style={{ padding: "5px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: v == null ? "var(--text3)" : v >= 0 ? C.pos : C.neg }}>
                    {v == null ? "—" : `${v > 0 ? "+" : ""}${v}%`}
                  </div>
                );
                return (
                  <Fragment key={st.sym}>
                    <div style={{ padding: "5px 0", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span title={st.a50 ? "Above 50-SMA" : "Below 50-SMA"}
                        style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: st.a50 ? C.pos : "var(--border2)" }} />
                      <button onClick={() => onPickStock?.(st.sym)} title={`Open ${st.sym}`}
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", font: "inherit", fontFamily: "var(--display)", fontWeight: 700, letterSpacing: "0.02em", overflow: "hidden", textOverflow: "ellipsis", textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{st.sym}</button>
                      {st.a200 && <span style={{ fontSize: 9.5, color: "var(--text3)" }} title="Above 200-SMA">200↑</span>}
                    </div>
                    {pctCell(st.ret1m)}
                    {pctCell(st.ret3m)}
                    <div style={{ padding: "5px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: "var(--text2)" }}>
                      {st.off_high == null ? "—" : `${st.off_high}%`}
                    </div>
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {sectors.map(s => {
          const c = MQ_DIM_COLOR[s.status] || C.muted;
          const active = s.name === selected;
          return (
            <button key={s.name} onClick={() => onSelect(active ? null : s.name)} aria-pressed={active}
              style={{ textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer",
                border: `1px solid ${active ? c : `${c}33`}`, background: active ? `${c}24` : `${c}0F`,
                borderRadius: 10, padding: "8px 10px", minWidth: 0, boxShadow: active ? `0 0 0 1px ${c}` : "none" }}>
              <div style={{ fontSize: 11, color: "var(--text2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={`${s.name} · ${s.n} stocks`}>{s.name}</div>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 3, gap: 4 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{s.p50 ?? "—"}%</span>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: c }}>{s.status}</span>
              </div>
              <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", marginTop: 2 }}>
                {s.n} stk{s.p50_chg != null && <MqDelta cur={s.p50_chg} prev={0} />}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MqLeaders({ leaders, sector, onClear, onPickStock }) {
  if (!leaders?.length) {
    return sector ? (
      <div style={{ ...mqCardStyle, fontSize: 12, color: "var(--text3)" }}>
        No {sector} stock is in the Nifty 500 leaders list right now.{" "}
        <button onClick={onClear} style={{ background: "none", border: "none", color: "var(--text2)", textDecoration: "underline", cursor: "pointer", font: "inherit", padding: 0 }}>Show all leaders</button>
      </div>
    ) : null;
  }
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span>LEADERS{sector ? ` · ${sector.toUpperCase()}` : ""}</span>
        {sector && (
          <button onClick={onClear} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 12, color: "var(--text2)", fontSize: 10, padding: "2px 8px", cursor: "pointer", letterSpacing: 0, fontWeight: 400 }}>
            All sectors ×
          </button>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 10 }}>Above 10/50/200-SMA, within 5% of 52w high · ranked by 12-month return</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", columnGap: 12, rowGap: 0, fontSize: 12 }}>
        <span style={{ fontSize: 10, color: "var(--text3)", paddingBottom: 6 }}>STOCK</span>
        <span style={{ fontSize: 10, color: "var(--text3)", textAlign: "right" }}>12M</span>
        <span style={{ fontSize: 10, color: "var(--text3)", textAlign: "right" }}>FROM HIGH</span>
        {leaders.map(l => (
          <Fragment key={l.sym}>
            <div style={{ padding: "6px 0", borderTop: "1px solid var(--border)", minWidth: 0 }}>
              <button onClick={() => onPickStock?.(l.sym)} title={`Open ${l.sym}`}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", font: "inherit", fontFamily: "var(--display)", fontWeight: 700, letterSpacing: "0.02em", textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{l.sym}</button>
              <div style={{ fontSize: 10, color: "var(--text3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.sector}</div>
            </div>
            <div style={{ padding: "6px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: (l.ret12m ?? 0) >= 0 ? C.pos : C.neg }}>
              {l.ret12m == null ? "—" : `${l.ret12m > 0 ? "+" : ""}${l.ret12m}%`}
            </div>
            <div style={{ padding: "6px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: "var(--text2)" }}>
              {l.off_high}%
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function MarketQuadrantPage({ onPickStock }) {
  const { data, loading, refreshing, error, progress, refresh, retry } = useMarketQuadrant();
  const [sector, setSector] = useState(null); // tapped sector → its stocks shown first
  const header = <div className="section-title" style={{ marginBottom: 10 }}>Market</div>;
  const [mseg, setMseg] = useState(() => { try { return localStorage.getItem("td_market_seg") || "signal"; } catch (_) { return "signal"; } });
  const pickM = (k) => { setMseg(k); try { localStorage.setItem("td_market_seg", k); } catch (_) {} window.scrollTo(0, 0); };

  if (loading && !data?.history) return (
    <div className="fade-in" style={{ padding: "20px 16px 100px" }}>
      {header}
      <div style={{ textAlign: "center", padding: "60px 0", color: "var(--text3)", fontSize: 13 }}>
        <div style={{ marginBottom: 12 }}>{progress.msg}</div>
        <div style={{ height: 3, background: "var(--border)", borderRadius: 3, overflow: "hidden", maxWidth: 240, margin: "0 auto 12px" }}>
          <div style={{ height: "100%", width: `${Math.round(progress.pct)}%`, background: "var(--text2)", transition: "width 0.4s ease" }} />
        </div>
        <div style={{ fontSize: 11 }}>First run of the day fetches 500 stocks — may take 10–30 s</div>
      </div>
    </div>
  );

  if (error && !data?.history) return (
    <div className="fade-in" style={{ padding: "20px 16px 100px" }}>
      {header}
      <div style={{ background: "rgba(220,20,60,0.06)", border: "1px solid rgba(220,20,60,0.2)", borderRadius: 12, padding: 16, color: "var(--red)", fontSize: 13 }}>{error}</div>
      <button className="btn-ghost" style={{ width: "100%", marginTop: 12 }} onClick={retry}>Retry</button>
    </div>
  );

  if (!data?.history) return null;

  const h = data.history;
  const prev = h.length >= 2 ? h[h.length - 2] : null;
  const sigColor = MQ_SIGNAL_COLOR[data.overall] || C.muted;
  const sigBg    = MQ_SIGNAL_BG[data.overall]    || "var(--bg2)";
  const changed  = prev?.sig && prev.sig !== data.overall;

  const updatedAt = (() => {
    try {
      return new Date(data.updated_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) + " IST";
    } catch (_) { return data.updated_at; }
  })();

  const swingConfLabel = data.swing_confidence >= 60 ? "HIGH" : data.swing_confidence >= 40 ? "MEDIUM" : data.swing_confidence >= 20 ? "LOW" : "ZERO";
  const swingConfColor = data.swing_confidence >= 60 ? C.pos : data.swing_confidence >= 40 ? C.warn : "var(--text3)";

  return (
    <div className="fade-in" style={{ padding: "20px 16px 100px" }}>
      {header}

      {error && (
        <div style={{ background: "rgba(220,20,60,0.06)", border: "1px solid rgba(220,20,60,0.2)", borderRadius: 10, padding: "8px 12px", color: "var(--red)", fontSize: 12, marginBottom: 12 }}>
          Refresh failed: {error} Showing the last result.
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {[["signal", "Signal"], ["breadth", "Breadth"], ["sectors", "Sectors"], ["flows", "Money flow"]].map(([k, l]) => <button key={k} className="chip" aria-pressed={mseg === k} onClick={() => pickM(k)} style={{ flex: "1 0 auto" }}>{l}</button>)}
      </div>
      {mseg === "signal" && <>
      <div id="q-signal" style={{ scrollMarginTop: 100 }}><Guide id="signal" d={data} compact /></div>
      {/* ── Overall Signal ── */}
      <div style={{ background: sigBg, border: `1px solid ${sigColor}33`, borderRadius: 18, padding: "20px 16px", marginBottom: 14, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "var(--text3)", letterSpacing: "0.14em", marginBottom: 8 }}>OVERALL SIGNAL</div>
        <div style={{ fontSize: 40, fontWeight: 800, color: sigColor, letterSpacing: "-0.03em", lineHeight: 1, fontFamily: "var(--display)" }}>
          {data.overall}
        </div>
        {changed && (
          <div style={{ display: "inline-block", marginTop: 10, fontSize: 11, fontWeight: 700, color: "var(--text)", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 20, padding: "3px 10px" }}>
            Changed from <span style={{ color: MQ_SIGNAL_COLOR[prev.sig] }}>{prev.sig}</span> on {mqFmtDate(data.as_of)}
          </div>
        )}
        <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 8 }}>
          Nifty 500 · {data.total} stocks · {data.phase_weeks > 0 ? `${data.phase_weeks}w in this phase` : "new phase"} · as of {mqFmtDate(data.as_of)}{data.final ? "" : " (intraday)"}
        </div>
        <div style={{ fontSize: 11, color: sigColor, marginTop: 6, fontWeight: 600 }}>{data.environment ? briefRule(data) : MQ_POS_RULE[data.overall]}</div>
        {data.thrust_detected && (
          <div style={{ marginTop: 10, background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.3)", borderRadius: 8, padding: "6px 10px", fontSize: 11, color: C.pos, fontWeight: 700, letterSpacing: "0.1em" }}>
            ⚡ BREADTH THRUST DETECTED
          </div>
        )}
      </div>


      <MqVerificationBadge data={data} />

      <MqSignalTimeline history={h} />

      <QuadSection id="dims" title="The four readings" d={data} />
      {/* ── Four Dimensions ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        {[
          {
            label: "BIAS", value: data.bias,
            tag: data.bias_turning ? `TURNING ${data.bias === "BEAR" ? "UP" : "DOWN"}` : null,
            tagColor: data.bias === "BEAR" ? C.pos : C.neg,
            sub: <>{data.pct_above_200}% &gt; 200-SMA<MqDelta cur={data.pct_above_200} prev={prev?.p200} /></>,
            note: data.bias_turning ? `${data.bias_days}/${data.bias_needed} sessions ${data.bias === "BEAR" ? "above" : "below"} 50% to flip` : `held ${data.bias_days}+ sessions`,
          },
          {
            label: "TREND", value: data.trend,
            sub: <>{data.pct_above_50}% &gt; 50-SMA<MqDelta cur={data.pct_above_50} prev={prev?.p50} /></>,
            note: `52w net new highs ${data.nnh_52w > 0 ? "+" : ""}${data.nnh_52w}`,
          },
          {
            label: "SWING", value: data.swing_state,
            sub: <>{data.pct_above_10}% &gt; 10-SMA<MqDelta cur={data.pct_above_10} prev={prev?.p10} /></>,
            note: `10-day ${data.pct_above_10 >= data.pct_above_20 ? "≥" : "<"} 20-day (${data.pct_above_20}%)`,
          },
          {
            label: "MOMENTUM", value: data.momentum_sign,
            tag: data.momentum_dir, tagColor: MQ_DIM_COLOR[data.momentum_dir],
            sub: <>4-wk ROC vs avg {data.momentum_change > 0 ? "+" : ""}{data.momentum_change} pts</>,
          },
        ].map(({ label, value, tag, tagColor, sub, note }) => (
          <div key={label} style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14, padding: "14px 12px", minWidth: 0 }}>
            <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.14em", marginBottom: 6, fontWeight: 700 }}>{label}</div>
            <div style={{ fontSize: 19, fontWeight: 800, color: MQ_DIM_COLOR[value] || "var(--text)", letterSpacing: "-0.02em", lineHeight: 1 }}>{value}</div>
            {tag && <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: tagColor, marginTop: 4 }}>{tag}</div>}
            <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 5, fontFamily: "var(--mono)" }}>{sub}</div>
            {note && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{note}</div>}
          </div>
        ))}
      </div>

      <QuadSection id="sizing" title="Sizing" d={data} />
      <MqEnvironment data={data} />
      <MqGreenLight gl={data.green_light} long={data.long_bt} />
      <MqFollowThrough data={data} />
      </>}
      {mseg === "breadth" && <>
      <QuadSection id="breadth" title="Breadth" d={data} />
      <MqBreadthChart history={h} />

      {/* ── Breadth Bars ── */}
      <div style={{ ...mqCardStyle, padding: "14px 14px 10px" }}>
        <div style={{ ...mqHeadStyle, marginBottom: 12 }}>BREADTH TODAY <span style={{ fontWeight: 400, letterSpacing: 0 }}>· change vs previous day</span></div>
        <BreadthBar label="Above 200-SMA (long-term)" pct={data.pct_above_200} prev={prev?.p200} count={data.above_200} total={data.total} />
        <BreadthBar label="Above 50-SMA (medium)"     pct={data.pct_above_50}  prev={prev?.p50}  count={data.above_50}  total={data.total} />
        <BreadthBar label="Above 10-SMA (short-term)" pct={data.pct_above_10}  prev={prev?.p10}  count={data.above_10}  total={data.total} />
      </div>

      {/* ── Net New Highs ── */}
      <div style={mqCardStyle}>
        <div style={{ ...mqHeadStyle, marginBottom: 12 }}>NET NEW HIGHS</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
          <NNHBadge label="20-day"  value={data.nnh_20}  />
          <NNHBadge label="65-day"  value={data.nnh_65}  />
          <NNHBadge label="52-week" value={data.nnh_52w} />
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 3 }}>52w H/L</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700 }}>
              <span style={{ color: C.pos }}>{data.new_highs}</span>
              <span style={{ color: "var(--text3)" }}> / </span>
              <span style={{ color: C.neg }}>{data.new_lows}</span>
            </div>
          </div>
        </div>
        <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 10 }}>Counts stocks within 1% of their high / low.</div>
      </div>

      {/* ── Swing Confidence ── */}
      <div style={mqCardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ ...mqHeadStyle, marginBottom: 4 }}>SWING CONFIDENCE</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 800, color: swingConfColor }}>{data.swing_confidence}<span style={{ fontSize: 12, fontWeight: 400, color: "var(--text3)" }}>/100</span></div>
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: swingConfColor, letterSpacing: "0.08em" }}>{swingConfLabel}</div>
        </div>
      </div>

      <MqMbi mbi={data.mbi} dip={data.dip} long={data.long_bt} />
      <MqMarketMonitor mm={data.market_monitor} />
      </>}
      {mseg === "sectors" && <>
      <QuadSection id="sectors" title="Sectors & themes" d={data} />
      <SectionBoundary name="Sector funds"><MqSectorFunds sectors={data.sectors} /></SectionBoundary>
      <MqSectorGrid sectors={data.sectors} sectorStocks={data.sector_stocks} selected={sector} onSelect={setSector} onPickStock={onPickStock} />
      <MqRotationMap data={data} onSelect={(n) => { setSector(n); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
      <MqSectorRotation data={data} onSelect={setSector} />
      <MqThemes themes={data.themes} onPickStock={onPickStock} />
      <MqLeaders leaders={sector ? data.leaders.filter(l => l.sector === sector) : data.leaders} sector={sector} onClear={() => setSector(null)} onPickStock={onPickStock} />

      </>}
      {mseg === "flows" && <>
      <QuadSection id="flows" title="Money flow" d={data} />
      <MqFlowsDeals data={data} onPickStock={onPickStock} />
      <EtfPanel lockout={data.environment?.lockout} onPickStock={onPickStock} />
      </>}
      {mseg === "signal" && <>
      {/* ── To Upgrade ── */}
      {data.to_upgrade?.length > 0 && (
        <div style={mqCardStyle}>
          <div style={{ ...mqHeadStyle, marginBottom: 12 }}>TO UPGRADE</div>
          {data.to_upgrade.map((upgrade, i) => (
            <div key={i} style={{ marginBottom: i < data.to_upgrade.length - 1 ? 16 : 0 }}>
              <div style={{ fontSize: 11, color: MQ_SIGNAL_COLOR[upgrade.to] || "var(--text2)", fontWeight: 700, marginBottom: 8 }}>→ {upgrade.to}</div>
              {upgrade.conditions.map((c, j) => {
                const unit = c.unit ?? "";
                const fmt = (v) => (typeof v === "number" ? `${v}${unit}` : v);
                return (
                  <div key={j} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", paddingBottom: 8, marginBottom: 8, borderBottom: j < upgrade.conditions.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <div style={{ fontSize: 12, color: "var(--text2)", flex: 1, marginRight: 8 }}>{c.metric}</div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--red)" }}>{fmt(c.current)}</span>
                      <span style={{ color: "var(--text3)", fontSize: 12 }}> → </span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: C.pos }}>{fmt(c.needs)}</span>
                      <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", marginTop: 1 }}>gap {fmt(c.gap)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <MqWeeklyReport data={data} />
      <QuadSection id="record" title="Track record" d={data} />
      <Fold id="records" title="Backtests behind the rules" sub="How each gauge, scan and exit rule did in the past — open only if you want the evidence.">
        <MqForward fw={data.forward} picks={data.picks} onPickStock={onPickStock} />
        <MqSignalBacktest bt={data.signal_backtest} />
        {data.long_bt?.signal_bt && <MqSignalBacktest bt={data.long_bt.signal_bt} title="DOES THE SIGNAL WORK? · 5 YEARS" />}
        <MqSystem sys={data.long_bt?.system_bt} />
        <MqSignalBuckets long={data.long_bt} />
        <MqExitRules rows={data.long_bt?.exit_bt} from={data.long_bt?.from} />
      </Fold>

      </>}
      {/* ── Footer: refresh + timestamp ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
        <button className="btn-ghost" style={{ fontSize: 12, padding: "8px 14px" }} onClick={refresh} disabled={refreshing}>
          {refreshing ? `${progress.msg}` : "↻ Refresh"}
        </button>
        <span style={{ fontSize: 11, color: "var(--text3)" }}>Updated {updatedAt}</span>
      </div>
    </div>
  );
}

// Compact market-signal banner for the calculator (cache only — never triggers the 500-stock download)
function MarketSignalBanner({ onOpen }) {
  const [data, setData] = useState(() => getLastMarketQuadrant());
  useEffect(() => {
    let alive = true;
    loadMarketQuadrant({ allowCompute: false }).then(d => { if (alive && d) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!data?.overall) return null;
  const c = MQ_SIGNAL_COLOR[data.overall];
  const stale = mqAgeDays(data.as_of) > 4;
  const ft = data.follow_through;
  const ftWeak = ft && ft.label === "WEAK";
  const cautions = [
    ftWeak && `Breakouts failing: only ${ft.rate}% of recent pocket pivots held`,
    ft && ft.label === "MIXED" && `Follow-through mixed (${ft.rate}%) — breakouts are a coin flip`,
  ].filter(Boolean);
  const warn = data.overall !== "INVEST" || ftWeak || data.lows_ok === false;
  return (
    <div onClick={onOpen} role={onOpen ? "button" : undefined}
      style={{ cursor: onOpen ? "pointer" : "default", marginBottom: 12, borderRadius: 12, padding: "10px 12px", border: `1px solid ${c}${warn ? "66" : "33"}`, background: `${c}${warn ? "1A" : "0D"}`, display: "flex", gap: 10, alignItems: "center" }}>
      <span style={{ fontSize: 16 }}>{data.overall === "CASH" ? "⛔" : data.overall === "SELECTIVE" ? "⚠️" : "✅"}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: c, letterSpacing: "0.04em" }}>
          Market {data.overall}{stale ? " (stale)" : ""}
        </div>
        <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 2 }}>{data.environment ? briefRule(data) : MQ_POS_RULE[data.overall]}</div>
        {cautions.map(t => (
          <div key={t} style={{ fontSize: 11, color: C.warn, marginTop: 3 }}>⚠ {t}</div>
        ))}
        {ft?.label === "STRONG" && !cautions.length && (
          <div style={{ fontSize: 11, color: C.pos, marginTop: 3 }}>Breakouts are following through ({ft.rate}%)</div>
        )}
      </div>
      <span style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", whiteSpace: "nowrap" }}>{mqFmtDate(data.as_of)} ›</span>
    </div>
  );
}

// Win rate / P&L of closed trades grouped by the market signal at entry
function MarketSignalStats({ closed }) {
  const [mq, setMq] = useState(() => getLastMarketQuadrant());
  useEffect(() => {
    let alive = true;
    loadMarketQuadrant({ allowCompute: false }).then(d => { if (alive && d) setMq(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!closed.length) return null;

  const groups = { INVEST: [], SELECTIVE: [], CASH: [], Unknown: [] };
  for (const t of closed) {
    const entryDate = t.entries?.[0]?.date || t.date;
    const sig = t.marketSignal || signalOnDate(mq, entryDate) || "Unknown";
    (groups[sig] || groups.Unknown).push(t);
  }
  const rows = Object.entries(groups).filter(([, ts]) => ts.length).map(([sig, ts]) => {
    const wins = ts.filter(t => (t.pnl || 0) > 0).length;
    const pnl = ts.reduce((s, t) => s + (t.pnl || 0), 0);
    const rs = ts.filter(t => (t.riskAmount || 0) > 0).map(t => (t.pnl || 0) / t.riskAmount);
    return { sig, n: ts.length, wr: Math.round((wins / ts.length) * 100), pnl, avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null };
  });

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 4 }}>By Market Signal at Entry</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 12 }}>
        {mq?.history ? "From the QUAD tab's Nifty 500 breadth" : "Open the QUAD tab once to tag older trades"}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 12, fontSize: 12 }}>
        {["SIGNAL", "WIN %", "AVG R", "P&L"].map((hd, i) => (
          <span key={hd} style={{ fontSize: 10, color: "var(--text3)", paddingBottom: 6, textAlign: i ? "right" : "left" }}>{hd}</span>
        ))}
        {rows.map(r => (
          <Fragment key={r.sig}>
            <div style={{ padding: "7px 0", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: MQ_SIGNAL_COLOR[r.sig] || "var(--border)" }} />
              <span style={{ fontWeight: 600 }}>{r.sig}</span>
              <span style={{ color: "var(--text3)", fontFamily: "var(--mono)", fontSize: 11 }}>{r.n}</span>
            </div>
            <div style={{ padding: "7px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: r.wr > 50 ? "var(--green)" : "var(--text2)" }}>{r.wr}%</div>
            <div style={{ padding: "7px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: "var(--text2)" }}>{r.avgR == null ? "—" : `${r.avgR > 0 ? "+" : ""}${r.avgR.toFixed(2)}`}</div>
            <div style={{ padding: "7px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: r.pnl >= 0 ? "var(--green)" : "var(--red)" }}>{r.pnl >= 0 ? "+" : ""}{formatINR(r.pnl)}</div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ─── MARKET BRIEF (TODAY) & SCAN — information-first views built on QUAD data ─

/** One-line rule for today, from signal + environment + follow-through + lows. */
function briefRule(d) {
  const env = d.environment?.name, sr = suggestedRisk(d);
  if (!sr || sr.pct === 0) {
    const why = d.overall === "CASH" ? "the signal is CASH" : "no-money environment";
    return `No new entries — ${why}. Protect capital; let stops do their job.`;
  }
  let rule = `Risk ${sr.pct}% per trade. `;
  if (env === "HARD MONEY") rule += d.environment?.lockout ? "Prefer index ETFs or lower-timeframe entries; don't chase extended stocks." : "Only grade-A setups in HOT/WARM sectors; take profits quicker.";
  else rule += sr.pct >= 1 ? "A/B setups in HOT/WARM sectors; let winners run." : "Best setups only; wait for follow-through.";
  if (d.lows_ok === false) rule += ` ${d.new_lows} stocks at 52-week lows.`;
  return rule;
}

/** "What changed since the previous session" bullets, most important first. */
function briefChanges(d) {
  const h = d.history || [];
  const prev = h.length >= 2 ? h[h.length - 2] : null;
  const out = [];
  if (prev?.sig && prev.sig !== d.overall) out.push({ tone: MQ_SIGNAL_COLOR[d.overall], text: `Signal changed ${prev.sig} → ${d.overall}` });
  if (d.bias_turning) out.push({ tone: C.warn, text: `Bias ${d.bias} is turning ${d.bias === "BEAR" ? "up" : "down"}: ${d.bias_days}/${d.bias_needed} sessions ${d.bias === "BEAR" ? "above" : "below"} 50% (200-SMA)` });
  if (d.environment?.lockout) out.push({ tone: C.warn, text: "Lockout rally — stocks running without clean pullback entries" });
  if (d.thrust_detected) out.push({ tone: C.pos, text: "Breadth thrust: 10-day breadth jumped from washed-out levels" });
  if (prev) {
    for (const [k, label] of [["p200", "200-SMA"], ["p50", "50-SMA"], ["p10", "10-SMA"]]) {
      const cur = { p200: d.pct_above_200, p50: d.pct_above_50, p10: d.pct_above_10 }[k];
      const delta = cur != null && prev[k] != null ? +(cur - prev[k]).toFixed(1) : 0;
      if (Math.abs(delta) >= 3) out.push({ tone: delta > 0 ? C.pos : C.neg, text: `% above ${label} ${delta > 0 ? "up" : "down"} ${Math.abs(delta)} pts to ${cur}%` });
    }
  }
  const ft = d.follow_through;
  if (ft?.rate != null) {
    const past = ft.history?.[ft.history.length - 6];
    const was = past?.rate != null ? (past.rate >= FT_BANDS.strong ? "STRONG" : past.rate >= FT_BANDS.weak ? "MIXED" : "WEAK") : null;
    out.push({ tone: FT_COLOR[ft.label], text: was && was !== ft.label ? `Follow-through ${was} → ${ft.label} (${ft.rate}%) over the past week` : `Follow-through ${ft.label} (${ft.rate}% of recent breakouts holding)` });
  }
  const moved = (d.sectors || []).filter(s => s.status_d1 && s.status !== s.status_d1 && s.status !== "—" && s.status_d1 !== "—");
  const rank = { COLD: 0, COOL: 1, WARM: 2, HOT: 3 };
  for (const s of moved.sort((a, b) => Math.abs(rank[b.status] - rank[b.status_d1]) - Math.abs(rank[a.status] - rank[a.status_d1])).slice(0, 4)) {
    out.push({ tone: rank[s.status] > rank[s.status_d1] ? C.pos : C.neg, text: `${s.name}: ${s.status_d1} → ${s.status}` });
  }
  if (d.leaders_new?.length) out.push({ tone: C.pos, text: `New leaders: ${d.leaders_new.slice(0, 5).join(", ")}` });
  if (d.scans?.pivots_total) out.push({ tone: "var(--text2)", text: `${d.scans.pivots_total} pocket pivots today` });
  return out;
}

function Skeleton({ lines = 4 }) {
  return (
    <div aria-hidden="true">
      <div className="skel" style={{ height: 30, width: "45%", marginBottom: 12 }} />
      {Array.from({ length: lines }, (_, i) => <div key={i} className="skel" style={{ height: 12, width: `${90 - i * 12}%`, marginBottom: 8 }} />)}
    </div>
  );
}

const TOUR = [
  ["TODAY", "One screen that follows the clock: a brief before the open, the market during the day, the day wrap after 3:30 — then your positions, today's best setups and your watchlist."],
  ["STOCKS", "Ideas (ranked and sized for today), Scans, Movers (gainers, heatmap, 52-week highs, leaders, delivery) and your Watchlist. Tap any stock for its chart, plan, notes and compare."],
  ["MARKET", "The full picture in four parts: Signal (and today's risk per trade), Breadth, Sectors and Money flow."],
  ["INVEST", "Your mutual fund portfolio, every fund vs its index, and the year's IPOs — kept apart from trading."],
  ["JOURNAL", "Your trades (with Zerodha import), review, stats and setups. The ☰ next to your capital opens settings and this tour; 🔍 searches stocks, funds and IPOs."],
];
function Tour({ onDone }) {
  const [i, setI] = useState(0);
  const [title, body] = TOUR[i];
  return (
    <div role="dialog" aria-modal="true" aria-label="App tour" style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-end", justifyContent: "center", padding: 16 }}>
      <div className="card" style={{ maxWidth: 440, width: "100%", marginBottom: 70 }}>
        <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.12em" }}>WELCOME · {i + 1}/{TOUR.length}</div>
        <div style={{ fontFamily: "var(--display)", fontSize: 22, margin: "6px 0" }}>{title}</div>
        <div style={{ fontSize: 13, color: "var(--text2)", lineHeight: 1.5 }}>{body}</div>
        <div style={{ display: "flex", gap: 6, margin: "12px 0" }}>{TOUR.map((_, k) => <span key={k} style={{ width: 18, height: 3, borderRadius: 2, background: k <= i ? "var(--text)" : "var(--border)" }} />)}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-ghost" style={{ padding: "8px 12px" }} onClick={onDone}>Skip</button>
          <button className="btn-primary" style={{ flex: 1, padding: "8px" }} onClick={() => (i < TOUR.length - 1 ? setI(i + 1) : onDone())}>{i < TOUR.length - 1 ? "Next" : "Start"}</button>
        </div>
      </div>
    </div>
  );
}
function AppSettings({ onTour }) {
  const setTheme = (t) => { try { localStorage.setItem("td_theme", t); } catch (_) {} location.reload(); };
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="label" style={{ marginBottom: 8 }}>Settings</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text2)" }}>Theme</span>
        {[["dark", "Dark"], ["light", "Light"]].map(([v, l]) => (
          <button key={v} className="chip" aria-pressed={THEME === v} onClick={() => THEME !== v && setTheme(v)}
            style={THEME === v ? { borderColor: "var(--text)", color: "var(--text)" } : {}}>{l}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="chip" onClick={onTour}>Show tour</button>
      </div>
    </div>
  );
}

function MarketBrief({ onOpenQuad, onOpenScan, onOpenWrap }) {
  const { data, loading, error, progress, retry } = useMarketQuadrant();
  const { flows } = useFlowsDeals();
  const [allChanges, setAllChanges] = useState(false);
  if (!data?.history) {
    return (
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="label">Market Brief</div>
        {error ? (
          <>
            <div style={{ fontSize: 12, color: "var(--red)", marginTop: 6 }}>{error}</div>
            <button className="btn-ghost" style={{ marginTop: 10 }} onClick={retry}>Retry</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "var(--text3)", margin: "8px 0" }}>{loading ? progress.msg : "Loading…"}</div>
            <div style={{ height: 3, background: "var(--border)", borderRadius: 3, overflow: "hidden", marginBottom: 14 }}>
              <div style={{ height: "100%", width: `${Math.round(progress.pct)}%`, background: "var(--text2)", transition: "width 0.4s ease" }} />
            </div>
            <Skeleton lines={5} />
          </>
        )}
      </div>
    );
  }
  const d = data;
  const sigColor = MQ_SIGNAL_COLOR[d.overall];
  const envColor = MQ_ENV_COLOR[d.environment?.name] || C.muted;
  const verified = d.verification && d.verification.date === d.as_of;
  const changes = briefChanges(d);
  const chips = [
    ["BIAS", d.bias + (d.bias_turning ? " ↗" : "")], ["TREND", d.trend], ["SWING", d.swing_state],
    ["MOMENTUM", `${d.momentum_sign === "POSITIVE" ? "POS" : "NEG"} ${d.momentum_dir === "IMPROVING" ? "↗" : "↘"}`],
  ];
  return (
    <div className="card" style={{ marginBottom: 14, border: `1.5px solid ${sigColor}55`, background: `linear-gradient(135deg, ${sigColor}12 0%, var(--bg2) 60%)` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div className="label">Market Brief · {mqFmtDate(d.as_of)}</div>
        <span style={{ fontSize: 10, color: verified ? C.pos : d.final ? "var(--amber)" : "var(--text3)" }}>
          {verified ? "✓ NSE-verified" : d.final ? "awaiting NSE close" : "intraday"}{d.pending_day ? ` · ${mqFmtDate(d.pending_day)} pending` : ""}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
        <span style={{ fontFamily: "var(--display)", fontSize: 34, color: sigColor, lineHeight: 1 }}>{d.overall}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: envColor, border: `1px solid ${envColor}66`, borderRadius: 12, padding: "2px 8px" }}>{d.environment?.name}</span>
        {d.environment?.lockout && <span style={{ fontSize: 11, color: C.warn }}>🔒 lockout</span>}
      </div>
      <div style={{ fontSize: 13, color: "var(--text)", marginTop: 8, lineHeight: 1.45 }}>{briefRule(d)}</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginTop: 12 }}>
        {chips.map(([k, v]) => (
          <div key={k} style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 6px", minWidth: 0 }}>
            <div style={{ fontSize: 9.5, color: "var(--text3)", letterSpacing: "0.12em" }}>{k}</div>
            <div style={{ fontSize: 11, fontWeight: 700, marginTop: 2, color: k === "MOMENTUM" ? (v === "POS ↗" ? C.pos : v === "NEG ↘" ? C.neg : C.warn) : (MQ_DIM_COLOR[v.split(" ")[0]] || "var(--text)"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</div>
          </div>
        ))}
      </div>

      {changes.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.12em", marginBottom: 6 }}>WHAT CHANGED</div>
          {changes.slice(0, allChanges ? 8 : 3).map((c, i) => (
            <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--text2)", padding: "3px 0", lineHeight: 1.4 }}>
              <span style={{ width: 6, height: 6, borderRadius: 3, background: c.tone, marginTop: 6, flexShrink: 0 }} />
              <span>{c.text}</span>
            </div>
          ))}
          {changes.length > 3 && <button className="chip" style={{ marginTop: 4, fontSize: 11 }} onClick={() => setAllChanges(v => !v)}>{allChanges ? "Show less" : `+${Math.min(8, changes.length) - 3} more`}</button>}
        </div>
      )}

      {d.momentum_leaders?.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 10 }}>
          Leading sectors: {d.momentum_leaders.slice(0, 4).map(m => `${m.name} +${m.ret1m}%`).join(" · ")}
        </div>
      )}
      <FlowsLine flows={flows} />
      {(d.mbi?.rows?.length || d.green_light?.band) && (() => {
        const m = d.mbi?.rows?.[d.mbi.rows.length - 1], g = d.green_light;
        return (
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 6 }}>
            {m && <>MBI <b style={{ color: MBI_COLOR[m.color] }}>{m.color.toLowerCase()} day</b></>}
            {m && g?.band ? " · " : ""}
            {g?.band && <>Green light <b style={{ color: GL_COLOR[g.band] }}>{g.em}</b></>}
            {d.dip?.today && <> · <b style={{ color: C.pos }}>pullback window</b></>}
          </div>
        );
      })()}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        {onOpenWrap && !isMarketHours() && !isPreOpen()
          ? <button className="btn-primary" style={{ flex: 1, padding: "10px 8px", fontSize: 12 }} onClick={onOpenWrap}>🌙 Day wrap ›</button>
          : <button className="btn-primary" style={{ flex: 1, padding: "10px 8px", fontSize: 12 }} onClick={onOpenScan}>Today's ideas ›</button>}
        <button className="btn-ghost" style={{ flex: 1, padding: "10px 8px", fontSize: 12 }} onClick={onOpenQuad}>Market ›</button>
      </div>

    </div>
  );
}

const SCAN_DEFS = [
  { id: "pivots", label: "Pivots today", hint: "Up ≥4.5% today on volume above yesterday's and the 50-day average — fresh institutional demand.",
    cols: [["CHG", r => r.chg != null ? `+${r.chg}%` : "—"], ["VOL×", r => r.volx != null ? `${r.volx}×` : "—"], ["DELIV", r => r.deliv != null ? `${Math.round(r.deliv)}%` : "—"]] },
  { id: "htf", label: "High-tight flag", hint: "Up 60%+ from its low about two months ago, then a tight 10-day flag (≤15% range) near the peak. Rare, fast and volatile — size small.",
    cols: [["RANGE", r => r.range10 != null ? `${r.range10}%` : "—"], ["3M", r => r.ret3m != null ? `${r.ret3m > 0 ? "+" : ""}${r.ret3m}%` : "—"], ["vs 21E", r => r.e21 != null ? `${r.e21 > 0 ? "+" : ""}${r.e21}%` : "—"]] },
  { id: "pb21", label: "21-EMA pullback", hint: "A leader (RS 80+, 50-day above the 200-day) that ran 8%+ above its 21-day EMA in the last 3 weeks and has pulled back to within 2% of it — the classic low-risk add.",
    cols: [["vs 21E", r => r.e21 != null ? `${r.e21 > 0 ? "+" : ""}${r.e21}%` : "—"], ["HIGH", r => r.off_high != null ? `${r.off_high}%` : "—"], ["3M", r => r.ret3m != null ? `${r.ret3m > 0 ? "+" : ""}${r.ret3m}%` : "—"]] },
  { id: "first52", label: "First 52w high", hint: "First close at a 52-week high in 20+ sessions, by an RS 80+ stage-2 stock — a fresh breakout to new ground.",
    cols: [["3M", r => r.ret3m != null ? `${r.ret3m > 0 ? "+" : ""}${r.ret3m}%` : "—"], ["vs 21E", r => r.e21 != null ? `${r.e21 > 0 ? "+" : ""}${r.e21}%` : "—"], ["HIGH", r => r.off_high != null ? `${r.off_high}%` : "—"]] },
  { id: "coil", label: "Coiling", hint: "Anticipation setups: RS 80+, above the 50-SMA, the tightest 10-day range in a month and volume drying up — strong stocks going quiet before a possible breakout.",
    cols: [["RANGE", r => r.range10 != null ? `${r.range10}%` : "—"], ["HIGH", r => r.off_high != null ? `${r.off_high}%` : "—"], ["3M", r => r.ret3m != null ? `${r.ret3m > 0 ? "+" : ""}${r.ret3m}%` : "—"]] },
  { id: "leaders", label: "Leaders · hot sectors", hint: "Above 10/50/200-SMA, within 5% of 52-week high, in a HOT or WARM sector.",
    cols: [["12M", r => r.ret12m != null ? `${r.ret12m > 0 ? "+" : ""}${r.ret12m}%` : "—"], ["3M", r => r.ret3m != null ? `${r.ret3m > 0 ? "+" : ""}${r.ret3m}%` : "—"], ["HIGH", r => r.off_high != null ? `${r.off_high}%` : "—"]] },
  { id: "tight", label: "Tight near highs", hint: "Above 50 & 200-SMA, within 10% of the 52-week high, last 10 closes in a ≤6% range — low-volatility setups.",
    cols: [["RANGE", r => r.range10 != null ? `${r.range10}%` : "—"], ["HIGH", r => r.off_high != null ? `${r.off_high}%` : "—"], ["3M", r => r.ret3m != null ? `${r.ret3m > 0 ? "+" : ""}${r.ret3m}%` : "—"]] },
  { id: "ep", label: "Earnings EP", hint: "Episodic pivots: ≥8% up on ≥3× average volume in the last 5 sessions and still holding. ★ = results were due around the move.",
    cols: [["DAY", r => mqFmtDate(r.d)], ["MOVE", r => `+${r.chg}% ${r.volx}×`], ["SINCE", r => `${r.held > 0 ? "+" : ""}${r.held}%`]] },
  { id: "fundflow", label: "Fund flow", hint: "Stocksgeeks' Fund Flow: a green week on 5×+ the average weekly volume, ₹5 cr+ daily turnover, an average move of 2%+ a day (≈ ATR 3%), 50-SMA above the 200-SMA and within 25% of the 52-week high. Signals from the last 4 weeks; ● = this week (still forming).",
    cols: [["WEEK", r => `${r.live ? "● " : ""}${mqFmtDate(r.wk)}`], ["VOL×", r => `${r.volx}×`], ["WEEK %", r => `${r.wchg > 0 ? "+" : ""}${r.wchg}%`]] },
  { id: "ipo", label: "New listings", hint: "IPOs (and demergers, marked) listed within ~260 sessions and holding the average that fits its age: under 50 sessions above the 20-SMA, 50–100 above the 50-SMA, 100–260 above the 100-SMA. ⚡ = a 4.5%+ day on above-average volume in the last 5 sessions; ↑ = at a new high since listing.",
    cols: [["AGE", r => `${r.days}d`], ["LISTING", r => `${r.from_listing > 0 ? "+" : ""}${r.from_listing}%`], ["NOW", r => (r.pop ? `⚡+${r.pop.chg}%` : r.breakout ? "↑ new" : `${r.off_high}%`)]] },
  { id: "reclaim50", label: "Reclaimed 50-SMA", hint: "Closed back above the 50-day average today after being below it yesterday.",
    cols: [["200↑", r => (r.a200 ? "yes" : "no")], ["HIGH", r => r.off_high != null ? `${r.off_high}%` : "—"], ["3M", r => r.ret3m != null ? `${r.ret3m > 0 ? "+" : ""}${r.ret3m}%` : "—"]] },
];

const SCAN_SORT = {
  pivots: (a, b) => b.volx * b.chg - a.volx * a.chg,
  ep: (a, b) => (b.results - a.results) || (b.d > a.d ? 1 : b.d < a.d ? -1 : 0) || (b.volx * b.chg - a.volx * a.chg),
  ipo: (a, b) => (!!b.pop - !!a.pop) || (b.breakout - a.breakout) || (b.off_high ?? -999) - (a.off_high ?? -999),
  fundflow: (a, b) => (b.wk > a.wk ? 1 : b.wk < a.wk ? -1 : 0) || b.volx - a.volx,
  htf: (a, b) => (b.rs ?? 0) - (a.rs ?? 0), pb21: (a, b) => (b.rs ?? 0) - (a.rs ?? 0), first52: (a, b) => (b.rs ?? 0) - (a.rs ?? 0),
  leaders: (a, b) => (b.ret12m ?? b.ret3m ?? -999) - (a.ret12m ?? a.ret3m ?? -999),
  tight: (a, b) => (b.ret3m ?? -999) - (a.ret3m ?? -999),
  coil: (a, b) => (b.rs ?? 0) - (a.rs ?? 0),
  reclaim50: (a, b) => (b.ret3m ?? -999) - (a.ret3m ?? -999),
};

function ScanPage({ onPickStock, watchlist, setWatchlist, onOpenIpos, onOpenMovers }) {
  const { data, loading, error, progress, retry } = useMarketQuadrant();
  const [micro, setMicro] = useState(() => { try { return localStorage.getItem("td_scan_micro") === "1"; } catch (_) { return false; } });
  const [microData, setMicroData] = useState(null);
  const [microState, setMicroState] = useState(null); // null | "loading" | error text
  useEffect(() => {
    try { localStorage.setItem("td_scan_micro", micro ? "1" : "0"); } catch (_) {}
    if (!micro) return;
    let alive = true;
    setMicroState("loading");
    loadMicrocapScans().then(d => { if (alive) { setMicroData(d); setMicroState(null); } })
      .catch(e => alive && setMicroState(e.message || "Microcap data unavailable"));
    return () => { alive = false; };
  }, [micro]);
  const [tab, setTab] = useState(() => { try { return localStorage.getItem("td_scan_tab") || "pivots"; } catch (_) { return "pivots"; } });
  const [quality, toggleQuality] = useQualityGate();
  const pick = (id) => { setTab(id); try { localStorage.setItem("td_scan_tab", id); } catch (_) {} };

  const head = (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div className="section-title">Scan</div>

      </div>
      <div style={{ fontSize: 13, color: "var(--text3)", marginTop: 4 }}>Nifty 500 setups from today's close. Tap a stock for its chart and checklist.</div>
    </div>
  );
  if (!data?.scans) {
    return (
      <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
        {head}
        <div className="card" style={{ fontSize: 12, color: error ? "var(--red)" : "var(--text3)" }}>
          {!error && <div style={{ marginBottom: 12 }}><Skeleton lines={6} /></div>}
          {error || (loading ? progress.msg : "Loading…")}
          {error && <button className="btn-ghost" style={{ marginTop: 10, width: "100%" }} onClick={retry}>Retry</button>}
        </div>
      </div>
    );
  }

  const statusOf = Object.fromEntries((data.sectors || []).map(s => [s.name, s.status]));
  const hot = (l) => ["HOT", "WARM"].includes(statusOf[l.sector]);
  const base = {
    pivots: (data.scans.pivots || []).map(r => ({ ...r, deliv: data.deliv_of?.[r.sym] ?? null })), tight: data.scans.tight || [], reclaim50: data.scans.reclaim50 || [],
    ep: data.scans.ep || [], ipo: data.scans.ipo || [], leaders: (data.leaders || []).filter(hot), coil: data.scans.coil || [], fundflow: data.scans.fundflow || [],
    htf: data.scans.htf || [], pb21: data.scans.pb21 || [], first52: data.scans.first52 || [],
  };
  const totals = { pivots: data.scans.pivots_total, tight: data.scans.tight_total, reclaim50: data.scans.reclaim50_total,
    ep: data.scans.ep_total || 0, ipo: data.scans.ipo_total || 0, leaders: base.leaders.length, coil: data.scans.coil_total || 0, fundflow: data.scans.fundflow_total || 0,
    htf: data.scans.htf_total || 0, pb21: data.scans.pb21_total || 0, first52: data.scans.first52_total || 0 };
  const lists = { ...base };
  if (micro && microData?.scans) {
    const m = microData.scans, tag = (xs) => (xs || []).map(x => ({ ...x, micro: true }));
    const add = { pivots: tag(m.pivots), tight: tag(m.tight), reclaim50: tag(m.reclaim50), ep: tag(m.ep), ipo: tag(m.ipo), leaders: tag((microData.leaders || []).filter(hot)), coil: tag(m.coil), fundflow: tag(m.fundflow), htf: tag(m.htf), pb21: tag(m.pb21), first52: tag(m.first52) };
    for (const k of Object.keys(add)) {
      const seen = new Set(base[k].map(x => x.sym));
      lists[k] = [...base[k], ...add[k].filter(x => !seen.has(x.sym))].sort(SCAN_SORT[k]).slice(0, 25);
      totals[k] = (totals[k] || 0) + ({ pivots: m.pivots_total, tight: m.tight_total, reclaim50: m.reclaim50_total, ep: m.ep_total, ipo: m.ipo_total, leaders: add.leaders.length, coil: m.coil_total, fundflow: m.fundflow_total, htf: m.htf_total, pb21: m.pb21_total, first52: m.first52_total }[k] || 0);
    }
  }
  const isWatch = tab === "watch";
  const def = SCAN_DEFS.find(x => x.id === tab) || SCAN_DEFS[0];
  const quiet = def.id === "tight" || def.id === "coil" || def.id === "pb21";
  const qOfRow = (r) => r.q ?? data.q_of?.[r.sym] ?? microData?.q_of?.[r.sym] ?? null;
  const rawRows = lists[def.id] || [];
  const rows = quality ? rawRows.filter(r => qualityOk(qOfRow(r), quiet)) : rawRows;
  const hiddenQ = rawRows.length - rows.length;
  const verified = data.verification && data.verification.date === data.as_of;

  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      {head}
      <MarketSignalBanner />
      <Guide id="scan" d={data} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 11, color: "var(--text3)" }}>
        Universe:
        {[[false, "Nifty 500"], [true, "+ Microcap 250"]].map(([v, l]) => (
          <button key={l} className="chip" onClick={() => setMicro(v)} aria-pressed={micro === v}
            style={micro === v ? { borderColor: "var(--text)", color: "var(--text)" } : {}}>{l}</button>
        ))}
        <button className="chip" onClick={toggleQuality} aria-pressed={quality} title="Stocksgeeks-style quality gate: ₹10 cr+ daily turnover (₹3 cr microcaps) and an average move of 1.8%+ a day. Tight / coiling lists use the turnover test only."
          style={quality ? { borderColor: C.pos, color: C.pos } : {}}>Quality {quality ? "on" : "off"}</button>
        {micro && microState === "loading" && <span>loading microcaps…</span>}
        {micro && microState && microState !== "loading" && <span style={{ color: "var(--red)" }}>{microState}</span>}
      </div>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, marginBottom: 10, scrollbarWidth: "none" }}>
        <button onClick={() => pick("watch")} className="chip" aria-pressed={isWatch}
          style={isWatch ? { borderColor: C.warn, color: C.warn, whiteSpace: "nowrap" } : { whiteSpace: "nowrap" }}>
          ★ Watchlist <span style={{ fontFamily: "var(--mono)", opacity: 0.7 }}>{watchlist?.length || 0}</span>
        </button>
        {[...SCAN_DEFS].sort((a, b) => {
          const ex = (id) => (data.long_bt?.scan_stats || data.scan_stats)?.[id]?.excess ?? -9;
          return ex(b.id) - ex(a.id);
        }).map(x => (
          <button key={x.id} onClick={() => pick(x.id)} className="chip" aria-pressed={!isWatch && x.id === def.id}
            style={!isWatch && x.id === def.id ? { borderColor: "var(--text)", color: "var(--text)", whiteSpace: "nowrap" } : { whiteSpace: "nowrap" }}>
            {x.label} <span style={{ fontFamily: "var(--mono)", opacity: 0.7 }}>{totals[x.id] ?? 0}</span>
            {data.scan_stats?.[x.id]?.recent?.excess >= 0.5 && <span title="Beat the average stock over the last 3 months" style={{ color: C.pos, marginLeft: 3 }}>✓</span>}
            {(data.long_bt?.scan_stats?.[x.id]?.excess ?? 1) < 0.2 && <span title="No real edge over 5 years — use it to watch, not to buy" style={{ color: "var(--text3)", marginLeft: 3, fontSize: 10 }}>watch</span>}
          </button>
        ))}
      </div>
      {isWatch ? (
        <div className="card"><WatchlistPanel watchlist={watchlist} setWatchlist={setWatchlist} onPickStock={onPickStock} /></div>
      ) : (
      <div className="card">
        <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 10, lineHeight: 1.45 }}>{def.hint}</div>
        <ScanEdge st={data.scan_stats?.[def.id]} long={data.long_bt?.scan_stats?.[def.id]} />
        {quality && hiddenQ > 0 && <div style={{ fontSize: 10, color: "var(--text3)", margin: "-4px 0 8px" }}>{hiddenQ} hidden by the quality gate ({quiet ? "turnover under the minimum" : "thin turnover or slow mover"}).</div>}
        {rows.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text3)", padding: "16px 0", textAlign: "center" }}>Nothing qualifies today.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 12, fontSize: 12 }}>
            <span style={{ fontSize: 9, color: "var(--text3)", paddingBottom: 6 }}>STOCK</span>
            {def.cols.map(([h]) => <span key={h} style={{ fontSize: 9, color: "var(--text3)", textAlign: "right" }}>{h}</span>)}
            {rows.map(r => {
              const st = statusOf[r.sector];
              return (
                <Fragment key={r.sym}>
                  <div style={{ padding: "7px 0", borderTop: "1px solid var(--border)", minWidth: 0 }}>
                    <button onClick={() => onPickStock?.(r.sym)} title={`Open ${r.sym}`}
                      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", font: "inherit", fontFamily: "var(--display)", fontWeight: 700, letterSpacing: "0.02em", textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{r.sym}</button>
                    <RsBadge rs={r.rs ?? data.rs_of?.[r.sym] ?? microData?.rs_of?.[r.sym]} grade={r.grade ?? data.grade_of?.[r.sym] ?? microData?.grade_of?.[r.sym]} /><NoteMark sym={r.sym} />
                    <div style={{ fontSize: 10, color: "var(--text3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {r.results && <span style={{ color: C.warn, marginRight: 4 }} title="Results were due around this move">★</span>}
                      {r.not_ipo && <span style={{ color: C.warn, marginRight: 4 }} title="Demerger / relisting — 'from listing' starts at its first traded day">demerger ·</span>}
                      {r.sector}{st && st !== "—" && <span style={{ color: MQ_DIM_COLOR[st], marginLeft: 4 }}>· {st}</span>}
                      {r.micro && <span style={{ marginLeft: 4, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: 6, padding: "0 4px", fontSize: 10 }}>micro</span>}
                      <NseFlagBadge f={data.flags_of?.[r.sym] ?? microData?.flags_of?.[r.sym]} sym={r.sym} />
                      {qOfRow(r)?.to != null && <span style={{ marginLeft: 4, fontFamily: "var(--mono)" }} title="20-day average turnover · 60-day average daily move">· ₹{qOfRow(r).to >= 100 ? Math.round(qOfRow(r).to) : qOfRow(r).to}cr · {qOfRow(r).move}%/d</span>}
                    </div>
                  </div>
                  {def.cols.map(([h, f]) => (
                    <div key={h} style={{ padding: "7px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: "var(--text2)" }}>{f(r)}</div>
                  ))}
                </Fragment>
              );
            })}
          </div>
        )}
        {totals[def.id] > rows.length && (
          <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 8 }}>Showing top {rows.length} of {totals[def.id]}.</div>
        )}
        {micro && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>Microcaps are thinly traded — check liquidity and spread before acting.</div>}
      </div>
      )}
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 10 }}>
        Data as of {mqFmtDate(data.as_of)} {verified ? "· ✓ closes verified against NSE" : data.final ? "· awaiting NSE's official closes" : "· intraday"}. Ideas, not recommendations — check the chart and your plan.
      </div>
    </div>
  );
}

// Strength rank + setup grade, shown next to a stock name
const GRADE_COLOR = { A: C.pos, B: C.warn, C: C.muted };
function RsBadge({ rs, grade }) {
  if (rs == null && !grade) return null;
  const rc = rs == null ? "var(--text3)" : rs >= 90 ? C.pos : rs >= 70 ? C.lime : rs >= 40 ? C.muted : C.neg;
  return (
    <span style={{ display: "inline-flex", gap: 4, marginLeft: 6, verticalAlign: "middle" }}>
      {rs != null && <span title="Strength rank vs the Nifty 500 (1–99)" style={{ fontFamily: "var(--mono)", fontSize: 10.5, fontWeight: 700, color: rc, border: `1px solid ${rc}55`, borderRadius: 6, padding: "0 4px" }}>RS {rs}</span>}
      {grade && <span title="Setup grade (A best)" style={{ fontSize: 10.5, fontWeight: 800, color: GRADE_COLOR[grade], border: `1px solid ${GRADE_COLOR[grade]}55`, borderRadius: 6, padding: "0 4px" }}>{grade}</span>}
    </span>
  );
}

/** One line telling how a scan did historically (10 sessions after each signal). */
function ScanEdge({ st, long }) {
  if (!st) return null;
  const sub = (x) => (x ? <>{x.hit}% higher · <span style={{ color: x.excess >= 0.5 ? C.pos : x.excess <= -0.5 ? C.neg : "var(--text2)", fontWeight: 700 }}>{x.excess > 0 ? "+" : ""}{x.excess}% vs average</span> ({x.signals.toLocaleString("en-IN")})</> : "—");
  const extra = (st.recent || st.gated || long) && (
    <div style={{ fontSize: 10.5, color: "var(--text3)", margin: "-6px 0 10px", lineHeight: 1.5 }}>
      {st.recent && <div>Last 3 months: {sub(st.recent)}{st.recent.excess >= 0.5 ? " — working now" : st.recent.excess <= -0.5 ? " — not working lately" : ""}</div>}
      {long && <div>5 years ({long.signals.toLocaleString("en-IN")} signals): {sub(long)}{Math.sign(long.excess) !== Math.sign(st.excess) && Math.abs(long.excess - st.excess) >= 0.5 ? " — the past year was unusual" : ""}</div>}
      {st.gated && <div>Quality gate passes only: {sub(st.gated)}{st.gated.excess - st.excess >= 0.3 ? " — the gate helped" : st.gated.excess - st.excess <= -0.3 ? " — the gate hurt" : ""}</div>}
    </div>
  );
  return <><ScanEdgeMain st={st} />{extra}<ScanEdgeNotes st={st} /></>;
}
function ScanEdgeNotes({ st }) {
  if (!st?.approx && !st?.survivor) return null;
  return <div style={{ fontSize: 10, color: "var(--text3)", margin: "-6px 0 10px", lineHeight: 1.45 }}>{st.approx ? `⚠ ${st.approx} ` : ""}{st.survivor ? "Tested on today's index members, so stocks that dropped out are missing — real results would be a little worse." : ""}</div>;
}
function ScanEdgeMain({ st }) {
  const tone = st.excess >= 0.5 ? C.pos : st.excess <= -0.5 ? C.neg : "var(--text3)";
  const verdict = st.excess >= 0.5 ? "beat the average stock" : st.excess <= -0.5 ? "lagged the average stock" : "no clear edge";
  return (
    <div style={{ fontSize: 10.5, color: "var(--text3)", margin: "-4px 0 10px", lineHeight: 1.45 }}>
      Past year ({st.signals.toLocaleString("en-IN")} signals): <b style={{ color: "var(--text2)" }}>{st.hit}%</b> higher {st.horizon} sessions later ·
      avg {st.avg > 0 ? "+" : ""}{st.avg}% · <span style={{ color: tone, fontWeight: 700 }}>{st.excess > 0 ? "+" : ""}{st.excess}% vs average stock — {verdict}</span>
    </div>
  );
}

// ─── STOCK DETAIL (C) ─────────────────────────────────────────────────────────
const STOCK_SERIES = [
  { key: "s10", label: "10-SMA", color: "#A06CD5" },
  { key: "s50", label: "50-SMA", color: "#D9632B" },
  { key: "s200", label: "200-SMA", color: "#3987E5" },
];
const IDX_TICKER = "^CRSLDX"; // Nifty 500

/** The newest bar is still forming: it's today (IST), before 15:45, and NSE hasn't confirmed it. */
function isIntradayBar(day, verified) {
  const ist = new Date(Date.now() + 19800000);
  const today = ist.toISOString().slice(0, 10), mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day === today && mins < 15 * 60 + 45 && verified?.date !== day;
}

async function fetchStockDetail(sym) {
  const tk = `${sym}.NS`;
  const url = `/api/spark?symbols=${encodeURIComponent(`${tk},${IDX_TICKER}`)}&range=2y&interval=1d&vol=260&ohlc=260`;
  const [sparkRes, bhavRes, nseIdx] = await Promise.all([
    fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null),
    fetch("/api/nse?type=bhav&v=4").then(r => (r.ok ? r.json() : null)).catch(() => null),
    fetch("/api/nse?type=indices").then(r => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const items = Object.fromEntries((sparkRes?.spark?.result || []).map(it => [it.symbol, it]));
  const s = items[tk], ix = items[IDX_TICKER];
  if (!s) throw new Error(`No price history for ${sym}`);
  const toDays = (it) => {
    const r = it.response[0], ts = r.timestamp, cl = r.indicators.quote[0].close;
    const off = ts.length - (it.volTail || []).length, offO = ts.length - (it.ohlcTail || []).length;
    const rows = {};
    ts.forEach((t, i) => { if (cl[i] != null) rows[istDayKey(t)] = { c: cl[i], v: i >= off ? it.volTail[i - off] : null, o: i >= offO ? it.ohlcTail[i - offO] : null }; });
    return rows;
  };
  const sd = toDays(s), id = ix ? toDays(ix) : {};
  const dates = Object.keys(sd).sort();
  const closes = dates.map(d => sd[d].c), vols = dates.map(d => sd[d].v);
  let opens = dates.map(d => sd[d].o?.[0] ?? null), highs = dates.map(d => sd[d].o?.[1] ?? null), lows = dates.map(d => sd[d].o?.[2] ?? null);
  if (!highs.some(v => v != null)) { opens = null; highs = null; lows = null; }

  // Verify / correct the latest closes against NSE's official bhavcopy
  let verified = null;
  const b = bhavRes?.closes?.[sym];
  if (b && bhavRes.date) {
    let i = dates.indexOf(bhavRes.date);
    if (i < 0 && bhavRes.date > dates[dates.length - 1]) { dates.push(bhavRes.date); closes.push(b[1]); vols.push(b[2] ?? null); opens?.push(null); highs?.push(null); lows?.push(null); i = dates.length - 1; }
    if (i >= 0) {
      const fix = (k, official) => { if (k >= 0 && official != null && Math.abs(closes[k] / official - 1) > 0.001) { closes[k] = official; return true; } return false; };
      const c1 = fix(i, b[1]), c2 = fix(i - 1, b[0]);
      verified = { date: bhavRes.date, corrected: c1 || c2 };
    }
  }
  const idx = dates.map(d => id[d]?.c ?? null);
  // A day NSE has published but Yahoo's index series hasn't yet: use NSE's official Nifty 500 close for it
  const n500 = nseIdx?.indices?.["Nifty 500"]?.close;
  if (n500 && nseIdx.date) { const k = dates.indexOf(nseIdx.date); if (k >= 0 && idx[k] == null) idx[k] = n500; }
  const delivery = b && b[3] != null && bhavRes?.date ? { pct: b[3], date: bhavRes.date } : null;
  const intraday = isIntradayBar(dates[dates.length - 1], verified);
  return {
    sym, dates, closes, vols, idx, verified, delivery, opens, highs, lows, intraday,
    s10: smaSeries(closes, 10, 8), s50: smaSeries(closes, 50, 40), s200: smaSeries(closes, 200, 150),
  };
}

/** True-range stats from open/high/low/close (null when the bars aren't there). */
function rangeStats(d, i = d.closes.length - 1) {
  if (!d.highs) return null;
  const tr = [], adr = [];
  for (let k = Math.max(1, i - 19); k <= i; k++) {
    const h = d.highs[k], l = d.lows[k], pc = d.closes[k - 1];
    if (h == null || l == null || pc == null || l <= 0) continue;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)) / pc); adr.push(h / l - 1);
  }
  if (tr.length < 10) return null;
  const atr14 = tr.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, tr.length);
  return { atr: atr14 * 100, adr: (adr.reduce((a, b) => a + b, 0) / adr.length) * 100 };
}
/** Inside bars and the lowest-volume bar of the last 20 sessions (Stocksgeeks' LVC idea). */
function candleMarks(d) {
  const n = d.closes.length, out = { inside: new Set(), lvc: null };
  if (!d.highs) return out;
  for (let i = Math.max(1, n - 60); i < n; i++) {
    const h = d.highs[i], l = d.lows[i], ph = d.highs[i - 1], pl = d.lows[i - 1];
    if (h != null && l != null && ph != null && pl != null && h <= ph && l >= pl) out.inside.add(i);
  }
  let best = null; for (let i = Math.max(0, n - 20); i < (d.intraday ? n - 1 : n); i++) if (d.vols[i] != null && (best == null || d.vols[i] < d.vols[best])) best = i;
  out.lvc = best;
  return out;
}

function StockChart({ d, from, series = STOCK_SERIES, marks = [], candles = false }) {
  const [hover, setHover] = useState(null);
  const n = d.dates.length, start = Math.max(0, n - from);
  const idx = Array.from({ length: n - start }, (_, k) => start + k);
  const W = 340, H = 150, VH = 34, padL = 4, padR = 40, padT = 6;
  const showCandles = candles && !!d.highs;
  const cm = showCandles ? candleMarks(d) : { inside: new Set(), lvc: null };
  const vals = idx.flatMap(i => [d.closes[i], d.s10[i], d.s50[i], d.s200[i], ...(showCandles ? [d.highs[i], d.lows[i]] : [])]).filter(v => v != null);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const x = (k) => padL + (k / Math.max(1, idx.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / span) * (H - padT - 4);
  const path = (arr) => { let p = "", pen = false; idx.forEach((i, k) => { const v = arr[i]; if (v == null) { pen = false; return; } p += `${pen ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }); return p; };
  const maxV = Math.max(...idx.map(i => d.vols[i] || 0)) || 1;
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(idx.length - 1, Math.round(((px - padL) / (W - padL - padR)) * (idx.length - 1)))));
  };
  const hi_ = hover != null ? idx[hover] : null;
  const ticks = [lo, lo + span / 2, hi];
  const fmt = (v) => (v >= 1000 ? v.toFixed(0) : v.toFixed(1));
  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H + VH + 6}`} width="100%" style={{ display: "block", touchAction: "pan-y" }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => e.touches[0] && onMove({ currentTarget: e.currentTarget, clientX: e.touches[0].clientX })}
        onTouchMove={(e) => e.touches[0] && onMove({ currentTarget: e.currentTarget, clientX: e.touches[0].clientX })}
        onTouchEnd={() => setHover(null)} role="img" aria-label={`${d.sym} price with 10, 50 and 200-day moving averages and volume`}>
        {ticks.map((t, k) => (
          <g key={k}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
            <text x={W - padR + 4} y={y(t) + 3} fontSize="9" fill="var(--text3)" fontFamily="var(--mono)">{fmt(t)}</text>
          </g>
        ))}
        {series.map(s => <path key={s.key} d={path(d[s.key])} fill="none" stroke={s.color} strokeWidth="1.4" />)}
        {!showCandles && <path d={path(d.closes)} fill="none" stroke="var(--text)" strokeWidth="1.8" strokeLinejoin="round" />}
        {showCandles && idx.map((i, k) => {
          const o = d.opens[i], h = d.highs[i], l = d.lows[i], c = d.closes[i];
          if (c == null) return null;
          if (o == null || h == null || l == null) return <circle key={i} cx={x(k)} cy={y(c)} r="1" fill="var(--text2)" />;
          const hh = Math.max(h, o, c), ll = Math.min(l, o, c), up = c >= o, bw = Math.max(1, (W - padL - padR) / idx.length * 0.65);
          const col = up ? C.pos : C.neg;
          return (
            <g key={i}>
              <line x1={x(k)} x2={x(k)} y1={y(hh)} y2={y(ll)} stroke={col} strokeWidth="1" />
              <rect x={x(k) - bw / 2} width={bw} y={y(Math.max(o, c))} height={Math.max(0.8, Math.abs(y(o) - y(c)))} fill={up ? "var(--bg2)" : col} stroke={col} strokeWidth="1" />
              {cm.inside.has(i) && <circle cx={x(k)} cy={y(hh) - 4} r="1.8" fill={C.warn}><title>{`Inside bar ${mqFmtDate(d.dates[i])}`}</title></circle>}
              {cm.lvc === i && <text x={x(k)} y={y(ll) + 10} fontSize="7" textAnchor="middle" fill={C.lime} fontFamily="var(--mono)">LV<title>{`Lowest volume of the last 20 sessions (${mqFmtDate(d.dates[i])}) — a quiet bar to buy above`}</title></text>}
            </g>
          );
        })}
        {idx.map((i, k) => d.vols[i] ? (
          <rect key={i} x={x(k) - 0.6} width="1.2" y={H + 6 + VH - (d.vols[i] / maxV) * VH} height={(d.vols[i] / maxV) * VH}
            fill={d.closes[i] >= (d.closes[i - 1] ?? d.closes[i]) ? C.pos : C.neg} opacity="0.55" />
        ) : null)}
        {/* Trade replay: your buys (▲ below) and sells (▼ above), on the first chart bar on/after the trade day */}
        {marks.map((m, j) => {
          const k = idx.findIndex(i => d.dates[i] >= m.day);
          if (k < 0 || (k === 0 && d.dates[idx[0]] > m.day)) return null;
          const px = x(k), py = y(Math.min(hi, Math.max(lo, m.price)));
          return m.side === "buy"
            ? <path key={j} d={`M${px},${py + 4} l-4,7 h8 z`} fill={C.pos} stroke="var(--bg2)" strokeWidth="1"><title>{`Bought ₹${m.price} on ${mqFmtDate(m.day)}`}</title></path>
            : <path key={j} d={`M${px},${py - 4} l-4,-7 h8 z`} fill={C.neg} stroke="var(--bg2)" strokeWidth="1"><title>{`Sold ₹${m.price} on ${mqFmtDate(m.day)}`}</title></path>;
        })}
        {hi_ != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H + VH + 6} stroke="var(--text3)" strokeWidth="1" />
            <circle cx={x(hover)} cy={y(d.closes[hi_])} r="3.5" fill="var(--text)" stroke="var(--bg2)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hi_ != null && (
        <div style={{ position: "absolute", top: 0, left: `${(x(hover) / W) * 100}%`, transform: x(hover) / W > 0.55 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
          background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 8px", fontSize: 11, fontFamily: "var(--mono)", pointerEvents: "none", whiteSpace: "nowrap", zIndex: 2 }}>
          <div style={{ color: "var(--text3)" }}>{mqFmtDate(d.dates[hi_])}</div>
          {showCandles && d.highs[hi_] != null
            ? <div>O {d.opens[hi_]} H {d.highs[hi_]} L {d.lows[hi_]} C {d.closes[hi_].toFixed(2)}</div>
            : <div>₹{d.closes[hi_].toFixed(2)}</div>}
          {series.map(s => d[s.key][hi_] != null && <div key={s.key} style={{ color: "var(--text2)" }}><span style={{ display: "inline-block", width: 8, height: 2, background: s.color, marginRight: 5, verticalAlign: "middle" }} />{s.label} {d[s.key][hi_].toFixed(1)}</div>)}
          {d.vols[hi_] != null && <div style={{ color: "var(--text3)" }}>Vol {(d.vols[hi_] / 1e5).toFixed(1)}L</div>}
        </div>
      )}
    </div>
  );
}

/** How the stock reacted to its last results (NSE board-meeting dates): next-session move and 5 sessions on. */
function ResultsReaction({ d }) {
  const [dates, setDates] = useState(null);
  useEffect(() => {
    let alive = true; setDates(null);
    fetch(`/api/nse?type=pastresults&symbol=${encodeURIComponent(d.sym)}`).then(r => (r.ok ? r.json() : null)).catch(() => null).then(j => alive && setDates(j?.dates || []));
    return () => { alive = false; };
  }, [d.sym]);
  if (!dates?.length) return null;
  const rows = dates.map(day => {
    let k = d.dates.findIndex(x => x > day); // results usually land after the close → react next session
    if (k < 1 || d.closes[k] == null || d.closes[k - 1] == null) return null;
    const base = d.closes[k - 1], next = d.closes[k] / base - 1, five = d.closes[k + 5] != null ? d.closes[k + 5] / base - 1 : null;
    return { day, next: next * 100, five: five != null ? five * 100 : null };
  }).filter(Boolean).slice(-6).reverse();
  if (!rows.length) return null;
  const avgAbs = rows.reduce((a, r) => a + Math.abs(r.next), 0) / rows.length;
  const pc = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.08em", marginBottom: 4 }}>RESULTS REACTIONS · typical move ±{avgAbs.toFixed(1)}%</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", columnGap: 12, fontSize: 11, fontFamily: "var(--mono)" }}>
        <span style={{ fontSize: 9.5, color: "var(--text3)" }}>RESULTS</span><span style={{ fontSize: 9.5, color: "var(--text3)", textAlign: "right" }}>NEXT DAY</span><span style={{ fontSize: 9.5, color: "var(--text3)", textAlign: "right" }}>+5 DAYS</span>
        {rows.map(r => (
          <Fragment key={r.day}>
            <span style={{ color: "var(--text2)" }}>{mqFmtDate(r.day)}</span>
            <span style={{ textAlign: "right", color: r.next >= 0 ? C.pos : C.neg }}>{pc(r.next)}</span>
            <span style={{ textAlign: "right", color: r.five == null ? "var(--text3)" : r.five >= 0 ? C.pos : C.neg }}>{pc(r.five)}</span>
          </Fragment>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>If the typical move is bigger than your stop distance, holding through results risks a gap past it.</div>
    </div>
  );
}

/** Stocksgeeks-style table: true ATR / ADR, turnover and volume vs average. */
function StockStats({ d, q }) {
  const n = d.closes.length - 1, rs = rangeStats(d);
  const avg = (arr, a, b) => { const xs = []; for (let k = a; k <= b; k++) if (k >= 0 && arr[k] != null) xs.push(arr[k]); return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null; };
  const to = []; for (let k = 0; k <= n; k++) to.push(d.vols[k] != null && d.closes[k] != null ? (d.vols[k] * d.closes[k]) / 1e7 : null);
  const to20 = avg(to, n - 19, n), to50 = avg(to, n - 49, n), v50 = avg(d.vols, n - 50, n - 1);
  const vx = d.vols[n] != null && v50 ? d.vols[n] / v50 : null;
  const cr = (v) => (v == null ? "—" : `₹${v >= 100 ? Math.round(v).toLocaleString("en-IN") : v.toFixed(1)} cr`);
  const cells = [
    rs ? ["ATR (14)", `${rs.atr.toFixed(1)}%`, rs.atr >= 2.65 ? C.pos : "var(--text)"] : ["AVG MOVE", q?.move != null ? `${q.move}%` : "—", "var(--text3)"],
    ["ADR (20)", rs ? `${rs.adr.toFixed(1)}%` : "—", "var(--text)"],
    ["TURNOVER 20D", cr(to20), to20 != null && to20 >= 10 ? C.pos : to20 != null && to20 < 3 ? C.neg : "var(--text)"],
    ["VS 50D", to20 != null && to50 ? `${(to20 / to50).toFixed(1)}×` : "—", "var(--text)"],
    ["VOL TODAY", vx != null ? `${vx.toFixed(1)}×` : "—", vx != null && vx >= 1.5 ? C.pos : "var(--text)"],
  ];
  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px 6px" }}>
        {cells.map(([k, v, c]) => (
          <div key={k} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 9.5, color: "var(--text3)", letterSpacing: "0.08em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{k}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, color: c, whiteSpace: "nowrap" }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>
        {q?.pass === false ? "Below the quality gate (₹10 cr turnover, 1.8%+ average move) — slippage and slow moves likely." : q?.pass ? "Passes the quality gate." : ""}
        {!rs ? " Range stats need intraday highs/lows, unavailable for this stock." : ""}
      </div>
    </div>
  );
}

function ResultsWarning({ symbol, style }) {
  const [up, setUp] = useState(null);
  useEffect(() => {
    let alive = true; setUp(null);
    if (symbol) fetchResultsCalendar().then(cal => alive && setUp(upcomingResults(cal, normalizeSymbol(symbol), 10)));
    return () => { alive = false; };
  }, [symbol]);
  if (!up) return null;
  return (
    <div style={{ fontSize: 11, color: C.warn, border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.07)", borderRadius: 8, padding: "6px 9px", ...style }}>
      📅 Results {up.inDays === 0 ? "today" : up.inDays === 1 ? "tomorrow" : `in ${up.inDays} days`} ({mqFmtDate(up.date)}) — expect a big gap either way; size down or wait.
    </div>
  );
}

function StockPage({ symbol, onBack, onPlan, watchlist, setWatchlist, trades = [], onCompare }) {
  const { data: mq } = useMarketQuadrant();
  const { deals } = useFlowsDeals();
  const myDeals = (deals?.deals || []).filter(x => x.sym === symbol).filter((x, i, arr) => arr.findIndex(y => y.client === x.client && y.side === x.side && y.qty === x.qty && y.price === x.price) === i);
  const marks = tradeMarks(trades, symbol);
  const myTrades = (trades || []).filter(t => normalizeSymbol(t.symbol) === symbol);
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [range, setRange] = useState(250);
  const [weekly, setWeekly] = useState(false);
  const [candles, setCandles] = useState(() => { try { return localStorage.getItem("td_candles") === "1"; } catch (_) { return false; } });
  const pickCandles = (v) => { setCandles(v); try { localStorage.setItem("td_candles", v ? "1" : "0"); } catch (_) {} if (v && range > 126) setRange(126); };
  useEffect(() => {
    let alive = true;
    setD(null); setErr(null);
    fetchStockDetail(symbol).then(x => alive && setD(x)).catch(e => alive && setErr(e.message));
    return () => { alive = false; };
  }, [symbol]);

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
      <button onClick={onBack} className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }}>‹ Back</button>
      <div className="section-title" style={{ fontSize: 26 }}>{symbol}</div>
    </div>
  );
  if (err) return <div className="fade-in" style={{ padding: "16px 16px 120px" }}>{header}<div className="card" style={{ color: "var(--red)", fontSize: 13 }}>{err}</div></div>;
  if (!d) return <div className="fade-in" style={{ padding: "16px 16px 120px" }}>{header}<div className="card" style={{ color: "var(--text3)", fontSize: 13 }}>Loading {symbol}…</div></div>;

  const last = d.closes.length - 1, c = d.closes[last], pc = d.closes[last - 1];
  const chg = pc ? (c / pc - 1) * 100 : null;
  const hi252 = Math.max(...d.closes.slice(-252)), offHigh = (c / hi252 - 1) * 100;
  const retN = (arr, n) => { const a = arr[arr.length - 1], b = arr[arr.length - 1 - n]; return a != null && b != null ? (a / b - 1) * 100 : null; };
  const periods = [["1M", 21], ["3M", 63], ["6M", 126], ["12M", 246]].map(([l, n]) => {
    const s = retN(d.closes, n), ix = retN(d.idx, n);
    return { l, s, ix, rel: s != null && ix != null ? s - ix : null };
  });
  // RS line: stock / index, rebased to 100 at the start of the visible range
  const startI = Math.max(0, d.closes.length - range);
  const rs = d.closes.map((v, i) => (d.idx[i] ? v / d.idx[i] : null));
  const rs0 = rs.slice(startI).find(v => v != null);
  const rsLine = rs.map((v, i) => (i >= startI && v != null && rs0 ? (v / rs0) * 100 : null));

  const sector = mq?.sector_of?.[symbol] || null;
  const secInfo = sector ? (mq?.sectors || []).find(s => s.name === sector) : null;
  // Pocket pivots in the last 60 sessions
  const pivots = [];
  for (let i = Math.max(51, last - 59); i <= last; i++) {
    const v = d.vols[i], pv = d.vols[i - 1];
    if (v == null || pv == null || d.closes[i] / d.closes[i - 1] - 1 < 0.045 || v <= pv) continue;
    const w = d.vols.slice(i - 50, i).filter(x => x != null);
    if (w.length >= 20 && v > w.reduce((a, b) => a + b, 0) / w.length) pivots.push(d.dates[i]);
  }
  const rsRank = mq?.rs_breaks ? rsRating(rsScore(d.closes, last), mq.rs_breaks) : null;
  const envOk = mq ? mq.overall !== "CASH" && mq.environment?.name !== "NO MONEY" : null;
  const g = gradeSetup({ closes: d.closes, vols: d.vols, i: last, s50: d.s50[last], s200: d.s200[last], rs: rsRank, sectorStatus: secInfo?.status ?? null, envOk });
  const plan = tradePlan(d.closes, last);
  const wk = toWeekly(d);
  const wTrend = weeklyTrend(wk);
  const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
  const col = (v) => (v == null ? "var(--text3)" : v >= 0 ? C.pos : C.neg);

  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      {header}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 24, fontWeight: 700 }}>₹{c.toFixed(2)}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: col(chg) }}>{pct(chg)}</span>
          <span style={{ fontSize: 11, color: d.intraday ? C.warn : "var(--text3)" }}>{d.intraday ? `${mqFmtDate(d.dates[last])} · intraday (not a close)` : `${mqFmtDate(d.dates[last])} close${d.verified?.date === d.dates[last] ? " · ✓ NSE" : " · unverified"}`}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg3)" }}>
          <span title="Setup grade (A best)" style={{ fontSize: 13, fontWeight: 800, color: GRADE_COLOR[g.grade] }}>Grade {g.grade}</span>
          {rsRank != null && <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: rsRank >= 80 ? C.pos : "var(--text2)" }}>RS {rsRank}</span>}
          {secInfo && <span style={{ fontSize: 12, color: MQ_DIM_COLOR[secInfo.status] }}>{secInfo.status}</span>}
          {mq?.srank_of?.[symbol] && <span title={`Strength rank inside ${sector}`} style={{ fontSize: 12, color: mq.srank_of[symbol][0] <= 3 ? C.pos : "var(--text2)" }}>#{mq.srank_of[symbol][0]} of {mq.srank_of[symbol][1]} in sector</span>}
          <NseFlagBadge f={mq?.flags_of?.[symbol]} sym={symbol} />
          <span style={{ flex: 1 }} />
          {plan && <button className="btn-primary" style={{ padding: "8px 14px", fontSize: 12, borderRadius: 10 }} onClick={() => onPlan?.({ symbol, entry: plan.entry, stop: plan.stop })}>Plan trade ›</button>}
          {plan && <div style={{ width: "100%", fontFamily: "var(--mono)", fontSize: 12, color: "var(--text2)" }}>Entry ₹{plan.entry} · stop ₹{plan.stop} (−{plan.riskPct}%)</div>}
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><WatchButton symbol={symbol} watchlist={watchlist} setWatchlist={setWatchlist} />{onCompare && <button className="chip chip-sm" onClick={() => onCompare(symbol)}>Compare ›</button>}</div>
        <ResultsWarning symbol={symbol} style={{ marginTop: 8 }} />
        {d.delivery && (
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 6 }}>
            Delivery <b style={{ color: d.delivery.pct >= 50 ? C.pos : "var(--text)" }}>{Math.round(d.delivery.pct)}%</b> of traded shares on {mqFmtDate(d.delivery.date)} (NSE){d.delivery.pct >= 50 ? " — mostly real buying/selling, not intraday churn" : ""}
          </div>
        )}
        {myDeals.length > 0 && (
          <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 6 }}>
            {myDeals.slice(0, 3).map((x, i) => <div key={i}><b style={{ color: x.side === "BUY" ? C.pos : C.neg }}>{x.kind} {x.side.toLowerCase()}</b> · {x.client} · {(x.qty / 1e5).toFixed(1)}L sh @ ₹{x.price}</div>)}
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>
          {sector || "—"}{secInfo && <span style={{ color: MQ_DIM_COLOR[secInfo.status] }}> · {secInfo.status}</span>}{secInfo?.quadrant && ` · ${secInfo.quadrant.toLowerCase()}`} · {offHigh.toFixed(1)}% from 52w high
        </div>
        <div style={{ display: "flex", gap: 6, margin: "12px 0 6px", flexWrap: "wrap" }}>
          {(weekly ? [["1Y", 52], ["2Y", 104]] : [["3M", 63], ["6M", 126], ["1Y", 250]]).map(([l, n]) => (
            <button key={l} className="chip" onClick={() => setRange(n)} aria-pressed={range === n}
              style={range === n ? { borderColor: "var(--text)", color: "var(--text)" } : {}}>{l}</button>
          ))}
          <span style={{ flex: 1 }} />
          {!weekly && d.highs && (
            <button className="chip" onClick={() => pickCandles(!candles)} aria-pressed={candles} style={candles ? { borderColor: "var(--text)", color: "var(--text)" } : {}}>Candles</button>
          )}
          {[[false, "Daily"], [true, "Weekly"]].map(([v, l]) => (
            <button key={l} className="chip" onClick={() => { setWeekly(v); setRange(v ? 104 : 250); }} aria-pressed={weekly === v}
              style={weekly === v ? { borderColor: "var(--text)", color: "var(--text)" } : {}}>{l}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 10, color: "var(--text2)", marginBottom: 4 }}>
          <span><span style={{ display: "inline-block", width: 10, height: 2, background: "var(--text)", marginRight: 4, verticalAlign: "middle" }} />Price</span>
          {(weekly ? WEEKLY_SERIES : STOCK_SERIES).map(s => <span key={s.key}><span style={{ display: "inline-block", width: 10, height: 2, background: s.color, marginRight: 4, verticalAlign: "middle" }} />{s.label}</span>)}
        </div>
        <StockChart d={weekly ? wk : d} from={range} series={weekly ? WEEKLY_SERIES : STOCK_SERIES} marks={marks} candles={candles && !weekly} />
        {candles && !weekly && d.highs && (
          <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>
            <span style={{ color: C.warn }}>●</span> inside bar (range inside the day before) · <span style={{ color: C.lime, fontFamily: "var(--mono)" }}>LV</span> lowest-volume bar of the last 20 sessions — quiet bars are low-risk places to buy above, stop under their low.
          </div>
        )}
        <StockStats d={d} q={mq?.q_of?.[symbol]} />
        <ResultsReaction d={d} />
        {myTrades.length > 0 && (
          <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
            <div style={{ color: "var(--text3)", marginBottom: 3 }}>Your trades in {symbol} <span style={{ color: C.pos }}>▲ buy</span> <span style={{ color: C.neg }}>▼ sell</span></div>
            {myTrades.slice(0, 5).map(t => (
              <div key={t.id} style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)" }}>
                <span>{mqFmtDate(new Date(Date.parse(t.entries?.[0]?.date || t.date) + 19800000).toISOString().slice(0, 10))} · {t.setupType} · {t.status}</span>
                <span style={{ color: (t.pnl || 0) >= 0 ? C.pos : C.neg }}>{t.status === "closed" ? `${(t.pnl || 0) >= 0 ? "+" : ""}${formatINR(t.pnl || 0)}` : `@ ₹${t.avgEntry}`}</span>
              </div>
            ))}
          </div>
        )}
        {wTrend && <div style={{ fontSize: 11, marginTop: 6, color: wTrend.above && wTrend.rising ? C.pos : !wTrend.above && !wTrend.rising ? C.neg : C.warn }}>{wTrend.label}</div>}
      </div>

      <StockNotes symbol={symbol} last={c} />
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Relative strength vs Nifty 500{secInfo ? ` and ${sector}` : ""}</div>
        <svg viewBox="0 0 340 60" width="100%" style={{ display: "block" }} role="img" aria-label="Relative strength line versus Nifty 500">
          {(() => {
            const vals = rsLine.filter(v => v != null); if (!vals.length) return null;
            const lo = Math.min(...vals, 100), hi = Math.max(...vals, 100), sp = hi - lo || 1, n = d.closes.length - startI;
            const X = (i) => ((i - startI) / Math.max(1, n - 1)) * 300, Y = (v) => 4 + (1 - (v - lo) / sp) * 52;
            let p = ""; rsLine.forEach((v, i) => { if (v != null) p += `${p ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; });
            return (<>
              <line x1="0" x2="300" y1={Y(100)} y2={Y(100)} stroke="var(--border)" strokeDasharray="3 3" />
              <path d={p} fill="none" stroke={vals[vals.length - 1] >= 100 ? C.pos : C.neg} strokeWidth="1.6" />
              <text x="304" y={Y(vals[vals.length - 1]) + 3} fontSize="9" fill="var(--text2)" fontFamily="var(--mono)">{vals[vals.length - 1].toFixed(0)}</text>
            </>);
          })()}
        </svg>
        <div style={{ display: "grid", gridTemplateColumns: secInfo ? "auto 1fr 1fr 1fr 1fr" : "auto 1fr 1fr 1fr", columnGap: 10, rowGap: 4, fontSize: 11, marginTop: 8, fontFamily: "var(--mono)" }}>
          <span style={{ color: "var(--text3)" }} />
          <span style={{ color: "var(--text3)", textAlign: "right" }}>{symbol}</span>
          {secInfo && <span style={{ color: "var(--text3)", textAlign: "right" }} title={`Average of ${sector} stocks in the Nifty 500`}>Sector</span>}
          <span style={{ color: "var(--text3)", textAlign: "right" }}>N500</span>
          <span style={{ color: "var(--text3)", textAlign: "right" }}>Edge</span>
          {periods.map(p => (
            <Fragment key={p.l}>
              <span style={{ color: "var(--text3)" }}>{p.l}</span>
              <span style={{ textAlign: "right", color: col(p.s) }}>{pct(p.s)}</span>
              {secInfo && <span style={{ textAlign: "right", color: "var(--text2)" }}>{pct({ "1M": secInfo.ret1m, "3M": secInfo.ret3m, "6M": secInfo.ret6m }[p.l] ?? null)}</span>}
              <span style={{ textAlign: "right", color: "var(--text2)" }}>{pct(p.ix)}</span>
              <span style={{ textAlign: "right", color: col(p.rel), fontWeight: 700 }}>{p.rel == null ? "—" : `${p.rel > 0 ? "+" : ""}${p.rel.toFixed(1)}`}</span>
            </Fragment>
          ))}
        </div>
        <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>Line = price ÷ Nifty 500, rebased to 100. Rising = outperforming.</div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <span style={{ fontFamily: "var(--display)", fontSize: 40, lineHeight: 1, color: GRADE_COLOR[g.grade] }}>{g.grade}</span>
          <div>
            <div className="label">Setup grade · {g.pass}/{g.of} checks</div>
            <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 2 }}>
              Strength rank <b style={{ color: rsRank == null ? "var(--text3)" : rsRank >= 80 ? C.pos : "var(--text)" }}>{rsRank ?? "—"}</b>/99 vs the Nifty 500
            </div>
          </div>
        </div>
        {g.checks.filter(([, ok]) => ok != null).map(([t, ok]) => (
          <div key={t} style={{ display: "flex", gap: 8, fontSize: 12, padding: "3px 0", color: ok ? "var(--text)" : "var(--text3)" }}>
            <span style={{ color: ok ? C.pos : C.neg, width: 12 }}>{ok ? "✓" : "✗"}</span>{t}
          </div>
        ))}
        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 8 }}>
          Pocket pivots (60 sessions): {pivots.length ? pivots.slice(-5).map(mqFmtDate).join(", ") : "none"}
        </div>
      </div>

      {plan && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="label" style={{ marginBottom: 8 }}>Suggested plan</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, fontFamily: "var(--mono)" }}>
            {[["ENTRY", `₹${plan.entry}`, "var(--text)"], ["STOP", `₹${plan.stop}`, C.neg], ["TO STOP", `−${plan.riskPct}%`, plan.riskPct > 6 ? C.warn : "var(--text)"]].map(([l, v, col]) => (
              <div key={l} style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 8px" }}>
                <div style={{ fontSize: 9, color: "var(--text3)" }}>{l}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: col }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 8, lineHeight: 1.45 }}>
            {plan.breaking ? "Closing at a 10-day high — entry at today's close." : `Entry just above the 10-day closing high (₹${plan.pivot}).`} Stop just under the last 5 closes.{plan.note ? ` ${plan.note}.` : ""} Based on closing prices — adjust to the chart.
          </div>
        </div>
      )}
      <button className="btn-primary" style={{ width: "100%" }} onClick={() => onPlan(plan ? { symbol, entry: plan.entry, stop: plan.stop } : symbol)}>
        Plan trade ›
      </button>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 10 }}>Information only — not a recommendation.</div>
    </div>
  );
}

// ─── SECTOR ROTATION (D) ──────────────────────────────────────────────────────
const QUAD_COLOR = { LEADING: C.pos, WEAKENING: C.warn, LAGGING: C.neg, IMPROVING: "#3987E5" };
function MqSectorRotation({ data, onSelect }) {
  const hist = data?.sector_history;
  if (!hist) return null;
  const rows = (data.sectors || []).filter(s => hist[s.name]);
  const weeks = hist[rows[0]?.name] || [];
  const counts = rows.reduce((a, s) => { if (s.quadrant) a[s.quadrant] = (a[s.quadrant] || 0) + 1; return a; }, {});
  // single-hue sequential scale (green), darker = more stocks above the 50-SMA
  const cell = (v) => (v == null ? "var(--border)" : `rgba(74,222,128,${(0.08 + 0.85 * Math.min(100, Math.max(0, v)) / 100).toFixed(2)})`);
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>SECTOR ROTATION · 13 WEEKS</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 10 }}>
        Each cell = % of the sector's stocks above their 50-SMA that week (darker = broader). Quadrant = breadth level × 4-week change.
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        {["LEADING", "IMPROVING", "WEAKENING", "LAGGING"].map(q => (
          <span key={q} style={{ fontSize: 10, color: "var(--text2)", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: QUAD_COLOR[q] }} />{q.toLowerCase()} <span style={{ fontFamily: "var(--mono)", color: "var(--text3)" }}>{counts[q] || 0}</span>
          </span>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) repeat(13, 10px) 58px", columnGap: 2, rowGap: 3, alignItems: "center" }}>
        {rows.map(s => (
          <Fragment key={s.name}>
            <button onClick={() => onSelect?.(s.name)} title={s.name} style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", fontFamily: "inherit", fontSize: 10.5, lineHeight: 1.2, color: "var(--text2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</button>
            {hist[s.name].map(w => <span key={w.d} title={`${s.name} · week of ${mqFmtDate(w.d)}: ${w.p50 ?? "—"}% above 50-SMA · 1M ${w.ret1m ?? "—"}%`} style={{ height: 14, borderRadius: 2, background: cell(w.p50) }} />)}
            <span style={{ fontSize: 9, fontWeight: 700, color: QUAD_COLOR[s.quadrant] || "var(--text3)", textAlign: "right", letterSpacing: "0.04em" }}>{s.quadrant || "—"}</span>
          </Fragment>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", marginTop: 6 }}>
        <span>{weeks[0] ? mqFmtDate(weeks[0].d) : ""}</span><span>now</span>
      </div>
    </div>
  );
}

// ─── WEEKLY REPORT (F) ────────────────────────────────────────────────────────
function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { week: Math.ceil(((t - y0) / 86400000 + 1) / 7), year: t.getUTCFullYear() };
}
function weeklyReports(data, count = 8) {
  const h = data?.history || [];
  const byWeek = new Map();
  for (const r of h) { const { week, year } = isoWeek(r.d); byWeek.set(`${year}-${week}`, { r, week, year }); }
  const weeks = [...byWeek.values()].slice(-count - 1);
  const out = [];
  for (let k = 1; k < weeks.length; k++) {
    const { r, week, year } = weeks[k], prev = weeks[k - 1].r;
    const turning = r.b === "BEAR" && r.p200 >= 50 ? " (turning up)" : r.b === "BULL" && r.p200 < 50 ? " (turning down)" : "";
    const [sign, dir] = (r.m || "").split(" ");
    const sectorsAt = Object.entries(data.sector_history || {}).map(([name, ws]) => {
      const w = [...ws].reverse().find(x => x.d <= r.d); return w && w.ret1m != null ? { name, ret1m: w.ret1m } : null;
    }).filter(Boolean).sort((a, b) => b.ret1m - a.ret1m).slice(0, 4);
    const ftRow = (data.follow_through?.history || []).find(x => x.d === r.d);
    const dlt = (a, b) => (a != null && b != null ? `${a - b >= 0 ? "+" : ""}${(a - b).toFixed(1)}` : "—");
    const lines = [
      `Market Quadrant ${week}/${year} · ${k === weeks.length - 1 ? "week to" : "week ending"} ${mqFmtDate(r.d)}`,
      `Signal: ${r.sig}${prev.sig && prev.sig !== r.sig ? ` (was ${prev.sig})` : " (unchanged)"} · Environment: ${r.e}`,
      ``,
      `⦿ Bias → ${r.b}${turning}: ${r.p200}% of stocks above their 200-day SMA (${dlt(r.p200, prev.p200)} on the week).`,
      `⦿ Trend → ${r.t}: ${r.p50}% above the 50-day SMA (${dlt(r.p50, prev.p50)}); 52-week net new highs ${r.nnh > 0 ? "+" : ""}${r.nnh}.`,
      `⦿ Swing → ${r.s}: ${r.p10}% above the 10-day SMA vs ${r.p20}% above the 20-day.`,
      `⦿ Momentum → ${sign ? sign[0] + sign.slice(1).toLowerCase() : "—"}${dir ? `, ${dir.toLowerCase()}` : ""}.`,
      sectorsAt.length ? `Leading sectors (1-month): ${sectorsAt.map(s => `${s.name} ${s.ret1m > 0 ? "+" : ""}${s.ret1m}%`).join(", ")}.` : null,
      ftRow?.rate != null ? `Follow-through: ${ftRow.rate}% of the last 10 sessions' pocket pivots holding (${ftRow.events} pivots).` : null,
    ].filter(x => x !== null);
    out.push({ key: `${year}-${week}`, label: `${week}/${year}`, text: lines.join("\n") });
  }
  return out.reverse();
}
function MqWeeklyReport({ data }) {
  const reports = weeklyReports(data);
  const [sel, setSel] = useState(0);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(null);
  if (!reports.length) return null;
  const rep = reports[Math.min(sel, reports.length - 1)];
  const copy = async () => {
    try { await navigator.clipboard.writeText(rep.text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (_) {}
  };
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>WEEKLY REPORT</span>
        <span style={{ display: "flex", gap: 6 }}>
          <button onClick={async () => { const r = await shareReport(rep); setShared(r); setTimeout(() => setShared(null), 2000); }} className="chip" style={{ fontSize: 10, letterSpacing: 0 }}>
            {shared === "shared" ? "Shared ✓" : shared === "downloaded" ? "Saved ✓" : "Share image"}
          </button>
          <button onClick={copy} className="chip" style={{ fontSize: 10, letterSpacing: 0 }}>{copied ? "Copied ✓" : "Copy"}</button>
        </span>
      </div>
      <Guide id="ideas" d={data} />
      <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 10, scrollbarWidth: "none" }}>
        {reports.map((r, i) => (
          <button key={r.key} className="chip" onClick={() => setSel(i)} aria-pressed={i === sel}
            style={i === sel ? { borderColor: "var(--text)", color: "var(--text)", whiteSpace: "nowrap" } : { whiteSpace: "nowrap" }}>{r.label}</button>
        ))}
      </div>
      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.55, color: "var(--text2)", margin: 0 }}>{rep.text}</pre>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 8 }}>Generated from the app's Nifty 500 breadth data, in the format of Nitin R's weekly Market Quadrant posts.</div>
    </div>
  );
}

// ─── TRADES (E): journal + stats in one tab, with market context ─────────────
/** Market context to stamp on a trade opened now (null if no recent data). */
function currentMarketTags(symbol) {
  const d = getLastMarketQuadrant();
  if (!d || mqAgeDays(d.as_of) > 4) return null;
  const sym = normalizeSymbol(symbol || "");
  const sector = d.sector_of?.[sym] || null;
  return {
    as_of: d.as_of, signal: d.overall, env: d.environment?.name || null,
    ft: d.follow_through?.label || null, sector, risk: suggestedRisk(d)?.pct ?? null, em: d.green_light?.em ?? null,
    sectorStatus: sector ? (d.sectors || []).find(s => s.name === sector)?.status || null : null,
  };
}
const FT_BAND = (rate) => (rate == null ? null : rate >= FT_BANDS.strong ? "STRONG" : rate >= FT_BANDS.weak ? "MIXED" : "WEAK");
const SECTOR_STATUS = (p) => (p == null ? null : p >= 70 ? "HOT" : p >= 50 ? "WARM" : p >= 30 ? "COOL" : "COLD");
/** A trade's market context: stamped tags first, else reconstructed from history by entry date. */
function tradeContext(t, mq) {
  const tags = t.marketTags || {};
  const date = t.entries?.[0]?.date || t.date;
  const row = historyOnDate(mq, date);
  const day = row?.d;
  const sym = normalizeSymbol(t.symbol || "");
  const sector = tags.sector || mq?.sector_of?.[sym] || null;
  let secStatus = tags.sectorStatus || null;
  if (!secStatus && sector && day && mq?.sector_history?.[sector]) {
    const w = [...mq.sector_history[sector]].reverse().find(x => x.d <= day);
    secStatus = SECTOR_STATUS(w?.p50);
  }
  const ftRow = day ? (mq?.follow_through?.history || []).find(x => x.d === day) : null;
  return {
    signal: tags.signal || t.marketSignal || row?.sig || null,
    env: tags.env || row?.e || null,
    ft: tags.ft || FT_BAND(ftRow?.rate) || null,
    sectorStatus: secStatus,
  };
}

const CONTEXT_DIMS = [
  { id: "signal", label: "Signal", order: ["INVEST", "SELECTIVE", "CASH"], color: (k) => MQ_SIGNAL_COLOR[k] },
  { id: "env", label: "Environment", order: ["EASY MONEY", "HARD MONEY", "NO MONEY"], color: (k) => MQ_ENV_COLOR[k] },
  { id: "ft", label: "Follow-through", order: ["STRONG", "MIXED", "WEAK"], color: (k) => FT_COLOR[k] },
  { id: "sectorStatus", label: "Sector", order: ["HOT", "WARM", "COOL", "COLD"], color: (k) => MQ_DIM_COLOR[k] },
];

function MarketContextStats({ closed }) {
  const [mq, setMq] = useState(() => getLastMarketQuadrant());
  const [dim, setDim] = useState("env");
  useEffect(() => {
    let alive = true;
    loadMarketQuadrant({ allowCompute: false }).then(d => { if (alive && d) setMq(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!closed.length) return null;
  const def = CONTEXT_DIMS.find(x => x.id === dim);
  const groups = {};
  for (const t of closed) {
    const k = tradeContext(t, mq)[dim] || "Unknown";
    (groups[k] ||= []).push(t);
  }
  const keys = [...def.order.filter(k => groups[k]), ...(groups.Unknown ? ["Unknown"] : [])];
  const rows = keys.map(k => {
    const ts = groups[k];
    const wins = ts.filter(t => (t.pnl || 0) > 0).length;
    const pnl = ts.reduce((s, t) => s + (t.pnl || 0), 0);
    const rs = ts.filter(t => (t.riskAmount || 0) > 0).map(t => (t.pnl || 0) / t.riskAmount);
    return { k, n: ts.length, wr: Math.round((wins / ts.length) * 100), pnl, avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null };
  });
  const best = rows.filter(r => r.k !== "Unknown" && r.n >= 3 && r.avgR != null).sort((a, b) => b.avgR - a.avgR)[0];
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 6 }}>Your results by market condition at entry</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {CONTEXT_DIMS.map(x => (
          <button key={x.id} className="chip" onClick={() => setDim(x.id)} aria-pressed={x.id === dim}
            style={x.id === dim ? { borderColor: "var(--text)", color: "var(--text)" } : {}}>{x.label}</button>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 12, fontSize: 12 }}>
        {["CONDITION", "WIN %", "AVG R", "P&L"].map((hd, i) => (
          <span key={hd} style={{ fontSize: 10, color: "var(--text3)", paddingBottom: 6, textAlign: i ? "right" : "left" }}>{hd}</span>
        ))}
        {rows.map(r => (
          <Fragment key={r.k}>
            <div style={{ padding: "7px 0", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: def.color(r.k) || "var(--border)" }} />
              <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.k}</span>
              <span style={{ color: "var(--text3)", fontFamily: "var(--mono)", fontSize: 11 }}>{r.n}</span>
            </div>
            <div style={{ padding: "7px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: r.wr > 50 ? "var(--green)" : "var(--text2)" }}>{r.wr}%</div>
            <div style={{ padding: "7px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: "var(--text2)" }}>{r.avgR == null ? "—" : `${r.avgR > 0 ? "+" : ""}${r.avgR.toFixed(2)}`}</div>
            <div style={{ padding: "7px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: r.pnl >= 0 ? "var(--green)" : "var(--red)" }}>{r.pnl >= 0 ? "+" : ""}{formatINR(r.pnl)}</div>
          </Fragment>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 10 }}>
        {best ? `You do best in ${best.k} (${best.n} trades, avg ${best.avgR > 0 ? "+" : ""}${best.avgR.toFixed(2)}R).` : "Needs at least 3 tagged trades per condition to compare."}
        {" "}New trades are tagged at entry; older ones are matched to the market history by date.
      </div>
    </div>
  );
}

function TradesPage({ sub, setSub, journalProps, statsProps }) {
  return (
    <div>
      <div style={{ display: "flex", gap: 6, padding: "14px 16px 0" }}>
        {[["journal", "Journal"], ["stats", "Stats"]].map(([id, l]) => (
          <button key={id} className="chip" onClick={() => setSub(id)} aria-pressed={sub === id}
            style={sub === id ? { borderColor: "var(--text)", color: "var(--text)", flex: 1 } : { flex: 1 }}>{l}</button>
        ))}
      </div>
      {sub === "journal" && <ZerodhaImport trades={journalProps.trades} setTrades={journalProps.setTrades} />}
      {sub === "stats" ? <AnalyticsPage {...statsProps} /> : <JournalPage {...journalProps} />}
    </div>
  );
}

// ─── PHASE 1: position health · environment sizing · discipline ──────────────

/** Risk per trade and total open-risk cap suggested by today's market state. */
function suggestedRisk(d) {
  if (!d?.environment) return null;
  const env = d.environment.name;
  let pct = env === "EASY MONEY" ? 1 : env === "HARD MONEY" ? 0.5 : 0;
  const why = [env === "EASY MONEY" ? "Easy money" : env === "HARD MONEY" ? "Hard money" : "No money"];
  if (d.overall === "CASH") { pct = 0; why.push("signal CASH"); }
  if (pct > 0 && d.green_light?.mult != null) {
    if (d.green_light.mult === 0) { pct = 0; why.push(`green light ${d.green_light.em} — below 9, stand down`); }
    else if (d.green_light.mult < 1) { pct *= d.green_light.mult; why.push(`green light ${d.green_light.em} (${d.green_light.mult}×)`); }
  }
  else if (pct > 0 && d.follow_through?.label === "WEAK") { pct /= 2; why.push("follow-through weak"); }
  if (pct > 0 && d.lows_ok === false) { pct /= 2; why.push(`${d.new_lows} at 52w lows`); }
  const heatCap = env === "EASY MONEY" ? 6 : env === "HARD MONEY" ? 3 : 0;
  return { pct: Math.round(pct * 100) / 100, heatCap, why: why.join(" · ") };
}

/** Open risk across positions, % of portfolio (risk to current stop on remaining qty). */
function openHeatPct(trades, portfolio) {
  if (!portfolio) return 0;
  const risk = trades.filter(t => t.status === "open" || t.status === "partial").map(normalizeTrade)
    .reduce((s, t) => s + Math.max(0, ((t.avgEntry || 0) - (t.currentStop || 0)) * (t.remainingQty || t.totalQty || 0)), 0);
  return (risk / portfolio) * 100;
}

function SizingAdvice({ portfolio, trades, riskPct, onApply }) {
  const [d, setD] = useState(() => getLastMarketQuadrant());
  useEffect(() => {
    let alive = true;
    loadMarketQuadrant({ allowCompute: false }).then(x => { if (alive && x) setD(x); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const s = suggestedRisk(d);
  if (!s) return null;
  const heat = openHeatPct(trades || [], portfolio);
  const after = heat + (riskPct || 0);
  const over = s.heatCap === 0 ? riskPct > 0 : after > s.heatCap;
  const above = riskPct > s.pct + 1e-9;
  return (
    <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 10, border: `1px solid ${over || above ? "rgba(245,158,11,0.4)" : "var(--border)"}`, background: over || above ? "rgba(245,158,11,0.06)" : "transparent" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ fontSize: 11, color: "var(--text2)" }}>
          Suggested: <b style={{ color: "var(--text)" }}>{s.pct}%</b> <span style={{ color: "var(--text3)" }}>({s.why})</span>
        </div>
        {s.pct > 0 && Math.abs(riskPct - s.pct) > 1e-9 && (
          <button className="chip chip-sm" onClick={() => onApply(s.pct)}>Use {s.pct}%</button>
        )}
      </div>
      <div style={{ fontSize: 11, color: over ? C.warn : "var(--text3)", marginTop: 4, fontFamily: "var(--mono)" }}>
        Portfolio heat {heat.toFixed(1)}% → {after.toFixed(1)}% after this trade · cap {s.heatCap}%
      </div>
      {s.pct === 0 && <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>⚠ Market rules say no new entries today.</div>}
      {s.pct > 0 && above && <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>⚠ {riskPct}% is above today's suggested risk.</div>}
      {s.pct > 0 && over && <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>⚠ This would take total open risk over the {s.heatCap}% cap.</div>}
    </div>
  );
}

// Per-stock daily trend for open positions (cached per symbol per day)
const _trendCache = new Map();
async function stockTrend(sym) {
  const key = `${sym}|${Math.floor(Date.now() / 1200000)}`; // 20-minute buckets: intraday prices go stale
  if (_trendCache.has(key)) return _trendCache.get(key);
  const p = fetchStockDetail(sym).then(d => {
    const i = d.closes.length - 1;
    const s20 = smaSeries(d.closes, 20, 15);
    const rs = rangeStats(d, i);
    const atrAbs = rs ? (rs.atr / 100) * d.closes[i - 1 >= 0 ? i - 1 : i] : null;
    const low10 = Math.min(...(d.lows || []).slice(-10).filter(v => v != null), Infinity);
    return { close: d.closes[i], s10: d.s10[i], s20: s20[i], s50: d.s50[i], s200: d.s200[i], date: d.dates[i], intraday: d.intraday,
      atr: atrAbs, ext: atrAbs && d.s10[i] != null ? (d.closes[i] - d.s10[i]) / atrAbs : null, low10: Number.isFinite(low10) ? low10 : null };
  }).catch(() => null);
  _trendCache.set(key, p);
  return p;
}

/** Hold / Tighten / Exit for an open position, with reasons. */
function positionHealth(t, trend, mq, livePrice) {
  const price = livePrice?.price ?? trend?.close;
  const reasons = [];
  let level = 0; // 0 hold, 1 tighten, 2 exit
  const bump = (l, why) => { level = Math.max(level, l); reasons.push({ l, why }); };
  const stop = t.currentStop || t.stop;
  if (price != null && stop && price <= stop) bump(2, `At/below stop ₹${stop}`);
  const verb = trend?.intraday ? "Trading below" : "Closed below", tag = trend?.intraday ? " (intraday — wait for the close)" : "";
  if (trend?.s50 != null && trend.close < trend.s50) bump(trend.intraday ? 1 : 2, `${verb} its 50-day SMA${tag}`);
  else if (trend?.s20 != null && trend.close < trend.s20) reasons.push({ l: 0.3, why: `${verb} its 20-day SMA — normal noise; the tested exit is a close under the 50-day${tag}` });
  const sector = mq?.sector_of?.[normalizeSymbol(t.symbol)];
  const sec = sector ? (mq.sectors || []).find(s => s.name === sector) : null;
  if (sec && ["COOL", "COLD"].includes(sec.status)) bump(1, `Sector ${sector} is ${sec.status}`);
  if (sec && sec.status_d1 && sec.status !== sec.status_d1 && ["HOT", "WARM"].includes(sec.status_d1) && !["HOT", "WARM"].includes(sec.status)) bump(1, `${sector} dropped ${sec.status_d1} → ${sec.status}`);
  const entryTagged = t.marketTags?.sectorStatus;
  if (entryTagged && ["HOT", "WARM"].includes(entryTagged) && sec && !["HOT", "WARM"].includes(sec.status)) bump(1, `Sector was ${entryTagged} at entry`);
  if (mq?.environment?.name === "NO MONEY" || mq?.overall === "CASH") bump(1, "Market turned No money / CASH");
  if (mq?.follow_through?.label === "WEAK") bump(1, "Breakouts are failing market-wide");
  const days = calcDaysHeld(t);
  const st = getDaysHeldStatus(t.setupType, days);
  const r1 = (t.avgEntry || t.entry) && t.stop ? (t.avgEntry || t.entry) - t.stop : null;
  const working = r1 > 0 && trend?.close != null && trend.close >= (t.avgEntry || t.entry) + r1; // up 1R or more
  if (/Decision needed/.test(st.label) && !working) reasons.push({ l: 0.35, why: `Day ${days} and not up 1R yet — slow trades are fine as long as it holds the 50-day` });
  // Selling into strength: far above the 10-day average in ATRs → trim; trail the stop under the 10-day low
  let trim = false;
  if (trend?.ext != null && trend.ext >= 3 && level < 2) { trim = true; reasons.push({ l: 0.5, why: `${trend.ext.toFixed(1)} ATR above its 10-day — extended. Over 5 years trimming here earned a little less than holding with a 50-day trail; trim only if the position is too big for you` }); }
  const entry = t.avgEntry || t.entry, r0 = entry && t.stop ? entry - t.stop : null;
  // Once it's working, the tested trail is a close under the 50-day (tight 10-day / breakeven trails did worst)
  if (level < 2 && trend?.s50 != null && stop && trend.close > entry && r0 > 0 && trend.close - entry >= 2 * r0) {
    const trail = +(trend.s50 * 0.995).toFixed(2);
    if (trail > stop) reasons.push({ l: 0.4, why: `Up ${((trend.close - entry) / r0).toFixed(1)}R — trail the stop to ₹${trail}, just under the 50-day (best exit over 5 years)` });
  }
  const label = level === 0 && trim ? "EXTENDED" : ["HOLD", "TIGHTEN STOP", "EXIT"][level];
  return { level, trim, label, color: level === 0 && trim ? C.lime : [C.pos, C.warn, C.neg][level], reasons: reasons.sort((a, b) => b.l - a.l).map(r => r.why) };
}

function PositionHealth({ trade, livePrice }) {
  const [trend, setTrend] = useState(null);
  const [mq, setMq] = useState(() => getLastMarketQuadrant());
  const [results, setResults] = useState(null);
  useEffect(() => {
    let alive = true;
    stockTrend(normalizeSymbol(trade.symbol)).then(x => alive && setTrend(x));
    fetchResultsCalendar().then(cal => alive && setResults(upcomingResults(cal, normalizeSymbol(trade.symbol), 5)));
    loadMarketQuadrant({ allowCompute: false }).then(x => { if (alive && x) setMq(x); }).catch(() => {});
    return () => { alive = false; };
  }, [trade.symbol]);
  if (!trend && !mq) return null;
  const h = positionHealth(trade, trend, mq, livePrice);
  if (results) {
    h.reasons.unshift(`Results ${results.inDays === 0 ? "today" : results.inDays === 1 ? "tomorrow" : `in ${results.inDays} days`} (${mqFmtDate(results.date)}) — decide before the gap`);
    if (h.level < 1) { h.level = 1; h.label = "TIGHTEN STOP"; h.color = C.warn; }
  }
  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.1em", color: h.color, border: `1px solid ${h.color}66`, borderRadius: 10, padding: "1px 8px" }}>{h.label}</span>
        <span style={{ fontSize: 11, color: "var(--text3)" }}>{h.reasons.length ? h.reasons[0] : "Trend, sector and market all intact"}</span>
      </div>
      {h.reasons.length > 1 && (
        <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4, lineHeight: 1.5 }}>{h.reasons.slice(1).join(" · ")}</div>
      )}
      {trend && (
        <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4, fontFamily: "var(--mono)" }}>
          10d {trend.s10?.toFixed(1) ?? "—"} · 20d {trend.s20?.toFixed(1) ?? "—"} · 50d {trend.s50?.toFixed(1) ?? "—"} ({trend.intraday ? "intraday" : "close"} {mqFmtDate(trend.date)})
        </div>
      )}
    </div>
  );
}

/** Rule-following score for a closed trade (5 checks, from conditions at entry). */
function disciplineScore(t, mq, portfolio) {
  const ctx = tradeContext(t, mq);
  const entryRow = historyOnDate(mq, t.entries?.[0]?.date || t.date);
  const sugg = t.marketTags?.risk != null ? { pct: t.marketTags.risk }
    : suggestedRisk(entryRow ? { environment: { name: ctx.env }, overall: ctx.signal, follow_through: { label: ctx.ft } } : null);
  const riskPct = portfolio && t.riskAmount ? (t.riskAmount / portfolio) * 100 : null;
  const checks = [
    ["Signal wasn't CASH", ctx.signal ? ctx.signal !== "CASH" : null],
    ["Environment wasn't No money", ctx.env ? ctx.env !== "NO MONEY" : null],
    ["Sector HOT/WARM", ctx.sectorStatus ? ["HOT", "WARM"].includes(ctx.sectorStatus) : null],
    ["Risk within suggested size", sugg && riskPct != null ? riskPct <= sugg.pct + 0.1 : null],
    ["Had a stop", t.source === "zerodha" && !((t.currentStop || t.stop) > 0) ? null : (t.currentStop || t.stop) > 0],
    ["Pre-trade checklist complete", t.checklist ? t.checklist.ticked.length === t.checklist.total : null],
  ];
  const known = checks.filter(c => c[1] != null);
  return { score: known.filter(c => c[1]).length, of: known.length, checks };
}

function DisciplineStats({ closed, portfolio }) {
  const [mq, setMq] = useState(() => getLastMarketQuadrant());
  useEffect(() => {
    let alive = true;
    loadMarketQuadrant({ allowCompute: false }).then(d => { if (alive && d) setMq(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!closed.length) return null;
  const scored = closed.map(t => ({ t, ...disciplineScore(t, mq, portfolio) })).filter(x => x.of >= 3);
  if (!scored.length) return null;
  const good = scored.filter(x => x.score === x.of), bad = scored.filter(x => x.score < x.of);
  const avgR = (xs) => { const rs = xs.filter(x => x.t.riskAmount > 0).map(x => (x.t.pnl || 0) / x.t.riskAmount); return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null; };
  const wr = (xs) => (xs.length ? Math.round((xs.filter(x => (x.t.pnl || 0) > 0).length / xs.length) * 100) : null);
  const avgScore = scored.reduce((a, x) => a + x.score / x.of, 0) / scored.length;
  const misses = {};
  for (const x of scored) for (const [name, ok] of x.checks) if (ok === false) misses[name] = (misses[name] || 0) + 1;
  const topMiss = Object.entries(misses).sort((a, b) => b[1] - a[1])[0];
  const fmtR = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}R`);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 6 }}>Discipline</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 24, fontWeight: 800, color: avgScore >= 0.8 ? C.pos : avgScore >= 0.6 ? C.warn : C.neg }}>{Math.round(avgScore * 100)}%</span>
        <span style={{ fontSize: 11, color: "var(--text3)" }}>of the rules followed on average · {scored.length} trades</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 12, fontSize: 12, marginTop: 10 }}>
        {["", "TRADES", "WIN %", "AVG R"].map((h, i) => <span key={i} style={{ fontSize: 10, color: "var(--text3)", textAlign: i ? "right" : "left", paddingBottom: 4 }}>{h}</span>)}
        {[["Followed every rule", good], ["Broke a rule", bad]].map(([l, xs]) => (
          <Fragment key={l}>
            <span style={{ padding: "6px 0", borderTop: "1px solid var(--border)" }}>{l}</span>
            <span style={{ padding: "6px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)" }}>{xs.length}</span>
            <span style={{ padding: "6px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)" }}>{wr(xs) ?? "—"}{xs.length ? "%" : ""}</span>
            <span style={{ padding: "6px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: (avgR(xs) ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>{fmtR(avgR(xs))}</span>
          </Fragment>
        ))}
      </div>
      {topMiss && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 8 }}>Most-broken rule: <b style={{ color: "var(--text2)" }}>{topMiss[0]}</b> ({topMiss[1]}×)</div>}
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>Checks: signal not CASH · environment not No money · sector HOT/WARM · risk within the suggested size · a stop was set. Risk % uses your current portfolio value.</div>
    </div>
  );
}

// ─── PHASE 2: signal backtest · themes · index ETFs ──────────────────────────

/** The whole system as a ₹10 lakh portfolio over ~4 years, vs the Nifty 500. */
function MqSystem({ sys }) {
  const [hover, setHover] = useState(null);
  if (!sys?.variants?.rules?.curve?.length) return null;
  const V = sys.variants, lines = [
    { k: "rules", label: "TRADESK rules", color: "#3B82F6", pts: V.rules.curve },
    ...(V.no_filter ? [{ k: "no_filter", label: "No market filter", color: C.lime, pts: V.no_filter.curve }] : []),
    ...(sys.index ? [{ k: "index", label: "Nifty 500", color: "#D9632B", pts: sys.index.curve.filter(p => p[1] != null) }] : []),
  ];
  const W = 340, H = 120, padL = 4, padR = 38, padT = 6;
  const all = lines.flatMap(l => l.pts.map(p => p[1]));
  const lo = Math.min(...all), hi = Math.max(...all), sp = hi - lo || 1, n = V.rules.curve.length;
  const x = (i) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR), y = (v) => padT + (1 - (v - lo) / sp) * (H - padT - 4);
  const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const lakh = (v) => (v == null ? "—" : `₹${(v / 1e5).toFixed(1)}L`);
  const rows = [["rules", V.rules], ["cash_half", V.cash_half], ["no_filter", V.no_filter]].filter(([, v]) => v);
  const hp = hover != null ? V.rules.curve[hover] : null;
  const cell = { borderTop: "1px solid var(--border)", padding: "3px 0" };
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>THE WHOLE SYSTEM · ₹10 LAKH ACCOUNT</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8, lineHeight: 1.45 }}>
        Only TRADESK's rules, {mqFmtDate(sys.from)} {sys.from.slice(0, 4)} – {mqFmtDate(sys.to)} {sys.to.slice(0, 4)}: high-tight flags, first 52-week highs and 21-EMA pullbacks that pass the quality gate; size from the day's risk with the gap buffer and caps; out at the stop or a close under the 50-day; 0.15% costs a side.
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        {lines.map(l => <span key={l.k} style={{ fontSize: 11, color: "var(--text2)", display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 12, height: 2, background: l.color }} />{l.label} <b style={{ fontFamily: "var(--mono)" }}>{lakh(l.pts[l.pts.length - 1][1])}</b></span>)}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", touchAction: "pan-y" }} role="img" aria-label="Equity curves: TRADESK rules, no market filter and Nifty 500"
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(n - 1, Math.round((((e.clientX - r.left) / r.width) * W - padL) / (W - padL - padR) * (n - 1))))); }} onMouseLeave={() => setHover(null)}>
        <line x1={padL} x2={W - padR} y1={y(1e6)} y2={y(1e6)} stroke="var(--border)" strokeDasharray="3 3" />
        <text x={W - padR + 3} y={y(1e6) + 3} fontSize="9" fill="var(--text3)" fontFamily="var(--mono)">₹10L</text>
        <text x={W - padR + 3} y={y(hi) + 6} fontSize="9" fill="var(--text3)" fontFamily="var(--mono)">{lakh(hi)}</text>
        {lines.map(l => <path key={l.k} d={path(l.pts)} fill="none" stroke={l.color} strokeWidth={l.k === "rules" ? 2 : 1.4} />)}
        {hp && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H} stroke="var(--text3)" />}
      </svg>
      {hp && <div style={{ fontSize: 10.5, color: "var(--text2)", fontFamily: "var(--mono)" }}>{mqFmtDate(hp[0])} {hp[0].slice(0, 4)} · rules {lakh(hp[1])}{V.no_filter ? ` · no filter ${lakh(V.no_filter.curve[hover]?.[1])}` : ""}{sys.index?.curve[hover]?.[1] ? ` · N500 ${lakh(sys.index.curve[hover][1])}` : ""}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 10, fontSize: 11, marginTop: 8 }}>
        {["", "PER YEAR", "WORST DROP", "TRADES"].map((h, i) => <span key={i} style={{ fontSize: 9.5, color: "var(--text3)", textAlign: i ? "right" : "left" }}>{h}</span>)}
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <span style={{ ...cell, color: "var(--text2)" }}>{v.label}</span>
            <span style={{ ...cell, fontFamily: "var(--mono)", textAlign: "right", color: v.cagr >= 0 ? C.pos : C.neg }}>{v.cagr > 0 ? "+" : ""}{v.cagr}%</span>
            <span style={{ ...cell, fontFamily: "var(--mono)", textAlign: "right", color: C.neg }}>{v.maxDD}%</span>
            <span style={{ ...cell, fontFamily: "var(--mono)", textAlign: "right" }}>{v.trades}</span>
          </Fragment>
        ))}
        {sys.index && <>
          <span style={{ ...cell, color: "var(--text2)" }}>Nifty 500 buy & hold</span>
          <span style={{ ...cell, fontFamily: "var(--mono)", textAlign: "right" }}>{sys.index.cagr > 0 ? "+" : ""}{sys.index.cagr}%</span>
          <span style={{ ...cell, fontFamily: "var(--mono)", textAlign: "right", color: C.neg }}>{sys.index.maxDD}%</span>
          <span style={cell} />
        </>}
      </div>
      <div style={{ fontSize: 10.5, color: "var(--text2)", marginTop: 8, lineHeight: 1.5 }}>
        Trades: {V.rules.win}% winners averaging +{V.rules.avgWin}%, losers averaging {V.rules.avgLoss}%, held about {V.rules.days} days — a few big winners pay for many small losses.
      </div>
      <div style={{ fontSize: 10, color: C.warn, marginTop: 6, lineHeight: 1.45 }}>
        ⚠ Optimistic: it uses today's Nifty 500 members (stocks that later fell out are missing, which flatters momentum setups) and closing prices only. Treat it as "the rules hang together", not as the return to expect.
      </div>
    </div>
  );
}

/** What followed each signal / environment over 5 years (average Nifty 500 stock, next 10 sessions). */
function MqSignalBuckets({ long }) {
  if (!long?.by_signal) return null;
  const row = (k, v, c) => v && (
    <div key={k} style={{ display: "grid", gridTemplateColumns: "100px 1fr 64px", alignItems: "center", gap: 8, fontSize: 11.5, margin: "3px 0" }}>
      <span style={{ color: c, fontWeight: 700 }}>{k}</span>
      <div style={{ height: 8, borderRadius: 4, background: "var(--bg3)", position: "relative" }}><div style={{ width: `${Math.min(100, Math.max(3, v.up))}%`, height: "100%", borderRadius: 4, background: c, opacity: 0.7 }} /></div>
      <span style={{ fontFamily: "var(--mono)", textAlign: "right", color: v.fwd >= 0 ? C.pos : C.neg }}>{v.fwd > 0 ? "+" : ""}{v.fwd}%</span>
    </div>
  );
  const S = long.by_signal, E = long.by_env || {};
  const best = Object.entries(S).sort((a, b) => b[1].fwd - a[1].fwd)[0]?.[0];
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>WHAT FOLLOWED EACH READING · 5 YEARS</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8 }}>Average Nifty 500 stock over the next 10 sessions; the bar is how often it was higher. {mqFmtDate(long.from)} {long.from?.slice(0, 4)} – {mqFmtDate(long.to)} {long.to?.slice(0, 4)}.</div>
      {["INVEST", "SELECTIVE", "CASH"].map(k => row(k, S[k], MQ_SIGNAL_COLOR[k]))}
      <div style={{ height: 6 }} />
      {["EASY MONEY", "HARD MONEY", "NO MONEY"].map(k => row(k, E[k], MQ_ENV_COLOR[k] || C.muted))}
      <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 6, lineHeight: 1.45 }}>
        {best === "INVEST" ? "INVEST days led to the best follow-through — the signal sorts the market the right way over 5 years."
          : `${best} days were followed by the best returns, not INVEST — the signal mostly lowers risk (smaller drops) rather than picking the best times to buy.`}
      </div>
    </div>
  );
}

/** Exit rules compared on the same entries over 5 years. */
function MqExitRules({ rows, from }) {
  if (!rows?.length) return null;
  const mx = Math.max(...rows.map(r => Math.abs(r.avgR)), 0.3);
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>WHICH EXIT WORKS? · 5 YEARS</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8, lineHeight: 1.45 }}>
        The same {rows[0].n.toLocaleString("en-IN")} entries (high-tight flags, first 52-week highs, 21-EMA pullbacks since {mqFmtDate(from)} {from?.slice(0, 4)}, bought at the close with the app's stop), each managed by a different exit rule. Best average R first.
      </div>
      {rows.map((r, i) => (
        <div key={r.id} style={{ padding: "5px 0", borderTop: i ? "1px solid var(--border)" : "none" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11.5 }}>
            <span style={{ color: i === 0 ? C.pos : "var(--text2)", fontWeight: i === 0 ? 700 : 400 }}>{i === 0 ? "★ " : ""}{r.label}</span>
            <span style={{ fontFamily: "var(--mono)", color: r.avgR >= 0 ? C.pos : C.neg, whiteSpace: "nowrap" }}>{r.avgR > 0 ? "+" : ""}{r.avgR}R</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
            <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--bg3)" }}><div style={{ width: `${(Math.abs(r.avgR) / mx) * 100}%`, height: "100%", borderRadius: 3, background: r.avgR >= 0 ? C.pos : C.neg, opacity: 0.75 }} /></div>
            <span style={{ fontSize: 10, color: "var(--text3)", whiteSpace: "nowrap", fontFamily: "var(--mono)" }}>{r.avg > 0 ? "+" : ""}{r.avg}% · {r.win}% win · {r.days}d</span>
          </div>
        </div>
      ))}
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>Closing prices only; real fills on stops are worse (the app's sizing allows 25% for that). Today's index members only.</div>
    </div>
  );
}

function MqSignalBacktest({ bt, title = "DOES THE SIGNAL WORK?" }) {
  const [hover, setHover] = useState(null);
  if (!bt) return null;
  const pts = bt.curve;
  const W = 340, H = 110, padL = 4, padR = 34, padT = 6;
  const vals = pts.flatMap(p => [p.s, p.h]);
  const lo = Math.min(...vals), hi = Math.max(...vals), sp = hi - lo || 1;
  const x = (i) => padL + (i / Math.max(1, pts.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / sp) * (H - padT - 4);
  const path = (k) => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
  const S = { s: { label: "Follow signal", color: "#3987E5" }, h: { label: "Buy & hold N500", color: "#D9632B" } };
  const beat = bt.strat.ret >= bt.hold.ret;
  const verdict = beat
    ? `Following the signal beat buy & hold (${bt.strat.ret > 0 ? "+" : ""}${bt.strat.ret}% vs ${bt.hold.ret > 0 ? "+" : ""}${bt.hold.ret}%) with a smaller worst drop.`
    : `Following the signal returned ${bt.strat.ret > 0 ? "+" : ""}${bt.strat.ret}% vs ${bt.hold.ret > 0 ? "+" : ""}${bt.hold.ret}% for buy & hold — it did not add return. It cut the worst drop from ${bt.hold.maxDD}% to ${bt.strat.maxDD}%, mostly by being invested only ${bt.strat.exposure}% of the time.`;
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(pts.length - 1, Math.round((((e.clientX - r.left) / r.width) * W - padL) / (W - padL - padR) * (pts.length - 1)))));
  };
  const hp = hover != null ? pts[hover] : null;
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8 }}>
        Nifty 500 held 100% on INVEST, 50% on SELECTIVE, 0% on CASH · {mqFmtDate(bt.from)} {bt.from.slice(0, 4)} – {mqFmtDate(bt.to)} {bt.to.slice(0, 4)} ({bt.sessions} sessions)
      </div>
      <div style={{ display: "flex", gap: 14, marginBottom: 6, flexWrap: "wrap" }}>
        {Object.entries(S).map(([k, v]) => (
          <span key={k} style={{ fontSize: 11, color: "var(--text2)", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 12, height: 2, background: v.color }} />{v.label}
            <span style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>{pts[pts.length - 1][k]}</span>
          </span>
        ))}
      </div>
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", touchAction: "pan-y" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
          onTouchMove={(e) => e.touches[0] && onMove({ currentTarget: e.currentTarget, clientX: e.touches[0].clientX })} onTouchEnd={() => setHover(null)}
          role="img" aria-label="Growth of 100: following the signal versus buy and hold">
          <line x1={padL} x2={W - padR} y1={y(100)} y2={y(100)} stroke="var(--border)" strokeDasharray="3 3" />
          <text x={W - padR + 4} y={y(100) + 3} fontSize="9" fill="var(--text3)" fontFamily="var(--mono)">100</text>
          {["h", "s"].map(k => <path key={k} d={path(k)} fill="none" stroke={S[k].color} strokeWidth="1.8" strokeLinejoin="round" />)}
          {hp && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H} stroke="var(--text3)" />}
          {hp && ["h", "s"].map(k => <circle key={k} cx={x(hover)} cy={y(hp[k])} r="3.5" fill={S[k].color} stroke="var(--bg2)" strokeWidth="2" />)}
        </svg>
        {hp && (
          <div style={{ position: "absolute", top: 0, left: `${(x(hover) / W) * 100}%`, transform: x(hover) / W > 0.55 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
            background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "5px 8px", fontSize: 11, fontFamily: "var(--mono)", pointerEvents: "none", whiteSpace: "nowrap" }}>
            <div style={{ color: "var(--text3)" }}>{mqFmtDate(hp.d)}</div>
            <div>Signal {hp.s} · Hold {hp.h}</div>
          </div>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 12, fontSize: 12, marginTop: 10, fontFamily: "var(--mono)" }}>
        {["", "RETURN", "WORST DROP", "INVESTED"].map((h, i) => <span key={i} style={{ fontSize: 9, color: "var(--text3)", textAlign: i ? "right" : "left" }}>{h}</span>)}
        {[["Follow signal", bt.strat.ret, bt.strat.maxDD, `${bt.strat.exposure}%`], ["Buy & hold", bt.hold.ret, bt.hold.maxDD, "100%"]].map(([l, r, dd, ex]) => (
          <Fragment key={l}>
            <span style={{ fontFamily: "inherit", color: "var(--text2)", paddingTop: 4 }}>{l}</span>
            <span style={{ textAlign: "right", paddingTop: 4, color: r >= 0 ? C.pos : C.neg }}>{r > 0 ? "+" : ""}{r}%</span>
            <span style={{ textAlign: "right", paddingTop: 4, color: C.neg }}>{dd}%</span>
            <span style={{ textAlign: "right", paddingTop: 4, color: "var(--text2)" }}>{ex}</span>
          </Fragment>
        ))}
      </div>
      <div style={{ fontSize: 12, color: "var(--text)", marginTop: 10, lineHeight: 1.45 }}>{verdict}</div>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6, lineHeight: 1.45 }}>
        Avg next-day index move after INVEST {bt.next_day.INVEST ?? "—"}% ({bt.days.INVEST}d) · SELECTIVE {bt.next_day.SELECTIVE ?? "—"}% ({bt.days.SELECTIVE}d) · CASH {bt.next_day.CASH ?? "—"}% ({bt.days.CASH}d).
        In-sample (same rules, same period), ~14 months, no costs, cash earns 0 — treat as a sanity check, not proof.
      </div>
    </div>
  );
}

function MqThemes({ themes, onPickStock }) {
  if (!themes?.length) return null;
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>THEMES</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 10 }}>NSE thematic index members in the Nifty 500 · % above 50-SMA · 1-month return · strongest members</div>
      {themes.map(t => (
        <div key={t.name} style={{ padding: "7px 0", borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, flex: 1, minWidth: 0 }}>{t.name} <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 400 }}>{t.n}</span></span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{t.p50 ?? "—"}%</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: MQ_DIM_COLOR[t.status], width: 34, textAlign: "right" }}>{t.status}</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: (t.ret1m ?? 0) >= 0 ? C.pos : C.neg, width: 48, textAlign: "right" }}>{t.ret1m == null ? "—" : `${t.ret1m > 0 ? "+" : ""}${t.ret1m}%`}</span>
          </div>
          {t.top?.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
              {t.top.slice(0, 4).map(x => (
                <button key={x.sym} onClick={() => onPickStock?.(x.sym)} title={`Open ${x.sym}`}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)", textDecoration: "underline dotted", textUnderlineOffset: 3 }}>
                  {x.sym} <span style={{ color: x.ret3m >= 0 ? C.pos : C.neg }}>{x.ret3m > 0 ? "+" : ""}{x.ret3m}%</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const INDEX_ETFS = [
  ["NIFTYBEES", "Nifty 50"], ["JUNIORBEES", "Nifty Next 50"], ["MID150BEES", "Midcap 150"],
  ["HDFCSML250", "Smallcap 250"], ["BANKBEES", "Bank Nifty"], ["GOLDBEES", "Gold"],
];
let _etfCache = null;
async function fetchEtfTrends() {
  const day = istDayKey(Math.floor(Date.now() / 1000));
  if (_etfCache && _etfCache.day === day && Date.now() - _etfCache.at < 20 * 60000) return _etfCache.rows;
  const tickers = INDEX_ETFS.map(([t]) => `${t}.NS`);
  const r = await fetch(`/api/spark?symbols=${encodeURIComponent(tickers.join(","))}&range=2y&interval=1d`).then(x => x.json());
  const rows = [];
  for (const [t, name] of INDEX_ETFS) {
    const it = (r?.spark?.result || []).find(x => x.symbol === `${t}.NS`);
    if (!it) continue;
    const cl = it.response[0].indicators.quote[0].close.filter(v => v != null);
    const i = cl.length - 1, c = cl[i];
    const s50 = smaSeries(cl, 50, 40)[i], s200 = smaSeries(cl, 200, 150)[i], s10 = smaSeries(cl, 10, 8)[i];
    const ret1m = cl[i - 21] ? (c / cl[i - 21] - 1) * 100 : null;
    const trend = s50 && s200 ? (c > s50 && c > s200 && s50 > s200 ? "UP" : c < s50 && c < s200 ? "DOWN" : "MIXED") : "—";
    rows.push({ sym: t, name, close: c, ret1m, above10: s10 != null && c > s10, trend });
  }
  _etfCache = { day, at: Date.now(), rows };
  return rows;
}

function EtfPanel({ lockout, onPickStock }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { let alive = true; fetchEtfTrends().then(x => alive && setRows(x)).catch(() => alive && setRows([])); return () => { alive = false; }; }, []);
  if (!rows?.length) return null;
  const col = { UP: C.pos, DOWN: C.neg, MIXED: C.warn };
  return (
    <div style={{ ...mqCardStyle, borderColor: lockout ? "rgba(245,158,11,0.4)" : "var(--border)" }}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>INDEX ETFS</div>
      <div style={{ fontSize: 11, color: lockout ? C.warn : "var(--text3)", marginBottom: 8 }}>
        {lockout ? "Lockout rally: index ETFs often give the cleanest risk/reward." : "Trend of the main index ETFs (vs 50 & 200-day SMA)."}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 12, fontSize: 12 }}>
        {["ETF", "TREND", "1M", "10D"].map((h, i) => <span key={h} style={{ fontSize: 9, color: "var(--text3)", textAlign: i ? "right" : "left", paddingBottom: 4 }}>{h}</span>)}
        {rows.map(r => (
          <Fragment key={r.sym}>
            <div style={{ padding: "6px 0", borderTop: "1px solid var(--border)", minWidth: 0 }}>
              <button onClick={() => onPickStock?.(r.sym)} title={`Open ${r.sym}`} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", fontFamily: "var(--display)", fontWeight: 700, fontSize: 12, textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{r.sym}</button>
              <div style={{ fontSize: 10, color: "var(--text3)" }}>{r.name}</div>
            </div>
            <span style={{ padding: "6px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontSize: 10, fontWeight: 700, color: col[r.trend] || "var(--text3)" }}>{r.trend}</span>
            <span style={{ padding: "6px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: (r.ret1m ?? 0) >= 0 ? C.pos : C.neg }}>{r.ret1m == null ? "—" : `${r.ret1m > 0 ? "+" : ""}${r.ret1m.toFixed(1)}%`}</span>
            <span style={{ padding: "6px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontSize: 11, color: r.above10 ? C.pos : C.neg }}>{r.above10 ? "above" : "below"}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ─── PHASE 4: watchlist · alerts · notifications ─────────────────────────────

/** Alerts for watched stocks from today's data (+ live price for level crosses). */
function watchAlerts(watchlist, mq, micro, quotes, cal) {
  const out = [];
  const lists = [mq?.scans, micro?.scans].filter(Boolean);
  const inList = (key, sym) => lists.some(sc => (sc[key] || []).some(x => x.sym === sym));
  for (const w of watchlist || []) {
    const sym = w.sym;
    if (inList("pivots", sym)) out.push({ sym, kind: "pivot", text: "Pocket pivot today" });
    if (inList("ep", sym)) out.push({ sym, kind: "ep", text: "Episodic pivot (≥8% on ≥3× volume)" });
    if (inList("tight", sym)) out.push({ sym, kind: "tight", text: "Tight setup near highs" });
    if (inList("reclaim50", sym)) out.push({ sym, kind: "reclaim", text: "Reclaimed its 50-day SMA" });
    const q = quotes?.[sym];
    if (w.level && q?.price != null && q.price >= w.level) out.push({ sym, kind: "level", text: `Price ₹${q.price.toFixed(2)} ≥ your level ₹${w.level}` });
    const up = upcomingResults(cal, sym, 5);
    if (up) out.push({ sym, kind: "results", text: `Results ${up.inDays === 0 ? "today" : up.inDays === 1 ? "tomorrow" : `in ${up.inDays} days`}` });
  }
  return out;
}

function useWatchAlerts(watchlist) {
  const { data: mq } = useMarketQuadrant();
  const [extra, setExtra] = useState({ quotes: {}, cal: null, micro: null });
  const key = (watchlist || []).map(w => `${w.sym}:${w.level || ""}`).join(",");
  useEffect(() => {
    let alive = true;
    if (!watchlist?.length) { setExtra({ quotes: {}, cal: null, micro: null }); return; }
    (async () => {
      const [quotes, cal] = await Promise.all([fetchQuotes(watchlist.map(w => w.sym), { force: true }).catch(() => ({})), fetchResultsCalendar()]);
      let micro = null;
      try { const e = JSON.parse(localStorage.getItem("td_mq_micro_v1") || "null"); micro = e?.data || null; } catch (_) {}
      if (alive) setExtra({ quotes, cal, micro });
    })();
    return () => { alive = false; };
  }, [key]);
  const alerts = watchAlerts(watchlist, mq, extra.micro, extra.quotes, extra.cal);
  return { alerts, quotes: extra.quotes, mq };
}

const ALERT_ICON = { pivot: "⚡", ep: "🚀", tight: "🎯", reclaim: "↗", level: "🔔", results: "📅" };

// Browser notifications for new alerts (works while the app is open or in a background tab)
function useAlertNotifications(alerts) {
  useEffect(() => {
    if (!alerts.length || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    let seen = {};
    const today = istDayKey(Math.floor(Date.now() / 1000));
    try { seen = JSON.parse(localStorage.getItem("td_alerts_seen") || "{}"); } catch (_) {}
    if (seen.day !== today) seen = { day: today, ids: [] };
    const fresh = alerts.filter(a => !seen.ids.includes(`${a.sym}|${a.kind}`));
    if (!fresh.length) return;
    const body = fresh.slice(0, 4).map(a => `${a.sym}: ${a.text}`).join("\n");
    const title = `${fresh.length} watchlist alert${fresh.length > 1 ? "s" : ""}`;
    (navigator.serviceWorker?.getRegistration?.() || Promise.resolve(null))
      .then(reg => (reg ? reg.showNotification(title, { body, icon: "/icon-192.png", tag: "watchlist" }) : new Notification(title, { body })))
      .catch(() => {});
    seen.ids.push(...fresh.map(a => `${a.sym}|${a.kind}`));
    try { localStorage.setItem("td_alerts_seen", JSON.stringify(seen)); } catch (_) {}
  }, [alerts.map(a => `${a.sym}|${a.kind}`).join(",")]);
}

function WatchAlertsCard({ watchlist, onOpen }) {
  const { alerts } = useWatchAlerts(watchlist);
  useAlertNotifications(alerts);
  const [perm, setPerm] = useState(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
  if (!watchlist?.length) return null;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div className="label">Watchlist alerts · {watchlist.length} watched</div>
        {perm === "default" && (
          <button className="chip" style={{ fontSize: 10 }} onClick={() => Notification.requestPermission().then(setPerm)}>Notify me</button>
        )}
      </div>
      {alerts.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text3)" }}>No alerts today on your watched stocks.</div>
      ) : alerts.map((a, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, padding: "4px 0" }}>
          <span style={{ width: 16 }}>{ALERT_ICON[a.kind]}</span>
          <button onClick={() => onOpen?.(a.sym)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", fontFamily: "var(--display)", fontWeight: 700, textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{a.sym}</button>
          <span style={{ color: "var(--text2)" }}>{a.text}</span>
        </div>
      ))}
      {perm === "granted" && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>Notifications on — they arrive while the app is open or in a background tab.</div>}
    </div>
  );
}

function WatchButton({ symbol, watchlist, setWatchlist }) {
  const w = (watchlist || []).find(x => x.sym === symbol);
  const [level, setLevel] = useState(w?.level ? String(w.level) : "");
  useEffect(() => { setLevel(w?.level ? String(w.level) : ""); }, [symbol, w?.level]);
  const toggle = () => setWatchlist(prev => (prev || []).some(x => x.sym === symbol)
    ? prev.filter(x => x.sym !== symbol)
    : [...(prev || []), { sym: symbol, addedAt: new Date().toISOString(), level: null }]);
  const saveLevel = () => {
    const v = parseFloat(level);
    setWatchlist(prev => (prev || []).map(x => (x.sym === symbol ? { ...x, level: Number.isFinite(v) && v > 0 ? v : null } : x)));
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <button className="chip" onClick={toggle} aria-pressed={Boolean(w)} style={w ? { borderColor: C.warn, color: C.warn } : {}}>
        {w ? "★ Watching" : "☆ Watch"}
      </button>
      {w && (
        <>
          <input type="number" inputMode="decimal" placeholder="Alert at ₹" value={level} onChange={e => setLevel(e.target.value)} onBlur={saveLevel}
            style={{ width: 110, fontSize: 12, padding: "6px 8px" }} />
          {w.level && <span style={{ fontSize: 10, color: "var(--text3)" }}>alerts when price ≥ ₹{w.level}</span>}
        </>
      )}
    </div>
  );
}

function WatchlistPanel({ watchlist, setWatchlist, onPickStock }) {
  const { alerts, quotes, mq } = useWatchAlerts(watchlist);
  if (!watchlist?.length) {
    return <div style={{ fontSize: 12, color: "var(--text3)", padding: "16px 0", textAlign: "center" }}>Nothing watched yet — open a stock and tap ☆ Watch.</div>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", columnGap: 12, fontSize: 12 }}>
      {["STOCK", "PRICE", ""].map((h, i) => <span key={i} style={{ fontSize: 9, color: "var(--text3)", paddingBottom: 6, textAlign: i ? "right" : "left" }}>{h}</span>)}
      {watchlist.map(w => {
        const q = quotes?.[w.sym], al = alerts.filter(a => a.sym === w.sym);
        const sector = mq?.sector_of?.[w.sym];
        return (
          <Fragment key={w.sym}>
            <div style={{ padding: "7px 0", borderTop: "1px solid var(--border)", minWidth: 0 }}>
              <button onClick={() => onPickStock?.(w.sym)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", fontFamily: "var(--display)", fontWeight: 700, textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{w.sym}</button>
              <div style={{ fontSize: 10, color: al.length ? C.warn : "var(--text3)" }}>
                {al.length ? al.map(a => `${ALERT_ICON[a.kind]} ${a.text}`).join(" · ") : sector || ""}{w.level ? ` · alert ≥ ₹${w.level}` : ""}
              </div>
            </div>
            <div style={{ padding: "7px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)" }}>
              {q?.price != null ? `₹${q.price.toFixed(2)}` : "—"}
              {Number.isFinite(q?.changePct) && <div style={{ fontSize: 10, color: q.changePct >= 0 ? C.pos : C.neg }}>{q.changePct >= 0 ? "+" : ""}{q.changePct.toFixed(2)}%</div>}
            </div>
            <div style={{ padding: "7px 0", borderTop: "1px solid var(--border)", textAlign: "right" }}>
              <button onClick={() => setWatchlist(prev => prev.filter(x => x.sym !== w.sym))} aria-label={`Remove ${w.sym}`} style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 14 }}>×</button>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

// ─── C · F · G: Zerodha import, exit replay, equity & risk ───────────────────

function ZerodhaImport({ trades, setTrades }) {
  const [state, setState] = useState(null); // { preview } | { error } | { done }
  const fileRef = useRef(null);
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const text = await f.text();
      const { fills, skippedSegment } = parseTradebook(text);
      const existing = new Set((trades || []).flatMap(t => t.importIds || []));
      const r = buildTrades(fills, existing);
      setState({ preview: { ...r, skippedSegment, file: f.name } });
    } catch (err) { setState({ error: err.message || String(err) }); }
  };
  const confirm = () => {
    const p = state.preview;
    // stamp market context by entry date so stats work immediately
    const mq = getLastMarketQuadrant();
    const tagged = p.trades.map(t => {
      const row = historyOnDate(mq, t.entries[0]?.date);
      return row ? { ...t, marketSignal: row.sig || null } : t;
    });
    setTrades([...(trades || []), ...tagged]);
    setState({ done: p.trades.length });
  };
  return (
    <div className="card" style={{ margin: "12px 16px 0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div className="label">Import from Zerodha</div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>Console → Reports → Tradebook → Equity → download CSV</div>
        </div>
        <button className="btn-ghost" style={{ fontSize: 12, padding: "8px 12px" }} onClick={() => fileRef.current?.click()}>Choose CSV</button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} />
      </div>
      {state?.error && <div style={{ fontSize: 12, color: "var(--red)", marginTop: 8 }}>{state.error}</div>}
      {state?.preview && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--text2)", lineHeight: 1.6 }}>
          <b style={{ color: "var(--text)" }}>{state.preview.file}</b><br />
          {state.preview.closed} closed trades · {state.preview.open} open positions to add
          {state.preview.duplicates ? ` · ${state.preview.duplicates} fills already imported (skipped)` : ""}
          {state.preview.skippedShort ? ` · ${state.preview.skippedShort} short sells skipped` : ""}
          {state.preview.skippedSegment ? ` · ${state.preview.skippedSegment} F&O/other rows skipped` : ""}
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>Stops aren't in the tradebook, so R-multiples and the stop check are skipped for imported trades — add a stop to a trade to include it.</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn-primary" style={{ flex: 1, padding: "8px" }} disabled={!state.preview.trades.length} onClick={confirm}>
              Import {state.preview.trades.length} trade{state.preview.trades.length === 1 ? "" : "s"}
            </button>
            <button className="btn-ghost" style={{ padding: "8px 12px" }} onClick={() => setState(null)}>Cancel</button>
          </div>
        </div>
      )}
      {state?.done != null && <div style={{ fontSize: 12, color: C.pos, marginTop: 8 }}>✓ Imported {state.done} trades. They're tagged with the market conditions at entry.</div>}
    </div>
  );
}

// ── G: equity curve, drawdown, return distribution, Monte Carlo ──
function tradeReturnPct(t, portfolio) {
  return portfolio ? ((t.pnl || 0) / portfolio) * 100 : null;
}
function exitDate(t) {
  const x = (t.exits || []).slice(-1)[0];
  return x?.date || t.date;
}
function monteCarlo(rets, n = 50, runs = 2000) {
  if (rets.length < 10) return null; // too few trades for a meaningful reshuffle
  let dd10 = 0, dd20 = 0; const ends = [];
  for (let r = 0; r < runs; r++) {
    let eq = 100, peak = 100, worst = 0;
    for (let k = 0; k < n; k++) {
      eq *= 1 + rets[Math.floor(Math.random() * rets.length)] / 100;
      peak = Math.max(peak, eq); worst = Math.min(worst, eq / peak - 1);
    }
    if (worst <= -0.1) dd10++; if (worst <= -0.2) dd20++;
    ends.push(eq - 100);
  }
  ends.sort((a, b) => a - b);
  return { n, p10: Math.round((dd10 / runs) * 100), p20: Math.round((dd20 / runs) * 100), median: +ends[Math.floor(runs / 2)].toFixed(1), worst5: +ends[Math.floor(runs * 0.05)].toFixed(1) };
}

function EquityRisk({ closed, portfolio }) {
  const sorted = [...closed].sort((a, b) => (exitDate(a) < exitDate(b) ? -1 : 1));
  if (sorted.length < 2 || !portfolio) return null;
  const pts = []; let eq = 0, peak = 0, maxDD = 0;
  for (const t of sorted) { eq += t.pnl || 0; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq - peak); pts.push({ d: exitDate(t), eq }); }
  const rets = sorted.map(t => tradeReturnPct(t, portfolio)).filter(Number.isFinite);
  const mc = monteCarlo(rets);
  const W = 340, H = 100, lo = Math.min(0, ...pts.map(p => p.eq)), hi = Math.max(0, ...pts.map(p => p.eq)), sp = hi - lo || 1;
  const x = (i) => 4 + (i / Math.max(1, pts.length - 1)) * (W - 44), y = (v) => 6 + (1 - (v - lo) / sp) * (H - 12);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.eq).toFixed(1)}`).join("");
  const rs = sorted.filter(t => t.riskAmount > 0).map(t => (t.pnl || 0) / t.riskAmount);
  const bins = [[-Infinity, -1], [-1, 0], [0, 1], [1, 2], [2, 3], [3, Infinity]], labels = ["<−1R", "−1–0", "0–1", "1–2", "2–3", "3R+"];
  const counts = bins.map(([a, b]) => rs.filter(r => r >= a && r < b).length), maxC = Math.max(1, ...counts);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 6 }}>Equity curve · {sorted.length} closed trades</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img" aria-label="Cumulative P&L by trade">
        <line x1="4" x2={W - 40} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke={eq >= 0 ? C.pos : C.neg} strokeWidth="1.8" strokeLinejoin="round" />
        <text x={W - 36} y={y(eq) + 3} fontSize="9" fill="var(--text2)" fontFamily="var(--mono)">{eq >= 0 ? "+" : ""}{Math.round(eq / 1000)}k</text>
      </svg>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8, fontSize: 12 }}>
        <div><span style={{ color: "var(--text3)" }}>Total</span> <b style={{ color: eq >= 0 ? "var(--green)" : "var(--red)", fontFamily: "var(--mono)" }}>{eq >= 0 ? "+" : ""}{formatINR(eq)}</b></div>
        <div><span style={{ color: "var(--text3)" }}>Worst drawdown</span> <b style={{ color: "var(--red)", fontFamily: "var(--mono)" }}>{formatINR(maxDD)}</b> <span style={{ color: "var(--text3)" }}>({((maxDD / portfolio) * 100).toFixed(1)}%)</span></div>
      </div>
      {rs.length >= 3 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 4 }}>R-multiples ({rs.length} trades with a stop)</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 50 }}>
            {counts.map((c, i) => (
              <div key={i} title={`${labels[i]}: ${c}`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                <span style={{ fontSize: 9, color: "var(--text3)", fontFamily: "var(--mono)" }}>{c || ""}</span>
                <div style={{ width: "100%", height: `${(c / maxC) * 34}px`, minHeight: c ? 2 : 0, borderRadius: 3, background: i < 2 ? C.neg : C.pos, opacity: 0.75 }} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4, fontSize: 9, color: "var(--text3)", marginTop: 2 }}>{labels.map(l => <span key={l} style={{ flex: 1, textAlign: "center" }}>{l}</span>)}</div>
        </div>
      )}
      {!mc && rets.length > 0 && rets.length < 10 && (
        <div style={{ marginTop: 10, fontSize: 11, color: "var(--text3)" }}>Drawdown odds appear after 10 closed trades ({rets.length} so far).</div>
      )}
      {mc && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)", fontSize: 12, color: "var(--text2)", lineHeight: 1.55 }}>
          <b style={{ color: "var(--text)" }}>Next {mc.n} trades, if they look like your last {rets.length}</b> (2,000 random reshuffles):<br />
          Chance of a 10% drawdown: <b style={{ color: mc.p10 > 30 ? C.neg : "var(--text)" }}>{mc.p10}%</b> · 20% drawdown: <b style={{ color: mc.p20 > 10 ? C.neg : "var(--text)" }}>{mc.p20}%</b><br />
          Median outcome {mc.median > 0 ? "+" : ""}{mc.median}% · bad case (5%) {mc.worst5 > 0 ? "+" : ""}{mc.worst5}%
          {rets.length < 30 && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>Small sample ({rets.length} trades) — treat as a rough guide; it firms up past ~30 trades.</div>}
        </div>
      )}
    </div>
  );
}

// ── F: exit replay — what trailing the 10 / 20-day SMA would have done ──
const _detailCache = new Map();
function cachedDetail(sym) {
  const key = `${sym}|${istDayKey(Math.floor(Date.now() / 1000))}`;
  if (!_detailCache.has(key)) _detailCache.set(key, fetchStockDetail(sym).catch(() => null));
  return _detailCache.get(key);
}
/** Simulate exits from the first entry: close below the N-day SMA → exit at that close. */
function replayExit(d, entryDate, entryPrice, period, maxDays = 120) {
  const s = smaSeries(d.closes, period, Math.ceil(period * 0.75));
  const day = new Date(Date.parse(entryDate) + 19800000).toISOString().slice(0, 10);
  let i = d.dates.findIndex(x => x >= day);
  if (i < 0) return null;
  for (let k = i + 1; k < d.closes.length && k <= i + maxDays; k++) {
    if (s[k] != null && d.closes[k] < s[k]) return { ret: (d.closes[k] / entryPrice - 1) * 100, days: k - i, open: false };
  }
  const last = Math.min(d.closes.length - 1, i + maxDays);
  return { ret: (d.closes[last] / entryPrice - 1) * 100, days: last - i, open: last === d.closes.length - 1 };
}

function ExitReplay({ closed }) {
  const [rows, setRows] = useState(null);
  const recent = [...closed].sort((a, b) => (exitDate(a) < exitDate(b) ? 1 : -1)).slice(0, 15);
  const key = recent.map(t => t.id).join(",");
  useEffect(() => {
    let alive = true;
    (async () => {
      const out = [];
      for (const t of recent) {
        const sym = normalizeSymbol(t.symbol), e0 = t.entries?.[0];
        const entry = t.avgEntry || e0?.price, qty = t.totalQty || e0?.qty;
        if (!entry || !qty || !e0?.date) continue;
        const d = await cachedDetail(sym);
        if (!d) continue;
        const actual = ((t.pnl || 0) / (entry * qty)) * 100;
        out.push({ sym, actual, s10: replayExit(d, e0.date, entry, 10), s20: replayExit(d, e0.date, entry, 20) });
        if (alive) setRows([...out]);
      }
      if (alive) setRows(out);
    })();
    return () => { alive = false; };
  }, [key]);
  if (!closed.length) return null;
  const done = (rows || []).filter(r => r.s10 && r.s20);
  const avg = (f) => (done.length ? done.reduce((a, r) => a + f(r), 0) / done.length : null);
  const a = avg(r => r.actual), b10 = avg(r => r.s10.ret), b20 = avg(r => r.s20.ret);
  const best = [["your exits", a], ["10-day SMA trail", b10], ["20-day SMA trail", b20]].filter(x => x[1] != null).sort((x, y) => y[1] - x[1])[0];
  const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
  const col = (v) => (v == null ? "var(--text3)" : v >= 0 ? C.pos : C.neg);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 4 }}>Exit replay · last {recent.length} trades</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 10 }}>Your actual return vs exiting at the first close below the 10- or 20-day SMA (same entry, closing prices).</div>
      {rows && rows.length < recent.length && <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 6 }}>Loading {rows.length}/{recent.length}…</div>}
      {!rows ? <div style={{ fontSize: 12, color: "var(--text3)" }}>Loading price history…</div> : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 12, fontSize: 12, fontFamily: "var(--mono)" }}>
          {["", "ACTUAL", "10-SMA", "20-SMA"].map((h, i) => <span key={i} style={{ fontSize: 9, color: "var(--text3)", textAlign: i ? "right" : "left", paddingBottom: 4 }}>{h}</span>)}
          {rows.map(r => (
            <Fragment key={r.sym + r.actual}>
              <span style={{ padding: "5px 0", borderTop: "1px solid var(--border)", fontFamily: "var(--display)", fontWeight: 700 }}>{r.sym}</span>
              <span style={{ padding: "5px 0", borderTop: "1px solid var(--border)", textAlign: "right", color: col(r.actual) }}>{pct(r.actual)}</span>
              <span style={{ padding: "5px 0", borderTop: "1px solid var(--border)", textAlign: "right", color: col(r.s10?.ret) }}>{pct(r.s10?.ret)}{r.s10?.open ? "*" : ""}</span>
              <span style={{ padding: "5px 0", borderTop: "1px solid var(--border)", textAlign: "right", color: col(r.s20?.ret) }}>{pct(r.s20?.ret)}{r.s20?.open ? "*" : ""}</span>
            </Fragment>
          ))}
          {done.length > 1 && (
            <>
              <span style={{ padding: "6px 0", borderTop: "1px solid var(--text3)", fontWeight: 700 }}>Average</span>
              {[a, b10, b20].map((v, i) => <span key={i} style={{ padding: "6px 0", borderTop: "1px solid var(--text3)", textAlign: "right", fontWeight: 700, color: col(v) }}>{pct(v)}</span>)}
            </>
          )}
        </div>
      )}
      {done.length > 1 && best && (
        <div style={{ fontSize: 12, color: "var(--text)", marginTop: 10 }}>
          {best[0] === "your exits" ? "Your own exits did best on these trades." : `Trailing the ${best[0].replace(" trail", "")} would have averaged ${pct(best[1])} vs your ${pct(a)}.`}
        </div>
      )}
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>* still above the average today (not exited yet). Ignores costs and intraday moves.</div>
    </div>
  );
}

// ─── H · I · J · K ────────────────────────────────────────────────────────────

// H: global markets / pre-market brief
const GLOBAL_TICKERS = [
  ["ES=F", "S&P 500 fut"], ["NQ=F", "Nasdaq fut"], ["^N225", "Nikkei"], ["^HSI", "Hang Seng"],
  ["^KS11", "Kospi"], ["CL=F", "Crude"], ["GC=F", "Gold"], ["USDINR=X", "USD/INR"],
];
let _globalCache = null;
async function fetchGlobal() {
  if (_globalCache && Date.now() - _globalCache.at < 5 * 60000) return _globalCache.rows;
  const r = await fetch(`/api/spark?symbols=${encodeURIComponent(GLOBAL_TICKERS.map(([t]) => t).join(","))}&range=5d&interval=1d`).then(x => x.json());
  const rows = GLOBAL_TICKERS.map(([t, name]) => {
    const it = (r?.spark?.result || []).find(x => x.symbol === t);
    if (!it) return null;
    const x = it.response[0], ts = x.timestamp, cl = x.indicators.quote[0].close;
    const idx = cl.map((v, i) => (v != null ? i : -1)).filter(i => i >= 0);
    if (idx.length < 2) return null;
    const a = cl[idx[idx.length - 1]], b = cl[idx[idx.length - 2]];
    return { t, name, price: a, chg: (a / b - 1) * 100, at: ts[idx[idx.length - 1]] };
  }).filter(Boolean);
  _globalCache = { at: Date.now(), rows };
  return rows;
}
function GlobalBrief() {
  const [rows, setRows] = useState(null);
  useEffect(() => { let alive = true; fetchGlobal().then(x => alive && setRows(x)).catch(() => alive && setRows([])); return () => { alive = false; }; }, []);
  if (!rows?.length) return null;
  const { mins, dow } = (() => { const d = new Date(Date.now() + 19800000); return { mins: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() }; })();
  const pre = dow >= 1 && dow <= 5 && mins < 9 * 60 + 15;
  const us = rows.filter(r => /=F$/.test(r.t) && /S&P|Nasdaq/.test(r.name));
  const usAvg = us.length ? us.reduce((a, r) => a + r.chg, 0) / us.length : null;
  const tone = usAvg == null ? null : usAvg > 0.4 ? "positive" : usAvg < -0.4 ? "negative" : "flat";
  const fmt = (r) => (r.t === "USDINR=X" ? r.price.toFixed(2) : r.price >= 1000 ? r.price.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : r.price.toFixed(2));
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div className="label">{pre ? "Pre-market · global cues" : "Global markets"}</div>
        {tone && <span style={{ fontSize: 11, color: tone === "positive" ? C.pos : tone === "negative" ? C.neg : "var(--text3)" }}>US futures {tone}</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 14, rowGap: 6, marginTop: 8 }}>
        {rows.map(r => (
          <div key={r.t} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, gap: 6 }}>
            <span style={{ color: "var(--text2)", whiteSpace: "nowrap" }}>{r.name}</span>
            <span style={{ fontFamily: "var(--mono)", whiteSpace: "nowrap" }}>
              <span style={{ color: "var(--text3)", fontSize: 10, marginRight: 4 }}>{fmt(r)}</span>
              <span style={{ color: r.t === "USDINR=X" ? (r.chg > 0 ? C.neg : C.pos) : r.chg >= 0 ? C.pos : C.neg }}>{r.chg >= 0 ? "+" : ""}{r.chg.toFixed(2)}%</span>
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 8 }}>Change vs previous close. A rising USD/INR (red) usually weighs on Indian stocks. GIFT Nifty isn't available from a free source.</div>
    </div>
  );
}

// I: weekly view of a daily price series (last close of each week; 10/30/40-week SMAs)
function toWeekly(d) {
  const wk = new Map();
  d.dates.forEach((day, i) => {
    const dt = new Date(`${day}T00:00:00Z`); const monday = new Date(dt); monday.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    const w = wk.get(key) || { date: day, close: null, vol: 0 };
    w.date = day; if (d.closes[i] != null) w.close = d.closes[i]; w.vol += d.vols[i] || 0; wk.set(key, w);
  });
  const rows = [...wk.values()].filter(w => w.close != null);
  const closes = rows.map(w => w.close);
  return { sym: d.sym, weekly: true, dates: rows.map(w => w.date), closes, vols: rows.map(w => w.vol || null),
    s10: smaSeries(closes, 10, 8), s50: smaSeries(closes, 30, 24), s200: smaSeries(closes, 40, 32) };
}
const WEEKLY_SERIES = [
  { key: "s10", label: "10-week", color: "#A06CD5" },
  { key: "s50", label: "30-week", color: "#D9632B" },
  { key: "s200", label: "40-week", color: "#3987E5" },
];
function weeklyTrend(w) {
  const i = w.closes.length - 1, s30 = w.s50, c = w.closes[i];
  if (s30[i] == null || s30[i - 4] == null) return null;
  const rising = s30[i] > s30[i - 4];
  return { above: c > s30[i], rising, label: c > s30[i] && rising ? "Weekly uptrend (above a rising 30-week SMA)" : c < s30[i] && !rising ? "Weekly downtrend (below a falling 30-week SMA)" : "Weekly trend mixed" };
}

// J: weekly report as a shareable image
async function reportImage(text) {
  const lines = text.split("\n");
  const W = 1080, pad = 64, lh = 46;
  const wrap = (ctx, s, max) => {
    const out = []; let cur = "";
    for (const word of s.split(" ")) { const t = cur ? cur + " " + word : word; if (ctx.measureText(t).width > max && cur) { out.push(cur); cur = word; } else cur = t; }
    out.push(cur); return out;
  };
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = "32px ui-monospace, Menlo, Consolas, monospace";
  const body = lines.slice(1).flatMap(l => (l ? wrap(probe, l, W - pad * 2) : [""]));
  const H = pad * 2 + 90 + body.length * lh + 70;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#080C0F"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.neg; ctx.fillRect(0, 0, W, 10);
  ctx.fillStyle = "#F5F0E6"; ctx.font = "bold 40px ui-sans-serif, system-ui, sans-serif"; ctx.fillText(lines[0], pad, pad + 40);
  ctx.font = "32px ui-monospace, Menlo, Consolas, monospace";
  body.forEach((l, k) => {
    ctx.fillStyle = /^⦿/.test(l) ? "#F5F0E6" : /^Signal|^Leading|^Follow/.test(l) ? "#D4CCB6" : C.muted;
    ctx.fillText(l, pad, pad + 110 + k * lh);
  });
  ctx.fillStyle = "#5A5548"; ctx.font = "26px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("TRADESK · Nifty 500 breadth, verified against NSE", pad, H - pad + 20);
  return new Promise(res => c.toBlob(res, "image/png"));
}
async function shareReport(rep) {
  const blob = await reportImage(rep.text);
  const file = new File([blob], `market-quadrant-${rep.label.replace("/", "-")}.png`, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: `Market Quadrant ${rep.label}` }); return "shared"; } catch (_) { return null; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return "downloaded";
}

// K: rotation map — breadth level vs 4-week change, with 4-week tails
function MqRotationMap({ data, onSelect }) {
  const hist = data?.sector_history;
  if (!hist) return null;
  const pts = (data.sectors || []).map(s => {
    const h = hist[s.name]; if (!h || h.length < 9) return null;
    const trail = [];
    for (let k = h.length - 4; k < h.length; k++) {
      const now = h[k]?.p50, ago = h[k - 4]?.p50;
      if (now != null && ago != null) trail.push({ x: now, y: now - ago });
    }
    return trail.length ? { name: s.name, q: s.quadrant, trail } : null;
  }).filter(Boolean);
  if (!pts.length) return null;
  const W = 340, H = 260, pad = 26;
  const ys = pts.flatMap(p => p.trail.map(t => t.y)), yMax = Math.max(20, ...ys.map(Math.abs)) * 1.1;
  const X = (v) => pad + (v / 100) * (W - pad * 2), Y = (v) => H / 2 - (v / yMax) * (H / 2 - pad);
  // Greedy label placement: nudge down/up to avoid overlaps; drop labels that can't fit
  const placed = [], labelPos = {};
  const ends = pts.map(p => ({ p, t: p.trail[p.trail.length - 1] })).sort((a, b) => Y(a.t.y) - Y(b.t.y));
  for (const { p, t } of ends) {
    const x = X(t.x) + 6, w = Math.min(70, p.name.length * 4.2);
    for (const dy of [3, 12, -6, 21, -15]) {
      const y = Y(t.y) + dy;
      if (!placed.some(b => Math.abs(b.y - y) < 9 && x < b.x + b.w && b.x < x + w) && x + w < W) { placed.push({ x, y, w }); labelPos[p.name] = y; break; }
    }
  }
  const short = (n) => n.replace("Consumer ", "Cons. ").replace("Cement & Materials", "Cement").replace("Capital Goods", "Cap Goods").replace("Telecommunication", "Telecom").replace("Construction", "Constr.");
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>ROTATION MAP</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 6 }}>Across: % of stocks above 50-SMA · Up: change over 4 weeks · Tails: last 4 weeks. Tap a dot for its stocks.</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img" aria-label="Sector rotation map">
        <rect x={X(50)} y={pad} width={X(100) - X(50)} height={Y(0) - pad} fill="rgba(74,222,128,0.05)" />
        <rect x={X(0)} y={Y(0)} width={X(50) - X(0)} height={H - pad - Y(0)} fill="rgba(220,20,60,0.05)" />
        <line x1={X(50)} x2={X(50)} y1={pad} y2={H - pad} stroke="var(--border)" />
        <line x1={pad} x2={W - pad} y1={Y(0)} y2={Y(0)} stroke="var(--border)" />
        {[["LEADING", X(97), pad + 10, "end"], ["WEAKENING", X(97), H - pad - 4, "end"], ["IMPROVING", X(3), pad + 10, "start"], ["LAGGING", X(3), H - pad - 4, "start"]].map(([l, x, y, a]) => (
          <text key={l} x={x} y={y} fontSize="9" fontWeight="700" letterSpacing="1" fill={QUAD_COLOR[l]} opacity="0.7" textAnchor={a}>{l}</text>
        ))}
        {pts.map(p => (
          <g key={p.name} onClick={() => onSelect?.(p.name)} style={{ cursor: "pointer" }}>
            <polyline points={p.trail.map(t => `${X(t.x).toFixed(1)},${Y(t.y).toFixed(1)}`).join(" ")} fill="none" stroke={QUAD_COLOR[p.q] || "var(--text3)"} strokeOpacity="0.35" strokeWidth="1.2" />
            {(() => { const t = p.trail[p.trail.length - 1]; return (
              <>
                <circle cx={X(t.x)} cy={Y(t.y)} r="4.5" fill={QUAD_COLOR[p.q] || "var(--text3)"} stroke="var(--bg2)" strokeWidth="1.5" />
                {labelPos[p.name] != null && <text x={X(t.x) + 6} y={labelPos[p.name]} fontSize="9" fill="var(--text2)">{short(p.name)}</text>}
                <circle cx={X(t.x)} cy={Y(t.y)} r="12" fill="transparent"><title>{`${p.name}: ${t.x.toFixed(0)}% above 50-SMA, ${t.y >= 0 ? "+" : ""}${t.y.toFixed(0)} pts in 4 weeks`}</title></circle>
              </>
            ); })()}
          </g>
        ))}
        <text x={X(0)} y={H - 6} fontSize="9" fill="var(--text3)">0%</text>
        <text x={X(50)} y={H - 6} fontSize="9" fill="var(--text3)" textAnchor="middle">50%</text>
        <text x={X(100)} y={H - 6} fontSize="9" fill="var(--text3)" textAnchor="end">100%</text>
      </svg>
    </div>
  );
}

// ─── IDEAS · plan sheet · error-safe sections ────────────────────────────────

/** Keeps one broken section from blanking the whole page; offers a retry. */
class SectionBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { console.warn(`[${this.props.name}]`, err); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="card" style={{ marginBottom: 14, fontSize: 12, color: "var(--text3)" }}>
        {this.props.name} couldn't load.{" "}
        <button className="chip" style={{ fontSize: 10 }} onClick={() => this.setState({ err: null })}>Retry</button>
      </div>
    );
  }
}

function readMicro() {
  try { return JSON.parse(localStorage.getItem("td_mq_micro_v3") || "null")?.data || null; } catch (_) { return null; }
}

const IDEA_TAG = { coil: "Coiling", deliv: "High delivery", block: "Block/bulk buy", pivot: "Pivot today", tight: "Tight", ep: "EP", epr: "EP ★ results", ipo: "IPO lifecycle", ipoup: "IPO ↑ new high", ipopop: "IPO ⚡ 4.5% day", flow: "Fund flow", htf: "High-tight flag", pb21: "21-EMA pullback", first52: "First 52w high", leader: "Leader", watch: "★ Watching" };

/**
 * One ranked, de-duplicated list of what's worth acting on today.
 * Score: grade (A 30 / B 15) + strength/5 + 6 per reason + hot-sector and watchlist bonuses.
 */
function buildIdeas(d, micro, watchlist, blockBuys = null) {
  if (!d?.scans) return [];
  const status = Object.fromEntries((d.sectors || []).map(s => [s.name, s.status]));
  const map = new Map();
  const add = (r, tag, isMicro) => {
    if (!r?.sym) return;
    const src = isMicro ? micro : d;
    const x = map.get(r.sym) || {
      sym: r.sym, sector: r.sector || src?.sector_of?.[r.sym] || d.sector_of?.[r.sym] || "Other",
      rs: r.rs ?? src?.rs_of?.[r.sym] ?? null, grade: r.grade ?? src?.grade_of?.[r.sym] ?? null,
      plan: r.plan ?? src?.plan_of?.[r.sym] ?? null, q: r.q ?? src?.q_of?.[r.sym] ?? d.q_of?.[r.sym] ?? null, tags: new Set(), micro: !!isMicro,
      flags: src?.flags_of?.[r.sym] ?? d.flags_of?.[r.sym] ?? null,
    };
    if (r.stage2 === false) x.stage2 = false;
    x.tags.add(tag); map.set(r.sym, x);
  };
  const take = (sc, isMicro) => {
    if (!sc) return;
    (sc.pivots || []).forEach(r => add(r, "pivot", isMicro));
    (sc.tight || []).forEach(r => add(r, "tight", isMicro));
    (sc.ep || []).forEach(r => add(r, r.results ? "epr" : "ep", isMicro));
    (sc.ipo || []).forEach(r => add(r, r.pop ? "ipopop" : r.breakout ? "ipoup" : "ipo", isMicro));
    (sc.fundflow || []).forEach(r => add(r, "flow", isMicro));
    (sc.htf || []).forEach(r => add(r, "htf", isMicro));
    (sc.pb21 || []).forEach(r => add(r, "pb21", isMicro));
    (sc.first52 || []).forEach(r => add(r, "first52", isMicro));
    (sc.coil || []).forEach(r => add(r, "coil", isMicro));
  };
  take(d.scans, false);
  (d.leaders || []).filter(l => ["HOT", "WARM"].includes(status[l.sector])).forEach(r => add(r, "leader", false));
  if (micro?.scans) take(micro.scans, true);
  for (const w of watchlist || []) add({ sym: w.sym }, "watch", false);
  // Delivery-backed moves: most of today's traded quantity was taken as delivery (NSE)
  for (const x of map.values()) if (x.tags.has("pivot") && !((x.rs ?? 0) >= 80 && x.stage2 !== false)) x.tags.delete("pivot"); // pivots only paid in RS 80+ stage-2 names
  for (const x of map.values()) if ((x.tags.has("pivot") || x.tags.has("coil")) && (d.deliv_of?.[x.sym] ?? 0) >= 50) x.tags.add("deliv");
  for (const sym of blockBuys || []) if (map.has(sym)) map.get(sym).tags.add("block");
  const G = { A: 30, B: 15, C: 0 };
  // Each list's weight follows its own record vs the average stock: +6 base, ±4 per point of excess (−6…+12)
  const SCAN_OF = { pivot: "pivots", tight: "tight", ep: "ep", epr: "ep", coil: "coil", leader: "leaders", flow: "fundflow", htf: "htf", pb21: "pb21", first52: "first52" };
  // 5-year records when the nightly job published them (far more signals than one year); microcaps use their own
  const statsFor = (x) => ((x.micro ? micro?.scan_stats : null) || d.long_bt?.scan_stats || d.scan_stats);
  const weight = (tag, x) => { const ex = statsFor(x)?.[SCAN_OF[tag]]?.excess; return ex == null ? 6 : Math.max(-6, Math.min(12, 6 + ex * 4)); };
  return [...map.values()].map(x => {
    const st = status[x.sector];
    if (![...x.tags].some(t => t !== "deliv" && t !== "block")) return null;
    const scanTags = [...x.tags].filter(t => SCAN_OF[t]);
    const watchOnly = (scanTags.length > 0 && scanTags.every(t => (statsFor(x)?.[SCAN_OF[t]]?.excess ?? 0) <= -0.5)) || !!x.flags?.t4t || !!survOf(x.sym)?.gsm;
    const score = (G[x.grade] ?? 0) + (x.rs ?? 0) / 5 + [...x.tags].reduce((a, t) => a + (SCAN_OF[t] ? weight(t, x) : 6), 0) + (st === "HOT" ? 6 : st === "WARM" ? 3 : 0) + (x.tags.has("watch") ? 8 : 0) - (watchOnly ? 20 : 0);
    if (!x.tags.size) return null;
    x.watchOnly = watchOnly;
    const quietOnly = [...x.tags].every(t => ["tight", "coil", "pb21", "watch", "deliv", "block"].includes(t));
    return { ...x, sectorStatus: st, score: Math.round(score), qok: qualityOk(x.q, quietOnly) };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
}

const MAX_POSITION_PCT = 25, MAX_TURNOVER_PCT = 2;
// Stops fill worse than planned (gaps, slippage): the review measured an average stop-out of −1.32R
const GAP_BUFFER = 1.25;
/** Quantity from risk, then capped at 25% of capital and 2% of the stock's 20-day average turnover (₹ cr). */
function capQty(qty, entry, portfolio, turnoverCr) {
  let cap = null;
  const byCap = Math.floor((portfolio * MAX_POSITION_PCT / 100) / entry);
  if (qty > byCap) { qty = byCap; cap = `capped at ${MAX_POSITION_PCT}% of capital`; }
  if (turnoverCr != null && turnoverCr >= 0) { turnoverCr = Math.max(turnoverCr, 0.05); const byLiq = Math.floor((turnoverCr * 1e7 * MAX_TURNOVER_PCT / 100) / entry); if (qty > byLiq) { qty = byLiq; cap = `capped at ${MAX_TURNOVER_PCT}% of daily turnover`; } }
  return { qty, cap };
}
function sizeFor(plan, portfolio, riskPct, turnoverCr = null) {
  if (!plan || !portfolio || !(riskPct > 0) || !(plan.entry > plan.stop)) return null;
  const raw = Math.floor((portfolio * riskPct / 100) / ((plan.entry - plan.stop) * GAP_BUFFER));
  const { qty, cap } = capQty(raw, plan.entry, portfolio, turnoverCr);
  return qty > 0 ? { qty, value: qty * plan.entry, cap } : null;
}

function IdeaRow({ x, portfolio, riskPct, onOpen, onPlan, compact }) {
  const size = x.watchOnly ? null : sizeFor(x.plan, portfolio, riskPct, x.q?.to);
  const cal = useResultsCal();
  const res = cal ? upcomingResults(cal, x.sym, 10) : null;
  return (
    <div style={{ padding: "9px 0", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button onClick={() => onOpen?.(x.sym)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", fontFamily: "var(--display)", fontWeight: 700, fontSize: 14, textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{x.sym}</button>
        <RsBadge rs={x.rs} grade={x.grade} /><NoteMark sym={x.sym} />
        {x.micro && <span style={{ fontSize: 9, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: 6, padding: "0 4px" }}>micro</span>}
        <NseFlagBadge f={x.flags} sym={x.sym} />
        {res && <span title={`Results ${mqFmtDate(res.date)} — a gap can jump the stop`} style={{ fontSize: 9, fontWeight: 700, color: C.warn, border: `1px solid ${C.warn}66`, borderRadius: 6, padding: "0 4px" }}>📅 {res.inDays === 0 ? "results today" : `results ${res.inDays}d`}</span>}
        <span style={{ flex: 1 }} />
        {x.plan && <button className="chip chip-sm" onClick={() => onPlan?.({ symbol: x.sym, entry: x.plan.entry, stop: x.plan.stop })}>Plan</button>}
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 3 }}>
        {x.sector}{x.sectorStatus && x.sectorStatus !== "—" && <span style={{ color: MQ_DIM_COLOR[x.sectorStatus] }}> · {x.sectorStatus}</span>}
        {" · "}{[...x.tags].map(t => IDEA_TAG[t]).join(" · ")}
      </div>
      {x.plan && !compact && (
        <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 4, fontFamily: "var(--mono)" }}>
          Entry ₹{x.plan.entry} · Stop ₹{x.plan.stop} (−{x.plan.riskPct}%)
          {x.watchOnly ? <span style={{ color: C.warn }} title="Only on lists whose record lost to the average stock, or trade-for-trade"> · watch only ({x.flags?.t4t ? "trade-for-trade" : "weak-record list"})</span>
            : size ? <span style={{ color: "var(--text)" }}> · {size.qty} sh ≈ {formatINR(size.value)}{size.cap && <span style={{ color: C.warn }}> ({size.cap})</span>}</span> : riskPct === 0 ? <span style={{ color: C.warn }}> · no new entries today</span> : null}
        </div>
      )}
    </div>
  );
}

function IdeasPage({ watchlist, portfolio, onOpenStock, onPlan }) {
  const { data, loading, error, progress, retry } = useMarketQuadrant();
  const { deals } = useFlowsDeals();
  const blockBuys = (deals?.deals || []).filter(x => x.side === "BUY").map(x => x.sym);
  const [filter, setFilter] = useState(() => { try { return localStorage.getItem("td_ideas_filter") || "all"; } catch (_) { return "all"; } });
  const pick = (f) => { setFilter(f); try { localStorage.setItem("td_ideas_filter", f); } catch (_) {} };
  const [quality, toggleQuality] = useQualityGate();
  const head = (
    <div style={{ marginBottom: 12 }}>
      <div className="section-title">Ideas</div>
      <div style={{ fontSize: 13, color: "var(--text3)", marginTop: 4 }}>Everything worth a look today, in one ranked list — sized for today's market.</div>
    </div>
  );
  if (!data?.scans) {
    return (
      <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
        {head}
        <div className="card">{error ? <><div style={{ color: "var(--red)", fontSize: 12 }}>{error}</div><button className="btn-ghost" style={{ marginTop: 10 }} onClick={retry}>Retry</button></> : <><div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 10 }}>{loading ? progress.msg : "Loading…"}</div><Skeleton lines={6} /></>}</div>
      </div>
    );
  }
  const micro = readMicro();
  const allRaw = buildIdeas(data, micro, watchlist, blockBuys);
  const all = quality ? allRaw.filter(x => x.qok || x.tags.has("watch")) : allRaw;
  const rows = all.filter(x => filter === "a" ? x.grade === "A" : filter === "watch" ? x.tags.has("watch") : filter === "n500" ? !x.micro : true);
  const s = suggestedRisk(data);
  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      {head}
      <div className="card" style={{ marginBottom: 12, padding: "10px 14px" }}>
        <div style={{ fontSize: 12, color: "var(--text)" }}>{briefRule(data)}</div>
        <StandDownNote d={data} style={{ marginTop: 6 }} />
        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>
          Sizes use {s?.pct ?? 0}% risk per trade ({s?.why || "—"}) on {formatINR(portfolio)}. Based on {mqFmtDate(data.as_of)} closes{data.verification?.date === data.as_of ? " ✓ NSE" : ""}.
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 10, scrollbarWidth: "none" }}>
        {[["all", `All ${all.length}`], ["a", `A-grade ${all.filter(x => x.grade === "A").length}`], ["watch", `★ Watchlist ${all.filter(x => x.tags.has("watch")).length}`], ["n500", "Nifty 500 only"]].map(([id, l]) => (
          <button key={id} className="chip" aria-pressed={filter === id} onClick={() => pick(id)} style={filter === id ? { borderColor: "var(--text)", color: "var(--text)", whiteSpace: "nowrap" } : { whiteSpace: "nowrap" }}>{l}</button>
        ))}
        <button className="chip" onClick={toggleQuality} aria-pressed={quality} title="Hide thin or slow stocks (₹10 cr+ turnover, 1.8%+ average daily move). Watchlist stocks always show."
          style={quality ? { borderColor: C.pos, color: C.pos, whiteSpace: "nowrap" } : { whiteSpace: "nowrap" }}>Quality {quality ? "on" : "off"}{quality && allRaw.length > all.length ? ` · ${allRaw.length - all.length} hidden` : ""}</button>
      </div>
      <div className="card" style={{ paddingTop: 6 }}>
        {rows.length === 0 ? <div style={{ fontSize: 12, color: "var(--text3)", padding: "16px 0", textAlign: "center" }}>Nothing here today.</div>
          : rows.slice(0, 40).map(x => <IdeaRow key={x.sym} x={x} portfolio={portfolio} riskPct={s?.pct ?? 0} onOpen={onOpenStock} onPlan={onPlan} />)}
        {rows.length > 40 && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 8 }}>Showing the top 40 of {rows.length}.</div>}
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 10, lineHeight: 1.5 }}>
        Ranked by grade, strength, how many lists a stock appears in, sector heat and your watchlist. Entry/stop come from closing prices — check the chart. {micro ? "Includes Microcap 250 (loaded from SCAN)." : "Turn on Microcap 250 in SCAN to include microcaps."} Ideas, not recommendations.
      </div>
    </div>
  );
}

function BestSetups({ watchlist, portfolio, onOpenStock, onPlan, onSeeAll }) {
  const { data } = useMarketQuadrant();
  if (!data?.scans) return null;
  let quality = true; try { quality = localStorage.getItem("td_quality") !== "0"; } catch (_) {}
  const top = buildIdeas(data, readMicro(), watchlist).filter(x => x.plan && (!quality || x.qok || x.tags.has("watch"))).slice(0, 5);
  const s = suggestedRisk(data);
  if (!top.length) return null;
  return (
    <div className="card" style={{ marginBottom: 14, paddingTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
        <div className="label">Today's best setups</div>
        <button className="chip" style={{ fontSize: 10 }} onClick={onSeeAll}>All ideas ›</button>
      </div>
      {data.green_light?.mult === 0 ? <StandDownNote d={data} style={{ margin: "6px 0" }} />
        : s?.pct === 0 && <div style={{ fontSize: 11, color: C.warn, margin: "4px 0" }}>Market rules say no new entries today ({s.why}) — watch only.</div>}
      {top.map(x => <IdeaRow key={x.sym} x={x} portfolio={portfolio} riskPct={s?.pct ?? 0} onOpen={onOpenStock} onPlan={onPlan} />)}
    </div>
  );
}

/** The calculator as a slide-up sheet, available from anywhere. */
function PlanSheet({ open, onClose, children }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [open]);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Plan a trade" style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ width: "100%", maxWidth: 480, maxHeight: "92vh", overflowY: "auto", background: "var(--bg)", borderTopLeftRadius: 18, borderTopRightRadius: 18, borderTop: "1px solid var(--border)", position: "relative" }}>
        <div style={{ position: "sticky", top: 0, zIndex: 2, background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px 0" }}>
          <span style={{ width: 36, height: 4, borderRadius: 2, background: "var(--border2)", margin: "0 auto" }} />
          <button onClick={onClose} aria-label="Close" style={{ position: "absolute", right: 12, top: 6, background: "none", border: "none", color: "var(--text2)", fontSize: 22, cursor: "pointer" }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── PLAYBOOK · Market Monitor · flows & deals ───────────────────────────────

// Setup library: rules (also the pre-trade checklist) and which scan finds live examples
const PLAYBOOK_SETUPS = {
  "Breakout": { scan: "pivots", rules: ["RS 80+ and above a rising 50-day SMA", "Base of 3+ weeks within 15% of the high", "Breaks out on volume well above average", "Market allows new longs (not CASH / No money)", "Stop under the breakout-day low, max 8%"] },
  "Pullback": { scan: "pb21", rules: ["Leader: RS 80+ and the 50-day above the 200-day", "Ran 8%+ above its 21-day EMA in the last 3 weeks", "Pulls back to within 2% of the 21-day EMA, ideally on lighter volume", "Buy as it turns up; stop under the pullback low"] },
  "U&R": { scan: "reclaim50", rules: ["Undercuts a prior low, then closes back above it", "Volume expands on the reclaim", "Sector HOT or WARM", "Stop under the undercut low"] },
  "Range Break": { scan: "tight", rules: ["Tight range (≤ 8%) for 2+ weeks near highs", "Closes out of the range on rising volume", "Stop inside the range"] },
  "Momentum": { scan: "pivots", rules: ["4%+ burst on rising volume", "Already a momentum stock (RS 80+)", "Plan to sell into strength in 3–5 days", "Stop under the burst-day low"] },
  "EP": { scan: "ep", rules: ["≥ 8% move on 3×+ volume around news or results", "Holds above the gap-day low", "Fresh catalyst, not a stale story", "Stop under the gap-day low"] },
  "IPO base": { scan: "ipo", rules: ["Listed within the last 12 months", "First base formed after listing", "Clears the post-listing high on volume", "Stop under the base"] },
  "Coiling": { scan: "coil", rules: ["RS 80+ and above the 50-day SMA", "Tightest 10-day range in a month", "Volume drying up", "Buy at/just before the breakout; stop under the coil"] },
};
const MISTAKES = ["Chased entry", "No/late stop", "Oversized", "Sold too early", "Held a loser", "Against market rule", "Broke my setup rules", "FOMO trade"];
const EMOTIONS = ["Calm", "Confident", "Anxious", "Greedy", "Bored", "Revenge"];

function PreTradeChecklist({ setup, ticked, onToggle }) {
  const def = PLAYBOOK_SETUPS[setup];
  if (!def) return null;
  const all = ticked.length === def.rules.length;
  return (
    <div className="card" style={{ marginBottom: 12, borderColor: all ? `${C.pos}66` : "var(--border)" }}>
      <div className="label" style={{ marginBottom: 6 }}>Pre-trade checklist · {setup} <span style={{ color: all ? C.pos : "var(--text3)" }}>{ticked.length}/{def.rules.length}</span></div>
      {def.rules.map((r, i) => (
        <label key={r} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, padding: "4px 0", cursor: "pointer", color: ticked.includes(i) ? "var(--text)" : "var(--text2)" }}>
          <input type="checkbox" checked={ticked.includes(i)} onChange={() => onToggle(i)} style={{ width: 16, height: 16, marginTop: 1, accentColor: C.pos }} />
          {r}
        </label>
      ))}
      {!all && <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>Unticked rules are saved with the trade and count against your discipline score.</div>}
    </div>
  );
}

// ── Market Monitor (QUAD) ──
// ── Stocksgeeks-derived pieces: MBI breadth, green light, quality gate ──
const SG_LINK = "https://thestocksgeeks.com/";
const MBI_COLOR = { GREEN: C.pos, RED: C.neg, NEUTRAL: C.muted };
const GL_COLOR = { FULL: C.pos, NORMAL: C.pos, HALF: C.warn, SMALL: C.warn };
const GL_TEXT = { FULL: "Full size", NORMAL: "Full size", HALF: "Half size", SMALL: "Half size" };
/** Shown wherever a new trade can be planned when the green light says stand down. */
function StandDownNote({ d, style }) {
  const g = d?.green_light;
  if (g?.mult !== 0) return null; // the green light no longer stands the app down (5-year data); kept for safety
  return (
    <div style={{ fontSize: 11, color: C.neg, border: `1px solid ${C.neg}55`, background: `${C.neg}10`, borderRadius: 8, padding: "6px 9px", lineHeight: 1.45, ...style }}>
      ⛔ Stand down: green light {g.em} is below 9 — recent breakouts are failing. Since {mqFmtDate(g.from)} readings below 9 were followed by {g.bt?.SMALL ? `${g.bt.SMALL.fwd > 0 ? "+" : ""}${g.bt.SMALL.fwd}% for the average stock over 10 sessions (${g.bt.SMALL.up}% higher)` : "weak returns"}. Watch, don't buy.
    </div>
  );
}
/** Calculator warnings: sizing caps, gap buffer, sector concentration, NSE flags. */
function CalcWarnings({ symbol, trades, portfolio, cap }) {
  const d = getLastMarketQuadrant();
  const sym = normalizeSymbol(symbol || "");
  if (!sym || sym.length < 2) return null;
  const sector = d?.sector_of?.[sym];
  const open = (trades || []).filter(t => t.status === "open" || t.status === "partial").map(normalizeTrade);
  const same = sector ? open.filter(t => d.sector_of?.[normalizeSymbol(t.symbol)] === sector && normalizeSymbol(t.symbol) !== sym) : [];
  const sameVal = same.reduce((a, t) => a + (t.avgEntry || 0) * (t.remainingQty || t.totalQty || 0), 0);
  const lines = [];
  const f = d?.flags_of?.[sym] ?? readMicro()?.flags_of?.[sym];
  if (f?.t4t) lines.push([C.neg, "Trade-for-trade (BE/BZ) stock: no intraday exit, wide spreads, often under NSE surveillance."]);
  const sv = survOf(sym);
  if (sv?.gsm) lines.push([C.neg, `On NSE's GSM surveillance list (${sv.gsm}) — restricted trading; avoid.`]);
  if (sv?.asm) lines.push([C.warn, `On NSE's ASM list (${sv.asm}) — higher margins and it can move to trade-for-trade.`]);
  if (sv?.band) lines.push([C.warn, `Narrow ${sv.band}% price band — it can lock at the circuit with your stop unfilled; size smaller.`]);
  if (f?.uc) lines.push([C.warn, `Closed at the day's high, +${f.chg}% — likely an upper circuit; you may not get filled at the plan price.`]);
  if (same.length >= 2 || (portfolio && sameVal / portfolio >= 0.3)) lines.push([C.warn, `Already ${same.length} open in ${sector} (${portfolio ? Math.round((sameVal / portfolio) * 100) : "—"}% of capital) — another one concentrates your risk in one sector.`]);
  if (cap) lines.push([C.warn, `Quantity ${cap}.`]);
  lines.push(["var(--text3)", "Quantity assumes the stop fills 25% worse than planned (gaps / slippage)."]);
  return (
    <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
      {lines.map(([c, t], i) => <div key={i} style={{ fontSize: 11, color: c, lineHeight: 1.4 }}>{c === "var(--text3)" ? "ℹ" : "⚠"} {t}</div>)}
    </div>
  );
}
function CalcStandDown() {
  const [d, setD] = useState(() => getLastMarketQuadrant());
  useEffect(() => { let alive = true; loadMarketQuadrant({ allowCompute: false }).then(x => alive && x && setD(x)).catch(() => {}); return () => { alive = false; }; }, []);
  return <StandDownNote d={d} style={{ marginTop: 8 }} />;
}
// Results calendar shared by list rows (one fetch)
let _calP = null;
function useResultsCal() {
  const [cal, setCal] = useState(null);
  useEffect(() => { let alive = true; (_calP ||= fetchResultsCalendar()).then(c => alive && setCal(c)); return () => { alive = false; }; }, []);
  return cal;
}

// NSE surveillance lists, fetched once per session
let _survP = null, _surv = null;
function useSurv() {
  const [v, setV] = useState(_surv);
  useEffect(() => { let alive = true; (_survP ||= fetch("/api/nse?type=surv").then(r => (r.ok ? r.json() : null)).catch(() => null)).then(x => { _surv = x; if (alive) setV(x); }); return () => { alive = false; }; }, []);
  return v;
}
function survOf(sym) {
  if (!_surv || !sym) return null;
  const o = { ban: _surv.ban?.includes(sym) || undefined, asm: _surv.asm?.[sym], gsm: _surv.gsm?.[sym], band: _surv.band?.[sym] };
  return o.ban || o.asm || o.gsm || o.band ? o : null;
}
/** NSE warnings: trade-for-trade series, likely upper-circuit closes, surveillance lists, narrow bands. */
function NseFlagBadge({ f, sym }) {
  useSurv();
  const sv = survOf(sym);
  if (!f && !sv) return null;
  f = f || {};
  const st = (c) => ({ fontSize: 10, fontWeight: 700, color: c, border: `1px solid ${c}66`, borderRadius: 6, padding: "0 4px", marginLeft: 4, whiteSpace: "nowrap" });
  return <>
    {f.t4t && <span style={st(C.neg)} title="Trade-for-trade (BE/BZ): every trade must be delivered, no intraday exit; often on NSE surveillance lists — wide spreads">T2T</span>}
    {f.uc && <span style={st(C.warn)} title={`Closed at the day's high, +${f.chg}% — likely an upper circuit. There may be no sellers at your price, and it can lock down just as fast.`}>circuit ↑</span>}
    {sv?.gsm && <span style={st(C.neg)} title={`NSE Graded Surveillance (GSM ${sv.gsm}) — trading restrictions and extra margins`}>GSM</span>}
    {sv?.asm && <span style={st(C.warn)} title={`NSE Additional Surveillance (ASM ${sv.asm}) — higher margins, can move to trade-for-trade`}>ASM</span>}
    {sv?.ban && <span style={st(C.warn)} title="In the F&O ban period — no new derivative positions; often volatile">F&O ban</span>}
    {sv?.band && <span style={st(C.muted)} title={`Price band ${sv.band}% — it can lock at the circuit; size smaller`}>{sv.band}% band</span>}
  </>;
}

/** Quality gate for a scan row: tight / coiling setups are quiet by design, so only liquidity applies to them. */
function qualityOk(q, quiet) {
  if (!q) return true; // no volume data → can't judge, keep it
  const v = quiet ? q.liq : q.pass;
  return v !== false;
}
function useQualityGate() {
  const [on, set] = useState(() => { try { return localStorage.getItem("td_quality") !== "0"; } catch (_) { return true; } });
  const toggle = () => set(v => { try { localStorage.setItem("td_quality", v ? "0" : "1"); } catch (_) {} return !v; });
  return [on, toggle];
}
function BtLine({ items }) {
  const xs = items.filter(([, b]) => b);
  if (!xs.length) return null;
  return xs.map(([label, b], i) => (
    <span key={label}>{i ? " · " : ""}{label}: <b style={{ color: b.fwd > 0.3 ? C.pos : b.fwd < -0.3 ? C.neg : "var(--text2)" }}>{b.fwd > 0 ? "+" : ""}{b.fwd}%</b> ({b.up}% up, {b.days}d)</span>
  ));
}

function MqMbi({ mbi, dip, long, universe = "Nifty 500" }) {
  if (!mbi?.rows?.length) return null;
  const rows = mbi.rows, last = rows[rows.length - 1], T = mbi.thresholds;
  const strip = rows.slice(-10);
  const fmt = (v, k) => (last.inf?.[k] ? "∞" : v == null ? "—" : v);
  const sg = (v) => (v == null ? "" : v > 0 ? `+${v}` : `${v}`);
  const cells = [
    ["4.5R", fmt(last.r45, "r45"), last.boxes[0], `>${T.r45[0]} green · <${T.r45[1]} red — stocks up 4.5%+ ÷ down 4.5%+ ×100`],
    ["CHG", sg(last.c45), last.boxes[1], `±${T.chg}`],
    ["20R", fmt(last.r20, "r20"), last.boxes[2], `>${T.r20[0]} · <${T.r20[1]} — above ÷ below 20-SMA ×100`],
    ["CHG", sg(last.c20), last.boxes[3], `±${T.chg}`],
    ["50R", fmt(last.r50, "r50"), last.boxes[4], `>${T.r50[0]} · <${T.r50[1]} — above ÷ below 50-SMA ×100`],
    ["CHG", sg(last.c50), last.boxes[5], `±${T.chg}`],
    ["52W H/L", `${last.wh ?? "—"}/${last.wl ?? "—"}`, last.boxes[6], "% of stocks at a 52-week high / low"],
  ];
  const bc = (b) => (b > 0 ? C.pos : b < 0 ? C.neg : "var(--border)");
  const b = mbi.bt || {};
  const contrarian = b.green && b.red && b.green.fwd < b.red.fwd;
  return (
    <div style={mqCardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ ...mqHeadStyle, marginBottom: 4 }}>MBI BREADTH</div>
        <span style={{ fontSize: 12, fontWeight: 800, color: MBI_COLOR[last.color] }}>{last.color} DAY <span style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>({sg(last.score) || 0})</span></span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8, lineHeight: 1.45 }}>
        Stocksgeeks' Market Breadth Indicator rules, computed on the {universe}. Seven boxes turn green or red; green − red ≥ 3 is a green day, ≤ −3 a red day.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 4, marginBottom: 10 }}>
        {cells.map(([k, v, bx, tip], i) => (
          <div key={i} title={tip} style={{ border: `1.5px solid ${bc(bx)}`, background: bx ? `${bc(bx)}18` : "transparent", borderRadius: 6, padding: "4px 2px", textAlign: "center", minWidth: 0 }}>
            <div style={{ fontSize: 9.5, color: "var(--text3)", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{k}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, color: bx ? bc(bx) : "var(--text2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 9, color: "var(--text3)", letterSpacing: "0.1em", marginBottom: 4 }}>LAST 10 SESSIONS</div>
      <div style={{ display: "flex", gap: 3, marginBottom: 8 }}>
        {strip.map(r => (
          <div key={r.d} title={`${mqFmtDate(r.d)} · ${r.color} (${sg(r.score) || 0})`} style={{ flex: 1, minWidth: 0, textAlign: "center" }}>
            <div style={{ height: 18, borderRadius: 4, background: MBI_COLOR[r.color], opacity: r.color === "NEUTRAL" ? 0.35 : 0.9 }} />
            <div style={{ fontSize: 9.5, color: "var(--text3)", marginTop: 2, fontFamily: "var(--mono)", whiteSpace: "nowrap", overflow: "hidden" }}>{r.d.slice(8)}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", lineHeight: 1.5 }}>
        Since {mqFmtDate(b.from)}, average stock over the next {b.horizon || 10} sessions after a — <BtLine items={[["green day", b.green], ["neutral", b.neutral], ["red day", b.red]]} />.
        {contrarian ? " On this data green days came after rallies and did worse than red days — read it as a thermometer, not a buy signal." : ""}
        {long?.mbi_bt && <> 5 years: <BtLine items={[["green", long.mbi_bt.green], ["neutral", long.mbi_bt.neutral], ["red", long.mbi_bt.red]]} />.</>}
      </div>
      {dip?.bt && (
        <div style={{ fontSize: 11, marginTop: 8, padding: "6px 9px", borderRadius: 8, border: `1px solid ${dip.today ? C.pos : "var(--border)"}`, background: dip.today ? `${C.pos}12` : "transparent", color: "var(--text2)", lineHeight: 1.45 }}>
          <b style={{ color: dip.today ? C.pos : "var(--text2)" }}>{dip.today ? "● Pullback window today" : "Pullback window"}</b> — a red MBI day while the long-term Bias is still BULL.
          {" "}Past {dip.bt.days} such days: average stock <b>{dip.bt.fwd > 0 ? "+" : ""}{dip.bt.fwd}%</b> over the next {dip.horizon} sessions, {dip.bt.up}% higher
          {dip.other ? <> (other days {dip.other.fwd > 0 ? "+" : ""}{dip.other.fwd}%, {dip.other.up}% higher)</> : null}.
          {" "}{dip.other && dip.bt.days >= 30 && dip.bt.fwd - dip.other.fwd >= 0.5 && dip.bt.up - dip.other.up >= 5
            ? "A real if modest edge — good for adding to leaders on weakness."
            : "Too few days (and overlapping 10-day windows) to call it an edge yet — treat as context."}
          {!dip.today && dip.recent?.length > 0 && <span style={{ color: "var(--text3)" }}> Last seen {mqFmtDate(dip.recent[dip.recent.length - 1])}.</span>}
        </div>
      )}
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>
        Rules from <a href={SG_LINK} target="_blank" rel="noreferrer" style={{ color: "var(--text2)" }}>thestocksgeeks.com</a> (Umang); numbers are ours, so they differ from his sheet's universe.
      </div>
    </div>
  );
}

function MqGreenLight({ gl, long }) {
  if (!gl || gl.em == null) return null;
  const col = GL_COLOR[gl.band];
  const pct = Math.min(100, (gl.em / 40) * 100);
  const hist = (gl.history || []).filter(h => h.em != null);
  const max = Math.max(40, ...hist.map(h => h.em));
  const b = gl.bt || {};
  return (
    <div style={mqCardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ ...mqHeadStyle, marginBottom: 4 }}>GREEN LIGHT</div>
        <span style={{ fontSize: 12, fontWeight: 800, color: col }}>{GL_TEXT[gl.band]}{gl.mult ? ` · ${gl.mult}×` : ""}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8, lineHeight: 1.45 }}>
        Are breakouts paying? Our follow-through reading put on Stocksgeeks' EM scale: 15+ is full size, below 15 is half size. Over 5 years, 15+ days were followed by about +1.2% for the average stock (70% up) and lower readings by about +0.5% (54% up) — 25+ wasn't better than 15–25, and below 9 wasn't worse than 9–15.
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <span style={{ fontFamily: "var(--display)", fontSize: 30, color: col, lineHeight: 1 }}>{gl.em}</span>
        <span style={{ fontSize: 11, color: "var(--text3)" }}>EM-equivalent</span>
      </div>
      <div style={{ position: "relative", height: 8, borderRadius: 4, background: "var(--bg3)", marginBottom: 4 }}>
        {[9, 15, 25].map(t => <div key={t} style={{ position: "absolute", left: `${(t / 40) * 100}%`, top: -2, bottom: -2, width: 1, background: "var(--text3)" }} />)}
        <div style={{ width: `${pct}%`, height: "100%", borderRadius: 4, background: col }} />
      </div>
      <div style={{ position: "relative", height: 12, fontSize: 9.5, color: "var(--text3)", fontFamily: "var(--mono)", marginBottom: 8 }}>
        {[9, 15, 25].map(t => <span key={t} style={{ position: "absolute", left: `calc(${(t / 40) * 100}% - 6px)` }}>{t}</span>)}
      </div>
      {hist.length > 1 && (
        <svg viewBox="0 0 300 40" style={{ width: "100%", height: 40, display: "block", marginBottom: 6 }} preserveAspectRatio="none">
          {[9, 15, 25].map(t => <line key={t} x1="0" x2="300" y1={40 - (t / max) * 40} y2={40 - (t / max) * 40} stroke="var(--border)" strokeDasharray="3 3" />)}
          <polyline fill="none" stroke={col} strokeWidth="1.8" points={hist.map((h, i) => `${(i / (hist.length - 1)) * 300},${40 - (h.em / max) * 40}`).join(" ")} />
        </svg>
      )}
      <div style={{ fontSize: 10, color: "var(--text3)", lineHeight: 1.5 }}>
        Since {mqFmtDate(gl.from)}, average stock over the next 10 sessions — <BtLine items={[["25+", b.FULL], ["15–25", b.NORMAL], ["9–15", b.HALF], ["below 9", b.SMALL]]} />.
      </div>
      {long?.green_light_bt && <div style={{ fontSize: 10, color: "var(--text3)", lineHeight: 1.5, marginTop: 4 }}>
        5 years (since {mqFmtDate(long.green_light_from)}): <BtLine items={[["25+", long.green_light_bt.FULL], ["15–25", long.green_light_bt.NORMAL], ["9–15", long.green_light_bt.HALF], ["below 9", long.green_light_bt.SMALL]]} />.
      </div>}
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>
        Our own formula, lined up against the public EM series on <a href={SG_LINK} target="_blank" rel="noreferrer" style={{ color: "var(--text2)" }}>thestocksgeeks.com</a> (r ≈ 0.83); Umang's EM itself is his and not reproduced here.
      </div>
    </div>
  );
}

// ─── Infographic guides: "How to read this" for every section ─────────────────
function GScale({ min = 0, max = 100, zones, value, unit = "", label }) {
  const pos = (v) => `${Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100))}%`;
  return (
    <div style={{ margin: "8px 0 14px" }}>
      {label && <div style={{ fontSize: 11, color: "var(--text2)", marginBottom: 4 }}>{label}{value != null && <b style={{ fontFamily: "var(--mono)", marginLeft: 6 }}>{value}{unit}</b>}</div>}
      <div style={{ position: "relative", display: "flex", height: 14, borderRadius: 7, overflow: "hidden" }}>
        {zones.map(([a, b, c], i) => <div key={i} style={{ width: `${((b - a) / (max - min)) * 100}%`, background: c, opacity: 0.75 }} />)}
        {value != null && <div style={{ position: "absolute", left: pos(value), top: -3, bottom: -3, width: 3, marginLeft: -1.5, background: "var(--text)", borderRadius: 2, boxShadow: "0 0 0 2px var(--bg2)" }} />}
      </div>
      <div style={{ display: "flex", fontSize: 9.5, color: "var(--text3)", marginTop: 3 }}>
        {zones.map(([a, b, , t], i) => <div key={i} style={{ width: `${((b - a) / (max - min)) * 100}%`, textAlign: "center", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", padding: "0 1px" }}>{t}</div>)}
      </div>
    </div>
  );
}
function GFlow({ steps }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: 6, margin: "8px 0 12px" }}>
      {steps.map((st, i) => (
        <Fragment key={i}>
          <div style={{ minWidth: 0, border: `1.5px solid ${st.c || "var(--border2)"}`, background: st.c ? `${st.c}14` : "var(--bg3)", borderRadius: 10, padding: "6px 7px", textAlign: "center" }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, color: st.c || "var(--text)", letterSpacing: "0.04em", overflowWrap: "anywhere" }}>{i > 0 && <span style={{ color: "var(--text3)", marginRight: 3 }} aria-hidden="true">{st.op || "→"}</span>}{st.t}</div>
            {st.s && <div style={{ fontSize: 10, color: "var(--text2)", marginTop: 2, lineHeight: 1.35 }}>{st.s}</div>}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
function GPoints({ items }) {
  return (
    <div style={{ display: "grid", gap: 5 }}>
      {items.map(([icon, text], i) => (
        <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--text2)", lineHeight: 1.45 }}>
          <span style={{ flexShrink: 0, width: 18, textAlign: "center" }} aria-hidden="true">{icon}</span><span>{text}</span>
        </div>
      ))}
    </div>
  );
}
function GQuad() {
  const cell = (t, s, c, arrow) => (
    <div style={{ border: `1.5px solid ${c}`, background: `${c}14`, borderRadius: 10, padding: "8px 6px", textAlign: "center", position: "relative" }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: c }}>{t}</div>
      <div style={{ fontSize: 10, color: "var(--text2)", marginTop: 2 }}>{s}</div>
      <div style={{ position: "absolute", right: 6, top: 4, fontSize: 12, color: "var(--text3)" }}>{arrow}</div>
    </div>
  );
  return (
    <div style={{ margin: "8px 0 12px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "18px 1fr 1fr", gap: 6, alignItems: "center" }}>
        <div style={{ fontSize: 10, color: "var(--text3)", writingMode: "vertical-rl", transform: "rotate(180deg)", textAlign: "center" }}>breadth ↑</div>
        {cell("IMPROVING", "weak but getting better — early", C.lime, "→")}
        {cell("LEADING", "strong and still rising — buy here", C.pos, "↓")}
        <div style={{ fontSize: 10, color: "var(--text3)", writingMode: "vertical-rl", transform: "rotate(180deg)", textAlign: "center" }}>breadth ↓</div>
        {cell("LAGGING", "weak and getting weaker — avoid", C.neg, "↑")}
        {cell("WEAKENING", "strong but fading — tighten", C.warn, "←")}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "18px 1fr 1fr", gap: 6, fontSize: 9.5, color: "var(--text3)", marginTop: 3, textAlign: "center" }}>
        <span /> <span>breadth below 50%</span><span>breadth 50%+</span>
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4, textAlign: "center" }}>Sectors usually rotate clockwise: Improving → Leading → Weakening → Lagging</div>
    </div>
  );
}
function GRecord({ stats, long }) {
  const rows = Object.entries(stats || {}).filter(([, v]) => v && v.excess != null);
  if (!rows.length) return null;
  const NAME = { pivots: "Pivots", ep: "Earnings EP", tight: "Tight", reclaim50: "Reclaim 50", leaders: "Leaders", coil: "Coiling", fundflow: "Fund flow", htf: "High-tight", pb21: "21-EMA pb", first52: "First 52w hi" };
  const mx = Math.max(1.5, ...rows.map(([, v]) => Math.abs(v.excess)));
  return (
    <div style={{ margin: "8px 0 12px" }}>
      <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 4 }}>Each scan vs the average stock, 10 sessions later (past year)</div>
      {rows.sort((a, b) => b[1].excess - a[1].excess).map(([k, v]) => (
        <div key={k} style={{ display: "grid", gridTemplateColumns: "78px 1fr 1fr 40px", alignItems: "center", gap: 4, fontSize: 10.5, margin: "2px 0" }}>
          <span style={{ color: "var(--text2)", whiteSpace: "nowrap" }}>{NAME[k] || k}</span>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>{v.excess < 0 && <div style={{ width: `${(Math.abs(v.excess) / mx) * 100}%`, height: 10, background: C.neg, borderRadius: "5px 0 0 5px" }} />}</div>
          <div style={{ borderLeft: "1px solid var(--text3)" }}>{v.excess > 0 && <div style={{ width: `${(v.excess / mx) * 100}%`, height: 10, background: C.pos, borderRadius: "0 5px 5px 0" }} />}</div>
          <span style={{ fontFamily: "var(--mono)", color: v.excess >= 0.5 ? C.pos : v.excess <= -0.5 ? C.neg : "var(--text3)", textAlign: "right" }}>{v.excess > 0 ? "+" : ""}{v.excess}</span>
          {long?.[k] && <span style={{ gridColumn: "2 / 5", fontSize: 9.5, color: "var(--text3)", marginTop: -2 }}>5 years: {long[k].excess > 0 ? "+" : ""}{long[k].excess} ({long[k].signals.toLocaleString("en-IN")} signals)</span>}
        </div>
      ))}
    </div>
  );
}

const GUIDES = {
  app: () => ({
    title: "How TRADESK works — 5 steps every day", short: "How TRADESK works (5 steps)",
    body: <>
      <GFlow steps={[{ t: "1 · MARKET", s: "Is the tape safe? Signal + environment", c: C.lime }, { t: "2 · SIZE", s: "Risk % per trade for today", c: C.warn }, { t: "3 · SETUPS", s: "SCAN / IDEAS: graded, ranked", c: C.pos }, { t: "4 · PLAN", s: "Entry, stop, quantity", c: THEME === "light" ? "#1D4ED8" : "#3B82F6" }, { t: "5 · MANAGE", s: "Hold · Trail the 50-day · Exit", c: C.neg }]} />
      <GPoints items={[["🧭", "The market decides how much you risk — never the stock alone."], ["🎯", "Only take A/B setups that pass the quality gate, in HOT/WARM sectors."], ["🛑", "Every trade has a stop before entry. Size = risk ÷ (stop distance × 1.25), with capital and liquidity caps."], ["🔁", "Positions are re-checked every day. The tested exit is a close under the 50-day (best of 8 exit rules over 5 years); a cold sector or the stop also count."]]} />
    </>,
  }),
  signal: (d) => ({
    title: "Overall signal — four readings, one verdict",
    body: <>
      <GFlow steps={[{ t: "BIAS", s: "long term (200-day)" }, { t: "TREND", s: "medium (50-day)", op: "+" }, { t: "SWING", s: "short (10 vs 20-day)", op: "+" }, { t: "MOMENTUM", s: "is breadth accelerating?", op: "+" }]} />
      <GFlow steps={[{ t: "3–4 positive", s: "INVEST — trade normally", c: MQ_SIGNAL_COLOR.INVEST }, { t: "2 positive", s: "SELECTIVE — best setups only", c: MQ_SIGNAL_COLOR.SELECTIVE, op: "·" }, { t: "0–1 positive", s: "CASH — protect capital", c: MQ_SIGNAL_COLOR.CASH, op: "·" }]} />
      <GPoints items={[["📊", `Today: ${d.overall}. Bias ${d.bias}, Trend ${d.trend}, Swing ${d.swing_state}, Momentum ${d.momentum_dir === "IMPROVING" ? "rising (counts)" : "falling"}.`], ["✓", "Computed from all Nifty 500 stocks and checked against NSE's official closes every evening."], ["⏳", "Bias only flips after 20 sessions on the other side of 50% — it ignores short shake-outs."]]} />
    </>,
  }),
  dims: (d) => ({
    title: "The four readings — % of stocks above their averages",
    body: <>
      <GScale label="Bias · above the 200-day" value={d.pct_above_200} unit="%" zones={[[0, 30, C.neg, "weak"], [30, 50, C.warn, "mixed"], [50, 75, C.lime, "healthy"], [75, 100, C.pos, "strong"]]} />
      <GScale label="Trend · above the 50-day" value={d.pct_above_50} unit="%" zones={[[0, 20, C.neg, "washed out"], [20, 50, C.warn, "weak"], [50, 80, C.lime, "healthy"], [80, 100, C.pos, "hot"]]} />
      <GScale label="Swing · above the 10-day" value={d.pct_above_10} unit="%" zones={[[0, 20, C.neg, "oversold"], [20, 50, C.warn, "down-swing"], [50, 80, C.lime, "up-swing"], [80, 100, C.pos, "stretched"]]} />
      <GPoints items={[["💡", "The marker line is today. Moving right = more stocks in uptrends."], ["↗", "Momentum looks at whether the 50-day breadth is rising faster than its recent average."]]} />
    </>,
  }),
  sizing: (d) => {
    const s = suggestedRisk(d), env = d.environment?.name, g = d.green_light;
    return {
      title: "Sizing — how today's risk per trade is set",
      body: <>
        <GFlow steps={[
          { t: "ENVIRONMENT", s: `${env || "—"}: Easy 1% · Hard 0.5% · No money 0%`, c: MQ_ENV_COLOR[env] },
          { t: "GREEN LIGHT", s: g?.em != null ? `${g.em}: 15+ full · below 15 half` : "15+ full · below 15 half", c: GL_COLOR[g?.band], op: "×" },
          { t: "TODAY", s: s ? `${s.pct}% risk per trade` : "—", c: s?.pct > 0 ? C.pos : C.neg, op: "=" },
        ]} />
        {g?.em != null && <GScale label="Green light (EM-equivalent)" min={0} max={40} value={g.em} zones={[[0, 15, C.warn, "half size"], [15, 40, C.pos, "full size"]]} />}
        <GPoints items={[["🧮", "Quantity = (portfolio × risk %) ÷ ((entry − stop) × 1.25 gap buffer), capped at 25% of capital and 2% of the stock's daily turnover. The calculator and IDEAS use the same rule."], ["🔥", `Total open risk (heat) is capped at ${s?.heatCap ?? "—"}% today.`], ["⛔", "Signal CASH or No money → no new entries."], ["½", "Many stocks at 52-week lows halves it again."]]} />
      </>,
    };
  },
  breadth: (d) => {
    const m = d.mbi?.rows?.[d.mbi.rows.length - 1];
    return {
      title: "Breadth — how many stocks are taking part",
      body: <>
        <div style={{ fontSize: 11, color: "var(--text2)", margin: "4px 0" }}>MBI day colour = green boxes − red boxes</div>
        <GFlow steps={[{ t: "≥ +3", s: "GREEN day", c: C.pos }, { t: "−2 … +2", s: "NEUTRAL", c: C.muted, op: "·" }, { t: "≤ −3", s: "RED day", c: C.neg, op: "·" }]} />
        <GPoints items={[["🌡", `Today ${m ? `${m.color.toLowerCase()} (${m.score > 0 ? "+" : ""}${m.score})` : "—"}. Breadth is a thermometer${d.mbi?.bt?.red && d.mbi?.bt?.green ? `: after red days the average stock did ${d.mbi.bt.red.fwd > 0 ? "+" : ""}${d.mbi.bt.red.fwd}% over 10 sessions, after green days ${d.mbi.bt.green.fwd > 0 ? "+" : ""}${d.mbi.bt.green.fwd}%` : ""}.`], ["📈", "Market Monitor: stocks up ≥4% vs down ≥4%. Watch the 10-day ratio for whether momentum is paying."], ["🆕", "Net new highs > 0 for 3 sessions is one of the conditions for the Trend to turn UP."]]} />
      </>,
    };
  },
  sectors: () => ({
    title: "Sectors — where the strength is",
    body: <>
      <GQuad />
      <GPoints items={[["👆", "Tap a sector to see the stocks carrying it, strongest first."], ["🔥", "HOT ≥ 70% of its stocks above the 50-day · WARM ≥ 50% · COOL ≥ 30% · COLD below."], ["🎯", "Most big winners come from the top 2–3 sectors — favour LEADING and IMPROVING."]]} />
    </>,
  }),
  flows: () => ({
    title: "Institutions — who is buying",
    body: <GPoints items={[["🏦", "FII = foreign funds, DII = Indian funds (mutual funds, insurers). Net buying in ₹ crore, from NSE (provisional)."], ["🤝", "Bulk / block deals: large single trades. A big buyer in a stock you like is a plus — the IDEAS list tags it."], ["⚖", "Flows explain the index; your stocks still need their own setup."]]} />,
  }),
  record: (d) => ({
    title: "Track record — does it actually work?",
    body: <>
      <GRecord stats={d.scan_stats} long={d.long_bt?.scan_stats} />
      <GPoints items={[["✓", "\"vs average stock\" = percentage points better or worse over the next 10 sessions. +0.5 or more is worth attention, near 0 is no edge, negative means it lost. One year is a small sample — the 5-year line, when shown, is the better guide."], ["🔎", "Records use today's index members, so they're a little optimistic. Treat small differences as noise."], ["🧪", "Every gauge in TRADESK shows its own record — trust the ones that earned it."]]} />
    </>,
  }),
  scan: (d) => ({
    title: "How to use SCAN", short: "How to use SCAN",
    body: <>
      <GFlow steps={[{ t: "PICK A LIST", s: "each has its past-year record" }, { t: "QUALITY ON", s: "₹10 cr+ turnover, 1.8%+ daily move", c: C.pos }, { t: "RS + GRADE", s: "RS 80+, grade A/B" }, { t: "OPEN STOCK", s: "chart, plan, results date" }]} />
      <GRecord stats={d.scan_stats} />
      <GPoints items={[["✓", "A ✓ on a tab = that scan beat the average stock over the last 3 months."], ["⚠", "Lists with a negative record are for watching, not buying blindly."]]} />
    </>,
  }),
  ideas: () => ({
    title: "How IDEAS ranks stocks", short: "How IDEAS ranks stocks",
    body: <>
      <GFlow steps={[{ t: "GRADE", s: "A +30 · B +15" }, { t: "STRENGTH", s: "RS ÷ 5", op: "+" }, { t: "LISTS", s: "6 ± its record, per list", op: "+" }, { t: "SECTOR", s: "HOT +6 · WARM +3", op: "+" }, { t: "WATCH", s: "+8 if on your list", op: "+" }]} />
      <GPoints items={[["⚖", "Each list counts 6 points plus 4 per point it beat the average stock by (−6…+12). Stocks only on losing lists are watch only."], ["🧹", "Quality on hides thin or slow stocks (₹10 cr / ₹3 cr microcaps; your watchlist always shows)."], ["📅", "A results badge means the company reports soon — a gap can jump your stop."], ["📐", "Quantities use today's risk % and each stock's suggested entry/stop."]]} />
    </>,
  }),
};

/** Collapsible infographic. Remembers open/closed per guide. */
function Guide({ id, d, compact }) {
  const key = `td_guide_${id}`;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) === "1"; } catch (_) { return false; } });
  const toggle = () => setOpen(v => { try { localStorage.setItem(key, v ? "0" : "1"); } catch (_) {} return !v; });
  const g = GUIDES[id]?.(d || {});
  if (!g) return null;
  return (
    <div style={{ marginBottom: compact ? 8 : 12 }}>
      <button onClick={toggle} aria-expanded={open} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", minHeight: 36, background: open ? "var(--bg3)" : "transparent", border: "1px dashed var(--border2)", borderRadius: open ? "10px 10px 0 0" : 10, padding: "6px 12px", color: "var(--text2)", fontSize: 12, cursor: "pointer", textAlign: "left" }}>
        <span style={{ flex: 1 }}>{open ? g.title : `ⓘ ${g.short || g.title.split(" — ")[0]}`}</span><span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div style={{ border: "1px dashed var(--border2)", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "4px 12px 12px", background: "var(--bg3)" }}>{g.body}</div>}
    </div>
  );
}
/** A collapsed section (closed by default, remembered). */
function Fold({ id, title, sub, children }) {
  const key = `td_fold_${id}`;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) === "1"; } catch (_) { return false; } });
  const toggle = () => setOpen(v => { try { localStorage.setItem(key, v ? "0" : "1"); } catch (_) {} return !v; });
  return (
    <div style={{ marginBottom: 14 }}>
      <button onClick={toggle} aria-expanded={open} className="card" style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, textAlign: "left", cursor: "pointer", color: "var(--text)", marginBottom: open ? 10 : 0 }}>
        <span style={{ flex: 1 }}><span style={{ display: "block", fontSize: 13, fontWeight: 700 }}>{title}</span>{sub && <span style={{ display: "block", fontSize: 11, color: "var(--text3)", marginTop: 2 }}>{sub}</span>}</span>
        <span aria-hidden="true" style={{ color: "var(--text3)" }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && children}
    </div>
  );
}

/** QUAD section header with an anchor and its guide. */
function QuadSection({ id, title, d }) {
  return (
    <div id={`q-${id}`} style={{ scrollMarginTop: 100, margin: "22px 0 8px" }}>
      <div style={{ fontFamily: "var(--display)", fontSize: 20, color: "var(--text)", marginBottom: 6 }}>{title}</div>
      <Guide id={id} d={d} compact />
    </div>
  );
}
const QUAD_JUMPS = [["signal", "Signal"], ["dims", "Readings"], ["sizing", "Sizing"], ["breadth", "Breadth"], ["sectors", "Sectors"], ["flows", "Flows"], ["record", "Record"]];
function QuadJumpBar() {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "0 0 10px" }}>
      {QUAD_JUMPS.map(([id, l]) => (
        <button key={id} className="chip" style={{ whiteSpace: "nowrap" }} onClick={() => document.getElementById(`q-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{l}</button>
      ))}
    </div>
  );
}

function MqForward({ fw, picks, onPickStock }) {
  if (!fw && !picks?.rows?.length) return null;
  const col = (v) => (v == null ? "var(--text3)" : v > 0 ? C.pos : v < 0 ? C.neg : "var(--text2)");
  const ST = { closed: "closed", stopped: "stopped", open: "open", waiting: "waiting", "no fill": "no fill" };
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>FORWARD TEST · LIVE RECORD</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8, lineHeight: 1.45 }}>
        Every evening the app saves its top picks (grade A/B, quality gate, lists with a positive record) with the entry and stop it showed you. Later evenings score them: filled if a close reaches the entry within 3 sessions, out at the first close under the stop or after 10 sessions. No hindsight — this is what following the app would have done.
      </div>
      {fw?.done > 0 ? (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 8, fontSize: 12 }}>
          <span>Scored <b>{fw.done}</b></span>
          <span>Win rate <b>{fw.hit}%</b></span>
          <span>Avg <b style={{ color: col(fw.avg) }}>{fw.avg > 0 ? "+" : ""}{fw.avg}%</b></span>
          <span>vs average stock <b style={{ color: col(fw.vs) }}>{fw.vs > 0 ? "+" : ""}{fw.vs}%</b></span>
          <span>Avg <b style={{ color: col(fw.avgR) }}>{fw.avgR > 0 ? "+" : ""}{fw.avgR}R</b></span>
        </div>
      ) : <div style={{ fontSize: 12, color: "var(--text2)", marginBottom: 8 }}>{fw ? `${fw.picks} picks so far — the first ones are scored 10–13 sessions after they were made.` : "Starts with tonight's picks; the first results arrive in about two weeks."}</div>}
      {fw?.done > 0 && fw.done < 30 && <div style={{ fontSize: 10, color: C.warn, marginBottom: 6 }}>Fewer than 30 scored picks — too early to judge.</div>}
      {fw?.rows?.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", columnGap: 10, fontSize: 11, fontFamily: "var(--mono)" }}>
          {fw.rows.slice(0, 12).map((x, i) => (
            <Fragment key={i}>
              <span style={{ color: "var(--text3)", borderTop: "1px solid var(--border)", padding: "3px 0" }}>{mqFmtDate(x.d)}</span>
              <button onClick={() => onPickStock?.(x.sym)} style={{ textAlign: "left", background: "none", border: "none", borderTop: "1px solid var(--border)", padding: "3px 0", color: "var(--text)", cursor: "pointer", font: "inherit" }}>{x.sym}</button>
              <span style={{ color: x.status === "stopped" ? C.neg : "var(--text3)", borderTop: "1px solid var(--border)", padding: "3px 0" }}>{ST[x.status] || x.status}</span>
              <span style={{ color: col(x.ret), textAlign: "right", borderTop: "1px solid var(--border)", padding: "3px 0" }}>{x.ret != null ? `${x.ret > 0 ? "+" : ""}${x.ret}%` : "—"}</span>
            </Fragment>
          ))}
        </div>
      )}
      {picks?.rows?.length > 0 && <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 8 }}>Tonight's picks: {picks.rows.map(x => x.sym).join(", ")}</div>}
    </div>
  );
}

function MqMarketMonitor({ mm }) {
  if (!mm?.rows?.length) return null;
  const rows = mm.rows.slice(-10).reverse();
  const last = mm.rows[mm.rows.length - 1];
  const tone = (r) => (r == null ? "var(--text3)" : r >= 2 ? C.pos : r <= 0.5 ? C.neg : "var(--text)");
  const b = mm.bt || {};
  const line = (k, label) => b[k] ? <span>{label}: next 10 sessions avg {b[k].fwd > 0 ? "+" : ""}{b[k].fwd}% ({b[k].up}% up, {b[k].days}d)</span> : null;
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>MARKET MONITOR</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8 }}>Stocks up / down ≥4% on rising volume each day (Stockbee-style). Traders read a 10-day ratio above 2 as momentum-friendly and below 0.5 as hostile — check the record underneath before trusting it.</div>
      <div style={{ display: "flex", gap: 14, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12 }}>5-day ratio <b style={{ fontFamily: "var(--mono)", color: tone(last.r5) }}>{last.r5 ?? "—"}</b></span>
        <span style={{ fontSize: 12 }}>10-day ratio <b style={{ fontFamily: "var(--mono)", color: tone(last.r10) }}>{last.r10 ?? "—"}</b></span>
        <span style={{ fontSize: 12, color: "var(--text3)" }}>Up 25% in a quarter <b style={{ color: C.pos }}>{last.q25u}</b> · down 25% <b style={{ color: C.neg }}>{last.q25d}</b></span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto auto", columnGap: 12, fontSize: 11, fontFamily: "var(--mono)" }}>
        {["DAY", "UP 4%", "DOWN 4%", "5D", "10D"].map((h, i) => <span key={h} style={{ fontSize: 9, color: "var(--text3)", textAlign: i ? "right" : "left", paddingBottom: 3 }}>{h}</span>)}
        {rows.map(r => (
          <Fragment key={r.d}>
            <span style={{ borderTop: "1px solid var(--border)", padding: "3px 0", color: "var(--text2)" }}>{mqFmtDate(r.d)}</span>
            <span style={{ borderTop: "1px solid var(--border)", padding: "3px 0", textAlign: "right", color: C.pos }}>{r.up}</span>
            <span style={{ borderTop: "1px solid var(--border)", padding: "3px 0", textAlign: "right", color: C.neg }}>{r.dn}</span>
            <span style={{ borderTop: "1px solid var(--border)", padding: "3px 0", textAlign: "right", color: tone(r.r5) }}>{r.r5 ?? "—"}</span>
            <span style={{ borderTop: "1px solid var(--border)", padding: "3px 0", textAlign: "right", color: tone(r.r10) }}>{r.r10 ?? "—"}</span>
          </Fragment>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 8, lineHeight: 1.5 }}>
        Past year, for the average Nifty 500 stock — {line("strong", "10D ≥ 2")}{b.strong && b.mid ? " · " : ""}{line("mid", "in between")}{(b.strong || b.mid) && b.weak ? " · " : ""}{line("weak", "10D ≤ 0.5")}.
        {b.strong && b.mid && b.strong.fwd <= b.mid.fwd ? " Over this period strong readings did not lead to better returns — treat it as context, not a signal." : ""}
      </div>
    </div>
  );
}

// ── FII/DII flows + bulk/block deals ──
let _flowsCache = null, _dealsCache = null;
async function fetchFlows() {
  if (_flowsCache && Date.now() - _flowsCache.at < 15 * 60000) return _flowsCache.d;
  const d = await fetch("/api/nse?type=flows").then(r => (r.ok ? r.json() : null)).catch(() => null);
  _flowsCache = { at: Date.now(), d }; return d;
}
async function fetchDeals() {
  if (_dealsCache && Date.now() - _dealsCache.at < 15 * 60000) return _dealsCache.d;
  const d = await fetch("/api/nse?type=deals").then(r => (r.ok ? r.json() : null)).catch(() => null);
  _dealsCache = { at: Date.now(), d }; return d;
}
function useFlowsDeals() {
  const [s, set] = useState({ flows: null, deals: null });
  useEffect(() => { let alive = true; Promise.all([fetchFlows(), fetchDeals()]).then(([flows, deals]) => alive && set({ flows, deals })); return () => { alive = false; }; }, []);
  return s;
}
const crore = (v) => `${v >= 0 ? "+" : "−"}₹${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })} cr`;
function FlowsLine({ flows }) {
  if (!flows?.fii) return null;
  return (
    <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 8 }} title="FII/DII cash-market net buying (NSE, provisional)">
      Flows {mqFmtDate(flows.date)}: FII <b style={{ color: flows.fii.net >= 0 ? C.pos : C.neg }}>{crore(flows.fii.net)}</b> · DII <b style={{ color: flows.dii?.net >= 0 ? C.pos : C.neg }}>{flows.dii ? crore(flows.dii.net) : "—"}</b>
    </div>
  );
}
function MqFlowsDeals({ data, onPickStock }) {
  const { flows, deals } = useFlowsDeals();
  if (!flows && !deals) return null;
  const known = data?.sector_of || {};
  // NSE can list the same trade under both bulk and block deals — keep one
  const seen = new Set();
  const big = (deals?.deals || []).filter(x => known[x.sym]).filter(x => { const k = [x.sym, x.client, x.side, x.qty, x.price].join("|"); if (seen.has(k)) return false; seen.add(k); return true; })
    .map(x => ({ ...x, value: x.qty * x.price })).sort((a, b) => b.value - a.value).slice(0, 10);
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 8 }}>INSTITUTIONS</div>
      {flows?.fii && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          {[["FII / FPI", flows.fii], ["DII", flows.dii]].map(([l, f]) => f && (
            <div key={l} style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 10px" }}>
              <div style={{ fontSize: 10, color: "var(--text3)" }}>{l} · {mqFmtDate(flows.date)}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 16, fontWeight: 700, color: f.net >= 0 ? C.pos : C.neg }}>{crore(f.net)}</div>
              <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)" }}>buy {Math.round(f.buy).toLocaleString("en-IN")} · sell {Math.round(f.sell).toLocaleString("en-IN")}</div>
            </div>
          ))}
        </div>
      )}
      {big.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 4 }}>Largest bulk/block deals in tracked stocks · {mqFmtDate(deals.date)}</div>
          {big.map((x, i) => (
            <div key={i} style={{ display: "flex", gap: 8, fontSize: 11, padding: "4px 0", borderTop: "1px solid var(--border)", alignItems: "baseline" }}>
              <button onClick={() => onPickStock?.(x.sym)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", fontFamily: "var(--display)", fontWeight: 700, textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{x.sym}</button>
              <span style={{ color: x.side === "BUY" ? C.pos : C.neg, fontWeight: 700, fontSize: 10 }}>{x.side}</span>
              <span style={{ color: "var(--text3)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.client}</span>
              <span style={{ fontFamily: "var(--mono)", color: "var(--text2)" }}>₹{(x.value / 1e7).toFixed(1)} cr</span>
            </div>
          ))}
        </>
      )}
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>Source: NSE (provisional figures, latest session).</div>
    </div>
  );
}

// ── PLAYBOOK ──
function setupRecord(closed, mq, setup) {
  const ts = closed.filter(t => t.setupType === setup);
  if (!ts.length) return null;
  const wins = ts.filter(t => (t.pnl || 0) > 0).length;
  const rs = ts.filter(t => t.riskAmount > 0).map(t => (t.pnl || 0) / t.riskAmount);
  const byEnv = {};
  for (const t of ts) { const e = tradeContext(t, mq).env || "?"; (byEnv[e] ||= []).push(t); }
  const best = Object.entries(byEnv).filter(([e, xs]) => e !== "?" && xs.length >= 2)
    .map(([e, xs]) => [e, xs.reduce((a, t) => a + (t.pnl || 0), 0) / xs.length]).sort((a, b) => b[1] - a[1])[0];
  return { n: ts.length, wr: Math.round((wins / ts.length) * 100), avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, pnl: ts.reduce((a, t) => a + (t.pnl || 0), 0), best: best?.[0] || null };
}

function PlaybookSetups({ trades, onOpenStock }) {
  const { data: mq } = useMarketQuadrant();
  const [openSet, setOpenSet] = useState(null);
  const closed = trades.filter(t => t.status === "closed");
  const order = Object.entries(PLAYBOOK_SETUPS).sort((a, b) => (mq?.scans?.[b[1].scan]?.length || 0) - (mq?.scans?.[a[1].scan]?.length || 0));
  return (
    <div>
      {order.map(([name, def]) => {
        const isOpen = openSet === name;
        const live = mq?.scans?.[def.scan] || [];
        const rec = setupRecord(closed, mq, name);
        const edge = mq?.scan_stats?.[def.scan];
        return (
          <div key={name} className="card" style={{ marginBottom: 12 }}>
            <button onClick={() => setOpenSet(isOpen ? null : name)} aria-expanded={isOpen} style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "baseline", background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", minHeight: 36 }}>
              <span style={{ fontFamily: "var(--display)", fontSize: 18 }}>{name}</span>
              <span style={{ fontSize: 11, color: live.length ? C.pos : "var(--text3)" }}>{live.length ? `${live.length} today` : "none today"}{edge ? <span style={{ color: edge.excess >= 0.5 ? C.pos : edge.excess <= -0.5 ? C.neg : "var(--text3)" }}> · {edge.excess > 0 ? "+" : ""}{edge.excess}</span> : null} {isOpen ? "▴" : "▾"}</span>
            </button>
            {isOpen && (
              <ul style={{ margin: "6px 0 8px 16px", padding: 0, fontSize: 12, color: "var(--text2)", lineHeight: 1.6 }}>
                {def.rules.map(r => <li key={r}>{r}</li>)}
              </ul>
            )}
            {live.length > 0 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                {live.slice(0, 6).map(x => (
                  <button key={x.sym} onClick={() => onOpenStock?.(x.sym)} className="chip" style={{ fontSize: 11 }}>
                    {x.sym}{x.grade ? ` · ${x.grade}` : ""}
                  </button>
                ))}
              </div>
            )}
            <div style={{ fontSize: 11, color: "var(--text3)", borderTop: "1px solid var(--border)", paddingTop: 6, lineHeight: 1.5 }}>
              <b style={{ color: "var(--text2)" }}>You:</b>{" "}
              {rec ? <>{rec.n} trades · {rec.wr}% wins{rec.avgR != null ? ` · avg ${rec.avgR > 0 ? "+" : ""}${rec.avgR.toFixed(2)}R` : ""} · <span style={{ color: rec.pnl >= 0 ? C.pos : C.neg }}>{rec.pnl >= 0 ? "+" : ""}{formatINR(rec.pnl)}</span>{rec.best ? ` · best in ${rec.best}` : ""}</> : "no closed trades with this setup yet"}
              {edge && <><br /><b style={{ color: "var(--text2)" }}>Market, past year:</b> {edge.hit}% higher after 10 sessions · {edge.excess > 0 ? "+" : ""}{edge.excess} vs average stock</>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PnlCalendar({ closed }) {
  const byDay = {};
  for (const t of closed) {
    for (const x of t.exits || []) { const d = new Date(Date.parse(x.date) + 19800000).toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + (x.pnl || 0); }
    if (!(t.exits || []).length && t.date) { const d = new Date(Date.parse(t.date) + 19800000).toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + (t.pnl || 0); }
  }
  const today = new Date(Date.now() + 19800000); const monday = new Date(today); monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  const weeks = [];
  for (let w = 11; w >= 0; w--) {
    const days = [];
    for (let k = 0; k < 5; k++) { const d = new Date(monday); d.setUTCDate(monday.getUTCDate() - w * 7 + k); const key = d.toISOString().slice(0, 10); days.push({ key, v: byDay[key] ?? null }); }
    weeks.push(days);
  }
  const max = Math.max(1, ...Object.values(byDay).map(Math.abs));
  const cell = (v) => (v == null ? "var(--bg3)" : v >= 0 ? `rgba(74,222,128,${(0.2 + 0.8 * Math.abs(v) / max).toFixed(2)})` : `rgba(220,20,60,${(0.2 + 0.8 * Math.abs(v) / max).toFixed(2)})`);
  const total = weeks.flat().reduce((a, d) => a + (d.v || 0), 0);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="label" style={{ marginBottom: 8 }}>P&amp;L calendar · last 12 weeks <span style={{ color: total >= 0 ? C.pos : C.neg, fontFamily: "var(--mono)" }}>{total >= 0 ? "+" : ""}{formatINR(total)}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "auto repeat(12, 1fr)", gap: 3, alignItems: "center" }}>
        {["M", "T", "W", "T", "F"].map((dl, k) => (
          <Fragment key={k}>
            <span style={{ fontSize: 9, color: "var(--text3)", paddingRight: 4 }}>{dl}</span>
            {weeks.map((wk, w) => <span key={w} title={`${mqFmtDate(wk[k].key)}: ${wk[k].v == null ? "no closed trades" : formatINR(wk[k].v)}`} style={{ height: 14, borderRadius: 3, background: cell(wk[k].v) }} />)}
          </Fragment>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>Each square is a trading day (by exit date): green = profit, red = loss, darker = bigger.</div>
    </div>
  );
}

function PlaybookReview({ trades, setTrades, onOpenStock }) {
  const closed = trades.filter(t => t.status === "closed").sort((a, b) => ((a.exits?.slice(-1)[0]?.date || a.date) < (b.exits?.slice(-1)[0]?.date || b.date) ? 1 : -1));
  const update = (id, patch) => setTrades(trades.map(t => (t.id === id ? { ...t, ...patch } : t)));
  const cost = {};
  for (const t of closed) for (const m of t.mistakes || []) { cost[m] ||= { n: 0, pnl: 0 }; cost[m].n++; cost[m].pnl += t.pnl || 0; }
  const emo = {};
  for (const t of closed) if (t.emotion) { emo[t.emotion] ||= { n: 0, w: 0 }; emo[t.emotion].n++; if ((t.pnl || 0) > 0) emo[t.emotion].w++; }
  return (
    <div>
      <PnlCalendar closed={closed} />
      {(Object.keys(cost).length > 0 || Object.keys(emo).length > 0) && (
        <div className="card" style={{ marginBottom: 12 }}>
          {Object.keys(cost).length > 0 && (
            <>
              <div className="label" style={{ marginBottom: 6 }}>What your mistakes cost</div>
              {Object.entries(cost).sort((a, b) => a[1].pnl - b[1].pnl).map(([m, c]) => (
                <div key={m} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}>
                  <span style={{ color: "var(--text2)" }}>{m} <span style={{ color: "var(--text3)" }}>×{c.n}</span></span>
                  <span style={{ fontFamily: "var(--mono)", color: c.pnl >= 0 ? C.pos : C.neg }}>{c.pnl >= 0 ? "+" : ""}{formatINR(c.pnl)}</span>
                </div>
              ))}
            </>
          )}
          {Object.keys(emo).length > 0 && (
            <div style={{ marginTop: Object.keys(cost).length ? 10 : 0 }}>
              <div className="label" style={{ marginBottom: 6 }}>Win rate by mood</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
                {Object.entries(emo).map(([e, c]) => <span key={e} style={{ color: "var(--text2)" }}>{e} <b style={{ color: c.w / c.n > 0.5 ? C.pos : "var(--text)" }}>{Math.round((c.w / c.n) * 100)}%</b> <span style={{ color: "var(--text3)" }}>({c.n})</span></span>)}
              </div>
            </div>
          )}
        </div>
      )}
      <div className="card">
        <div className="label" style={{ marginBottom: 4 }}>Review your recent trades</div>
        <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 6 }}>Tag what went wrong and how you felt — the summaries above build from these.</div>
        {closed.length === 0 && <div style={{ fontSize: 12, color: "var(--text3)", padding: "12px 0" }}>No closed trades yet.</div>}
        {closed.slice(0, 20).map(t => (
          <div key={t.id} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <button onClick={() => onOpenStock?.(normalizeSymbol(t.symbol))} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", fontFamily: "var(--display)", fontWeight: 700, textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{t.symbol}</button>
              <span style={{ fontSize: 10, color: "var(--text3)" }}>{t.setupType}{t.checklist ? ` · checklist ${t.checklist.ticked.length}/${t.checklist.total}` : ""}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: (t.pnl || 0) >= 0 ? C.pos : C.neg }}>{(t.pnl || 0) >= 0 ? "+" : ""}{formatINR(t.pnl || 0)}</span>
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }}>
              {MISTAKES.map(m => {
                const on = (t.mistakes || []).includes(m);
                return <button key={m} className="chip" aria-pressed={on} onClick={() => update(t.id, { mistakes: on ? t.mistakes.filter(x => x !== m) : [...(t.mistakes || []), m] })}
                  style={{ fontSize: 10, padding: "2px 8px", ...(on ? { borderColor: C.neg, color: C.neg } : {}) }}>{m}</button>;
              })}
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 5 }}>
              {EMOTIONS.map(e => (
                <button key={e} className="chip" aria-pressed={t.emotion === e} onClick={() => update(t.id, { emotion: t.emotion === e ? null : e })}
                  style={{ fontSize: 10, padding: "2px 8px", ...(t.emotion === e ? { borderColor: "var(--text)", color: "var(--text)" } : {}) }}>{e}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlaybookPage({ trades, setTrades, portfolio, sub, setSub, onOpenStock, onOpenJournal }) {
  const [paperView, setPaperView] = useState(false);
  const hasPaper = trades.some(t => t.paper);
  const view = trades.filter(t => (paperView ? t.paper : !t.paper));
  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      <div className="section-title">{{ review: "Review", stats: "Stats", setups: "Setups" }[sub] || "Setups"}</div>
      <div style={{ fontSize: 13, color: "var(--text3)", margin: "4px 0 12px" }}>{{ review: "Go back over closed trades: what went right and wrong.", stats: "Your results, by setup, market condition and discipline.", setups: "Your setups, their rules and today's live examples." }[sub] || ""}</div>
      {hasPaper && sub !== "review" && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10, fontSize: 11, color: "var(--text3)", alignItems: "center" }}>
          Showing:
          {[[false, "Real trades"], [true, "Paper trades"]].map(([v, l]) => <button key={l} className="chip chip-sm" aria-pressed={paperView === v} onClick={() => setPaperView(v)}>{l}</button>)}
        </div>
      )}
      {sub === "review" ? <PlaybookReview trades={trades} setTrades={setTrades} onOpenStock={onOpenStock} />
        : sub === "stats" ? <div style={{ margin: "0 -16px" }}><AnalyticsPage trades={view} portfolio={portfolio} /></div>
        : <PlaybookSetups trades={view} onOpenStock={onOpenStock} />}
    </div>
  );
}

// ── Trade replay: your entries/exits for a symbol as chart marks ──
function tradeMarks(trades, symbol) {
  const out = [];
  for (const t of trades || []) {
    if (normalizeSymbol(t.symbol) !== symbol) continue;
    for (const e of t.entries || []) if (e.date && e.price) out.push({ day: new Date(Date.parse(e.date) + 19800000).toISOString().slice(0, 10), price: e.price, side: "buy" });
    for (const x of t.exits || []) if (x.date && x.price) out.push({ day: new Date(Date.parse(x.date) + 19800000).toISOString().slice(0, 10), price: x.price, side: "sell" });
  }
  return out;
}

// ─── BOTTOM NAV ──────────────────────────────────────────────────────────────
// ─── MUTUAL FUNDS (AMFI daily NAVs + mfapi.in history) ───────────────────────
let _mfListP = null;
function loadMfList() {
  return (_mfListP ||= fetch("/api/mf?type=list").then(r => (r.ok ? r.json() : Promise.reject(new Error("Fund list unavailable")))).catch(e => { _mfListP = null; throw e; }));
}
const _mfFund = new Map();
function loadMfFund(code) {
  if (!_mfFund.has(code)) _mfFund.set(code, fetch(`/api/mf?type=fund&code=${code}`).then(r => (r.ok ? r.json() : Promise.reject(new Error("Fund data unavailable")))).catch(e => { _mfFund.delete(code); throw e; }));
  return _mfFund.get(code);
}
const _mfCat = new Map(); // cat → { rows, total, done }
const _mfBench = new Map();
function loadMfBench(cat) {
  if (!_mfBench.has(cat)) _mfBench.set(cat, fetch(`/api/mf?type=bench&cat=${encodeURIComponent(cat)}`).then(r => (r.ok ? r.json() : null)).catch(() => null));
  return _mfBench.get(cat);
}
function useMfBench(cat) {
  const [b, setB] = useState(null);
  useEffect(() => { let alive = true; setB(null); if (cat) loadMfBench(cat).then(x => alive && setB(x)); return () => { alive = false; }; }, [cat]);
  return b;
}
function useMfList() {
  const [s, set] = useState({ data: null, error: null });
  useEffect(() => { let alive = true; loadMfList().then(d => alive && set({ data: d, error: null })).catch(e => alive && set({ data: null, error: e.message })); return () => { alive = false; }; }, []);
  return s;
}
// Set by App: writes funds data through the synced app snapshot (cloud sync)
let _mfSync = null;
const readMfWatch = () => { try { return JSON.parse(localStorage.getItem("td_mf_watch") || "[]"); } catch (_) { return []; } };
function useMfWatch() {
  const [w, setW] = useState(readMfWatch);
  useEffect(() => { const on = () => setW(readMfWatch()); window.addEventListener("td_mf_watch", on); return () => window.removeEventListener("td_mf_watch", on); }, []);
  const toggle = (code) => {
    const prev = readMfWatch(), next = prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code];
    setW(next);
    if (_mfSync) _mfSync.setWatch(next);
    else { try { localStorage.setItem("td_mf_watch", JSON.stringify(next)); } catch (_) {} window.dispatchEvent(new Event("td_mf_watch")); }
  };
  return [w, toggle];
}
const pctTxt = (v, d = 1) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const pctCol = (v) => (v == null ? "var(--text3)" : v > 0 ? C.pos : v < 0 ? C.neg : "var(--text2)");
const MF_GROUPS = ["Equity", "Hybrid", "Index", "Debt", "ETF", "Solution", "Other"];

function FundsPage({ onOpenFund }) {
  const { data, error } = useMfList();
  const [watch] = useMfWatch();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState(() => { try { return localStorage.getItem("td_mf_cat") || "Equity · Flexi Cap"; } catch (_) { return "Equity · Flexi Cap"; } });
  const [group, setGroup] = useState(() => (cat.split(" · ")[0] || "Equity"));
  const pickCat = (c) => { setCat(c); try { localStorage.setItem("td_mf_cat", c); } catch (_) {} };
  const head = (
    <div style={{ marginBottom: 12 }}>
      <div className="section-title">Funds</div>
      <div style={{ fontSize: 13, color: "var(--text3)", marginTop: 4 }}>Every Direct-Growth mutual fund, updated each evening from AMFI's official NAVs.</div>
    </div>
  );
  if (!data) return <div className="fade-in" style={{ padding: "16px 16px 120px" }}>{head}<div className="card" style={{ fontSize: 12, color: error ? "var(--red)" : "var(--text3)" }}>{error || <><div style={{ marginBottom: 10 }}>Loading AMFI's NAV file…</div><Skeleton lines={5} /></>}</div></div>;
  const ql = q.trim().toLowerCase();
  const hits = ql.length >= 2 ? data.funds.filter(f => f[1].toLowerCase().includes(ql) || f[2].toLowerCase().includes(ql)).slice(0, 25) : [];
  const catsInGroup = data.cats.map((c, i) => [c, data.funds.filter(f => f[3] === i).length]).filter(([c]) => c.startsWith(group + " · ")).sort((a, b) => b[1] - a[1]);
  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      {head}
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search a fund or AMC — e.g. parag parikh, nifty 50 index" aria-label="Search mutual funds"
        style={{ width: "100%", marginBottom: 12 }} />
      {ql.length >= 2 && (
        <div className="card" style={{ marginBottom: 12, paddingTop: 6 }}>
          {hits.length ? hits.map(f => <MfRow key={f[0]} f={f} cat={data.cats[f[3]]} onOpen={onOpenFund} />) : <div style={{ fontSize: 12, color: "var(--text3)", padding: "10px 0" }}>No fund matches "{q}".</div>}
        </div>
      )}
      {!ql && <MfPortfolio list={data} onOpenFund={onOpenFund} />}
      {watch.length > 0 && !ql && (
        <div className="card" style={{ marginBottom: 12, paddingTop: 10 }}>
          <div className="label" style={{ marginBottom: 4 }}>Funds you track</div>
          {watch.map(code => { const f = data.funds.find(x => x[0] === code); return f ? <MfWatchRow key={code} f={f} onOpen={onOpenFund} /> : null; })}
        </div>
      )}
      {!ql && <>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {MF_GROUPS.map(g => <button key={g} className="chip chip-sm" aria-pressed={group === g} onClick={() => setGroup(g)}>{g}</button>)}
        </div>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, marginBottom: 10, scrollbarWidth: "thin" }}>
          {catsInGroup.map(([c, n]) => <button key={c} className="chip chip-sm" aria-pressed={cat === c} onClick={() => pickCat(c)} style={{ whiteSpace: "nowrap" }}>{c.split(" · ")[1]} <span style={{ opacity: 0.6, fontFamily: "var(--mono)" }}>{n}</span></button>)}
        </div>
        <MfCategory cat={cat} onOpen={onOpenFund} />
      </>}
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 10, lineHeight: 1.5 }}>
        NAVs as of {mqFmtDate(data.date)} from AMFI (published ~9–11 pm IST); history from mfapi.in. Direct-Growth plans only. 3Y / 5Y are yearly (CAGR) returns. Past returns don't predict future returns — this is information, not advice.
      </div>
    </div>
  );
}

function MfRow({ f, cat, onOpen }) {
  return (
    <button onClick={() => onOpen(f[0])} style={{ display: "flex", width: "100%", textAlign: "left", gap: 8, alignItems: "center", background: "none", border: "none", borderTop: "1px solid var(--border)", padding: "8px 0", color: "var(--text)", cursor: "pointer", minHeight: 44 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f[1]}</span>
        <span style={{ display: "block", fontSize: 10.5, color: "var(--text3)" }}>{f[2].replace(/ Mutual Fund$/, "")} · {cat?.split(" · ")[1]}</span>
      </span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text2)" }}>₹{f[4].toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
    </button>
  );
}

function MfWatchRow({ f, onOpen }) {
  const [d, setD] = useState(null);
  useEffect(() => { let alive = true; loadMfFund(f[0]).then(x => alive && setD(x)).catch(() => {}); return () => { alive = false; }; }, [f[0]]);
  return (
    <button onClick={() => onOpen(f[0])} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, width: "100%", textAlign: "left", alignItems: "center", background: "none", border: "none", borderTop: "1px solid var(--border)", padding: "8px 0", color: "var(--text)", cursor: "pointer", minHeight: 44 }}>
      <span style={{ minWidth: 0, fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f[1]}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: pctCol(d?.chg) }}>{d ? pctTxt(d.chg, 2) : "…"}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: pctCol(d?.ret?.y1), minWidth: 52, textAlign: "right" }}>{d ? `1Y ${pctTxt(d.ret.y1)}` : ""}</span>
    </button>
  );
}

function MfCategory({ cat, onOpen }) {
  const [st, setSt] = useState(() => _mfCat.get(cat) || null);
  const [sort, setSort] = useState("y3");
  useEffect(() => {
    let alive = true;
    const cached = _mfCat.get(cat);
    setSt(cached || { rows: [], total: null, done: false, error: null });
    if (cached?.done) return;
    (async () => {
      let rows = cached?.rows || [], offset = rows.length, total = cached?.total ?? null;
      try {
        for (;;) {
          const j = await fetch(`/api/mf?type=cat&cat=${encodeURIComponent(cat)}&offset=${offset}`).then(r => (r.ok ? r.json() : Promise.reject(new Error("Category data unavailable"))));
          rows = [...rows, ...j.funds]; total = j.total; offset += j.shown;
          const s = { rows, total, done: !j.more };
          _mfCat.set(cat, s); if (alive) setSt(s);
          if (!j.more || !alive) break;
        }
        // mfapi throttles bursts: fill the funds the category call missed, 3 at a time
        const gaps = rows.filter(r => r.missing);
        let gi = 0;
        await Promise.all([0, 1, 2].map(async () => {
          while (alive && gi < gaps.length) {
            const g = gaps[gi++];
            try {
              const d = await loadMfFund(g.code);
              Object.assign(g, { missing: false, nav: d.nav, date: d.date, chg: d.chg, m1: d.ret.m1, m3: d.ret.m3, y1: d.ret.y1, y3: d.ret.y3, y5: d.ret.y5, vol: d.vol, dd: d.maxDD?.pct, since: d.since });
              const s2 = { rows: [...rows], total, done: true }; _mfCat.set(cat, s2); if (alive) setSt(s2);
            } catch (_) {}
          }
        }));
      } catch (e) { if (alive) setSt(s0 => ({ ...(s0 || {}), rows, total, done: false, error: e.message })); }
    })();
    return () => { alive = false; };
  }, [cat]);
  const rows = (st?.rows || []).filter(r => !r.missing);
  const bench = useMfBench(cat);
  const beatCol = (r, k) => (bench?.ret?.[k] == null || r[k] == null || !["y1", "y3", "y5"].includes(k) ? null : r[k] >= bench.ret[k] ? C.pos : C.neg);
  const tally = (k) => { const xs = rows.filter(r => r[k] != null); return bench?.ret?.[k] != null && xs.length ? [xs.filter(r => r[k] >= bench.ret[k]).length, xs.length] : null; };
  const key = (r) => r[sort] ?? -999;
  const sorted = [...rows].sort((a, b) => (sort === "dd" || sort === "vol" ? (sort === "dd" ? key(b) - key(a) : (a.vol ?? 999) - (b.vol ?? 999)) : key(b) - key(a)));
  const avg = (k) => { const xs = rows.map(r => r[k]).filter(v => v != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const COLS = [["y1", "1Y"], ["y3", "3Y"], ["y5", "5Y"], ["dd", "FALL"]];
  return (
    <div className="card" style={{ paddingTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <div className="label">{cat.split(" · ")[1]}</div>
        <span style={{ fontSize: 10.5, color: "var(--text3)" }}>{st?.total != null ? (st.done ? `${rows.length} funds${st.rows.length > rows.length ? ` · ${st.rows.length - rows.length} couldn't load` : ""}` : `loading ${st.rows.length} of ${st.total}…`) : "loading…"}</span>
      </div>
      {st?.error && <div style={{ fontSize: 11, color: C.warn, marginBottom: 6 }}>{st.error} — showing what loaded.</div>}
      {!rows.length && !st?.error ? <Skeleton lines={6} /> : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr repeat(4, auto)", columnGap: 10, fontSize: 12 }}>
          <span style={{ fontSize: 10, color: "var(--text3)", paddingBottom: 4 }}>FUND · tap a column to sort</span>
          {COLS.map(([k, l]) => <button key={k} onClick={() => setSort(k)} title={k === "dd" ? "Worst fall in the last 3 years" : `${l} return${k === "y1" ? "" : " per year"}`} style={{ background: "none", border: "none", padding: "0 0 4px", fontSize: 10, color: sort === k ? "var(--violet)" : "var(--text3)", fontWeight: sort === k ? 800 : 400, cursor: "pointer", textAlign: "right", minHeight: 28 }}>{l}{sort === k ? " ▾" : ""}</button>)}
          <span style={{ fontSize: 10.5, color: "var(--text3)", borderTop: "1px solid var(--border)", padding: "5px 0" }}>Category average</span>
          {COLS.map(([k]) => <span key={k} style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text3)", textAlign: "right", borderTop: "1px solid var(--border)", padding: "5px 0" }}>{avg(k) != null ? pctTxt(avg(k)) : "—"}</span>)}
          {bench && <>
            <button onClick={() => onOpen(bench.code)} style={{ textAlign: "left", background: "none", border: "none", borderTop: "1px solid var(--border)", padding: "5px 0", color: "var(--violet)", cursor: "pointer", fontSize: 10.5, fontWeight: 700 }} title={bench.name}>{bench.index} index fund — the bar to beat</button>
            {COLS.map(([k]) => <span key={k} style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--violet)", fontWeight: 700, textAlign: "right", borderTop: "1px solid var(--border)", padding: "5px 0" }}>{k === "dd" ? (bench.dd != null ? `${bench.dd}%` : "—") : bench.ret?.[k] != null ? pctTxt(bench.ret[k]) : "—"}</span>)}
          </>}
          {sorted.slice(0, 80).map((r, i) => (
            <Fragment key={r.code}>
              <button onClick={() => onOpen(r.code)} style={{ textAlign: "left", background: "none", border: "none", borderTop: "1px solid var(--border)", padding: "6px 0", color: "var(--text)", cursor: "pointer", minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><span style={{ color: "var(--text3)", fontFamily: "var(--mono)", marginRight: 4 }}>{i + 1}</span>{r.name}</span>
                <span style={{ display: "block", fontSize: 10, color: "var(--text3)" }}>{r.house.replace(/ Mutual Fund$/, "")}{r.y5 == null && r.since ? ` · since ${r.since.slice(0, 4)}` : ""}</span>
              </button>
              {COLS.map(([k]) => <span key={k} style={{ fontFamily: "var(--mono)", fontSize: 11.5, textAlign: "right", color: k === "dd" ? C.neg : beatCol(r, k) || pctCol(r[k]), fontWeight: beatCol(r, k) ? 700 : 400, borderTop: "1px solid var(--border)", padding: "6px 0", alignSelf: "center" }}>{r[k] != null ? (k === "dd" ? `${r[k]}%` : pctTxt(r[k])) : "—"}</span>)}
            </Fragment>
          ))}
        </div>
      )}
      {sorted.length > 80 && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>Top 80 of {sorted.length} by the chosen column — search to find any other.</div>}
      {bench && (tally("y3") || tally("y5")) && (
        <div style={{ fontSize: 11.5, color: "var(--text2)", marginTop: 8, lineHeight: 1.5, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          vs the {bench.index} index fund — {tally("y3") && <><b>{tally("y3")[0]} of {tally("y3")[1]}</b> beat it over 3 years</>}{tally("y3") && tally("y5") ? ", " : ""}{tally("y5") && <><b>{tally("y5")[0]} of {tally("y5")[1]}</b> over 5 years</>}. Green = beat the index fund, red = lagged it.
        </div>
      )}
    </div>
  );
}

/** Did this fund beat the cheap index fund for its category? */
function FundVsIndex({ d, code }) {
  const b = useMfBench(d.cat);
  if (!b || b.code === code) return null;
  const rows = [["1Y", "y1"], ["3Y/yr", "y3"], ["5Y/yr", "y5"]].filter(([, k]) => d.ret[k] != null && b.ret[k] != null);
  if (!rows.length) return null;
  const main = rows.find(([, k]) => k === "y5") || rows.find(([, k]) => k === "y3") || rows[0];
  const gap = d.ret[main[1]] - b.ret[main[1]];
  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.08em", marginBottom: 4 }}>VS THE {b.index.toUpperCase()} INDEX FUND</div>
      <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 1fr 1fr", gap: 6, fontSize: 11.5, fontFamily: "var(--mono)" }}>
        <span /><span style={{ fontSize: 9.5, color: "var(--text3)" }}>THIS FUND</span><span style={{ fontSize: 9.5, color: "var(--text3)" }}>INDEX FUND</span><span style={{ fontSize: 9.5, color: "var(--text3)" }}>DIFFERENCE</span>
        {rows.map(([l, k]) => { const g = d.ret[k] - b.ret[k]; return (
          <Fragment key={k}><span style={{ color: "var(--text2)", fontFamily: "var(--body)" }}>{l}</span><span style={{ color: pctCol(d.ret[k]) }}>{pctTxt(d.ret[k])}</span><span style={{ color: "var(--text2)" }}>{pctTxt(b.ret[k])}</span><span style={{ color: g >= 0 ? C.pos : C.neg, fontWeight: 700 }}>{g >= 0 ? "+" : ""}{g.toFixed(1)} pts</span></Fragment>
        ); })}
      </div>
      <div style={{ fontSize: 11, color: gap >= 0 ? C.pos : C.warn, marginTop: 6, lineHeight: 1.45 }}>
        {gap >= 0 ? `Beat a plain ${b.index} index fund by ${gap.toFixed(1)} pts a year over ${main[0].replace("/yr", "")} — the active management earned its fee.`
          : `Trailed a plain ${b.index} index fund by ${Math.abs(gap).toFixed(1)} pts a year over ${main[0].replace("/yr", "")} — an index fund would have done better.`}
        <span style={{ color: "var(--text3)" }}> (index fund: {b.name})</span>
      </div>
    </div>
  );
}

function FundPage({ code, onBack }) {
  const [d, setD] = useState(null), [err, setErr] = useState(null);
  const [range, setRange] = useState(3);
  const [watch, toggleWatch] = useMfWatch();
  useEffect(() => { let alive = true; setD(null); setErr(null); loadMfFund(code).then(x => alive && setD(x)).catch(e => alive && setErr(e.message)); return () => { alive = false; }; }, [code]);
  const back = <button onClick={onBack} className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12, marginBottom: 12 }}>‹ Back</button>;
  if (err) return <div className="fade-in" style={{ padding: "16px 16px 120px" }}>{back}<div className="card" style={{ color: "var(--red)", fontSize: 13 }}>{err}</div></div>;
  if (!d) return <div className="fade-in" style={{ padding: "16px 16px 120px" }}>{back}<div className="card"><Skeleton lines={8} /></div></div>;
  const name = (d.meta?.scheme_name || "").replace(/\s*-\s*direct.*$/i, "") || `Fund ${code}`;
  const catAvg = (() => { const c = d.cat && _mfCat.get(d.cat); if (!c?.rows?.length) return null; const a = (k) => { const xs = c.rows.map(r => r[k]).filter(v => v != null); return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null; }; const rk = (k) => { const xs = c.rows.filter(r => r[k] != null).sort((x, y) => y[k] - x[k]); const i = xs.findIndex(r => r.code === code); return i >= 0 ? [i + 1, xs.length] : null; }; return { y1: a("y1"), y3: a("y3"), y5: a("y5"), r3: rk("y3"), r1: rk("y1") }; })();
  const R = d.ret;
  const grid = [["1W", R.w1], ["1M", R.m1], ["3M", R.m3], ["6M", R.m6], ["YTD", R.ytd], ["1Y", R.y1], ["3Y/yr", R.y3], ["5Y/yr", R.y5], ["10Y/yr", R.y10], ["Since start/yr", R.inception]];
  // chart
  const cut = new Date(Date.parse(d.date) - range * 365.25 * 864e5).toISOString().slice(0, 10);
  const pts = d.series.filter(p => p[0] >= cut);
  const W = 340, H = 130, padL = 4, padR = 40, padT = 6;
  const lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1])), sp = hi - lo || 1;
  const x = (i) => padL + (i / Math.max(1, pts.length - 1)) * (W - padL - padR), y = (v) => padT + (1 - (v - lo) / sp) * (H - padT - 4);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const chgRange = pts.length > 1 ? (pts[pts.length - 1][1] / pts[0][1] - 1) * 100 : null;
  const lineCol = chgRange == null ? "var(--text)" : chgRange >= 0 ? C.pos : C.neg;
  const watching = watch.includes(code);
  const box = (k, v, sub) => (
    <div style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 8px", minWidth: 0 }}>
      <div style={{ fontSize: 9.5, color: "var(--text3)", letterSpacing: "0.06em" }}>{k}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700, color: pctCol(v) }}>{pctTxt(v)}</div>
      {sub && <div style={{ fontSize: 9.5, color: "var(--text3)" }}>{sub}</div>}
    </div>
  );
  const yrs = Math.max(1, ...d.years.map(([, v]) => Math.abs(v ?? 0)));
  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      {back}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontFamily: "var(--display)", fontSize: 20, lineHeight: 1.2 }}>{name}</div>
        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 3 }}>{d.meta?.fund_house} · {d.cat?.split(" · ")[1] || d.meta?.scheme_category} · Direct · Growth</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 24, fontWeight: 700 }}>₹{d.nav.toLocaleString("en-IN", { maximumFractionDigits: 4 })}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: pctCol(d.chg) }}>{pctTxt(d.chg, 2)}</span>
          <span style={{ fontSize: 11, color: "var(--text3)" }}>NAV {mqFmtDate(d.date)} (prev {mqFmtDate(d.prevDate)})</span>
        </div>
        <button className="chip" aria-pressed={watching} onClick={() => toggleWatch(code)} style={{ marginTop: 10 }}>{watching ? "★ Tracking" : "☆ Track this fund"}</button>

        <div style={{ display: "flex", gap: 6, margin: "14px 0 6px" }}>
          {[1, 3, 5, 10].map(n => <button key={n} className="chip chip-sm" aria-pressed={range === n} onClick={() => setRange(n)}>{n}Y</button>)}
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: pctCol(chgRange), alignSelf: "center" }}>{pctTxt(chgRange)}</span>
        </div>
        {pts.length > 1 && (
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img" aria-label={`${name} NAV over ${range} years`}>
            {[lo, (lo + hi) / 2, hi].map((t, k) => <g key={k}><line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" /><text x={W - padR + 4} y={y(t) + 3} fontSize="9" fill="var(--text3)" fontFamily="var(--mono)">{t >= 1000 ? t.toFixed(0) : t.toFixed(1)}</text></g>)}
            <path d={path} fill="none" stroke={lineCol} strokeWidth="1.8" strokeLinejoin="round" />
          </svg>
        )}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Returns</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 6 }}>
          {grid.map(([k, v]) => box(k, v))}
        </div>
        {catAvg && (
          <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 8, lineHeight: 1.5 }}>
            Category average: 1Y {pctTxt(catAvg.y1)} · 3Y {pctTxt(catAvg.y3)}/yr · 5Y {pctTxt(catAvg.y5)}/yr
            {catAvg.r3 && <> · ranks <b>#{catAvg.r3[0]} of {catAvg.r3[1]}</b> on 3-year return</>}
          </div>
        )}
        {!catAvg && d.cat && <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 8 }}>Open its category in Funds to see how it ranks against peers.</div>}
        <FundVsIndex d={d} code={code} />
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Risk & consistency</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12 }}>
          <div><div style={{ fontSize: 10, color: "var(--text3)" }}>WORST FALL · 3 YEARS</div><div style={{ fontFamily: "var(--mono)", fontWeight: 700, color: C.neg }}>{d.maxDD?.pct != null ? `${d.maxDD.pct}%` : "—"}</div>{d.maxDD?.from && <div style={{ fontSize: 10, color: "var(--text3)" }}>{mqFmtDate(d.maxDD.from)} {d.maxDD.from.slice(0, 4)} → {mqFmtDate(d.maxDD.to)} {d.maxDD.to.slice(0, 4)}</div>}</div>
          <div><div style={{ fontSize: 10, color: "var(--text3)" }}>VOLATILITY · 1 YEAR</div><div style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{d.vol != null ? `${d.vol}%` : "—"}</div><div style={{ fontSize: 10, color: "var(--text3)" }}>{d.vol == null ? "" : d.vol < 8 ? "low" : d.vol < 16 ? "moderate" : "high"} — how much it swings</div></div>
        </div>
        {d.rolling && (
          <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text2)", lineHeight: 1.5 }}>
            Every 1-year holding period in the last 3 years: worst <b style={{ color: pctCol(d.rolling.min) }}>{pctTxt(d.rolling.min)}</b>, typical <b>{pctTxt(d.rolling.median)}</b>, best <b style={{ color: pctCol(d.rolling.max) }}>{pctTxt(d.rolling.max)}</b> — positive {d.rolling.pos}% of the time.
          </div>
        )}
        {d.years?.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 4 }}>CALENDAR YEARS</div>
            {d.years.map(([yr, v]) => (
              <div key={yr} style={{ display: "grid", gridTemplateColumns: "40px 1fr 1fr 52px", alignItems: "center", gap: 4, fontSize: 11, margin: "2px 0" }}>
                <span style={{ color: "var(--text2)", fontFamily: "var(--mono)" }}>{yr}</span>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>{v < 0 && <div style={{ width: `${(Math.abs(v) / yrs) * 100}%`, height: 9, background: C.neg, borderRadius: "5px 0 0 5px" }} />}</div>
                <div style={{ borderLeft: "1px solid var(--text3)" }}>{v > 0 && <div style={{ width: `${(v / yrs) * 100}%`, height: 9, background: C.pos, borderRadius: "0 5px 5px 0" }} />}</div>
                <span style={{ fontFamily: "var(--mono)", textAlign: "right", color: pctCol(v) }}>{pctTxt(v)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>SIP of ₹10,000 a month</div>
        {[["1 year", d.sip?.y1], ["3 years", d.sip?.y3], ["5 years", d.sip?.y5]].filter(([, s]) => s).map(([l, s]) => (
          <div key={l} style={{ display: "grid", gridTemplateColumns: "64px 1fr auto", gap: 8, alignItems: "baseline", fontSize: 12, borderTop: "1px solid var(--border)", padding: "6px 0" }}>
            <span style={{ color: "var(--text2)" }}>{l}</span>
            <span style={{ fontFamily: "var(--mono)" }}>{formatINR(s.invested)} → <b style={{ color: s.value >= s.invested ? C.pos : C.neg }}>{formatINR(s.value)}</b></span>
            <span style={{ fontFamily: "var(--mono)", color: pctCol(s.xirr) }}>{pctTxt(s.xirr)}/yr</span>
          </div>
        ))}
        <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>Invested on the first NAV day of each month; /yr is the XIRR (annual return on a SIP).</div>
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", lineHeight: 1.5 }}>NAV from AMFI; history since {mqFmtDate(d.since)} {d.since?.slice(0, 4)} from mfapi.in. Returns exclude exit loads and taxes. Information, not advice.</div>
    </div>
  );
}

// ─── MUTUAL FUND PORTFOLIO (synced with the rest of your data) ───────────────
const MF_HOLD_KEY = "td_mf_holdings";
function readHoldings() { try { return JSON.parse(localStorage.getItem(MF_HOLD_KEY) || "[]"); } catch (_) { return []; } }
function useMfHoldings() {
  const [h, setH] = useState(readHoldings);
  useEffect(() => { const on = () => setH(readHoldings()); window.addEventListener("td_mf_holdings", on); return () => window.removeEventListener("td_mf_holdings", on); }, []);
  const save = (next) => {
    setH(next);
    if (_mfSync) _mfSync.setHoldings(next); // synced snapshot → writes td_mf_holdings and notifies
    else { try { localStorage.setItem(MF_HOLD_KEY, JSON.stringify(next)); } catch (_) {} window.dispatchEvent(new Event("td_mf_holdings")); }
  };
  return [h, save];
}
const _mfFull = new Map();
function loadMfFull(code) {
  if (!_mfFull.has(code)) _mfFull.set(code, fetch(`/api/mf?type=fund&code=${code}&full=1`).then(r => (r.ok ? r.json() : Promise.reject(new Error("NAV history unavailable")))).catch(e => { _mfFull.delete(code); throw e; }));
  return _mfFull.get(code);
}
/** First NAV on or after a date (purchases settle at that day's NAV). */
function navOnOrAfter(navs, day) {
  let lo = 0, hi = navs.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (navs[m][0] >= day) { k = m; hi = m - 1; } else lo = m + 1; }
  return k >= 0 ? navs[k] : null;
}
function xirr(flows) { // flows: [[ms, amount]] (investments negative, value positive)
  if (flows.length < 2 || !flows.some(f => f[1] < 0) || !flows.some(f => f[1] > 0)) return null;
  const t0 = Math.min(...flows.map(f => f[0]));
  const npv = (r) => flows.reduce((a, [ms, cf]) => a + cf / Math.pow(1 + r, (ms - t0) / (365.25 * 864e5)), 0);
  let lo = -0.99, hi = 10; if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 120; i++) { const mid = (lo + hi) / 2; if (npv(mid) > 0) lo = mid; else hi = mid; }
  return Math.round(((lo + hi) / 2) * 1000) / 10;
}
/** A holding's units, money in, cash flows — from its NAV history. */
function evalHolding(h, f) {
  const navs = f.navs || [], last = navs[navs.length - 1], prev = navs[navs.length - 2];
  if (!last) return null;
  let units = 0, invested = 0; const flows = [];
  const ms = (d) => Date.parse(d + "T00:00:00Z");
  if (h.kind === "units") {
    units = +h.units || 0; invested = +h.invested || 0;
    if (h.date && invested > 0) flows.push([ms(h.date), -invested]);
  } else if (h.kind === "lump") {
    const p = navOnOrAfter(navs, h.date); if (!p) return { error: "date is after the latest NAV" };
    units = (+h.amount || 0) / p[1]; invested = +h.amount || 0; flows.push([ms(p[0]), -invested]);
  } else if (h.kind === "sip") {
    const day = Math.min(28, Math.max(1, +h.day || +String(h.date).slice(8, 10) || 1));
    let [y, m] = [+h.date.slice(0, 4), +h.date.slice(5, 7)];
    const end = h.end && h.end < last[0] ? h.end : last[0];
    for (let guard = 0; guard < 600; guard++) {
      const want = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (want > end) break;
      if (want >= h.date) {
        const p = navOnOrAfter(navs, want);
        if (!p || p[0] > last[0]) break;
        units += (+h.amount || 0) / p[1]; invested += +h.amount || 0; flows.push([ms(p[0]), -(+h.amount || 0)]);
      }
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  const value = units * last[1];
  return { units, invested, value, nav: last[1], date: last[0], dayChg: prev ? units * (last[1] - prev[1]) : 0, flows, xirr: xirr([...flows, [ms(last[0]), value]]) };
}
/** Correlation of daily NAV moves over the last year, on shared dates. */
function navCorr(a, b) {
  const cut = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const mb = new Map(b.filter(x => x[0] >= cut).map(x => [x[0], x[1]]));
  const ra = [], rb = []; let pa = null, pb = null;
  for (const [d, v] of a) {
    if (d < cut || !mb.has(d)) continue;
    const w = mb.get(d);
    if (pa != null) { ra.push(v / pa - 1); rb.push(w / pb - 1); }
    pa = v; pb = w;
  }
  if (ra.length < 60) return null;
  const n = ra.length, ma = ra.reduce((x, y) => x + y, 0) / n, mbm = rb.reduce((x, y) => x + y, 0) / n;
  let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { s += (ra[i] - ma) * (rb[i] - mbm); sa += (ra[i] - ma) ** 2; sb += (rb[i] - mbm) ** 2; }
  return sa && sb ? s / Math.sqrt(sa * sb) : null;
}

function MfPortfolio({ list, onOpenFund }) {
  const [holdings, save] = useMfHoldings();
  const [full, setFull] = useState({});
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  useEffect(() => {
    let alive = true;
    for (const h of holdings) if (!full[h.code]) loadMfFull(h.code).then(f => alive && setFull(x => ({ ...x, [h.code]: f }))).catch(e => alive && setFull(x => ({ ...x, [h.code]: { error: e.message } })));
    return () => { alive = false; };
  }, [holdings.map(h => h.code).join(",")]);
  const evals = holdings.map(h => ({ h, f: full[h.code], e: full[h.code]?.navs ? evalHolding(h, full[h.code]) : null }));
  const ready = evals.filter(x => x.e && !x.e.error);
  const tot = ready.reduce((a, { e }) => ({ value: a.value + e.value, invested: a.invested + e.invested, day: a.day + e.dayChg }), { value: 0, invested: 0, day: 0 });
  const allFlows = ready.flatMap(({ e }) => e.flows);
  const lastDay = ready.map(({ e }) => e.date).sort().pop();
  const totX = lastDay ? xirr([...allFlows, [Date.parse(lastDay + "T00:00:00Z"), tot.value]]) : null;
  const catOf = (code) => { const f = list?.funds.find(x => x[0] === code); return f ? list.cats[f[3]] : null; };
  const houseOf = (code) => list?.funds.find(x => x[0] === code)?.[2] || null;
  const loading = holdings.length > ready.length && evals.some(x => !x.f);

  return (
    <div className="card" style={{ marginBottom: 12, paddingTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div className="label">My fund portfolio</div>
        <button className="chip chip-sm" onClick={() => { setAdding(v => !v); setEditId(null); }}>{adding ? "Close" : "+ Add holding"}</button>
      </div>
      {adding && <MfHoldingForm list={list} onSave={(h) => { save([...holdings, h]); setAdding(false); }} />}
      {!holdings.length && !adding && <div style={{ fontSize: 12, color: "var(--text3)", padding: "8px 0", lineHeight: 1.5 }}>Add the funds you own — units from your statement, a lump sum, or a monthly SIP — to see their value, returns, mix and overlap. Saved and backed up like your trades.</div>}
      {holdings.length > 0 && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "10px 0" }}>
            <div><div style={{ fontSize: 10, color: "var(--text3)" }}>VALUE</div><div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 700 }}>{formatINR(Math.round(tot.value))}</div>
              <div style={{ fontSize: 11, color: pctCol(tot.day) }}>{tot.day >= 0 ? "+" : ""}{formatINR(Math.round(tot.day))} today{lastDay ? ` · NAV ${mqFmtDate(lastDay)}` : ""}</div></div>
            <div><div style={{ fontSize: 10, color: "var(--text3)" }}>GAIN</div><div style={{ fontFamily: "var(--mono)", fontSize: 16, fontWeight: 700, color: pctCol(tot.value - tot.invested) }}>{tot.value - tot.invested >= 0 ? "+" : ""}{formatINR(Math.round(tot.value - tot.invested))}</div>
              <div style={{ fontSize: 11, color: "var(--text2)" }}>on {formatINR(Math.round(tot.invested))}{tot.invested ? ` (${pctTxt(((tot.value / tot.invested) - 1) * 100)})` : ""}{totX != null ? ` · XIRR ${pctTxt(totX)}` : ""}</div></div>
          </div>
          {loading && <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 6 }}>Loading NAV histories…</div>}
          {evals.map(({ h, f, e }) => (
            <div key={h.id} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <button onClick={() => onOpenFund(h.code)} style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", padding: 0, color: "var(--text)", cursor: "pointer", fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.name}</button>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{e && !e.error ? formatINR(Math.round(e.value)) : f?.error ? "—" : "…"}</span>
              </div>
              <div style={{ display: "flex", gap: 8, fontSize: 10.5, color: "var(--text3)", marginTop: 2, flexWrap: "wrap", alignItems: "center" }}>
                <span>{h.kind === "sip" ? `SIP ₹${(+h.amount).toLocaleString("en-IN")}/mo since ${mqFmtDate(h.date)} ${h.date.slice(0, 4)}` : h.kind === "lump" ? `₹${(+h.amount).toLocaleString("en-IN")} on ${mqFmtDate(h.date)} ${h.date.slice(0, 4)}` : `${(+h.units).toLocaleString("en-IN", { maximumFractionDigits: 3 })} units`}</span>
                {e && !e.error && <span style={{ color: pctCol(e.value - e.invested) }}>{e.invested ? pctTxt(((e.value / e.invested) - 1) * 100) : ""}{e.xirr != null ? ` · XIRR ${pctTxt(e.xirr)}` : ""}</span>}
                {(e?.error || f?.error) && <span style={{ color: C.warn }}>{e?.error || f.error}</span>}
                <span style={{ flex: 1 }} />
                <button className="chip chip-sm" onClick={() => setEditId(editId === h.id ? null : h.id)}>{editId === h.id ? "Close" : "Edit"}</button>
              </div>
              {editId === h.id && <MfHoldingForm list={list} initial={h} onSave={(nh) => { save(holdings.map(x => (x.id === h.id ? { ...nh, id: h.id } : x))); setEditId(null); }}
                onDelete={() => { if (confirm(`Remove ${h.name} from your portfolio?`)) { save(holdings.filter(x => x.id !== h.id)); setEditId(null); } }} />}
            </div>
          ))}
          {ready.length > 0 && <MfAllocation ready={ready} catOf={catOf} houseOf={houseOf} total={tot.value} />}
          {ready.length > 1 && <MfOverlap ready={ready} catOf={catOf} />}
        </>
      )}
    </div>
  );
}

function MfHoldingForm({ list, initial, onSave, onDelete }) {
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const [fund, setFund] = useState(initial ? { code: initial.code, name: initial.name } : null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState(initial?.kind || "sip");
  const [v, setV] = useState({ units: initial?.units ?? "", invested: initial?.invested ?? "", amount: initial?.amount ?? "", date: initial?.date ?? "", day: initial?.day ?? "", end: initial?.end ?? "" });
  const set = (k) => (e) => setV(x => ({ ...x, [k]: e.target.value }));
  const ql = q.trim().toLowerCase();
  const hits = !fund && ql.length >= 2 && list ? list.funds.filter(f => f[1].toLowerCase().includes(ql) || f[2].toLowerCase().includes(ql)).slice(0, 8) : [];
  const ok = fund && (kind === "units" ? +v.units > 0 : +v.amount > 0 && v.date && v.date <= today);
  const field = (k, label, type = "number", extra = {}) => (
    <label style={{ display: "block", fontSize: 10.5, color: "var(--text3)" }}>{label}
      <input type={type} value={v[k]} onChange={set(k)} style={{ width: "100%", marginTop: 3 }} {...extra} />
    </label>
  );
  return (
    <div style={{ border: "1px dashed var(--border2)", borderRadius: 10, padding: 10, margin: "8px 0", display: "grid", gap: 8 }}>
      {fund ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{fund.name}</span>
          {!initial && <button className="chip chip-sm" onClick={() => setFund(null)}>Change</button>}
        </div>
      ) : (
        <div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search the fund you hold" aria-label="Search fund to add" style={{ width: "100%" }} />
          {hits.map(f => <button key={f[0]} onClick={() => { setFund({ code: f[0], name: f[1] }); setQ(""); }} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderTop: "1px solid var(--border)", padding: "7px 0", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>{f[1]} <span style={{ color: "var(--text3)", fontSize: 10.5 }}>· {f[2].replace(/ Mutual Fund$/, "")}</span></button>)}
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        {[["sip", "Monthly SIP"], ["lump", "Lump sum"], ["units", "Units I hold"]].map(([k, l]) => <button key={k} className="chip chip-sm" aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}
      </div>
      {kind === "sip" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {field("amount", "₹ per month")}{field("date", "Started on", "date", { max: today })}
        {field("day", "Debit day (1–28)", "number", { min: 1, max: 28, placeholder: "same as start" })}{field("end", "Stopped on (optional)", "date", { max: today })}
      </div>}
      {kind === "lump" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>{field("amount", "₹ invested")}{field("date", "Invested on", "date", { max: today })}</div>}
      {kind === "units" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {field("units", "Units (from your statement)")}{field("invested", "Total ₹ invested (optional)")}
        {field("date", "First investment date (optional, for XIRR)", "date", { max: today })}
      </div>}
      <div style={{ fontSize: 10, color: "var(--text3)" }}>{kind === "units" ? "Most accurate: copy units from your CAS / AMC statement." : "Units are worked out from the NAV on each purchase day (the first NAV on or after it). Stamp duty and exit loads are ignored."}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn-primary" disabled={!ok} style={{ flex: 1, padding: "10px", fontSize: 13, opacity: ok ? 1 : 0.5 }}
          onClick={() => onSave({ id: initial?.id || Date.now(), code: fund.code, name: fund.name, kind, ...(kind === "units" ? { units: +v.units, invested: +v.invested || 0, date: v.date || null } : { amount: +v.amount, date: v.date, ...(kind === "sip" ? { day: +v.day || null, end: v.end || null } : {}) }) })}>{initial ? "Save" : "Add to portfolio"}</button>
        {onDelete && <button className="btn-ghost" style={{ padding: "10px 14px", fontSize: 13, color: C.neg }} onClick={onDelete}>Remove</button>}
      </div>
    </div>
  );
}

function MfAllocation({ ready, catOf, houseOf, total }) {
  const by = (fn) => { const m = {}; for (const { h, e } of ready) { const k = fn(h.code) || "Unknown"; m[k] = (m[k] || 0) + e.value; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const groups = by(c => catOf(c)?.split(" · ")[0]), cats = by(c => catOf(c)?.split(" · ")[1]), houses = by(c => houseOf(c)?.replace(/ Mutual Fund$/, ""));
  const GC = { Equity: "#3B82F6", Hybrid: C.lime, Debt: "#A06CD5", Index: "#0EA5E9", ETF: "#D9632B", Solution: C.warn, Other: C.muted, Unknown: C.muted };
  const pc = (v) => Math.round((v / (total || 1)) * 100);
  const notes = [];
  if (houses[0] && pc(houses[0][1]) >= 50 && houses.length > 1) notes.push(`${pc(houses[0][1])}% sits with one fund house (${houses[0][0]}).`);
  const smid = cats.filter(([k]) => /small|mid/i.test(k)).reduce((a, [, v]) => a + v, 0);
  if (pc(smid) >= 40) notes.push(`${pc(smid)}% is in small / mid-cap funds — expect bigger swings.`);
  const sect = cats.find(([k]) => /sectoral/i.test(k));
  if (sect && pc(sect[1]) >= 25) notes.push(`${pc(sect[1])}% is in sector / theme funds — concentrated bets.`);
  return (
    <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 10 }}>
      <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.08em", marginBottom: 6 }}>MIX</div>
      <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden", marginBottom: 6 }}>
        {groups.map(([k, v]) => <div key={k} title={`${k} ${pc(v)}%`} style={{ width: `${(v / total) * 100}%`, background: GC[k] || C.muted }} />)}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11, color: "var(--text2)", marginBottom: 8 }}>
        {groups.map(([k, v]) => <span key={k}><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: GC[k] || C.muted, marginRight: 4 }} />{k} {pc(v)}%</span>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 11 }}>
        <div><div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 3 }}>BY CATEGORY</div>{cats.slice(0, 6).map(([k, v]) => <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><span style={{ color: "var(--text2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{k}</span><span style={{ fontFamily: "var(--mono)" }}>{pc(v)}%</span></div>)}</div>
        <div><div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 3 }}>BY FUND HOUSE</div>{houses.slice(0, 6).map(([k, v]) => <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}><span style={{ color: "var(--text2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{k}</span><span style={{ fontFamily: "var(--mono)" }}>{pc(v)}%</span></div>)}</div>
      </div>
      {notes.map((n, i) => <div key={i} style={{ fontSize: 11, color: C.warn, marginTop: 6 }}>⚠ {n}</div>)}
    </div>
  );
}

function MfOverlap({ ready, catOf }) {
  const funds = ready.filter(x => x.f?.navs?.length);
  const pairs = [];
  for (let i = 0; i < funds.length; i++) for (let j = i + 1; j < funds.length; j++) {
    const r = navCorr(funds[i].f.navs, funds[j].f.navs);
    pairs.push({ a: funds[i].h, b: funds[j].h, r, sameCat: catOf(funds[i].h.code) && catOf(funds[i].h.code) === catOf(funds[j].h.code) });
  }
  const level = (r) => (r == null ? null : r >= 0.95 ? ["Moves almost the same", C.neg] : r >= 0.85 ? ["Very similar", C.warn] : r >= 0.6 ? ["Partly similar", "var(--text2)"] : ["Different", C.pos]);
  const shown = pairs.filter(p => p.r != null).sort((x, y) => y.r - x.r);
  const dup = shown.filter(p => p.r >= 0.95 || p.sameCat);
  const short = (n) => n.replace(/\s+Fund$/i, "").replace(/\s+(Direct|Plan|Growth).*$/i, "");
  const n = funds.length;
  return (
    <div style={{ borderTop: "1px solid var(--border)", marginTop: 10, paddingTop: 10 }}>
      <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.08em", marginBottom: 4 }}>OVERLAP · HOW ALIKE YOUR FUNDS ARE</div>
      <div style={{ fontSize: 10.5, color: "var(--text3)", marginBottom: 8, lineHeight: 1.45 }}>From how their daily NAVs moved together over the last year (1.00 = identical). Funds that move almost the same usually hold the same big stocks, so owning both adds little diversification. Holdings themselves aren't published daily, so this uses NAV moves.</div>
      {n <= 6 && (
        <div style={{ display: "grid", gridTemplateColumns: `90px repeat(${n}, minmax(0, 1fr))`, gap: 2, fontSize: 10, marginBottom: 8 }}>
          <span />
          {funds.map(x => <span key={x.h.id} title={x.h.name} style={{ color: "var(--text3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "center" }}>{short(x.h.name).split(" ")[0]}</span>)}
          {funds.map((x, i) => (
            <Fragment key={x.h.id}>
              <span title={x.h.name} style={{ color: "var(--text2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{short(x.h.name)}</span>
              {funds.map((y, j) => {
                const r = i === j ? 1 : pairs.find(p => (p.a === x.h && p.b === y.h) || (p.a === y.h && p.b === x.h))?.r;
                const c = i === j ? "var(--bg3)" : r == null ? "var(--bg3)" : r >= 0.95 ? `${C.neg}55` : r >= 0.85 ? `${C.warn}44` : r >= 0.6 ? "var(--bg3)" : `${C.pos}33`;
                return <span key={y.h.id} style={{ background: c, borderRadius: 4, textAlign: "center", padding: "4px 0", fontFamily: "var(--mono)", color: "var(--text)" }}>{i === j ? "—" : r == null ? "?" : r.toFixed(2)}</span>;
              })}
            </Fragment>
          ))}
        </div>
      )}
      {shown.slice(0, 8).map((p, i) => { const L = level(p.r); return (
        <div key={i} style={{ display: "flex", gap: 8, fontSize: 11, padding: "3px 0", alignItems: "baseline" }}>
          <span style={{ flex: 1, minWidth: 0, color: "var(--text2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{short(p.a.name)} ↔ {short(p.b.name)}</span>
          <span style={{ color: L[1], whiteSpace: "nowrap" }}>{L[0]}{p.sameCat ? " · same category" : ""}</span>
          <span style={{ fontFamily: "var(--mono)" }}>{p.r.toFixed(2)}</span>
        </div>
      ); })}
      {dup.length > 0
        ? <div style={{ fontSize: 11, color: C.warn, marginTop: 6, lineHeight: 1.45 }}>⚠ {dup.length === 1 ? "One pair is" : `${dup.length} pairs are`} close to duplicates — consider keeping the better of each pair (lower cost, steadier record) instead of both.</div>
        : <div style={{ fontSize: 11, color: C.pos, marginTop: 6 }}>No near-duplicates — your funds behave differently enough to diversify each other.</div>}
    </div>
  );
}

// QUAD sector → words in fund names (sector / thematic funds and sector index funds)
const SECTOR_FUND_RE = {
  Financials: /bank|financial|bfsi|psu bank/i, IT: /technology|digital|\bit\b|tech\b/i, Healthcare: /pharma|health/i,
  Auto: /\bauto|transport|mobility|\bev\b/i, FMCG: /fmcg|consumption/i, "Consumer Services": /consumption|consumer/i, "Consumer Durables": /consumption|consumer/i,
  "Capital Goods": /manufactur|infra|capital goods|industr/i, Construction: /infra|construction/i, Power: /power|energy|utilit/i, Utilities: /power|energy|utilit/i,
  "Oil & Gas": /energy|oil/i, Metals: /commodit|metal|mining/i, Realty: /realty|housing|real estate/i, Chemicals: /chemical/i,
  Telecommunication: /telecom|digital/i, Media: /media|entertain/i, "Cement & Materials": /infra|commodit|material/i,
};
/** QUAD: sector / thematic funds for the sectors leading right now. */
function MqSectorFunds({ sectors }) {
  const { data: list } = useMfList();
  const [stats, setStats] = useState({});
  const leading = (sectors || []).filter(x => ["HOT", "WARM"].includes(x.status) && SECTOR_FUND_RE[x.name]).slice(0, 3);
  const pick = (sec) => {
    if (!list) return [];
    const ok = new Set(["Equity · Sectoral / Thematic", "Index · Equity"].map(c => list.cats.indexOf(c)));
    return list.funds.filter(f => ok.has(f[3]) && SECTOR_FUND_RE[sec].test(f[1]) && !/etf|fof|elss/i.test(f[1])).slice(0, 12);
  };
  const want = leading.flatMap(x => pick(x.name).map(f => f[0]));
  useEffect(() => {
    let alive = true, i = 0;
    const todo = want.filter(c => !stats[c]);
    Promise.all([0, 1, 2].map(async () => { while (alive && i < todo.length) { const c = todo[i++]; try { const d = await loadMfFund(c); if (alive) setStats(s => ({ ...s, [c]: d })); } catch (_) {} } }));
    return () => { alive = false; };
  }, [want.join(",")]);
  if (!leading.length) return null;
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>FUNDS FOR THE LEADING SECTORS</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8, lineHeight: 1.45 }}>If you'd rather own the whole theme than pick one stock: sector and thematic funds (and sector index funds) matching today's strongest sectors, by 1-year return. Sector funds swing much more than diversified ones — size them as a satellite, not the core.</div>
      {!list ? <Skeleton lines={4} /> : leading.map(sec => {
        const funds = pick(sec.name).map(f => ({ f, st: stats[f[0]] })).filter(x => x.st).sort((a, b) => (b.st.ret.y1 ?? -99) - (a.st.ret.y1 ?? -99)).slice(0, 4);
        return (
          <div key={sec.name} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>{sec.name} <span style={{ color: MQ_DIM_COLOR[sec.status], fontSize: 10.5 }}>· {sec.status} · {sec.p50}% above 50-day</span></div>
            {!funds.length ? <div style={{ fontSize: 11, color: "var(--text3)" }}>{pick(sec.name).length ? "Loading funds…" : "No matching sector funds."}</div> : funds.map(({ f, st }) => (
              <div key={f[0]} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, fontSize: 11.5, borderTop: "1px solid var(--border)", padding: "5px 0", alignItems: "baseline" }}>
                <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--text2)" }}>{f[1]}</span>
                <span style={{ fontFamily: "var(--mono)", color: pctCol(st.ret.y1) }}>1Y {pctTxt(st.ret.y1)}</span>
                <span style={{ fontFamily: "var(--mono)", color: pctCol(st.ret.y3), minWidth: 62, textAlign: "right" }}>{st.ret.y3 != null ? `3Y ${pctTxt(st.ret.y3)}` : `since ${st.since.slice(0, 4)}`}</span>
              </div>
            ))}
          </div>
        );
      })}
      <div style={{ fontSize: 10, color: "var(--text3)" }}>Open Funds to see any of these in detail. Information, not advice.</div>
    </div>
  );
}

// ─── EVENING WRAP-UP: the day in one screen ──────────────────────────────────
function WrapPage({ trades, watchlist, indices, onBack, onOpenStock, onOpenFunds, onOpenQuad }) {
  const { data: d } = useMarketQuadrant();
  const { flows, deals } = useFlowsDeals();
  const [cal, setCal] = useState(null);
  const [pos, setPos] = useState({});
  const [holdings] = useMfHoldings();
  const [port, setPort] = useState(null);
  const open = (trades || []).filter(t => t.status === "open" || t.status === "partial").map(normalizeTrade);
  const mySyms = [...new Set([...open.map(t => normalizeSymbol(t.symbol)), ...(watchlist || []).map(w => w.sym)])];
  useEffect(() => { let alive = true; fetchResultsCalendar().then(c => alive && setCal(c)); return () => { alive = false; }; }, []);
  useEffect(() => {
    let alive = true;
    for (const t of open) {
      const sym = normalizeSymbol(t.symbol);
      cachedDetail(sym).then(x => {
        if (!alive || !x) return;
        const n = x.closes.length - 1, c = x.closes[n], p = x.closes[n - 1];
        setPos(s => ({ ...s, [t.id]: { c, chg: p ? (c / p - 1) * 100 : null, day: p ? (c - p) * (t.remainingQty || t.totalQty || 0) : null, date: x.dates[n], intraday: x.intraday } }));
      });
    }
    return () => { alive = false; };
  }, [open.map(t => t.id).join(",")]);
  useEffect(() => {
    let alive = true;
    if (!holdings.length) return;
    Promise.all(holdings.map(h => loadMfFull(h.code).then(f => evalHolding(h, f)).catch(() => null))).then(es => {
      const ok = es.filter(e => e && !e.error); if (!alive || !ok.length) return;
      setPort({ value: ok.reduce((a, e) => a + e.value, 0), day: ok.reduce((a, e) => a + e.dayChg, 0), date: ok.map(e => e.date).sort().pop() });
    });
    return () => { alive = false; };
  }, [JSON.stringify(holdings)]);

  const sec = (title, children, right) => (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}><div className="label">{title}</div>{right}</div>
      {children}
    </div>
  );
  const line = (k, v, c) => <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5, padding: "4px 0", borderTop: "1px solid var(--border)" }}><span style={{ color: "var(--text2)" }}>{k}</span><span style={{ fontFamily: "var(--mono)", color: c || "var(--text)", textAlign: "right" }}>{v}</span></div>;
  const idx = (x) => (x ? <>{x.price?.toLocaleString("en-IN", { maximumFractionDigits: 2 })} <span style={{ color: pctCol(x.changePct) }}>{pctTxt(x.changePct, 2)}</span></> : "—");
  const changes = d ? briefChanges(d) : [];
  const mbi = d?.mbi?.rows?.[d.mbi.rows.length - 1];
  const hotNow = (d?.sectors || []).filter(x => x.status_d1 && x.status !== x.status_d1);
  const dayPnl = Object.values(pos).reduce((a, p) => a + (p.day || 0), 0);
  const soon = cal ? mySyms.map(sym => ({ sym, r: upcomingResults(cal, sym, 3) })).filter(x => x.r).sort((a, b) => a.r.inDays - b.r.inDays) : [];
  const myDeals = (deals?.deals || []).filter(x => mySyms.includes(x.sym));
  const istDay = new Date(Date.now() + 19800000).toISOString().slice(0, 10);

  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      <button onClick={onBack} className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12, marginBottom: 12 }}>‹ Back</button>
      <div className="section-title">Day wrap</div>
      <div style={{ fontSize: 13, color: "var(--text3)", margin: "4px 0 12px" }}>{d ? `Closing picture for ${mqFmtDate(d.as_of)}${d.as_of !== istDay ? " (latest session)" : ""}` : "Loading…"}</div>

      {sec("Market", <>
        {line("Nifty 50", idx(indices?.nsei))}
        {line("Nifty 500", idx(indices?.cnx500))}
        {d && line("Signal · environment", <>{d.overall} · {d.environment?.name}</>, MQ_SIGNAL_COLOR[d.overall])}
        {d && line("Today's risk per trade", `${suggestedRisk(d)?.pct ?? 0}%`)}
        {d?.green_light?.em != null && line("Green light", `${d.green_light.em} · ${GL_TEXT[d.green_light.band]}`, GL_COLOR[d.green_light.band])}
        {mbi && line("Breadth (MBI)", `${mbi.color.toLowerCase()} day`, MBI_COLOR[mbi.color])}
        {d && line("Stocks above 50-day", `${d.pct_above_50}%`)}
        {flows?.fii && line(`FII / DII (${mqFmtDate(flows.date)})`, <><span style={{ color: flows.fii.net >= 0 ? C.pos : C.neg }}>{crore(flows.fii.net)}</span> / <span style={{ color: (flows.dii?.net ?? 0) >= 0 ? C.pos : C.neg }}>{flows.dii ? crore(flows.dii.net) : "—"}</span></>)}
        {changes.length > 0 && <div style={{ marginTop: 6 }}>{changes.slice(0, 5).map((c, i) => <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--text2)", padding: "2px 0" }}><span style={{ width: 6, height: 6, borderRadius: 3, background: c.tone, marginTop: 6, flexShrink: 0 }} /><span>{c.text}</span></div>)}</div>}
        {d?.chg_of && (() => { const e = Object.entries(d.chg_of).sort((a, b) => b[1] - a[1]); return <div style={{ fontSize: 11.5, color: "var(--text2)", marginTop: 6 }}>Biggest moves: {e.slice(0, 3).map(([k, v]) => <span key={k} style={{ color: C.pos }}>{k} {pctTxt(v)} </span>)}· {e.slice(-3).reverse().map(([k, v]) => <span key={k} style={{ color: C.neg }}>{k} {pctTxt(v)} </span>)}</div>; })()}
        {hotNow.length > 0 && <div style={{ fontSize: 11.5, color: "var(--text2)", marginTop: 6 }}>Sectors that changed: {hotNow.slice(0, 5).map(x => `${x.name} ${x.status_d1} → ${x.status}`).join(" · ")}</div>}
      </>, <button className="chip chip-sm" onClick={onOpenQuad}>QUAD ›</button>)}

      {sec("Your positions", open.length === 0 ? <div style={{ fontSize: 12, color: "var(--text3)" }}>No open positions.</div> : <>
        {Object.keys(pos).length > 0 && <div style={{ fontSize: 13, marginBottom: 4 }}>Today: <b style={{ fontFamily: "var(--mono)", color: pctCol(dayPnl) }}>{dayPnl >= 0 ? "+" : ""}{formatINR(Math.round(dayPnl))}</b></div>}
        {open.map(t => { const p = pos[t.id], sym = normalizeSymbol(t.symbol); return (
          <div key={t.id} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, fontSize: 12.5, borderTop: "1px solid var(--border)", padding: "6px 0", alignItems: "baseline" }}>
            <button onClick={() => onOpenStock(sym)} style={{ textAlign: "left", background: "none", border: "none", padding: 0, color: "var(--text)", fontWeight: 700, cursor: "pointer" }}>{sym}</button>
            <span style={{ fontFamily: "var(--mono)", color: pctCol(p?.chg) }}>{p ? pctTxt(p.chg, 2) : "…"}</span>
            <span style={{ fontFamily: "var(--mono)", color: pctCol(p ? (p.c / t.avgEntry - 1) : null), minWidth: 64, textAlign: "right" }}>{p && t.avgEntry ? `${pctTxt((p.c / t.avgEntry - 1) * 100)} total` : ""}</span>
          </div>
        ); })}
        <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 4 }}>Position health (hold / tighten / exit) is on TODAY.</div>
      </>)}

      {(port || holdings.length > 0) && sec("Your funds", port ? <>
        {line("Portfolio value", formatINR(Math.round(port.value)))}
        {line(`Change (NAV ${mqFmtDate(port.date)})`, `${port.day >= 0 ? "+" : ""}${formatINR(Math.round(port.day))}`, pctCol(port.day))}
        <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 4 }}>AMFI publishes tonight's NAVs around 9–11 pm; earlier in the evening this shows the previous day.</div>
      </> : <Skeleton lines={2} />, <button className="chip chip-sm" onClick={onOpenFunds}>Funds ›</button>)}

      {d?.scans && sec("Setups that appeared", <>
        {[["htf", "High-tight flags"], ["first52", "First 52-week highs"], ["pb21", "21-EMA pullbacks"], ["pivots", "Pocket pivots"], ["ep", "Earnings EPs"]].map(([k, l]) => {
          const rows = d.scans[k] || [];
          return rows.length ? <div key={k} style={{ fontSize: 12, padding: "4px 0", borderTop: "1px solid var(--border)" }}>
            <span style={{ color: "var(--text2)" }}>{l} <b style={{ fontFamily: "var(--mono)" }}>{d.scans[k + "_total"] ?? rows.length}</b>: </span>
            {rows.slice(0, 5).map((r, i) => <button key={r.sym} onClick={() => onOpenStock(r.sym)} style={{ background: "none", border: "none", padding: 0, color: "var(--text)", cursor: "pointer", textDecoration: "underline dotted", textUnderlineOffset: 3, marginRight: 6, font: "inherit" }}>{r.sym}</button>)}
          </div> : null;
        })}
        {d.picks?.rows?.length > 0 && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 6 }}>Tonight's forward-test picks: {d.picks.rows.map(x => x.sym).join(", ")}</div>}
      </>)}

      {sec("Coming up for your stocks", <>
        {soon.length === 0 ? <div style={{ fontSize: 12, color: "var(--text3)" }}>{cal ? "No results due in the next 3 days for your positions or watchlist." : "Loading results calendar…"}</div>
          : soon.map(({ sym, r }) => line(sym, r.inDays === 0 ? "results today" : r.inDays === 1 ? "results tomorrow" : `results in ${r.inDays} days`, r.inDays <= 1 ? C.warn : "var(--text2)"))}
        {myDeals.length > 0 && <div style={{ marginTop: 6 }}>{myDeals.slice(0, 5).map((x, i) => <div key={i} style={{ fontSize: 11.5, color: "var(--text2)", padding: "2px 0" }}><b style={{ color: x.side === "BUY" ? C.pos : C.neg }}>{x.kind} {x.side.toLowerCase()}</b> in {x.sym} · {x.client}</div>)}</div>}
      </>)}
      <div style={{ fontSize: 10, color: "var(--text3)", lineHeight: 1.5 }}>Closes verified against NSE each evening; flows are NSE provisional figures. Information, not advice.</div>
    </div>
  );
}

// ─── IPO TRACKER: every NSE listing of the last year ─────────────────────────
let _iposP = null;
function loadIpos() {
  return (_iposP ||= fetch("/api/nse?type=ipos").then(r => (r.ok ? r.json() : Promise.reject(new Error("NSE IPO list unavailable")))).catch(e => { _iposP = null; throw e; }));
}
const _ipoPx = new Map(); // sym → stats | null
/** Listing-day and since-listing numbers from the stock's own daily bars. */
function ipoStats(ipo, it) {
  const r = it?.response?.[0], ts = r?.timestamp, cl = r?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(cl)) return null;
  const off = ts.length - (it.ohlcTail || []).length;
  const bars = [];
  ts.forEach((t, i) => { const d = istDayKey(t); if (cl[i] != null && d >= ipo.listed) bars.push({ d, c: cl[i], o: i >= off ? it.ohlcTail[i - off]?.[0] : null, h: i >= off ? it.ohlcTail[i - off]?.[1] : null }); });
  if (!bars.length) return null;
  const first = bars[0], last = bars[bars.length - 1], closes = bars.map(b => b.c);
  const hi = Math.max(...bars.map(b => b.h ?? b.c));
  const ma = (n) => (closes.length >= Math.min(n, 15) ? closes.slice(-n).reduce((a, b) => a + b, 0) / Math.min(n, closes.length) : null);
  const age = bars.length, per = age < 50 ? 20 : age < 100 ? 50 : 100, trendMa = ma(per);
  const p = ipo.price, m1 = closes.length > 21 ? (last.c / closes[closes.length - 22] - 1) * 100 : null;
  return {
    sessions: age, last: last.c, lastDate: last.d,
    listOpenGain: p && first.o ? (first.o / p - 1) * 100 : null, listGain: p ? (first.c / p - 1) * 100 : null,
    sinceIssue: p ? (last.c / p - 1) * 100 : null, sinceListing: (last.c / first.c - 1) * 100,
    offHigh: (last.c / hi - 1) * 100, m1, trend: trendMa != null ? last.c > trendMa : null, trendMa: per,
  };
}

function IposPage({ onBack = null, onOpenStock }) {
  const [d, setD] = useState(null), [err, setErr] = useState(null);
  const [seg, setSeg] = useState(() => { try { return localStorage.getItem("td_ipo_seg") || "main"; } catch (_) { return "main"; } });
  const [sort, setSort] = useState("new");
  const [px, setPx] = useState({});
  const [loaded, setLoaded] = useState(0);
  const pickSeg = (v) => { setSeg(v); try { localStorage.setItem("td_ipo_seg", v); } catch (_) {} };
  useEffect(() => { let alive = true; loadIpos().then(x => alive && setD(x)).catch(e => alive && setErr(e.message)); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (!d) return;
    let alive = true;
    const todo = d.listed.filter(x => !_ipoPx.has(x.sym) && !x.sme);
    const smeTodo = d.listed.filter(x => !_ipoPx.has(x.sym) && x.sme);
    if (smeTodo.length) fetch("/api/nse?type=smeclose").then(r => (r.ok ? r.json() : null)).catch(() => null).then(j => {
      if (!alive) return;
      const add = {};
      for (const x of smeTodo) {
        const c = j?.closes?.[x.sym];
        const st = c && x.price ? { sessions: null, last: c, lastDate: j.date, listGain: null, sinceIssue: (c / x.price - 1) * 100, offHigh: null, trend: null, nseOnly: true } : null;
        _ipoPx.set(x.sym, st); add[x.sym] = st;
      }
      setPx(p => ({ ...p, ...add })); setLoaded(n => n + smeTodo.length);
    });
    const known = Object.fromEntries(d.listed.filter(x => _ipoPx.has(x.sym)).map(x => [x.sym, _ipoPx.get(x.sym)]));
    setPx(known); setLoaded(Object.keys(known).length);
    (async () => {
      const chunks = []; for (let i = 0; i < todo.length; i += 40) chunks.push(todo.slice(i, i + 40));
      let k = 0;
      await Promise.all([0, 1].map(async () => {
        while (alive && k < chunks.length) {
          const ch = chunks[k++];
          try {
            const j = await fetch(`/api/spark?symbols=${encodeURIComponent(ch.map(x => x.sym + ".NS").join(","))}&range=1y&interval=1d&ohlc=260`).then(r => (r.ok ? r.json() : null));
            const by = Object.fromEntries((j?.spark?.result || []).map(it => [it.symbol.replace(/\.NS$/, ""), it]));
            const add = {};
            for (const x of ch) { const st = ipoStats(x, by[x.sym]); _ipoPx.set(x.sym, st); add[x.sym] = st; }
            if (alive) { setPx(p => ({ ...p, ...add })); setLoaded(n => n + ch.length); }
          } catch (_) {}
        }
      }));
    })();
    return () => { alive = false; };
  }, [d]);

  const back = onBack ? <button onClick={onBack} className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12, marginBottom: 12 }}>‹ Back</button> : null;
  const head = <><div className="section-title">IPOs</div><div style={{ fontSize: 13, color: "var(--text3)", margin: "4px 0 12px" }}>Every NSE listing of the last 12 months — how it listed and how it has done since. From NSE's issue records.</div></>;
  if (!d) return <div className="fade-in" style={{ padding: "16px 16px 120px" }}>{back}{head}<div className="card" style={{ fontSize: 12, color: err ? "var(--red)" : "var(--text3)" }}>{err || <Skeleton lines={6} />}</div></div>;

  const inSeg = (x) => (seg === "all" ? true : seg === "sme" ? x.sme : !x.sme);
  const rows = d.listed.filter(inSeg).map(x => ({ ...x, s: px[x.sym] }));
  const withPx = rows.filter(x => x.s);
  const SORTS = { new: (a, b) => (a.listed < b.listed ? 1 : -1), since: (a, b) => (b.s?.sinceIssue ?? -999) - (a.s?.sinceIssue ?? -999),
    listing: (a, b) => (b.s?.listGain ?? -999) - (a.s?.listGain ?? -999), high: (a, b) => (b.s?.offHigh ?? -999) - (a.s?.offHigh ?? -999) };
  const sorted = [...rows].sort(SORTS[sort]);
  const med = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
  const above = withPx.filter(x => x.s.sinceIssue > 0).length;
  const best = [...withPx].sort((a, b) => b.s.sinceIssue - a.s.sinceIssue)[0], worst = [...withPx].sort((a, b) => a.s.sinceIssue - b.s.sinceIssue)[0];
  const live = (d.live || []).filter(inSeg), upcoming = (d.upcoming || []).filter(inSeg);
  const mo = (iso) => (iso ? `${mqFmtDate(iso)} ${iso.slice(2, 4)}` : "—");
  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      {back}{head}
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {[["main", `Mainboard ${d.listed.filter(x => !x.sme).length}`], ["sme", `SME ${d.listed.filter(x => x.sme).length}`], ["all", "All"]].map(([k, l]) => <button key={k} className="chip" aria-pressed={seg === k} onClick={() => pickSeg(k)}>{l}</button>)}
      </div>

      {(live.length > 0 || upcoming.length > 0) && (
        <div className="card" style={{ marginBottom: 12, paddingTop: 10 }}>
          <div className="label" style={{ marginBottom: 4 }}>Open for bidding now</div>
          {live.map(x => (
            <div key={x.sym} style={{ borderTop: "1px solid var(--border)", padding: "7px 0" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700 }}>{x.name}{x.sme && <span style={{ marginLeft: 6, fontSize: 10, color: C.warn, border: `1px solid ${C.warn}66`, borderRadius: 6, padding: "0 4px" }}>SME</span>}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: x.subscribed >= 1 ? C.pos : "var(--text2)" }}>{x.subscribed != null ? `${x.subscribed}× subscribed` : ""}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>Band ₹{x.band?.[0]}–{x.band?.[1]} · closes {mo(x.close)}{x.size ? ` · ${(x.size / 1e7).toFixed(2)} cr shares on offer` : ""}</div>
            </div>
          ))}
          {upcoming.map(x => <div key={x.sym} style={{ borderTop: "1px solid var(--border)", padding: "7px 0", fontSize: 12 }}><b>{x.name}</b> <span style={{ color: "var(--text3)" }}>· opens {mo(x.open)}{x.band ? ` · ₹${x.band[0]}–${x.band[1]}` : ""}</span></div>)}
          <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>Subscription is NSE's running total (times the shares on offer).</div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 6 }}>The last 12 months{seg === "sme" ? " · SME" : seg === "main" ? " · mainboard" : ""}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
          {[["LISTED", rows.length, null], ["ABOVE ISSUE NOW", withPx.length ? `${Math.round((above / withPx.length) * 100)}%` : "—", null],
            ["TYPICAL SINCE ISSUE", med(withPx.map(x => x.s.sinceIssue)) != null ? pctTxt(med(withPx.map(x => x.s.sinceIssue))) : "—", med(withPx.map(x => x.s.sinceIssue))],
            ["TYPICAL LISTING DAY", med(withPx.map(x => x.s.listGain)) != null ? pctTxt(med(withPx.map(x => x.s.listGain))) : "—", med(withPx.map(x => x.s.listGain))],
            ["HOLDING TREND", withPx.some(x => x.s.trend != null) ? `${Math.round((withPx.filter(x => x.s.trend).length / withPx.filter(x => x.s.trend != null).length) * 100)}%` : "—", null],
            ["PRICES LOADED", `${Math.min(loaded, d.listed.length)}/${d.listed.length}`, null]].map(([k, v, c]) => (
            <div key={k} style={{ minWidth: 0 }}><div style={{ fontSize: 9.5, color: "var(--text3)", letterSpacing: "0.06em" }}>{k}</div><div style={{ fontFamily: "var(--mono)", fontSize: 14, fontWeight: 700, color: c == null ? "var(--text)" : pctCol(c) }}>{v}</div></div>
          ))}
        </div>
        {best && worst && <div style={{ fontSize: 11.5, color: "var(--text2)", marginTop: 8 }}>Best: <b>{best.sym}</b> <span style={{ color: C.pos }}>{pctTxt(best.s.sinceIssue)}</span> · worst: <b>{worst.sym}</b> <span style={{ color: C.neg }}>{pctTxt(worst.s.sinceIssue)}</span> since issue</div>}
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        {[["new", "Newest"], ["since", "Best since issue"], ["listing", "Best listing"], ["high", "Nearest high"]].map(([k, l]) => <button key={k} className="chip chip-sm" aria-pressed={sort === k} onClick={() => setSort(k)}>{l}</button>)}
      </div>
      <div className="card" style={{ paddingTop: 6 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", columnGap: 10, fontSize: 12 }}>
          {["IPO · LISTED", "LISTING", "SINCE ISSUE", "FROM HIGH"].map((h, i) => <span key={h} style={{ fontSize: 9.5, color: "var(--text3)", textAlign: i ? "right" : "left", padding: "4px 0" }}>{h}</span>)}
          {sorted.map(x => {
            const s = x.s, pending = !(x.sym in px);
            return (
              <Fragment key={x.sym + x.listed}>
                <button onClick={() => onOpenStock(x.sym)} style={{ textAlign: "left", background: "none", border: "none", borderTop: "1px solid var(--border)", padding: "6px 0", color: "var(--text)", cursor: "pointer", minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 700, fontSize: 12.5 }}>{x.sym}{x.sme && <span style={{ marginLeft: 5, fontSize: 9.5, color: C.warn }}>SME</span>}{s?.trend != null && <span title={`${s.trend ? "Above" : "Below"} its ${s.trendMa}-day average`} style={{ marginLeft: 5, color: s.trend ? C.pos : C.neg }}>●</span>}</span>
                  <span style={{ display: "block", fontSize: 10, color: "var(--text3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{mo(x.listed)} · ₹{x.price ?? "—"}{s ? ` → ₹${s.last >= 1000 ? Math.round(s.last) : s.last.toFixed(1)}` : ""}</span>
                  {s?.sinceIssue > 1000 && <span style={{ display: "block", fontSize: 9.5, color: C.warn }}>check: may include a bonus / split</span>}
                </button>
                {[s?.listGain, s?.sinceIssue, s?.offHigh].map((v, i) => (
                  <span key={i} style={{ fontFamily: "var(--mono)", fontSize: 11.5, textAlign: "right", borderTop: "1px solid var(--border)", padding: "6px 0", alignSelf: "center", color: i === 2 ? (v != null && v > -10 ? C.pos : "var(--text2)") : pctCol(v) }}>
                    {v != null ? pctTxt(v) : pending ? "…" : "—"}
                  </span>
                ))}
              </Fragment>
            );
          })}
        </div>
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 10, lineHeight: 1.5 }}>
        Listing = first-day close vs issue price; since issue = latest close vs issue price; from high = vs the highest price since listing. ● = holding the average that fits its age (20-day under 50 sessions, 50-day under 100, else 100-day). SME prices are NSE's latest close (listing-day and trend need daily history that isn't available for SME), and — means it didn't trade in the latest session; SME stocks trade in large lots with thin volume. Very large gains can include bonus issues or splits. Information, not advice.
      </div>
    </div>
  );
}

// ─── MOVERS: today's moves, heatmap, 52-week highs / lows, strength leaders, delivery ─────────
function MoversPage({ onBack = null, onOpenStock }) {
  const { data: d } = useMarketQuadrant();
  const [tab, setTab] = useState(() => { try { return localStorage.getItem("td_movers_tab") || "movers"; } catch (_) { return "movers"; } });
  const pick = (t) => { setTab(t); try { localStorage.setItem("td_movers_tab", t); } catch (_) {} };
  const micro = readMicro();
  const back = onBack ? <button onClick={onBack} className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12, marginBottom: 12 }}>‹ Back</button> : null;
  if (!d?.chg_of) return <div className="fade-in" style={{ padding: "16px 16px 120px" }}>{back}<div className="section-title">Movers</div><div className="card" style={{ marginTop: 12 }}><Skeleton lines={6} /></div></div>;
  const chg = { ...(micro?.chg_of || {}), ...d.chg_of };
  const sectorOf = (sym) => d.sector_of?.[sym] || micro?.sector_of?.[sym] || "Other";
  const q = (sym) => d.q_of?.[sym] || micro?.q_of?.[sym] || null;
  const isMicro = (sym) => !(sym in d.chg_of);
  const tag = (sym) => isMicro(sym) ? <span style={{ fontSize: 9.5, color: "var(--text3)", marginLeft: 4 }}>micro</span> : null;
  const symBtn = (sym) => <button onClick={() => onOpenStock(sym)} style={{ background: "none", border: "none", padding: 0, color: "var(--text)", fontWeight: 700, cursor: "pointer", font: "inherit", textAlign: "left" }}>{sym}{tag(sym)}</button>;
  const row = (sym, right, sub) => (
    <div key={sym} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, fontSize: 12.5, borderTop: "1px solid var(--border)", padding: "6px 0", alignItems: "baseline" }}>
      <span style={{ minWidth: 0 }}>{symBtn(sym)}<span style={{ display: "block", fontSize: 10, color: "var(--text3)" }}>{sub ?? sectorOf(sym)}</span></span>
      <span style={{ fontFamily: "var(--mono)", textAlign: "right" }}>{right}</span>
    </div>
  );
  const TABS = [["movers", "Movers"], ["heat", "Heatmap"], ["hl", "52-week highs"], ["rs", "Strength leaders"], ["deliv", "Delivery"]];
  const entries = Object.entries(chg).filter(([, v]) => Number.isFinite(v));
  const up = [...entries].sort((a, b) => b[1] - a[1]).slice(0, 12), dn = [...entries].sort((a, b) => a[1] - b[1]).slice(0, 12);
  const vol = entries.map(([s, v]) => ({ s, v, vx: q(s)?.vx })).filter(x => x.vx >= 3 && Math.abs(x.v) >= 2).sort((a, b) => b.vx - a.vx).slice(0, 15);
  const breadth = { up: entries.filter(([, v]) => v > 0).length, dn: entries.filter(([, v]) => v < 0).length };
  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      {back}
      <div className="section-title">Movers</div>
      <div style={{ fontSize: 13, color: "var(--text3)", margin: "4px 0 10px" }}>What moved on {mqFmtDate(d.as_of)} — Nifty 500{micro?.chg_of ? " + Microcap 250" : ""} · <span style={{ color: C.pos }}>{breadth.up} up</span> · <span style={{ color: C.neg }}>{breadth.dn} down</span></div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>{TABS.map(([k, l]) => <button key={k} className="chip chip-sm" aria-pressed={tab === k} onClick={() => pick(k)}>{l}</button>)}</div>

      {tab === "movers" && <>
        <div className="card" style={{ marginBottom: 12 }}><div className="label">Top gainers</div>{up.map(([s, v]) => row(s, <span style={{ color: C.pos }}>{pctTxt(v)}</span>))}</div>
        <div className="card" style={{ marginBottom: 12 }}><div className="label">Top losers</div>{dn.map(([s, v]) => row(s, <span style={{ color: C.neg }}>{pctTxt(v)}</span>))}</div>
        <div className="card"><div className="label">Unusual volume</div>
          <div style={{ fontSize: 11, color: "var(--text3)", margin: "2px 0 4px" }}>3× or more the 50-day average volume, with a move of 2%+.</div>
          {vol.length ? vol.map(x => row(x.s, <><span style={{ color: pctCol(x.v) }}>{pctTxt(x.v)}</span> <span style={{ color: "var(--text2)" }}>{x.vx}×</span></>)) : <div style={{ fontSize: 12, color: "var(--text3)", padding: "6px 0" }}>Nothing unusual today.</div>}
        </div>
      </>}

      {tab === "heat" && <MoversHeatmap chg={d.chg_of} sectorOf={sectorOf} onOpenStock={onOpenStock} />}

      {tab === "hl" && <>
        {(() => {
          const H = [...(d.high_list || []), ...(micro?.high_list || [])], L = [...(d.low_list || []), ...(micro?.low_list || [])];
          const bySec = {}; for (const x of H) (bySec[x.sector] ||= []).push(x);
          const secs = Object.entries(bySec).sort((a, b) => b[1].length - a[1].length);
          return <>
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="label">New 52-week highs · {H.length}</div>
              <div style={{ fontSize: 11, color: "var(--text3)", margin: "2px 0 6px" }}>Grouped by sector — several in one sector often marks a theme getting going. ★ = first 52-week high in 20+ sessions.</div>
              {secs.length ? secs.map(([sec, xs]) => (
                <div key={sec} style={{ borderTop: "1px solid var(--border)", padding: "6px 0" }}>
                  <div style={{ fontSize: 11.5, color: "var(--text2)", marginBottom: 3 }}><b>{sec}</b> · {xs.length}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{xs.map(x => <button key={x.sym} className="chip chip-sm" onClick={() => onOpenStock(x.sym)}>{x.first ? "★ " : ""}{x.sym} <span style={{ color: pctCol(x.chg), fontFamily: "var(--mono)" }}>{pctTxt(x.chg)}</span></button>)}</div>
                </div>
              )) : <div style={{ fontSize: 12, color: "var(--text3)" }}>None today.</div>}
            </div>
            <div className="card"><div className="label">New 52-week lows · {L.length}</div>{L.length ? L.map(x => row(x.sym, <span style={{ color: pctCol(x.chg) }}>{pctTxt(x.chg)}</span>, x.sector)) : <div style={{ fontSize: 12, color: "var(--text3)", padding: "6px 0" }}>None today.</div>}</div>
          </>;
        })()}
      </>}

      {tab === "rs" && (() => {
        const ranked = Object.entries(d.rs_of || {}).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
        const top = ranked.slice(0, 50), cutWk = Object.values(d.rs_wk_of || {}).sort((a, b) => b - a)[49] ?? 99;
        return <div className="card">
          <div className="label">Strongest 50 by strength rank</div>
          <div style={{ fontSize: 11, color: "var(--text3)", margin: "2px 0 6px" }}>RS 1–99 vs the Nifty 500 · arrow = change over the past week · NEW = not in the top 50 a week ago.</div>
          {top.map(([s, rs], i) => { const wk = d.rs_wk_of?.[s], dlt = wk != null ? rs - wk : null; return (
            <div key={s} style={{ display: "grid", gridTemplateColumns: "22px 1fr auto auto", gap: 8, fontSize: 12.5, borderTop: "1px solid var(--border)", padding: "5px 0", alignItems: "baseline" }}>
              <span style={{ color: "var(--text3)", fontFamily: "var(--mono)", fontSize: 11 }}>{i + 1}</span>
              <span style={{ minWidth: 0 }}>{symBtn(s)}{wk != null && wk < cutWk && <span style={{ marginLeft: 5, fontSize: 9.5, color: C.pos, fontWeight: 800 }}>NEW</span>}<span style={{ display: "block", fontSize: 10, color: "var(--text3)" }}>{sectorOf(s)} · grade {d.grade_of?.[s] || "—"}</span></span>
              <span style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{rs}</span>
              <span style={{ fontFamily: "var(--mono)", minWidth: 36, textAlign: "right", color: dlt == null ? "var(--text3)" : dlt > 0 ? C.pos : dlt < 0 ? C.neg : "var(--text3)" }}>{dlt == null ? "—" : dlt > 0 ? `▲${dlt}` : dlt < 0 ? `▼${-dlt}` : "="}</span>
            </div>
          ); })}
        </div>;
      })()}

      {tab === "deliv" && (() => {
        const dv = { ...(micro?.deliv_of || {}), ...(d.deliv_of || {}) };
        const rows = Object.entries(dv).map(([s, p]) => ({ s, p, v: chg[s], vx: q(s)?.vx })).filter(x => x.p >= 55 && x.v >= 1.5 && (x.vx ?? 0) >= 1.3).sort((a, b) => b.p - a.p).slice(0, 25);
        return <div className="card">
          <div className="label">High delivery on an up day</div>
          <div style={{ fontSize: 11, color: "var(--text3)", margin: "2px 0 6px", lineHeight: 1.45 }}>55%+ of the day's traded shares were taken as delivery (held, not intraday), on a 1.5%+ gain with 1.3×+ normal volume — buying that looks like accumulation. NSE's figure for {mqFmtDate(d.as_of)}.</div>
          {rows.length ? rows.map(x => row(x.s, <><span style={{ color: C.pos }}>{Math.round(x.p)}% deliv</span> <span style={{ color: pctCol(x.v) }}>{pctTxt(x.v)}</span></>, `${sectorOf(x.s)}${x.vx ? ` · ${x.vx}× volume` : ""}`)) : <div style={{ fontSize: 12, color: "var(--text3)", padding: "6px 0" }}>Nothing qualifies today (or NSE's delivery figures aren't in yet).</div>}
        </div>;
      })()}
    </div>
  );
}

function MoversHeatmap({ chg, sectorOf, onOpenStock }) {
  const bySec = {};
  for (const [s, v] of Object.entries(chg)) if (Number.isFinite(v)) (bySec[sectorOf(s)] ||= []).push([s, v]);
  const secs = Object.entries(bySec).map(([k, xs]) => [k, xs.sort((a, b) => b[1] - a[1]), xs.reduce((a, [, v]) => a + v, 0) / xs.length]).sort((a, b) => b[2] - a[2]);
  const bg = (v) => { const a = Math.min(1, Math.abs(v) / 4); return v >= 0 ? `rgba(34,197,94,${0.15 + a * 0.6})` : `rgba(239,68,68,${0.15 + a * 0.6})`; };
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8 }}>Every Nifty 500 stock, by sector (best sector first). Deeper colour = bigger move (±4% = full). Tap a tile for the stock.</div>
      {secs.map(([sec, xs, avg]) => (
        <div key={sec} className="card" style={{ marginBottom: 10, padding: "8px 10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}><b>{sec}</b><span style={{ fontFamily: "var(--mono)", color: pctCol(avg) }}>{pctTxt(avg)} avg · {xs.length}</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(62px, 1fr))", gap: 3 }}>
            {xs.map(([s, v]) => (
              <button key={s} onClick={() => onOpenStock(s)} title={`${s} ${pctTxt(v)}`} style={{ background: bg(v), border: "none", borderRadius: 4, padding: "4px 2px", cursor: "pointer", minWidth: 0, color: "var(--text)" }}>
                <span style={{ display: "block", fontSize: 9.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s}</span>
                <span style={{ display: "block", fontSize: 9.5, fontFamily: "var(--mono)" }}>{v > 0 ? "+" : ""}{v.toFixed(1)}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── SEARCH: stocks, funds, IPOs in one box ──────────────────────────────────
function SearchSheet({ open, onClose, onOpenStock, onOpenFund, onOpenIpos }) {
  const [q, setQ] = useState("");
  const [syms, setSyms] = useState(null), [mf, setMf] = useState(null), [ipos, setIpos] = useState(null);
  const inputRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 50);
    loadLocalSymbols().then(setSyms);
    loadMfList().then(setMf).catch(() => {});
    loadIpos().then(setIpos).catch(() => {});
    const k = (e) => e.key === "Escape" && onClose(); document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k);
  }, [open]);
  if (!open) return null;
  const ql = q.trim().toLowerCase();
  const stocks = ql.length >= 1 && syms ? syms.filter(r => r.symbol.toLowerCase().includes(ql) || r.name.toLowerCase().includes(ql)).map(r => [rankLocalSymbolMatch(r, ql), r]).sort((a, b) => a[0][0] - b[0][0] || (a[0][1] < b[0][1] ? -1 : 1)).slice(0, 8).map(x => x[1]) : [];
  const funds = ql.length >= 2 && mf ? mf.funds.filter(f => f[1].toLowerCase().includes(ql) || f[2].toLowerCase().includes(ql)).slice(0, 6) : [];
  const ipoHits = ql.length >= 2 && ipos ? [...(ipos.live || []), ...ipos.listed].filter(x => x.sym.toLowerCase().includes(ql) || (x.name || "").toLowerCase().includes(ql)).slice(0, 4) : [];
  const go = (fn) => { setQ(""); onClose(); fn(); };
  const item = (k, title, sub, fn) => <button key={k} onClick={() => go(fn)} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderTop: "1px solid var(--border)", padding: "9px 0", color: "var(--text)", cursor: "pointer", minHeight: 44 }}><span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{title}</span><span style={{ display: "block", fontSize: 10.5, color: "var(--text3)" }}>{sub}</span></button>;
  const head = (t) => <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.1em", marginTop: 10 }}>{t}</div>;
  return (
    <div role="dialog" aria-modal="true" aria-label="Search" onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 450, background: "rgba(0,0,0,0.55)", display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
      <div style={{ width: "100%", maxWidth: 480, background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "12px 16px 16px", maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Stock, fund or IPO — e.g. tata, parag, flexi" aria-label="Search stocks, funds and IPOs" style={{ flex: 1 }} />
          <button className="btn-ghost" style={{ padding: "8px 12px", fontSize: 12 }} onClick={onClose}>Close</button>
        </div>
        {!ql && <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 10 }}>Search every NSE stock, all 1,700+ mutual funds and the last year's IPOs.</div>}
        {stocks.length > 0 && <>{head("STOCKS")}{stocks.map(r => item("s" + r.symbol, r.symbol, r.name, () => onOpenStock(r.symbol)))}</>}
        {funds.length > 0 && <>{head("MUTUAL FUNDS")}{funds.map(f => item("f" + f[0], f[1], `${f[2].replace(/ Mutual Fund$/, "")} · ${mf.cats[f[3]]?.split(" · ")[1] || ""}`, () => onOpenFund(f[0])))}</>}
        {ipoHits.length > 0 && <>{head("IPOS")}{ipoHits.map(x => item("i" + x.sym, x.name || x.sym, x.listed ? `listed ${mqFmtDate(x.listed)} at ₹${x.price}` : "open for bidding", () => (x.listed ? onOpenStock(x.sym) : onOpenIpos())))}</>}
        {ql && !stocks.length && !funds.length && !ipoHits.length && <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 10 }}>{syms ? `Nothing matches "${q}".` : "Loading…"}</div>}
      </div>
    </div>
  );
}

// ─── NOTES on any stock ──────────────────────────────────────────────────────
const readNotes = () => { try { return JSON.parse(localStorage.getItem("td_stock_notes") || "{}"); } catch (_) { return {}; } };
function useStockNotes() {
  const [n, setN] = useState(readNotes);
  useEffect(() => { const on = () => setN(readNotes()); window.addEventListener("td_stock_notes", on); return () => window.removeEventListener("td_stock_notes", on); }, []);
  const save = (sym, v) => { const next = { ...readNotes() }; if (v && (v.note || v.target)) next[sym] = { ...v, at: new Date().toISOString() }; else delete next[sym]; try { localStorage.setItem("td_stock_notes", JSON.stringify(next)); } catch (_) {} setN(next); window.dispatchEvent(new Event("td_stock_notes")); };
  return [n, save];
}
function NoteMark({ sym }) {
  const [n] = useStockNotes();
  return n[sym] ? <span title={n[sym].note || `target ₹${n[sym].target}`} style={{ marginLeft: 4, fontSize: 10 }}>📝</span> : null;
}
function StockNotes({ symbol, last }) {
  const [notes, save] = useStockNotes();
  const cur = notes[symbol];
  const [edit, setEdit] = useState(false), [note, setNote] = useState(cur?.note || ""), [target, setTarget] = useState(cur?.target ?? "");
  useEffect(() => { setNote(notes[symbol]?.note || ""); setTarget(notes[symbol]?.target ?? ""); setEdit(false); }, [symbol]);
  const tgt = cur?.target > 0 ? +cur.target : null;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div className="label">Your note</div>
        <button className="chip chip-sm" onClick={() => setEdit(v => !v)}>{edit ? "Cancel" : cur ? "Edit" : "+ Add note"}</button>
      </div>
      {!edit && cur && <>
        {cur.note && <div style={{ fontSize: 13, color: "var(--text)", whiteSpace: "pre-wrap", marginTop: 6, lineHeight: 1.5 }}>{cur.note}</div>}
        {tgt && <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 6 }}>Target ₹{tgt}{last ? <> · <b style={{ color: last >= tgt ? C.pos : "var(--text)" }}>{last >= tgt ? "reached" : `${((tgt / last - 1) * 100).toFixed(1)}% away`}</b></> : null}</div>}
        <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4 }}>Saved {mqFmtDate(cur.at?.slice(0, 10))}</div>
      </>}
      {!edit && !cur && <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 4 }}>Jot down why you're watching it, and a price target. It shows here and as 📝 in lists.</div>}
      {edit && <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} placeholder="Why I'm watching it, what I'm waiting for…" aria-label="Note" style={{ width: "100%", resize: "vertical" }} />
        <label style={{ fontSize: 10.5, color: "var(--text3)" }}>Target price ₹ (optional)<input type="number" value={target} onChange={e => setTarget(e.target.value)} style={{ width: "100%", marginTop: 3 }} /></label>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-primary" style={{ flex: 1, padding: 10, fontSize: 13 }} onClick={() => { save(symbol, { note: note.trim(), target: +target > 0 ? +target : null }); setEdit(false); }}>Save</button>
          {cur && <button className="btn-ghost" style={{ padding: "10px 14px", fontSize: 13, color: C.neg }} onClick={() => { save(symbol, null); setEdit(false); }}>Delete</button>}
        </div>
      </div>}
    </div>
  );
}

// ─── COMPARE up to 3 stocks ──────────────────────────────────────────────────
function ComparePage({ syms, setSyms, onBack, onOpenStock }) {
  const { data: mq } = useMarketQuadrant();
  const [dets, setDets] = useState({});
  const [range, setRange] = useState(126);
  const [q, setQ] = useState(""), [all, setAll] = useState(null);
  const [cal, setCal] = useState(null);
  useEffect(() => { loadLocalSymbols().then(setAll); fetchResultsCalendar().then(setCal); }, []);
  useEffect(() => { let alive = true; for (const s of syms) if (!dets[s]) cachedDetail(s).then(x => alive && x && setDets(p => ({ ...p, [s]: x }))); return () => { alive = false; }; }, [syms.join(",")]);
  const COL = ["#3B82F6", C.pos, "#D9632B"];
  const ql = q.trim().toLowerCase();
  const hits = ql && all ? all.filter(r => r.symbol.toLowerCase().startsWith(ql) || r.name.toLowerCase().includes(ql)).slice(0, 6) : [];
  const ready = syms.filter(s => dets[s]);
  const series = ready.map(s => { const d = dets[s], n = d.closes.length, a = Math.max(0, n - range), base = d.closes[a]; return { s, pts: d.closes.slice(a).map((c, i) => [d.dates[a + i], (c / base) * 100]) }; });
  const W = 340, H = 140, padR = 36;
  const vals = series.flatMap(x => x.pts.map(p => p[1])); const lo = Math.min(100, ...vals), hi = Math.max(100, ...vals), sp = hi - lo || 1;
  const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${((i / Math.max(1, pts.length - 1)) * (W - padR)).toFixed(1)},${(6 + (1 - (p[1] - lo) / sp) * (H - 10)).toFixed(1)}`).join("");
  const ret = (d, n) => { const k = d.closes.length - 1 - n; return k >= 0 ? (d.closes[d.closes.length - 1] / d.closes[k] - 1) * 100 : null; };
  const rowsDef = [
    ["Price", (s, d) => `₹${d.closes[d.closes.length - 1].toFixed(1)}`],
    ["Today", (s) => mq?.chg_of?.[s] != null ? pctTxt(mq.chg_of[s]) : "—"],
    ["1M", (s, d) => pctTxt(ret(d, 21))], ["3M", (s, d) => pctTxt(ret(d, 63))], ["6M", (s, d) => pctTxt(ret(d, 126))],
    ["From 52w high", (s, d) => { const h = Math.max(...d.closes.slice(-252)); return pctTxt((d.closes[d.closes.length - 1] / h - 1) * 100); }],
    ["Strength (RS)", (s) => mq?.rs_of?.[s] ?? "—"], ["Grade", (s) => mq?.grade_of?.[s] ?? "—"],
    ["Sector", (s) => { const sec = mq?.sector_of?.[s]; const st = sec && (mq.sectors || []).find(x => x.name === sec)?.status; return sec ? `${sec}${st ? ` · ${st}` : ""}` : "—"; }],
    ["Results", (s) => { const r = cal && upcomingResults(cal, s, 30); return r ? `in ${r.inDays}d` : "—"; }],
  ];
  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      <button onClick={onBack} className="btn-ghost" style={{ padding: "6px 10px", fontSize: 12, marginBottom: 12 }}>‹ Back</button>
      <div className="section-title">Compare</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
        {syms.map((s, i) => <button key={s} className="chip chip-sm" onClick={() => setSyms(syms.filter(x => x !== s))} style={{ borderColor: COL[i], color: COL[i] }}>{s} ✕</button>)}
      </div>
      {syms.length < 3 && <div style={{ marginBottom: 10 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={syms.length ? "Add another stock" : "Add a stock to compare"} aria-label="Add a stock to compare" style={{ width: "100%" }} />
        {hits.map(r => <button key={r.symbol} onClick={() => { setSyms([...new Set([...syms, r.symbol])].slice(0, 3)); setQ(""); }} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderTop: "1px solid var(--border)", padding: "8px 0", color: "var(--text)", cursor: "pointer", fontSize: 12.5 }}><b>{r.symbol}</b> <span style={{ color: "var(--text3)", fontSize: 11 }}>{r.name}</span></button>)}
      </div>}
      {ready.length > 0 && <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>{[[63, "3M"], [126, "6M"], [250, "1Y"]].map(([n, l]) => <button key={n} className="chip chip-sm" aria-pressed={range === n} onClick={() => setRange(n)}>{l}</button>)}<span style={{ flex: 1 }} /><span style={{ fontSize: 10.5, color: "var(--text3)", alignSelf: "center" }}>rebased to 100</span></div>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img" aria-label="Price comparison chart">
          <line x1="0" x2={W - padR} y1={6 + (1 - (100 - lo) / sp) * (H - 10)} y2={6 + (1 - (100 - lo) / sp) * (H - 10)} stroke="var(--border)" strokeDasharray="3 3" />
          {series.map((x) => <path key={x.s} d={path(x.pts)} fill="none" stroke={COL[syms.indexOf(x.s)]} strokeWidth="1.8" />)}
          {series.map((x) => { const v = x.pts[x.pts.length - 1][1]; return <text key={x.s} x={W - padR + 3} y={6 + (1 - (v - lo) / sp) * (H - 10) + 3} fontSize="9" fill={COL[syms.indexOf(x.s)]} fontFamily="var(--mono)">{v.toFixed(0)}</text>; })}
        </svg>
      </div>}
      {ready.length > 0 && <div className="card">
        <div style={{ display: "grid", gridTemplateColumns: `100px repeat(${ready.length}, minmax(0, 1fr))`, gap: "5px 8px", fontSize: 12 }}>
          <span />{ready.map(s => <button key={s} onClick={() => onOpenStock(s)} style={{ background: "none", border: "none", padding: 0, color: COL[syms.indexOf(s)], fontWeight: 800, cursor: "pointer", textAlign: "right", font: "inherit" }}>{s}</button>)}
          {rowsDef.map(([l, f]) => <Fragment key={l}><span style={{ color: "var(--text3)", fontSize: 11 }}>{l}</span>{ready.map(s => <span key={s} style={{ fontFamily: "var(--mono)", textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f(s, dets[s])}</span>)}</Fragment>)}
        </div>
      </div>}
      {!syms.length && <div style={{ fontSize: 12, color: "var(--text3)" }}>Add 2–3 stocks to see them on one chart and side by side.</div>}
    </div>
  );
}

// ─── PRE-MARKET BRIEF (weekday mornings) ─────────────────────────────────────
function MorningBrief({ trades, watchlist, onOpenStock }) {
  const { data: d } = useMarketQuadrant();
  const { deals } = useFlowsDeals();
  const [g, setG] = useState(null), [cal, setCal] = useState(null);
  useEffect(() => { let alive = true; fetchGlobal().then(x => alive && setG(x)).catch(() => {}); fetchResultsCalendar().then(c => alive && setCal(c)); return () => { alive = false; }; }, []);
  const open = (trades || []).filter(t => t.status === "open" || t.status === "partial").map(normalizeTrade);
  const mine = [...new Set([...open.map(t => normalizeSymbol(t.symbol)), ...(watchlist || []).map(w => w.sym)])];
  const today = cal ? mine.map(s => ({ s, r: upcomingResults(cal, s, 1) })).filter(x => x.r) : [];
  const myDeals = (deals?.deals || []).filter(x => mine.includes(x.sym));
  const sr = d ? suggestedRisk(d) : null;
  return (
    <div className="card" style={{ marginBottom: 14, border: "1.5px solid var(--violet)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><div className="label">☀️ Before the open</div><span style={{ fontSize: 10.5, color: "var(--text3)" }}>NSE opens 9:15</span></div>
      {d && <div style={{ fontSize: 12.5, marginTop: 6 }}>Signal <b style={{ color: MQ_SIGNAL_COLOR[d.overall] }}>{d.overall}</b> · risk <b>{sr?.pct ?? 0}%</b> per trade · {d.environment?.name?.toLowerCase()}</div>}
      {g?.length > 0 && <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6, marginTop: 8 }}>
        {g.slice(0, 8).map(x => <div key={x.t} style={{ minWidth: 0 }}><div style={{ fontSize: 9.5, color: "var(--text3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.name}</div><div style={{ fontFamily: "var(--mono)", fontSize: 12, color: pctCol(x.chg) }}>{pctTxt(x.chg)}</div></div>)}
      </div>}
      {open.length > 0 && <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.08em" }}>YOUR STOPS TODAY</div>
        {open.map(t => <div key={t.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", borderTop: "1px solid var(--border)" }}><button onClick={() => onOpenStock(normalizeSymbol(t.symbol))} style={{ background: "none", border: "none", padding: 0, color: "var(--text)", fontWeight: 700, cursor: "pointer" }}>{normalizeSymbol(t.symbol)}</button><span style={{ fontFamily: "var(--mono)", color: C.neg }}>stop ₹{t.currentStop || t.stop || "—"}</span></div>)}
      </div>}
      {today.length > 0 && <div style={{ fontSize: 12, color: C.warn, marginTop: 8 }}>📅 Results {today.map(x => `${x.s} ${x.r.inDays === 0 ? "today" : "tomorrow"}`).join(" · ")} — expect a gap.</div>}
      {myDeals.length > 0 && <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 6 }}>Big deals yesterday: {myDeals.slice(0, 3).map(x => `${x.sym} ${x.kind} ${x.side.toLowerCase()}`).join(" · ")}</div>}
      {!open.length && !today.length && <div style={{ fontSize: 11.5, color: "var(--text3)", marginTop: 8 }}>No open positions or results today in your stocks.</div>}
    </div>
  );
}

/** TODAY: IPOs open for bidding now, or a door into the tracker. */
function IpoTodayCard({ onOpen }) {
  const [d, setD] = useState(null);
  useEffect(() => { let alive = true; loadIpos().then(x => alive && setD(x)).catch(() => {}); return () => { alive = false; }; }, []);
  const live = d?.live || [];
  return (
    <button onClick={onOpen} className="card" style={{ display: "block", width: "100%", textAlign: "left", cursor: "pointer", color: "var(--text)", marginBottom: 14, paddingTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div className="label">IPOs</div><span style={{ fontSize: 11, color: "var(--text3)" }}>Tracker ›</span>
      </div>
      {live.length ? live.slice(0, 3).map(x => (
        <div key={x.sym} style={{ display: "flex", gap: 8, fontSize: 12, padding: "5px 0", borderTop: "1px solid var(--border)", alignItems: "baseline" }}>
          <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.name}{x.sme ? " · SME" : ""}</span>
          <span style={{ fontFamily: "var(--mono)", color: x.subscribed >= 1 ? C.pos : "var(--text2)" }}>{x.subscribed != null ? `${x.subscribed}×` : ""}</span>
          <span style={{ fontSize: 10.5, color: "var(--text3)" }}>closes {mqFmtDate(x.close)}</span>
        </div>
      )) : <div style={{ fontSize: 12, color: "var(--text3)", padding: "4px 0" }}>{d ? `${d.listed.filter(x => !x.sme).length} mainboard and ${d.listed.filter(x => x.sme).length} SME listings in the last year — see how each has done.` : "Loading NSE's IPO list…"}</div>}
    </button>
  );
}

/** Weekday, 09:15–15:30 IST — trading screens only; investing cards wait for the close. */
function isMarketHours() {
  const ist = new Date(Date.now() + 19800000), m = ist.getUTCHours() * 60 + ist.getUTCMinutes(), wd = ist.getUTCDay();
  return wd >= 1 && wd <= 5 && m >= 9 * 60 + 15 && m < 15 * 60 + 30;
}

/** Weekday, 05:00–09:15 IST. */
function isPreOpen() {
  const ist = new Date(Date.now() + 19800000), m = ist.getUTCHours() * 60 + ist.getUTCMinutes(), wd = ist.getUTCDay();
  return wd >= 1 && wd <= 5 && m >= 5 * 60 && m < 9 * 60 + 15;
}

/** TODAY: the door into the day wrap — prominent after the close. */
function WrapEntry({ onOpen }) {
  const ist = new Date(Date.now() + 19800000), mins = ist.getUTCHours() * 60 + ist.getUTCMinutes(), wd = ist.getUTCDay();
  const after = wd >= 1 && wd <= 5 && mins >= 15 * 60 + 30;
  return (
    <button onClick={onOpen} className="card" style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, textAlign: "left", cursor: "pointer", color: "var(--text)", marginBottom: 14, padding: "12px 14px", border: after ? "1.5px solid var(--violet)" : undefined }}>
      <span style={{ fontSize: 18 }} aria-hidden="true">{after ? "🌙" : "📋"}</span>
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 700 }}>{after ? "Today's wrap is ready" : "Day wrap"}</span>
        <span style={{ display: "block", fontSize: 11, color: "var(--text3)" }}>Market, your positions and funds, new setups, results coming up — one screen</span>
      </span>
      <span aria-hidden="true" style={{ color: "var(--text3)" }}>›</span>
    </button>
  );
}

/** TODAY: your tracked funds at a glance, or a door into Funds. */
function FundsTodayCard({ onOpen, onOpenFund }) {
  const [watch] = useMfWatch();
  const { data } = useMfList();
  const [holdings] = useMfHoldings();
  const [port, setPort] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!holdings.length) { setPort(null); return; }
    Promise.all(holdings.map(h => loadMfFull(h.code).then(f => evalHolding(h, f)).catch(() => null))).then(es => {
      if (!alive) return;
      const ok = es.filter(e => e && !e.error);
      if (!ok.length) return;
      setPort({ value: ok.reduce((a, e) => a + e.value, 0), invested: ok.reduce((a, e) => a + e.invested, 0), day: ok.reduce((a, e) => a + e.dayChg, 0), n: ok.length, date: ok.map(e => e.date).sort().pop() });
    });
    return () => { alive = false; };
  }, [JSON.stringify(holdings)]);
  return (
    <div className="card" style={{ marginBottom: 14, paddingTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
        <div className="label">Mutual funds</div>
        <button className="chip chip-sm" onClick={onOpen}>All funds ›</button>
      </div>
      {port && (
        <button onClick={onOpen} style={{ display: "flex", width: "100%", alignItems: "baseline", gap: 10, background: "none", border: "none", padding: "6px 0", color: "var(--text)", cursor: "pointer", textAlign: "left" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 700 }}>{formatINR(Math.round(port.value))}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: pctCol(port.day) }}>{port.day >= 0 ? "+" : ""}{formatINR(Math.round(port.day))} today</span>
          <span style={{ fontSize: 11, color: pctCol(port.value - port.invested), marginLeft: "auto" }}>{port.invested ? pctTxt(((port.value / port.invested) - 1) * 100) : ""} overall</span>
        </button>
      )}
      {watch.length && data ? watch.slice(0, 6).map(c => { const f = data.funds.find(x => x[0] === c); return f ? <MfWatchRow key={c} f={f} onOpen={onOpenFund} /> : null; })
        : !port && <div style={{ fontSize: 12, color: "var(--text3)", padding: "6px 0" }}>{data ? `${data.funds.length.toLocaleString("en-IN")} funds, NAVs as of ${mqFmtDate(data.date)}. Add your holdings in Funds, or tap ☆ on any fund to track it here.` : "Loading AMFI NAVs…"}</div>}
    </div>
  );
}

// Which bottom tab a page belongs to
const NAV_GROUP = {
  today: "today", wrap: "today",
  ideas: "stocks", scan: "stocks", movers: "stocks", watch: "stocks",
  quadrant: "market",
  funds: "invest", fund: "invest", ipos: "invest",
  journal: "journal", playbook: "journal",
};
const NAV_DEFAULT = { today: "today", stocks: "ideas", market: "quadrant", invest: "funds", journal: "journal" };
function lastIn(group) { try { return localStorage.getItem(`td_last_${group}`) || NAV_DEFAULT[group]; } catch (_) { return NAV_DEFAULT[group]; } }

function BottomNav({ page, setPage }) {
  const ico = (d) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{d}</svg>;
  const tabs = [
    { id: "today", label: "TODAY", icon: ico(<><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>) },
    { id: "stocks", label: "STOCKS", icon: ico(<><polyline points="3 17 9 11 13 15 21 7" /><polyline points="15 7 21 7 21 13" /></>) },
    { id: "market", label: "MARKET", icon: ico(<><path d="M3 12a9 9 0 1 1 18 0" /><line x1="12" y1="12" x2="16.5" y2="7.5" /><circle cx="12" cy="12" r="1.5" /></>) },
    { id: "invest", label: "INVEST", icon: ico(<><path d="M21 12A9 9 0 1 1 12 3v9z" /><path d="M14 2.2A9 9 0 0 1 21.8 10H14z" /></>) },
    { id: "journal", label: "JOURNAL", icon: ico(<><path d="M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z" /><line x1="8" y1="8" x2="15" y2="8" /><line x1="8" y1="12" x2="15" y2="12" /></>) },
  ];
  const active = NAV_GROUP[page];
  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0,
      background: "var(--bar)", backdropFilter: "blur(20px)",
      borderTop: "1px solid var(--border)",
      display: "flex", paddingBottom: "env(safe-area-inset-bottom)",
      zIndex: 100, maxWidth: 480, margin: "0 auto",
    }}>
      {tabs.map(tab => (
        <button key={tab.id} className={`nav-tab ${active === tab.id ? "active" : ""}`} aria-current={active === tab.id ? "page" : undefined}
          onClick={() => { setPage(tab.id === "today" ? "today" : active === tab.id && page !== "fund" ? page : lastIn(tab.id)); window.scrollTo(0, 0); }}>
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Segment bar shown at the top of every page inside a bottom tab. */
function SegBar({ items, active, onPick }) {
  return (
    <div style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none", padding: "12px 16px 0" }}>
      {items.map(([k, l]) => <button key={k} className="chip" aria-pressed={active === k} onClick={() => onPick(k)} style={{ whiteSpace: "nowrap", flex: "1 0 auto" }}>{l}</button>)}
    </div>
  );
}
const STOCKS_SEGS = [["ideas", "Ideas"], ["scan", "Scans"], ["movers", "Movers"], ["watch", "Watchlist"]];
const INVEST_SEGS = [["funds", "Mutual funds"], ["ipos", "IPOs"]];
const JOURNAL_SEGS = [["journal", "Trades"], ["review", "Review"], ["stats", "Stats"], ["setups", "Setups"]];

/** Top-bar menu: portfolio value, theme, tour, how the app works. */
function MenuSheet({ open, onClose, portfolio, setPortfolio, onTour }) {
  const [v, setV] = useState(String(portfolio || ""));
  useEffect(() => { if (open) setV(String(portfolio || "")); }, [open, portfolio]);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Menu" onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 450, background: "rgba(0,0,0,0.55)", display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
      <div style={{ width: "100%", maxWidth: 480, background: "var(--bg)", padding: "14px 16px 18px", maxHeight: "88vh", overflowY: "auto", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div className="section-title" style={{ fontSize: 22 }}>Menu</div>
          <button className="btn-ghost" style={{ padding: "8px 12px", fontSize: 12 }} onClick={onClose}>Close</button>
        </div>
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="label" style={{ marginBottom: 6 }}>Trading capital</div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8 }}>Used for position sizing, heat and risk per trade. Your mutual funds are tracked separately under INVEST.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="number" value={v} onChange={e => setV(e.target.value)} aria-label="Trading capital in rupees" style={{ flex: 1 }} />
            <button className="btn-primary" style={{ padding: "8px 14px", fontSize: 13 }} disabled={!(+v > 0)} onClick={() => { setPortfolio(Number(v)); onClose(); }}>Save</button>
          </div>
        </div>
        <AppSettings onTour={() => { onClose(); onTour(); }} />
        <div style={{ marginTop: 12 }}><Guide id="app" /></div>
      </div>
    </div>
  );
}

// ─── APP ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("today");
  const {
    regime,
    setRegime,
    regimeSince,
    setRegimeSince,
    portfolio,
    setPortfolio,
    trades,
    setTrades,
    watchlist,
    setWatchlist,
    setMfHoldings,
    setMfWatch,
  } = useSyncedAppState();
  _mfSync = { setHoldings: setMfHoldings, setWatch: setMfWatch };
  const [prefill, setPrefill] = useState(null);
  const [calcSymbol, setCalcSymbol] = useState(null); // stock picked in QUAD → opens in CALC
  const [showTour, setShowTour] = useState(() => { try { return localStorage.getItem("td_tour_done") !== "1"; } catch (_) { return false; } });
  const [stockSym, setStockSym] = useState(null);     // stock detail page
  const [fundCode, setFundCode] = useState(null);     // mutual fund detail page
  const [fundBack, setFundBack] = useState("funds");
  const openFund = (code) => { setFundCode(code); if (page !== "fund") setFundBack(page); setPage("fund"); window.scrollTo(0, 0); };
  const [ipoBack, setIpoBack] = useState("today");
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { const g = NAV_GROUP[page]; if (g && g !== "today" && page !== "fund") { try { localStorage.setItem(`td_last_${g}`, page); } catch (_) {} } }, [page]);
  const [compareSyms, setCompareSyms] = useState([]);
  const [subBack, setSubBack] = useState("today");
  const openSub = (p) => { setSubBack(page === p ? subBack : page); setPage(p); window.scrollTo(0, 0); };
  const openCompare = (sym) => { setCompareSyms(xs => [...new Set([...xs, sym].filter(Boolean))].slice(-3)); openSub("compare"); };
  const openIpos = () => { setPage("ipos"); window.scrollTo(0, 0); };
  const [stockBack, setStockBack] = useState("scan");
  const [pbSub, setPbSub] = useState(() => { try { return localStorage.getItem("td_playbook_sub") || "setups"; } catch (_) { return "setups"; } });
  const choosePbSub = (v) => { setPbSub(v); try { localStorage.setItem("td_playbook_sub", v); } catch (_) {} };
  // Remember where the journal was opened from, for its back button
  const lastPageRef = useRef("today");
  const [journalBack, setJournalBack] = useState("today");
  useEffect(() => {
    if (page === "journal") setJournalBack(lastPageRef.current === "journal" ? "today" : lastPageRef.current);
    else lastPageRef.current = page;
  }, [page]);
  // Old page ids (TRADES / STATS) now live in PLAYBOOK
  useEffect(() => {
    if (page === "trades" || page === "analytics") { choosePbSub("stats"); setPage("playbook"); }
    if (page === "calc") { setPage("today"); setPlanOpen(true); }
  }, [page]);
  const indicesTicker = useIndicesTicker();

  useEffect(() => {
    loadLocalSymbols();
  }, []);

  const handleRegimeChange = (nextRegime) => {
    if (nextRegime === regime) return;
    setRegime(nextRegime);
    setRegimeSince(new Date().toISOString());
  };

  const [planOpen, setPlanOpen] = useState(false);
  const pickStock = (p) => { setCalcSymbol(p || null); setPlanOpen(true); };
  const openStock = (sym) => { setStockSym(sym); setStockBack(page === "stock" ? stockBack : page); setPage("stock"); window.scrollTo(0, 0); };

  // Regime follows QUAD's Bias automatically (BULL/BEAR from Nifty 500 breadth), so the
  // header badge can never contradict the data. Re-checked whenever the page changes.
  useEffect(() => {
    let alive = true;
    loadMarketQuadrant().then((d) => {
      const next = d?.bias ? d.bias.toLowerCase() : null;
      if (alive && next && REGIME_CONFIG[next] && next !== regime) handleRegimeChange(next);
    }).catch(() => {});
    return () => { alive = false; };
  }, [page, regime]);

  const handleSendToJournal = (data) => {
    setPrefill(data);
    setPlanOpen(false);
    setPage("journal");
  };

  const realTrades = trades.filter(t => !t.paper); // paper trades stay out of TODAY, heat, sizing and stats
  return (
    <div style={{ maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "var(--bg)", position: "relative" }}>
      <GlobalStyle />
      <TopBar regime={regime} portfolio={portfolio} page={page} indicesData={indicesTicker} onSearch={() => setSearchOpen(true)} onMenu={() => setMenuOpen(true)} />
      <MenuSheet open={menuOpen} onClose={() => setMenuOpen(false)} portfolio={portfolio} setPortfolio={setPortfolio} onTour={() => setShowTour(true)} />
      {NAV_GROUP[page] === "stocks" && <SegBar items={STOCKS_SEGS} active={page} onPick={(k) => { setPage(k); window.scrollTo(0, 0); }} />}
      {(page === "funds" || page === "ipos") && <SegBar items={INVEST_SEGS} active={page} onPick={(k) => { setPage(k); window.scrollTo(0, 0); }} />}
      {(page === "journal" || page === "playbook") && <SegBar items={JOURNAL_SEGS} active={page === "journal" ? "journal" : pbSub}
        onPick={(k) => { if (k === "journal") setPage("journal"); else { choosePbSub(k); setPage("playbook"); } window.scrollTo(0, 0); }} />}
      <SearchSheet open={searchOpen} onClose={() => setSearchOpen(false)} onOpenStock={openStock} onOpenFund={openFund} onOpenIpos={openIpos} />
      <NiftyStrip data={indicesTicker} />

      {page === "today" && (
        <TodayPage regime={regime} setRegime={handleRegimeChange} regimeSince={regimeSince} portfolio={portfolio} setPortfolio={setPortfolio} trades={realTrades} setPage={setPage}
          watchlist={watchlist} onOpenStock={openStock} onPlan={pickStock} onOpenFund={openFund} onOpenIpos={openIpos} />
      )}
      {page === "ideas" && (
        <IdeasPage watchlist={watchlist} portfolio={portfolio} onOpenStock={openStock} onPlan={pickStock} />
      )}
      <PlanSheet open={planOpen} onClose={() => setPlanOpen(false)}>
        <SectionBoundary name="Trade calculator">
          <CalcPage portfolio={portfolio} trades={realTrades} onSendToJournal={handleSendToJournal} onOpenQuadrant={() => { setPlanOpen(false); setPage("quadrant"); }}
            prefillSymbol={calcSymbol} onPrefillUsed={() => setCalcSymbol(null)} />
        </SectionBoundary>
      </PlanSheet>
      {page === "playbook" && (
        <PlaybookPage trades={trades} setTrades={setTrades} portfolio={portfolio} sub={pbSub} setSub={choosePbSub}
          onOpenStock={openStock} onOpenJournal={() => setPage("journal")} />
      )}
      {page === "journal" && (
        <div>
          <ZerodhaImport trades={trades} setTrades={setTrades} />
          <JournalPage trades={trades} setTrades={setTrades} prefill={prefill} setPrefill={setPrefill} onOpenStock={openStock} />
        </div>
      )}
      {page === "scan" && (
        <ScanPage onPickStock={openStock} watchlist={watchlist} setWatchlist={setWatchlist} />
      )}
      {page === "quadrant" && (
        <MarketQuadrantPage onPickStock={openStock} />
      )}
      {page === "funds" && <FundsPage onOpenFund={openFund} />}
      {page === "movers" && <MoversPage onOpenStock={openStock} />}
      {page === "watch" && (
        <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
          <div className="section-title">Watchlist</div>
          <div style={{ fontSize: 13, color: "var(--text3)", margin: "4px 0 12px" }}>Stocks you're following — today's moves first, then the full list.</div>
          <SectionBoundary name="Watchlist moves"><WatchAlertsCard watchlist={watchlist} onOpen={openStock} /></SectionBoundary>
          <div className="card"><WatchlistPanel watchlist={watchlist} setWatchlist={setWatchlist} onPickStock={openStock} /></div>
        </div>
      )}
      {page === "compare" && <ComparePage syms={compareSyms} setSyms={setCompareSyms} onBack={() => { setPage(subBack); window.scrollTo(0, 0); }} onOpenStock={openStock} />}
      {page === "ipos" && <IposPage onOpenStock={openStock} />}
      {page === "wrap" && <WrapPage trades={realTrades} watchlist={watchlist} indices={indicesTicker} onBack={() => { setPage("today"); window.scrollTo(0, 0); }}
        onOpenStock={openStock} onOpenFunds={() => { setPage("funds"); window.scrollTo(0, 0); }} onOpenQuad={() => { setPage("quadrant"); window.scrollTo(0, 0); }} />}
      {page === "fund" && fundCode && <FundPage code={fundCode} onBack={() => { setPage(fundBack); window.scrollTo(0, 0); }} />}
      {page === "stock" && stockSym && (
        <StockPage symbol={stockSym} onBack={() => setPage(stockBack || "scan")} onPlan={pickStock} watchlist={watchlist} setWatchlist={setWatchlist} trades={trades} onCompare={openCompare} />
      )}

      {showTour && <Tour onDone={() => { setShowTour(false); try { localStorage.setItem("td_tour_done", "1"); } catch (_) {} }} />}

      <BottomNav page={page} setPage={setPage} />
    </div>
  );
}
