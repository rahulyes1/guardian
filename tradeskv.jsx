import { useState, useEffect, useRef, Fragment } from "react";
import { getSupabaseClient } from "./supabaseClient.js";
import {
  MQ_SIGNALS, loadMarketQuadrant, getLastMarketQuadrant, subscribeProgress, signalOnDate, configureSharedStore,
  FT_BANDS, FT_CALIBRATION, smaSeries, historyOnDate, istDayKey, fetchResultsCalendar, upcomingResults, loadMicrocapScans,
} from "./marketQuadrant.js";
import { INDEX_KEYS, reconcileIndex } from "./lib/marketChecks.js";
import { useSyncedAppState } from "./appStateSync.js";
// ─── THEME & CONSTANTS ───────────────────────────────────────────────────────
const REGIME_CONFIG = {
  bull:     { label: "BULL", color: "#4ADE80", glow: "0 0 0 rgba(0,0,0,0)", bg: "rgba(74,222,128,0.06)", text: "Trend is constructive. Stay selective, press clean strength, and let quality setups do the work." },
  bear:     { label: "BEAR", color: "#DC143C", glow: "0 0 0 rgba(0,0,0,0)", bg: "rgba(220,20,60,0.06)", text: "Flames consume the careless. Stay defensive. Only high-conviction cuts through the smoke." },
  sideways: { label: "SIDEWAYS", color: "#2DD4BF", glow: "0 0 0 rgba(0,0,0,0)", bg: "rgba(45,212,191,0.06)", text: "Range-bound conditions. Stay patient, stay light, and wait for decisive expansion before committing." },
};

const THEME_TOKENS = {
  selectorInactiveBorder: "#2A2A2A",
  selectorInactiveText: "#A39C89",
  portfolioValue: "#D4CCB6",
  openRiskValue: "#D4CCB6",
  heatNeutral: "#D4CCB6",
  heatWarm: "#A39C89",
  heatHot: "#DC143C",
};

