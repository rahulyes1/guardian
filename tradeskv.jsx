import { useState, useEffect, useRef, Fragment } from "react";
import { getSupabaseClient } from "./supabaseClient.js";
import {
  MQ_SIGNALS, loadMarketQuadrant, getLastMarketQuadrant, subscribeProgress, signalOnDate, configureSharedStore,
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
      {/* Regime Banner */}
      <div className="card" style={{
        marginBottom: 14,
        background: `linear-gradient(135deg, ${cfg.bg} 0%, var(--bg2) 60%)`,
        border: `1.5px solid ${cfg.color}`,
        boxShadow: cfg.glow,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div>
            <div className="label">Market Regime</div>
            <div style={{ fontFamily: "var(--display)", fontSize: 36, color: cfg.color, lineHeight: 1 }}>
              {cfg.label}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {Object.keys(REGIME_CONFIG).map(r => (
              <button key={r} onClick={() => setRegime(r)}
                className="chip"
                style={regime === r ? { borderColor: REGIME_CONFIG[r].color, color: REGIME_CONFIG[r].color, background: REGIME_CONFIG[r].bg } : { borderColor: THEME_TOKENS.selectorInactiveBorder, color: THEME_TOKENS.selectorInactiveText }}
              >
                {r.toUpperCase()}
              </button>
            ))}
            {regimeSince && (
              <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", textAlign: "center", marginTop: 2 }}>
                Since {new Date(regimeSince).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
              </div>
            )}
          </div>
        </div>
        <div style={{ fontSize: 13, color: "var(--text2)", lineHeight: 1.5 }}>{cfg.text}</div>
      </div>

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
    </div>
  );
}

// ─── CALCULATOR PAGE ─────────────────────────────────────────────────────────
function CalcPage({ portfolio, onSendToJournal, onOpenQuadrant }) {
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

      <MarketSignalStats closed={closed} />

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
const MQ_DIM_COLOR    = { BULL: "#4ADE80", BEAR: "#DC143C", UP: "#4ADE80", DOWN: "#DC143C", RISING: "#4ADE80", FALLING: "#DC143C", HOT: "#4ADE80", WARM: "#A3E635", COOL: "#A39C89", COLD: "#DC143C" };
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
    return () => { alive.current = false; unsub(); };
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
    detail = "Re-checked against NSE's official closes after the market closes (~6 pm IST).";
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

function MqSectorGrid({ sectors }) {
  if (!sectors?.length) return null;
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>SECTOR BREADTH</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 10 }}>% of stocks above 50-SMA · change vs 20 days ago</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {sectors.map(s => {
          const c = MQ_DIM_COLOR[s.status] || "var(--text3)";
          return (
            <div key={s.name} style={{ border: `1px solid ${c}33`, background: `${c}0F`, borderRadius: 10, padding: "8px 10px", minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "var(--text2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={`${s.name} · ${s.n} stocks`}>{s.name}</div>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 3, gap: 4 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{s.p50 ?? "—"}%</span>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: c }}>{s.status}</span>
              </div>
              <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)", marginTop: 2 }}>
                {s.n} stk{s.p50_chg != null && <MqDelta cur={s.p50_chg} prev={0} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MqLeaders({ leaders }) {
  if (!leaders?.length) return null;
  return (
    <div style={mqCardStyle}>
      <div style={{ ...mqHeadStyle, marginBottom: 4 }}>LEADERS</div>
      <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 10 }}>Above 10/50/200-SMA, within 5% of 52w high · ranked by 12-month return</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", columnGap: 12, rowGap: 0, fontSize: 12 }}>
        <span style={{ fontSize: 10, color: "var(--text3)", paddingBottom: 6 }}>STOCK</span>
        <span style={{ fontSize: 10, color: "var(--text3)", textAlign: "right" }}>12M</span>
        <span style={{ fontSize: 10, color: "var(--text3)", textAlign: "right" }}>FROM HIGH</span>
        {leaders.map(l => (
          <Fragment key={l.sym}>
            <div style={{ padding: "6px 0", borderTop: "1px solid var(--border)", minWidth: 0 }}>
              <div style={{ fontFamily: "var(--display)", fontWeight: 700, letterSpacing: "0.02em" }}>{l.sym}</div>
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

function MarketQuadrantPage() {
  const { data, loading, refreshing, error, progress, refresh, retry } = useMarketQuadrant();
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
        <div style={{ fontSize: 11, color: sigColor, marginTop: 6, fontWeight: 600 }}>{MQ_POS_RULE[data.overall]}</div>
        {data.thrust_detected && (
          <div style={{ marginTop: 10, background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.3)", borderRadius: 8, padding: "6px 10px", fontSize: 11, color: "#4ADE80", fontWeight: 700, letterSpacing: "0.1em" }}>
            ⚡ BREADTH THRUST DETECTED
          </div>
        )}
      </div>

      <MqVerificationBadge data={data} />

      <MqSignalTimeline history={h} />

      {/* ── Four Dimensions ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        {[
          { label: "BIAS", value: data.bias, sub: <>{data.pct_above_200}% &gt; 200-SMA<MqDelta cur={data.pct_above_200} prev={prev?.p200} /></> },
          { label: "TREND", value: data.trend, sub: <>{data.pct_above_50}% &gt; 50-SMA<MqDelta cur={data.pct_above_50} prev={prev?.p50} /></> },
          { label: "SWING", value: data.swing, sub: <>{data.pct_above_10}% &gt; 10-SMA<MqDelta cur={data.pct_above_10} prev={prev?.p10} /></> },
          { label: "MOMENTUM", value: data.momentum, sub: <>ROC vs avg {data.momentum_change > 0 ? "+" : ""}{data.momentum_change} pts</> },
        ].map(({ label, value, sub }) => (
          <div key={label} style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14, padding: "14px 12px" }}>
            <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.14em", marginBottom: 6, fontWeight: 700 }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: MQ_DIM_COLOR[value] || "var(--text)", letterSpacing: "-0.02em", lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 5, fontFamily: "var(--mono)" }}>{sub}</div>
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

      <MqSectorGrid sectors={data.sectors} />
      <MqLeaders leaders={data.leaders} />

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
  const warn = data.overall !== "INVEST";
  return (
    <div onClick={onOpen} role={onOpen ? "button" : undefined}
      style={{ cursor: onOpen ? "pointer" : "default", marginBottom: 12, borderRadius: 12, padding: "10px 12px", border: `1px solid ${c}${warn ? "66" : "33"}`, background: `${c}${warn ? "1A" : "0D"}`, display: "flex", gap: 10, alignItems: "center" }}>
      <span style={{ fontSize: 16 }}>{data.overall === "CASH" ? "⛔" : data.overall === "SELECTIVE" ? "⚠️" : "✅"}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: c, letterSpacing: "0.04em" }}>
          Market {data.overall}{stale ? " (stale)" : ""}
        </div>
        <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 2 }}>{MQ_POS_RULE[data.overall]}</div>
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

// ─── BOTTOM NAV ──────────────────────────────────────────────────────────────
function BottomNav({ page, setPage }) {
  const tabs = [
    { id: "today", label: "TODAY", icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
    )},
    { id: "calc", label: "CALC", icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="10" y2="14"/><line x1="14" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="10" y2="18"/><line x1="14" y1="18" x2="16" y2="18"/>
      </svg>
    )},
    { id: "journal", label: "LOG", icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
      </svg>
    )},
    { id: "analytics", label: "STATS", icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>
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
  const indicesTicker = useIndicesTicker();

  useEffect(() => {
    loadLocalSymbols();
  }, []);

  const handleRegimeChange = (nextRegime) => {
    if (nextRegime === regime) return;
    setRegime(nextRegime);
    setRegimeSince(new Date().toISOString());
  };

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
        <CalcPage portfolio={portfolio} onSendToJournal={handleSendToJournal} onOpenQuadrant={() => setPage("quadrant")} />
      )}
      {page === "journal" && (
        <JournalPage trades={trades} setTrades={setTrades} prefill={prefill} setPrefill={setPrefill} />
      )}
      {page === "analytics" && (
        <AnalyticsPage trades={trades} portfolio={portfolio} />
      )}
      {page === "quadrant" && (
        <MarketQuadrantPage />
      )}

      <BottomNav page={page} setPage={setPage} />
    </div>
  );
}