const SETUP_TYPES = ["Breakout", "Pullback", "U&R", "Range Break", "Momentum"];
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
  if (Math.abs(n) >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
  if (Math.abs(n) >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
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
  if (days >= rule.redMin) return { color: "var(--red)", label: `Day ${days} · Decision needed` };
  if (days > rule.greenMax) return { color: "var(--amber)", label: `Day ${days} · Watch closely` };
  return { color: "var(--green)", label: `Day ${days}` };
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
      background: "rgba(10,10,10,0.96)", backdropFilter: "blur(12px)",
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
      --amber:   #A39C89;
      /* ── Void violet (primary accent) ── */
      --blue:    #8B0000;
      --violet:  #DC143C;
      --mono:    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --display: 'Inter', sans-serif;
      --body:    'Inter', sans-serif;
    }

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
    .chip.active {
      border-color: var(--violet);
      color: var(--violet);
      background: rgba(220, 20, 60, 0.08);
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
function TopBar({ regime, portfolio, page, indicesData }) {
  const cfg = REGIME_CONFIG[regime];
  const open = isMarketOpen();
  const nsei = indicesData?.nsei || null;
  const cnx500 = indicesData?.cnx500 || null;
  const fmtIdxPrice = (v) => v?.toLocaleString("en-IN", { maximumFractionDigits: 2 }) ?? "—";
  const fmtIdxPct = (v) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "";
  const pctColor = (v) => v >= 0 ? "var(--green)" : "var(--red)";
  return (
    <div style={{
      position: "sticky", top: 0, zIndex: 100,
      background: "rgba(10,10,10,0.96)", backdropFilter: "blur(24px)",
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

      {/* Center: Nifty live prices */}
      <div style={{
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
              {!open && <span style={{ color: "var(--text3)", fontSize: 8, opacity: 0.7 }}>EOD</span>}
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
              {!open && <span style={{ color: "var(--text3)", fontSize: 8, opacity: 0.7 }}>EOD</span>}
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
      <div style={{
        background: "var(--bg3)", border: "1px solid var(--border2)",
        borderRadius: 10, padding: "5px 10px",
        fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)",
        flexShrink: 0,
      }}>
        {formatINR(portfolio)}
      </div>
    </div>
  );
}

// ─── TODAY PAGE ─────────────────────────────────────────────────────────────
function TodayPage({ regime, setRegime, regimeSince, portfolio, setPortfolio, trades, setPage }) {
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

  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      {/* Market brief — regime and rules come from the data, not a manual toggle */}
      <MarketBrief onOpenQuad={() => setPage("quadrant")} onOpenScan={() => setPage("scan")} />

      {/* Portfolio Value Edit */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="label">Portfolio Value</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="big-num" style={{ color: THEME_TOKENS.portfolioValue, flex: 1 }}>{formatINR(portfolio)}</div>
          <button className="btn-ghost" style={{ padding: "8px 14px", fontSize: 12 }}
            onClick={() => {
              const v = prompt("Enter portfolio value:", portfolio);
              if (v && !isNaN(v)) setPortfolio(Number(v));
            }}>
            Edit
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid-2" style={{ marginBottom: 14 }}>
        <div className="card-sm">
          <div className="label">Open Risk</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: THEME_TOKENS.openRiskValue, marginTop: 4 }}>
            {formatINR(totalRisk)}
          </div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>{pct(totalRisk, portfolio) || "0.0"}% of portfolio</div>
        </div>
        <div className="card-sm">
          <div className="label">Heat</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: getHeatColor(heat), marginTop: 4 }}>
            {heat}%
          </div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>{formatINR(totalRisk)} deployed</div>
        </div>
        {Object.keys(livePrices).length > 0 && (
          <div className="card-sm" style={{ gridColumn: "1 / -1" }}>
            <div className="label">Unrealized P&amp;L (live)</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: totalUnrealized >= 0 ? "var(--green)" : "var(--red)", marginTop: 4 }}>
              {totalUnrealized >= 0 ? "+" : ""}{formatINR(totalUnrealized)}
            </div>
            <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>{pct(totalUnrealized, portfolio)}% of portfolio</div>
          </div>
        )}
        <div className="card-sm">
          <div className="label">Today P&amp;L</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: hasTodayActivity ? (todayPnl >= 0 ? "var(--green)" : "var(--red)") : "var(--text3)", marginTop: 4 }}>
            {hasTodayActivity ? `${todayPnl >= 0 ? "+" : ""}${formatINR(todayPnl)}` : "—"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>closed today</div>
        </div>
        <div className="card-sm">
          <div className="label">Overall P&amp;L</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: closedTrades.length > 0 ? (overallPnl >= 0 ? "var(--green)" : "var(--red)") : "var(--text3)", marginTop: 4 }}>
            {closedTrades.length > 0 ? `${overallPnl >= 0 ? "+" : ""}${formatINR(overallPnl)}` : "—"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>{closedTrades.length} closed trades</div>
        </div>
      </div>

      {/* Open Positions */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div className="section-title" style={{ fontSize: 20 }}>Open Positions</div>
          <div style={{ display: "flex", gap: 8 }}>
            {openTrades.length > 0 && (
              <button className="btn-ghost" style={{ padding: "8px 12px", fontSize: 12, borderRadius: 8 }}
                onClick={() => refreshPrices({ force: true })} disabled={refreshing}>
                {refreshing ? "..." : "↺ Prices"}
              </button>
            )}
            <button className="btn-primary" style={{ padding: "8px 16px", fontSize: 12, borderRadius: 8 }}
              onClick={() => setPage("journal")}>
              + Add
            </button>
          </div>
        </div>
        {openTrades.length === 0 ? (
          <div className="card" style={{ textAlign: "center", padding: "32px 16px" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
            <div style={{ color: "var(--text2)", fontSize: 14, marginBottom: 4 }}>Book is clear</div>
            <div style={{ color: "var(--text3)", fontSize: 12 }}>Start from regime and next valid setup</div>
          </div>
        ) : (
          openTrades.map(t => (
            <OpenTradeCard key={t.id} trade={t} livePrice={livePrices[normalizeSymbol(t.symbol)]} />
          ))
        )}
      </div>

      {/* Quick Stats */}
      {trades.length > 0 && (
        <div className="card">
          <div className="label" style={{ marginBottom: 10 }}>Quick Stats</div>
          {[
            ["Win Rate", `${trades.filter(t=>t.status==='closed'&&(t.pnl||0)>0).length}/${trades.filter(t=>t.status==='closed').length} wins`],
            ["Total P&L", formatINR(trades.filter(t=>t.status==='closed').reduce((s,t)=>s+(t.pnl||0),0))],
          ].map(([l,v]) => (
            <div key={l} className="result-row">
              <span className="result-label">{l}</span>
              <span className="result-val">{v}</span>
            </div>
          ))}
        </div>
      )}
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
              <span className="tag" style={{ background: "rgba(220,20,60,0.08)", color: "var(--violet)", border: "1px solid rgba(220,20,60,0.2)", fontSize: 10 }}>PARTIAL</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
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
  const [symbol, setSymbol] = useState("");
  const [symbolInfo, setSymbolInfo] = useState(null);

  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [riskPct, setRiskPct] = useState(1);
  const [customRisk, setCustomRisk] = useState("");
  const [qty, setQty] = useState("");
  const [qtyMode, setQtyMode] = useState("auto");

  const r = Number(customRisk) > 0 ? Number(customRisk) : riskPct;
  const e = parseFloat(entry), s = parseFloat(stop), t = parseFloat(target);
  const valid = e > 0 && s > 0 && e > s;

  const riskBudget = (portfolio * r) / 100;
  const stopDist = valid ? e - s : null;
  const stopPct = valid ? ((stopDist / e) * 100).toFixed(2) : null;
  const autoQty = valid ? Math.floor(riskBudget / stopDist) : 0;
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
    onSymbolChange: setSymbol,
    onSymbolInfo: setSymbolInfo,
    onLtpSelect: (ltp) => setEntry(String(ltp.toFixed(2))),
  });

  useEffect(() => {
    if (!showSuggestions && symbol && symbol.length >= 2) {
      pinSelectedSymbol(symbol);
    }
  }, [symbol, showSuggestions]);

  // Stock picked from QUAD: select it and fetch its live price as the entry
  useEffect(() => {
    if (!prefillSymbol) return;
    selectSuggestion({ symbol: prefillSymbol, name: prefillSymbol });
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
function JournalPage({ trades, setTrades, prefill, setPrefill }) {
  const [step, setStep] = useState(0); // 0=list, 1=form

  const emptyForm = {
    symbol: "",
    setupType: "Breakout",
    entries: [{ price: "", qty: "" }],
    currentStop: "",
    targets: ["", "", ""],
    notes: "",
    conviction: 3,
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
      symbol: form.symbol,
      setupType: form.setupType,
      conviction: form.conviction,
      notes: form.notes,
      status: "open",
      date: new Date().toISOString(),
      marketSignal: currentMarketSignal(), // QUAD signal at entry (null if no recent data)
      marketTags: currentMarketTags(form.symbol), // signal, environment, follow-through, sector status at entry
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
              onClick={() => setForm(f => ({ ...f, setupType: s }))}>
              {s}
            </button>
          ))}
        </div>
      </div>

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
            <JournalTradeCard key={t.id} trade={t} onUpdateTrade={updateTrade} onDelete={deleteTrade} />
          ))}
        </div>
      )}

      {closedTrades.length > 0 && (
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Closed ({closedTrades.length})</div>
          {closedTrades.map(t => (
            <JournalTradeCard key={t.id} trade={t} onUpdateTrade={updateTrade} onDelete={deleteTrade} />
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
function JournalTradeCard({ trade, onUpdateTrade, onDelete }) {
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
            <div style={{ fontFamily: "var(--display)", fontSize: 22, letterSpacing: "0.04em" }}>{trade.symbol}</div>
            {trade.status === "partial" && (
              <span className="tag" style={{ background: "rgba(220,20,60,0.08)", color: "var(--violet)", border: "1px solid rgba(220,20,60,0.2)" }}>PARTIAL</span>
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
const MQ_SIGNAL_COLOR = { INVEST: "#4ADE80", SELECTIVE: "#F59E0B", CASH: "#DC143C" };
const MQ_SIGNAL_BG    = { INVEST: "rgba(74,222,128,0.08)", SELECTIVE: "rgba(245,158,11,0.08)", CASH: "rgba(220,20,60,0.08)" };
const MQ_DIM_COLOR    = {
  BULL: "#4ADE80", BEAR: "#DC143C", UP: "#4ADE80", DOWN: "#DC143C", SIDEWAYS: "#F59E0B",
  UPSWING: "#4ADE80", DOWNSWING: "#DC143C", CHOPPY: "#A39C89",
  POSITIVE: "#4ADE80", NEGATIVE: "#DC143C", IMPROVING: "#4ADE80", WORSENING: "#DC143C",
  RISING: "#4ADE80", FALLING: "#DC143C", HOT: "#4ADE80", WARM: "#A3E635", COOL: "#A39C89", COLD: "#DC143C",
};
const MQ_ENV_COLOR = { "EASY MONEY": "#4ADE80", "HARD MONEY": "#F59E0B", "NO MONEY": "#DC143C" };
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
    <span style={{ color: d > 0 ? "#4ADE80" : "#DC143C", fontSize: 10, fontFamily: "var(--mono)", whiteSpace: "nowrap" }}>
      {" "}{d > 0 ? "▲ +" : "▼ "}{d}{unit}
    </span>
  );
}

function BreadthBar({ label, pct, prev, count, total }) {
  const fill = pct >= 50 ? "#4ADE80" : pct >= 30 ? "#A39C89" : "#DC143C";
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
  const color = value > 0 ? "#4ADE80" : value < 0 ? "#DC143C" : "var(--text3)";
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
  const c = MQ_ENV_COLOR[env.name] || "var(--text2)";
  return (
    <div style={{ ...mqCardStyle, borderColor: `${c}55`, background: `${c}0D` }}>
      <div style={{ ...mqHeadStyle, marginBottom: 6 }}>ENVIRONMENT</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: c, letterSpacing: "-0.01em" }}>{env.name}</div>
      <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 4, lineHeight: 1.45 }}>{env.text}</div>
      {env.lockout && (
        <div style={{ marginTop: 10, border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.08)", borderRadius: 10, padding: "8px 10px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#F59E0B", letterSpacing: "0.08em", marginBottom: 3 }}>🔒 LOCKOUT RALLY</div>
          <div style={{ fontSize: 11, color: "var(--text2)", lineHeight: 1.45 }}>{env.lockout_text.replace(/^Lockout rally: (\w)/, (_, ch) => ch.toUpperCase())}</div>
        </div>
      )}
      {data.momentum_leaders?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 5 }}>Momentum leaders · sector avg 1-month return</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {data.momentum_leaders.map(m => (
              <span key={m.name} style={{ fontSize: 11, border: "1px solid var(--border)", borderRadius: 14, padding: "3px 9px", color: "var(--text)", background: "var(--bg2)" }}>
                {m.name} <span style={{ fontFamily: "var(--mono)", color: "#4ADE80" }}>+{m.ret1m}%</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const FT_COLOR = { STRONG: "#4ADE80", MIXED: "#F59E0B", WEAK: "#DC143C", "NO PIVOTS": "#A39C89" };

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
                  background: h.rate == null ? "var(--border)" : h.rate >= FT_BANDS.strong ? "#4ADE80" : h.rate >= FT_BANDS.weak ? "#F59E0B" : "#DC143C", opacity: 0.8 }} />
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
          <b style={{ color: lowsOk ? "#4ADE80" : "#F59E0B" }}>{data.new_lows} stocks at 52-week lows</b>
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
    color = "#4ADE80";
    text = `✓ Closes for ${mqFmtDate(v.date)} verified against NSE`;
    detail = `${v.checked} stocks checked against NSE's official bhavcopy` +
      (v.corrected ? ` · ${v.corrected} corrected to NSE values` : " · all matched") +
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
        <div ref={panelRef} style={{ border: `1px solid ${(MQ_DIM_COLOR[sel.status] || "#A39C89")}55`, borderRadius: 12, padding: "10px 12px", marginBottom: 10, background: "var(--bg3)" }}>
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
                  <div style={{ padding: "5px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: v == null ? "var(--text3)" : v >= 0 ? "#4ADE80" : "#DC143C" }}>
                    {v == null ? "—" : `${v > 0 ? "+" : ""}${v}%`}
                  </div>
                );
                return (
                  <Fragment key={st.sym}>
                    <div style={{ padding: "5px 0", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span title={st.a50 ? "Above 50-SMA" : "Below 50-SMA"}
                        style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: st.a50 ? "#4ADE80" : "var(--border2)" }} />
                      <button onClick={() => onPickStock?.(st.sym)} title={`Open ${st.sym}`}
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", font: "inherit", fontFamily: "var(--display)", fontWeight: 700, letterSpacing: "0.02em", overflow: "hidden", textOverflow: "ellipsis", textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{st.sym}</button>
                      {st.a200 && <span style={{ fontSize: 8, color: "var(--text3)" }} title="Above 200-SMA">200↑</span>}
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
          const c = MQ_DIM_COLOR[s.status] || "var(--text3)";
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
            <div style={{ padding: "6px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: (l.ret12m ?? 0) >= 0 ? "#4ADE80" : "#DC143C" }}>
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
  const header = <div style={{ fontSize: 11, color: "var(--text3)", letterSpacing: "0.15em", marginBottom: 16, fontWeight: 700 }}>MARKET QUADRANT</div>;

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
  const sigColor = MQ_SIGNAL_COLOR[data.overall] || "var(--text)";
  const sigBg    = MQ_SIGNAL_BG[data.overall]    || "var(--bg2)";
  const changed  = prev?.sig && prev.sig !== data.overall;

  const updatedAt = (() => {
    try {
      return new Date(data.updated_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) + " IST";
    } catch (_) { return data.updated_at; }
  })();

  const swingConfLabel = data.swing_confidence >= 60 ? "HIGH" : data.swing_confidence >= 40 ? "MEDIUM" : data.swing_confidence >= 20 ? "LOW" : "ZERO";
  const swingConfColor = data.swing_confidence >= 60 ? "#4ADE80" : data.swing_confidence >= 40 ? "#F59E0B" : "var(--text3)";

  return (
    <div className="fade-in" style={{ padding: "20px 16px 100px" }}>
      {header}

      {error && (
        <div style={{ background: "rgba(220,20,60,0.06)", border: "1px solid rgba(220,20,60,0.2)", borderRadius: 10, padding: "8px 12px", color: "var(--red)", fontSize: 12, marginBottom: 12 }}>
          Refresh failed: {error} Showing the last result.
        </div>
      )}

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
          <div style={{ marginTop: 10, background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.3)", borderRadius: 8, padding: "6px 10px", fontSize: 11, color: "#4ADE80", fontWeight: 700, letterSpacing: "0.1em" }}>
            ⚡ BREADTH THRUST DETECTED
          </div>
        )}
      </div>

      <MqEnvironment data={data} />
      <EtfPanel lockout={data.environment?.lockout} onPickStock={onPickStock} />
      <MqFollowThrough data={data} />

      <MqVerificationBadge data={data} />

      <MqSignalTimeline history={h} />

      {/* ── Four Dimensions ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        {[
          {
            label: "BIAS", value: data.bias,
            tag: data.bias_turning ? `TURNING ${data.bias === "BEAR" ? "UP" : "DOWN"}` : null,
            tagColor: data.bias === "BEAR" ? "#4ADE80" : "#DC143C",
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
              <span style={{ color: "#4ADE80" }}>{data.new_highs}</span>
              <span style={{ color: "var(--text3)" }}> / </span>
              <span style={{ color: "#DC143C" }}>{data.new_lows}</span>
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

      <MqSectorGrid sectors={data.sectors} sectorStocks={data.sector_stocks} selected={sector} onSelect={setSector} onPickStock={onPickStock} />
      <MqSectorRotation data={data} onSelect={setSector} />
      <MqThemes themes={data.themes} onPickStock={onPickStock} />
      <MqLeaders leaders={sector ? data.leaders.filter(l => l.sector === sector) : data.leaders} sector={sector} onClear={() => setSector(null)} onPickStock={onPickStock} />

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
                      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "#4ADE80" }}>{fmt(c.needs)}</span>
                      <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", marginTop: 1 }}>gap {fmt(c.gap)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <MqSignalBacktest bt={data.signal_backtest} />
      <MqWeeklyReport data={data} />

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
          <div key={t} style={{ fontSize: 11, color: "#F59E0B", marginTop: 3 }}>⚠ {t}</div>
        ))}
        {ft?.label === "STRONG" && !cautions.length && (
          <div style={{ fontSize: 11, color: "#4ADE80", marginTop: 3 }}>Breakouts are following through ({ft.rate}%)</div>
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
  const env = d.environment?.name;
  let rule;
  if (d.overall === "CASH" || env === "NO MONEY") rule = "No new entries. Protect capital; let stops do their job.";
  else if (env === "HARD MONEY") rule = d.environment?.lockout
    ? "Small size. Prefer index ETFs or lower-timeframe entries; don't chase extended stocks."
    : "Half size. Only A+ setups in HOT/WARM sectors; take profits quicker.";
  else rule = d.follow_through?.label === "STRONG"
    ? "Full size on A-grade setups in HOT/WARM sectors; let winners run."
    : "Normal size, but wait for follow-through — breakouts are a coin flip right now.";
  if (d.lows_ok === false) rule += ` ${d.new_lows} stocks at 52-week lows — cap size.`;
  return rule;
}

/** "What changed since the previous session" bullets, most important first. */
function briefChanges(d) {
  const h = d.history || [];
  const prev = h.length >= 2 ? h[h.length - 2] : null;
  const out = [];
  if (prev?.sig && prev.sig !== d.overall) out.push({ tone: MQ_SIGNAL_COLOR[d.overall], text: `Signal changed ${prev.sig} → ${d.overall}` });
  if (d.bias_turning) out.push({ tone: "#F59E0B", text: `Bias ${d.bias} is turning ${d.bias === "BEAR" ? "up" : "down"}: ${d.bias_days}/${d.bias_needed} sessions ${d.bias === "BEAR" ? "above" : "below"} 50% (200-SMA)` });
  if (d.environment?.lockout) out.push({ tone: "#F59E0B", text: "Lockout rally — stocks running without clean pullback entries" });
  if (d.thrust_detected) out.push({ tone: "#4ADE80", text: "Breadth thrust: 10-day breadth jumped from washed-out levels" });
  if (prev) {
    for (const [k, label] of [["p200", "200-SMA"], ["p50", "50-SMA"], ["p10", "10-SMA"]]) {
      const cur = { p200: d.pct_above_200, p50: d.pct_above_50, p10: d.pct_above_10 }[k];
      const delta = cur != null && prev[k] != null ? +(cur - prev[k]).toFixed(1) : 0;
      if (Math.abs(delta) >= 3) out.push({ tone: delta > 0 ? "#4ADE80" : "#DC143C", text: `% above ${label} ${delta > 0 ? "up" : "down"} ${Math.abs(delta)} pts to ${cur}%` });
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
    out.push({ tone: rank[s.status] > rank[s.status_d1] ? "#4ADE80" : "#DC143C", text: `${s.name}: ${s.status_d1} → ${s.status}` });
  }
  if (d.leaders_new?.length) out.push({ tone: "#4ADE80", text: `New leaders: ${d.leaders_new.slice(0, 5).join(", ")}` });
  if (d.scans?.pivots_total) out.push({ tone: "var(--text2)", text: `${d.scans.pivots_total} pocket pivots today` });
  return out;
}

function MarketBrief({ onOpenQuad, onOpenScan }) {
  const { data, loading, error, progress, retry } = useMarketQuadrant();
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
            <div style={{ height: 3, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.round(progress.pct)}%`, background: "var(--text2)", transition: "width 0.4s ease" }} />
            </div>
          </>
        )}
      </div>
    );
  }
  const d = data;
  const sigColor = MQ_SIGNAL_COLOR[d.overall];
  const envColor = MQ_ENV_COLOR[d.environment?.name] || "var(--text2)";
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
        <span style={{ fontSize: 10, color: verified ? "#4ADE80" : d.final ? "var(--amber)" : "var(--text3)" }}>
          {verified ? "✓ NSE-verified" : d.final ? "awaiting NSE close" : "intraday"}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
        <span style={{ fontFamily: "var(--display)", fontSize: 34, color: sigColor, lineHeight: 1 }}>{d.overall}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: envColor, border: `1px solid ${envColor}66`, borderRadius: 12, padding: "2px 8px" }}>{d.environment?.name}</span>
        {d.environment?.lockout && <span style={{ fontSize: 11, color: "#F59E0B" }}>🔒 lockout</span>}
      </div>
      <div style={{ fontSize: 13, color: "var(--text)", marginTop: 8, lineHeight: 1.45 }}>{briefRule(d)}</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginTop: 12 }}>
        {chips.map(([k, v]) => (
          <div key={k} style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 6px", minWidth: 0 }}>
            <div style={{ fontSize: 8, color: "var(--text3)", letterSpacing: "0.12em" }}>{k}</div>
            <div style={{ fontSize: 11, fontWeight: 700, marginTop: 2, color: k === "MOMENTUM" ? (v === "POS ↗" ? "#4ADE80" : v === "NEG ↘" ? "#DC143C" : "#F59E0B") : (MQ_DIM_COLOR[v.split(" ")[0]] || "var(--text)"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</div>
          </div>
        ))}
      </div>

      {changes.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.12em", marginBottom: 6 }}>WHAT CHANGED</div>
          {changes.slice(0, 8).map((c, i) => (
            <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--text2)", padding: "3px 0", lineHeight: 1.4 }}>
              <span style={{ width: 6, height: 6, borderRadius: 3, background: c.tone, marginTop: 6, flexShrink: 0 }} />
              <span>{c.text}</span>
            </div>
          ))}
        </div>
      )}

      {d.momentum_leaders?.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 10 }}>
          Leading sectors: {d.momentum_leaders.slice(0, 4).map(m => `${m.name} +${m.ret1m}%`).join(" · ")}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button className="btn-primary" style={{ flex: 1, padding: "10px 8px", fontSize: 12 }} onClick={onOpenScan}>
          SCAN · {(d.scans?.pivots_total || 0) + (d.scans?.tight_total || 0) + (d.scans?.reclaim50_total || 0)} ideas
        </button>
        <button className="btn-ghost" style={{ flex: 1, padding: "10px 8px", fontSize: 12 }} onClick={onOpenQuad}>Full QUAD ›</button>
      </div>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 8 }}>
        Header regime ({d.bias}) is set automatically from this breadth data.
      </div>
    </div>
  );
}

const SCAN_DEFS = [
  { id: "pivots", label: "Pivots today", hint: "Up ≥4.5% today on volume above yesterday's and the 50-day average — fresh institutional demand.",
    cols: [["CHG", r => r.chg != null ? `+${r.chg}%` : "—"], ["VOL×", r => r.volx != null ? `${r.volx}×` : "—"], ["3M", r => r.ret3m != null ? `${r.ret3m > 0 ? "+" : ""}${r.ret3m}%` : "—"]] },
  { id: "leaders", label: "Leaders · hot sectors", hint: "Above 10/50/200-SMA, within 5% of 52-week high, in a HOT or WARM sector.",
    cols: [["12M", r => r.ret12m != null ? `${r.ret12m > 0 ? "+" : ""}${r.ret12m}%` : "—"], ["3M", r => r.ret3m != null ? `${r.ret3m > 0 ? "+" : ""}${r.ret3m}%` : "—"], ["HIGH", r => r.off_high != null ? `${r.off_high}%` : "—"]] },
  { id: "tight", label: "Tight near highs", hint: "Above 50 & 200-SMA, within 10% of the 52-week high, last 10 closes in a ≤6% range — low-volatility setups.",
    cols: [["RANGE", r => r.range10 != null ? `${r.range10}%` : "—"], ["HIGH", r => r.off_high != null ? `${r.off_high}%` : "—"], ["3M", r => r.ret3m != null ? `${r.ret3m > 0 ? "+" : ""}${r.ret3m}%` : "—"]] },
  { id: "ep", label: "Earnings EP", hint: "Episodic pivots: ≥8% up on ≥3× average volume in the last 5 sessions and still holding. ★ = results were due around the move.",
    cols: [["DAY", r => mqFmtDate(r.d)], ["MOVE", r => `+${r.chg}% ${r.volx}×`], ["SINCE", r => `${r.held > 0 ? "+" : ""}${r.held}%`]] },
  { id: "ipo", label: "IPO bases", hint: "Listed within ~12 months and trading within 5% of the highest close since listing. ↑ = breaking above it today.",
    cols: [["AGE", r => `${r.days}d`], ["LISTING", r => `${r.from_listing > 0 ? "+" : ""}${r.from_listing}%`], ["HIGH", r => (r.breakout ? "↑ new" : `${r.off_high}%`)]] },
  { id: "reclaim50", label: "Reclaimed 50-SMA", hint: "Closed back above the 50-day average today after being below it yesterday.",
    cols: [["200↑", r => (r.a200 ? "yes" : "no")], ["HIGH", r => r.off_high != null ? `${r.off_high}%` : "—"], ["3M", r => r.ret3m != null ? `${r.ret3m > 0 ? "+" : ""}${r.ret3m}%` : "—"]] },
];

const SCAN_SORT = {
  pivots: (a, b) => b.volx * b.chg - a.volx * a.chg,
  ep: (a, b) => (b.results - a.results) || (b.d > a.d ? 1 : b.d < a.d ? -1 : 0) || (b.volx * b.chg - a.volx * a.chg),
  ipo: (a, b) => (b.breakout - a.breakout) || (b.from_listing - a.from_listing),
  leaders: (a, b) => (b.ret12m ?? b.ret3m ?? -999) - (a.ret12m ?? a.ret3m ?? -999),
  tight: (a, b) => (b.ret3m ?? -999) - (a.ret3m ?? -999),
  reclaim50: (a, b) => (b.ret3m ?? -999) - (a.ret3m ?? -999),
};

function ScanPage({ onPickStock }) {
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
  const pick = (id) => { setTab(id); try { localStorage.setItem("td_scan_tab", id); } catch (_) {} };

  const head = (
    <div style={{ marginBottom: 14 }}>
      <div className="section-title">Scan</div>
      <div style={{ fontSize: 13, color: "var(--text3)", marginTop: 4 }}>Nifty 500 setups from today's close. Tap a stock for its chart and checklist.</div>
    </div>
  );
  if (!data?.scans) {
    return (
      <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
        {head}
        <div className="card" style={{ fontSize: 12, color: error ? "var(--red)" : "var(--text3)" }}>
          {error || (loading ? progress.msg : "Loading…")}
          {error && <button className="btn-ghost" style={{ marginTop: 10, width: "100%" }} onClick={retry}>Retry</button>}
        </div>
      </div>
    );
  }

  const statusOf = Object.fromEntries((data.sectors || []).map(s => [s.name, s.status]));
  const hot = (l) => ["HOT", "WARM"].includes(statusOf[l.sector]);
  const base = {
    pivots: data.scans.pivots || [], tight: data.scans.tight || [], reclaim50: data.scans.reclaim50 || [],
    ep: data.scans.ep || [], ipo: data.scans.ipo || [], leaders: (data.leaders || []).filter(hot),
  };
  const totals = { pivots: data.scans.pivots_total, tight: data.scans.tight_total, reclaim50: data.scans.reclaim50_total,
    ep: data.scans.ep_total || 0, ipo: data.scans.ipo_total || 0, leaders: base.leaders.length };
  const lists = { ...base };
  if (micro && microData?.scans) {
    const m = microData.scans, tag = (xs) => (xs || []).map(x => ({ ...x, micro: true }));
    const add = { pivots: tag(m.pivots), tight: tag(m.tight), reclaim50: tag(m.reclaim50), ep: tag(m.ep), ipo: tag(m.ipo), leaders: tag((microData.leaders || []).filter(hot)) };
    for (const k of Object.keys(add)) {
      const seen = new Set(base[k].map(x => x.sym));
      lists[k] = [...base[k], ...add[k].filter(x => !seen.has(x.sym))].sort(SCAN_SORT[k]).slice(0, 25);
      totals[k] = (totals[k] || 0) + ({ pivots: m.pivots_total, tight: m.tight_total, reclaim50: m.reclaim50_total, ep: m.ep_total, ipo: m.ipo_total, leaders: add.leaders.length }[k] || 0);
    }
  }
  const def = SCAN_DEFS.find(x => x.id === tab) || SCAN_DEFS[0];
  const rows = lists[def.id] || [];
  const verified = data.verification && data.verification.date === data.as_of;

  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      {head}
      <MarketSignalBanner />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 11, color: "var(--text3)" }}>
        Universe:
        {[[false, "Nifty 500"], [true, "+ Microcap 250"]].map(([v, l]) => (
          <button key={l} className="chip" onClick={() => setMicro(v)} aria-pressed={micro === v}
            style={micro === v ? { borderColor: "var(--text)", color: "var(--text)" } : {}}>{l}</button>
        ))}
        {micro && microState === "loading" && <span>loading microcaps…</span>}
        {micro && microState && microState !== "loading" && <span style={{ color: "var(--red)" }}>{microState}</span>}
      </div>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, marginBottom: 10, scrollbarWidth: "none" }}>
        {SCAN_DEFS.map(x => (
          <button key={x.id} onClick={() => pick(x.id)} className="chip" aria-pressed={x.id === def.id}
            style={x.id === def.id ? { borderColor: "var(--text)", color: "var(--text)", whiteSpace: "nowrap" } : { whiteSpace: "nowrap" }}>
            {x.label} <span style={{ fontFamily: "var(--mono)", opacity: 0.7 }}>{totals[x.id] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="card">
        <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 10, lineHeight: 1.45 }}>{def.hint}</div>
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
                    <div style={{ fontSize: 10, color: "var(--text3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {r.results && <span style={{ color: "#F59E0B", marginRight: 4 }} title="Results were due around this move">★</span>}
                      {r.sector}{st && st !== "—" && <span style={{ color: MQ_DIM_COLOR[st], marginLeft: 4 }}>· {st}</span>}
                      {r.micro && <span style={{ marginLeft: 4, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: 6, padding: "0 4px", fontSize: 9 }}>micro</span>}
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
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 10 }}>
        Data as of {mqFmtDate(data.as_of)} {verified ? "· ✓ closes verified against NSE" : data.final ? "· awaiting NSE's official closes" : "· intraday"}. Ideas, not recommendations — check the chart and your plan.
      </div>
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

async function fetchStockDetail(sym) {
  const tk = `${sym}.NS`;
  const url = `/api/spark?symbols=${encodeURIComponent(`${tk},${IDX_TICKER}`)}&range=2y&interval=1d&vol=260`;
  const [sparkRes, bhavRes] = await Promise.all([
    fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null),
    fetch("/api/nse?type=bhav").then(r => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const items = Object.fromEntries((sparkRes?.spark?.result || []).map(it => [it.symbol, it]));
  const s = items[tk], ix = items[IDX_TICKER];
  if (!s) throw new Error(`No price history for ${sym}`);
  const toDays = (it) => {
    const r = it.response[0], ts = r.timestamp, cl = r.indicators.quote[0].close;
    const off = ts.length - (it.volTail || []).length;
    const rows = {};
    ts.forEach((t, i) => { if (cl[i] != null) rows[istDayKey(t)] = { c: cl[i], v: i >= off ? it.volTail[i - off] : null }; });
    return rows;
  };
  const sd = toDays(s), id = ix ? toDays(ix) : {};
  const dates = Object.keys(sd).sort();
  const closes = dates.map(d => sd[d].c), vols = dates.map(d => sd[d].v);

  // Verify / correct the latest closes against NSE's official bhavcopy
  let verified = null;
  const b = bhavRes?.closes?.[sym];
  if (b && bhavRes.date) {
    let i = dates.indexOf(bhavRes.date);
    if (i < 0 && bhavRes.date > dates[dates.length - 1]) { dates.push(bhavRes.date); closes.push(b[1]); vols.push(null); i = dates.length - 1; }
    if (i >= 0) {
      const fix = (k, official) => { if (k >= 0 && official != null && Math.abs(closes[k] / official - 1) > 0.001) { closes[k] = official; return true; } return false; };
      const c1 = fix(i, b[1]), c2 = fix(i - 1, b[0]);
      verified = { date: bhavRes.date, corrected: c1 || c2 };
    }
  }
  const idx = dates.map(d => id[d]?.c ?? null);
  return {
    sym, dates, closes, vols, idx, verified,
    s10: smaSeries(closes, 10, 8), s50: smaSeries(closes, 50, 40), s200: smaSeries(closes, 200, 150),
  };
}

function StockChart({ d, from }) {
  const [hover, setHover] = useState(null);
  const n = d.dates.length, start = Math.max(0, n - from);
  const idx = Array.from({ length: n - start }, (_, k) => start + k);
  const W = 340, H = 150, VH = 34, padL = 4, padR = 40, padT = 6;
  const vals = idx.flatMap(i => [d.closes[i], d.s10[i], d.s50[i], d.s200[i]]).filter(v => v != null);
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
        {STOCK_SERIES.map(s => <path key={s.key} d={path(d[s.key])} fill="none" stroke={s.color} strokeWidth="1.4" />)}
        <path d={path(d.closes)} fill="none" stroke="var(--text)" strokeWidth="1.8" strokeLinejoin="round" />
        {idx.map((i, k) => d.vols[i] ? (
          <rect key={i} x={x(k) - 0.6} width="1.2" y={H + 6 + VH - (d.vols[i] / maxV) * VH} height={(d.vols[i] / maxV) * VH}
            fill={d.closes[i] >= (d.closes[i - 1] ?? d.closes[i]) ? "#4ADE80" : "#DC143C"} opacity="0.55" />
        ) : null)}
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
          <div>₹{d.closes[hi_].toFixed(2)}</div>
          {STOCK_SERIES.map(s => d[s.key][hi_] != null && <div key={s.key} style={{ color: "var(--text2)" }}><span style={{ display: "inline-block", width: 8, height: 2, background: s.color, marginRight: 5, verticalAlign: "middle" }} />{s.label} {d[s.key][hi_].toFixed(1)}</div>)}
          {d.vols[hi_] != null && <div style={{ color: "var(--text3)" }}>Vol {(d.vols[hi_] / 1e5).toFixed(1)}L</div>}
        </div>
      )}
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
    <div style={{ fontSize: 11, color: "#F59E0B", border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.07)", borderRadius: 8, padding: "6px 9px", ...style }}>
      📅 Results {up.inDays === 0 ? "today" : up.inDays === 1 ? "tomorrow" : `in ${up.inDays} days`} ({mqFmtDate(up.date)}) — expect a big gap either way; size down or wait.
    </div>
  );
}

function StockPage({ symbol, onBack, onPlan }) {
  const { data: mq } = useMarketQuadrant();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [range, setRange] = useState(250);
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
  const rel3 = periods[1].rel;
  const checks = [
    ["Above 50 & 200-day SMA", d.s50[last] != null && d.s200[last] != null && c > d.s50[last] && c > d.s200[last]],
    [`Sector ${sector || "?"} is HOT/WARM${secInfo ? ` (${secInfo.status})` : ""}`, ["HOT", "WARM"].includes(secInfo?.status)],
    ["Within 15% of 52-week high", offHigh >= -15],
    ["Beating Nifty 500 over 3 months", rel3 != null && rel3 > 0],
    [`Market allows new longs (${mq?.environment?.name || "?"})`, mq ? mq.overall !== "CASH" && mq.environment?.name !== "NO MONEY" : false],
    [`Breakouts following through (${mq?.follow_through?.rate ?? "?"}%)`, mq?.follow_through?.label === "STRONG"],
  ];
  const score = checks.filter(x => x[1]).length;
  const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
  const col = (v) => (v == null ? "var(--text3)" : v >= 0 ? "#4ADE80" : "#DC143C");

  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      {header}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 24, fontWeight: 700 }}>₹{c.toFixed(2)}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: col(chg) }}>{pct(chg)}</span>
          <span style={{ fontSize: 11, color: "var(--text3)" }}>{mqFmtDate(d.dates[last])} close{d.verified ? (d.verified.date === d.dates[last] ? " · ✓ NSE" : "") : " · unverified"}</span>
        </div>
        <ResultsWarning symbol={symbol} style={{ marginTop: 8 }} />
        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>
          {sector || "—"}{secInfo && <span style={{ color: MQ_DIM_COLOR[secInfo.status] }}> · {secInfo.status}</span>}{secInfo?.quadrant && ` · ${secInfo.quadrant.toLowerCase()}`} · {offHigh.toFixed(1)}% from 52w high
        </div>
        <div style={{ display: "flex", gap: 6, margin: "12px 0 6px" }}>
          {[["3M", 63], ["6M", 126], ["1Y", 250]].map(([l, n]) => (
            <button key={l} className="chip" onClick={() => setRange(n)} aria-pressed={range === n}
              style={range === n ? { borderColor: "var(--text)", color: "var(--text)" } : {}}>{l}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 10, color: "var(--text2)", marginBottom: 4 }}>
          <span><span style={{ display: "inline-block", width: 10, height: 2, background: "var(--text)", marginRight: 4, verticalAlign: "middle" }} />Price</span>
          {STOCK_SERIES.map(s => <span key={s.key}><span style={{ display: "inline-block", width: 10, height: 2, background: s.color, marginRight: 4, verticalAlign: "middle" }} />{s.label}</span>)}
        </div>
        <StockChart d={d} from={range} />
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Relative strength vs Nifty 500</div>
        <svg viewBox="0 0 340 60" width="100%" style={{ display: "block" }} role="img" aria-label="Relative strength line versus Nifty 500">
          {(() => {
            const vals = rsLine.filter(v => v != null); if (!vals.length) return null;
            const lo = Math.min(...vals, 100), hi = Math.max(...vals, 100), sp = hi - lo || 1, n = d.closes.length - startI;
            const X = (i) => ((i - startI) / Math.max(1, n - 1)) * 300, Y = (v) => 4 + (1 - (v - lo) / sp) * 52;
            let p = ""; rsLine.forEach((v, i) => { if (v != null) p += `${p ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; });
            return (<>
              <line x1="0" x2="300" y1={Y(100)} y2={Y(100)} stroke="var(--border)" strokeDasharray="3 3" />
              <path d={p} fill="none" stroke={vals[vals.length - 1] >= 100 ? "#4ADE80" : "#DC143C"} strokeWidth="1.6" />
              <text x="304" y={Y(vals[vals.length - 1]) + 3} fontSize="9" fill="var(--text2)" fontFamily="var(--mono)">{vals[vals.length - 1].toFixed(0)}</text>
            </>);
          })()}
        </svg>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr 1fr", columnGap: 10, rowGap: 4, fontSize: 11, marginTop: 8, fontFamily: "var(--mono)" }}>
          <span style={{ color: "var(--text3)" }} />
          <span style={{ color: "var(--text3)", textAlign: "right" }}>{symbol}</span>
          <span style={{ color: "var(--text3)", textAlign: "right" }}>N500</span>
          <span style={{ color: "var(--text3)", textAlign: "right" }}>Edge</span>
          {periods.map(p => (
            <Fragment key={p.l}>
              <span style={{ color: "var(--text3)" }}>{p.l}</span>
              <span style={{ textAlign: "right", color: col(p.s) }}>{pct(p.s)}</span>
              <span style={{ textAlign: "right", color: "var(--text2)" }}>{pct(p.ix)}</span>
              <span style={{ textAlign: "right", color: col(p.rel), fontWeight: 700 }}>{p.rel == null ? "—" : `${p.rel > 0 ? "+" : ""}${p.rel.toFixed(1)}`}</span>
            </Fragment>
          ))}
        </div>
        <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>Line = price ÷ Nifty 500, rebased to 100. Rising = outperforming.</div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Fits today's market? <span style={{ color: score >= 5 ? "#4ADE80" : score >= 3 ? "#F59E0B" : "#DC143C" }}>{score}/6</span></div>
        {checks.map(([t, ok]) => (
          <div key={t} style={{ display: "flex", gap: 8, fontSize: 12, padding: "3px 0", color: ok ? "var(--text)" : "var(--text3)" }}>
            <span style={{ color: ok ? "#4ADE80" : "#DC143C", width: 12 }}>{ok ? "✓" : "✗"}</span>{t}
          </div>
        ))}
        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 8 }}>
          Pocket pivots (60 sessions): {pivots.length ? pivots.slice(-5).map(mqFmtDate).join(", ") : "none"}
        </div>
      </div>

      <button className="btn-primary" style={{ width: "100%" }} onClick={() => onPlan(symbol)}>Plan a trade in {symbol} ›</button>
      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 10 }}>Information only — not a recommendation.</div>
    </div>
  );
}

// ─── SECTOR ROTATION (D) ──────────────────────────────────────────────────────
const QUAD_COLOR = { LEADING: "#4ADE80", WEAKENING: "#F59E0B", LAGGING: "#DC143C", IMPROVING: "#3987E5" };
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
  if (!reports.length) return null;
  const rep = reports[Math.min(sel, reports.length - 1)];
  const copy = async () => {
    try { await navigator.clipboard.writeText(rep.text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (_) {}
  };
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>WEEKLY REPORT</span>
        <button onClick={copy} className="chip" style={{ fontSize: 10, letterSpacing: 0 }}>{copied ? "Copied ✓" : "Copy"}</button>
      </div>
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
    ft: d.follow_through?.label || null, sector,
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
  if (pct > 0 && d.follow_through?.label === "WEAK") { pct /= 2; why.push("follow-through weak"); }
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
          <button className="chip" style={{ fontSize: 10 }} onClick={() => onApply(s.pct)}>Use {s.pct}%</button>
        )}
      </div>
      <div style={{ fontSize: 11, color: over ? "#F59E0B" : "var(--text3)", marginTop: 4, fontFamily: "var(--mono)" }}>
        Portfolio heat {heat.toFixed(1)}% → {after.toFixed(1)}% after this trade · cap {s.heatCap}%
      </div>
      {s.pct === 0 && <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 4 }}>⚠ Market rules say no new entries today.</div>}
      {s.pct > 0 && above && <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 4 }}>⚠ {riskPct}% is above today's suggested risk.</div>}
      {s.pct > 0 && over && <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 4 }}>⚠ This would take total open risk over the {s.heatCap}% cap.</div>}
    </div>
  );
}

// Per-stock daily trend for open positions (cached per symbol per day)
const _trendCache = new Map();
async function stockTrend(sym) {
  const key = `${sym}|${istDayKey(Math.floor(Date.now() / 1000))}`;
  if (_trendCache.has(key)) return _trendCache.get(key);
  const p = fetchStockDetail(sym).then(d => {
    const i = d.closes.length - 1;
    const s20 = smaSeries(d.closes, 20, 15);
    return { close: d.closes[i], s10: d.s10[i], s20: s20[i], s50: d.s50[i], s200: d.s200[i], date: d.dates[i] };
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
  if (trend?.s50 != null && trend.close < trend.s50) bump(2, "Closed below its 50-day SMA");
  else if (trend?.s20 != null && trend.close < trend.s20) bump(1, "Closed below its 20-day SMA");
  else if (trend?.s10 != null && trend.close < trend.s10) bump(1, "Closed below its 10-day SMA");
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
  if (/Decision needed/.test(st.label)) bump(1, `Day ${days}: past the time limit for a ${t.setupType}`);
  const label = ["HOLD", "TIGHTEN STOP", "EXIT"][level];
  return { level, label, color: ["#4ADE80", "#F59E0B", "#DC143C"][level], reasons: reasons.sort((a, b) => b.l - a.l).map(r => r.why) };
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
    if (h.level < 1) { h.level = 1; h.label = "TIGHTEN STOP"; h.color = "#F59E0B"; }
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
          10d {trend.s10?.toFixed(1) ?? "—"} · 20d {trend.s20?.toFixed(1) ?? "—"} · 50d {trend.s50?.toFixed(1) ?? "—"} (close {mqFmtDate(trend.date)})
        </div>
      )}
    </div>
  );
}

/** Rule-following score for a closed trade (5 checks, from conditions at entry). */
function disciplineScore(t, mq, portfolio) {
  const ctx = tradeContext(t, mq);
  const entryRow = historyOnDate(mq, t.entries?.[0]?.date || t.date);
  const sugg = suggestedRisk(entryRow ? { environment: { name: ctx.env }, overall: ctx.signal, follow_through: { label: ctx.ft } } : null);
  const riskPct = portfolio && t.riskAmount ? (t.riskAmount / portfolio) * 100 : null;
  const checks = [
    ["Signal wasn't CASH", ctx.signal ? ctx.signal !== "CASH" : null],
    ["Environment wasn't No money", ctx.env ? ctx.env !== "NO MONEY" : null],
    ["Sector HOT/WARM", ctx.sectorStatus ? ["HOT", "WARM"].includes(ctx.sectorStatus) : null],
    ["Risk within suggested size", sugg && riskPct != null ? riskPct <= sugg.pct + 0.1 : null],
    ["Had a stop", (t.currentStop || t.stop) > 0],
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
        <span style={{ fontFamily: "var(--mono)", fontSize: 24, fontWeight: 800, color: avgScore >= 0.8 ? "#4ADE80" : avgScore >= 0.6 ? "#F59E0B" : "#DC143C" }}>{Math.round(avgScore * 100)}%</span>
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

function MqSignalBacktest({ bt }) {
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
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>DOES THE SIGNAL WORK?</div>
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
            <span style={{ textAlign: "right", paddingTop: 4, color: r >= 0 ? "#4ADE80" : "#DC143C" }}>{r > 0 ? "+" : ""}{r}%</span>
            <span style={{ textAlign: "right", paddingTop: 4, color: "#DC143C" }}>{dd}%</span>
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
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: (t.ret1m ?? 0) >= 0 ? "#4ADE80" : "#DC143C", width: 48, textAlign: "right" }}>{t.ret1m == null ? "—" : `${t.ret1m > 0 ? "+" : ""}${t.ret1m}%`}</span>
          </div>
          {t.top?.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
              {t.top.slice(0, 4).map(x => (
                <button key={x.sym} onClick={() => onPickStock?.(x.sym)} title={`Open ${x.sym}`}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10, color: "var(--text2)", textDecoration: "underline dotted", textUnderlineOffset: 3 }}>
                  {x.sym} <span style={{ color: x.ret3m >= 0 ? "#4ADE80" : "#DC143C" }}>{x.ret3m > 0 ? "+" : ""}{x.ret3m}%</span>
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
  const col = { UP: "#4ADE80", DOWN: "#DC143C", MIXED: "#F59E0B" };
  return (
    <div style={{ ...mqCardStyle, borderColor: lockout ? "rgba(245,158,11,0.4)" : "var(--border)" }}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>INDEX ETFS</div>
      <div style={{ fontSize: 11, color: lockout ? "#F59E0B" : "var(--text3)", marginBottom: 8 }}>
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
            <span style={{ padding: "6px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontFamily: "var(--mono)", color: (r.ret1m ?? 0) >= 0 ? "#4ADE80" : "#DC143C" }}>{r.ret1m == null ? "—" : `${r.ret1m > 0 ? "+" : ""}${r.ret1m.toFixed(1)}%`}</span>
            <span style={{ padding: "6px 0", borderTop: "1px solid var(--border)", textAlign: "right", fontSize: 11, color: r.above10 ? "#4ADE80" : "#DC143C" }}>{r.above10 ? "above" : "below"}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ─── BOTTOM NAV ──────────────────────────────────────────────────────────────
function BottomNav({ page, setPage }) {
  const tabs = [
    { id: "today", label: "TODAY", icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
    )},
    { id: "scan", label: "SCAN", icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><polyline points="8 12 10 10 12 12 14 9"/>
      </svg>
    )},
    { id: "calc", label: "CALC", icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="10" y2="14"/><line x1="14" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="10" y2="18"/><line x1="14" y1="18" x2="16" y2="18"/>
      </svg>
    )},
    { id: "trades", label: "TRADES", icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="18" x2="8" y2="15"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="16" y1="18" x2="16" y2="14"/>
      </svg>
    )},
    { id: "quadrant", label: "QUAD", icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>
      </svg>
    )},
  ];

  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 200,
      background: "rgba(10,10,10,0.98)", backdropFilter: "blur(24px)",
      borderTop: "1px solid var(--border2)",
      boxShadow: "none",
      display: "flex",
      paddingBottom: "env(safe-area-inset-bottom)",
      maxWidth: 480, margin: "0 auto",
    }}>
      {tabs.map(tab => (
        <button key={tab.id} className={`nav-tab ${page === tab.id ? "active" : ""}`}
          onClick={() => setPage(tab.id)}>
          {tab.icon}
          {tab.label}
        </button>
      ))}
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
  } = useSyncedAppState();
  const [prefill, setPrefill] = useState(null);
  const [calcSymbol, setCalcSymbol] = useState(null); // stock picked in QUAD → opens in CALC
  const [stockSym, setStockSym] = useState(null);     // stock detail page
  const [stockBack, setStockBack] = useState("scan");
  const [tradesSub, setTradesSub] = useState(() => { try { return localStorage.getItem("td_trades_sub") || "journal"; } catch (_) { return "journal"; } });
  const chooseTradesSub = (v) => { setTradesSub(v); try { localStorage.setItem("td_trades_sub", v); } catch (_) {} };
  // Old page ids (LOG / STATS) now live inside TRADES
  useEffect(() => {
    if (page === "journal") { chooseTradesSub("journal"); setPage("trades"); }
    if (page === "analytics") { chooseTradesSub("stats"); setPage("trades"); }
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

  const pickStock = (sym) => { setCalcSymbol(sym); setPage("calc"); window.scrollTo(0, 0); };
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
    setPage("journal");
  };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "var(--bg)", position: "relative" }}>
      <GlobalStyle />
      <TopBar regime={regime} portfolio={portfolio} page={page} indicesData={indicesTicker} />
      <NiftyStrip data={indicesTicker} />

      {page === "today" && (
        <TodayPage regime={regime} setRegime={handleRegimeChange} regimeSince={regimeSince} portfolio={portfolio} setPortfolio={setPortfolio} trades={trades} setPage={setPage} />
      )}
      {page === "calc" && (
        <CalcPage portfolio={portfolio} trades={trades} onSendToJournal={handleSendToJournal} onOpenQuadrant={() => setPage("quadrant")}
          prefillSymbol={calcSymbol} onPrefillUsed={() => setCalcSymbol(null)} />
      )}
      {page === "trades" && (
        <TradesPage sub={tradesSub} setSub={chooseTradesSub}
          journalProps={{ trades, setTrades, prefill, setPrefill }} statsProps={{ trades, portfolio }} />
      )}
      {page === "scan" && (
        <ScanPage onPickStock={openStock} />
      )}
      {page === "quadrant" && (
        <MarketQuadrantPage onPickStock={openStock} />
      )}
      {page === "stock" && stockSym && (
        <StockPage symbol={stockSym} onBack={() => setPage(stockBack || "scan")} onPlan={pickStock} />
      )}

      <BottomNav page={page} setPage={setPage} />
    </div>
  );
}
