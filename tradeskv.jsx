import { useState, useEffect, useRef } from "react";

// ─── THEME & CONSTANTS ───────────────────────────────────────────────────────
const REGIME_CONFIG = {
  bull: { label: "BULL", color: "#00FF88", glow: "0 0 20px #00FF8855", bg: "#00FF8815", text: "Participation is healthy. Focus on clean risk and strong follow-through." },
  bear: { label: "BEAR", color: "#FF4466", glow: "0 0 20px #FF446655", bg: "#FF446615", text: "Stay defensive. Reduce size. Only high-conviction setups." },
  sideways: { label: "SIDE", color: "#FFAA00", glow: "0 0 20px #FFAA0055", bg: "#FFAA0015", text: "Range-bound. Wait for breakout confirmation before adding risk." },
};

const SETUP_TYPES = ["Breakout", "Pullback", "U&R", "Range Break", "Momentum"];

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

// ─── YAHOO FINANCE ───────────────────────────────────────────────────────────
const _priceCache = new Map(); // ticker → { result, ts }

async function fetchStockPrice(symbol) {
  if (!symbol || symbol.length < 2) return null;
  const ticker = /\./.test(symbol) ? symbol : `${symbol}.NS`;
  const cached = _priceCache.get(ticker);
  if (cached && Date.now() - cached.ts < 30000) return cached.result;

  const yUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`;
  const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(yUrl)}`;

  for (const url of [yUrl, proxyUrl]) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const data = await res.json();
      const q = data?.quoteResponse?.result?.[0];
      if (q && q.regularMarketPrice) {
        const result = {
          price: q.regularMarketPrice,
          name: q.shortName || q.longName || symbol,
          changePct: q.regularMarketChangePercent || 0,
        };
        _priceCache.set(ticker, { result, ts: Date.now() });
        return result;
      }
    } catch {}
  }
  return null;
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
function isMarketOpen() {
  const now = new Date();
  const ist = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 5.5 * 3600000);
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

async function fetchIndexData(encodedSymbol) {
  const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}`;
  const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(yUrl)}`;
  for (const url of [yUrl, proxyUrl]) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        const price = meta.regularMarketPrice;
        const prev = meta.previousClose || meta.chartPreviousClose || price;
        const changePct = ((price - prev) / prev) * 100;
        return { price, changePct };
      }
    } catch {}
  }
  return null;
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
function NiftyStrip() {
  const [nsei, setNsei] = useState(null);
  const [cnx500, setCnx500] = useState(null);

  const fetchAll = async () => {
    const [n, c] = await Promise.all([
      fetchIndexData("%5ENSEI"),
      fetchIndexData("%5ECNX500"),
    ]);
    if (n) setNsei(n);
    if (c) setCnx500(c);
  };

  useEffect(() => {
    fetchAll();
    if (!isMarketOpen()) return;
    const iv = setInterval(fetchAll, 60000);
    return () => clearInterval(iv);
  }, []);

  const fmtPrice = (v) => v?.toLocaleString("en-IN", { maximumFractionDigits: 2 }) ?? "—";
  const fmtPct = (v) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "";
  const pctColor = (v) => v >= 0 ? "var(--green)" : "var(--red)";
  const open = isMarketOpen();

  return (
    <div style={{
      background: "var(--bg2)", borderBottom: "1px solid var(--border)",
      padding: "5px 16px", display: "flex", alignItems: "center", gap: 16,
      fontFamily: "var(--mono)", fontSize: 11, overflowX: "auto", whiteSpace: "nowrap",
    }}>
      {nsei && (
        <span>
          <span style={{ color: "var(--text3)", marginRight: 4 }}>NIFTY 50</span>
          <span style={{ color: "var(--text)" }}>{fmtPrice(nsei.price)}</span>
          {" "}<span style={{ color: pctColor(nsei.changePct) }}>{fmtPct(nsei.changePct)}</span>
        </span>
      )}
      {cnx500 && (
        <span>
          <span style={{ color: "var(--text3)", marginRight: 4 }}>NIFTY 500</span>
          <span style={{ color: "var(--text)" }}>{fmtPrice(cnx500.price)}</span>
          {" "}<span style={{ color: pctColor(cnx500.changePct) }}>{fmtPct(cnx500.changePct)}</span>
        </span>
      )}
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5 }}>
        {open ? (
          <>
            <span className="pulse-dot" style={{ background: "var(--green)", display: "inline-block" }} />
            <span style={{ color: "var(--green)", fontWeight: 600 }}>OPEN</span>
          </>
        ) : (
          <span style={{ color: "var(--text3)" }}>CLOSED</span>
        )}
      </span>
    </div>
  );
}

// ─── GLOBAL STYLES ──────────────────────────────────────────────────────────
const GlobalStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #080C0F;
      --bg2: #0D1318;
      --bg3: #131B22;
      --bg4: #1A2430;
      --border: #1E2D3D;
      --border2: #243545;
      --text: #E8F0F8;
      --text2: #7A99B8;
      --text3: #4A6480;
      --green: #00E87A;
      --green2: #00B85E;
      --red: #FF3D5A;
      --amber: #FFB020;
      --blue: #3D9EFF;
      --mono: 'DM Mono', monospace;
      --display: 'Bebas Neue', sans-serif;
      --body: 'DM Sans', sans-serif;
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
      border: 1.5px solid var(--border2);
      color: var(--text);
      font-family: var(--mono);
      font-size: 15px;
      padding: 12px 14px;
      border-radius: 10px;
      outline: none;
      width: 100%;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus, select:focus {
      border-color: var(--green);
      box-shadow: 0 0 0 3px #00E87A18;
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
      animation: fadeIn 0.3s ease forwards;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .pulse-dot {
      width: 8px; height: 8px; border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }

    .card {
      background: var(--bg2);
      border: 1.5px solid var(--border);
      border-radius: 16px;
      padding: 16px;
    }

    .card-sm {
      background: var(--bg3);
      border: 1.5px solid var(--border);
      border-radius: 12px;
      padding: 12px 14px;
    }

    .label {
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.12em;
      color: var(--text3);
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .big-num {
      font-family: var(--display);
      font-size: 32px;
      letter-spacing: 0.02em;
      line-height: 1;
    }

    .tag {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      font-family: var(--mono);
    }

    .btn-primary {
      background: var(--green);
      color: #000;
      font-weight: 700;
      font-size: 14px;
      padding: 14px 24px;
      border-radius: 12px;
      letter-spacing: 0.04em;
    }
    .btn-primary:hover { background: var(--green2); box-shadow: 0 4px 20px #00E87A33; }

    .btn-ghost {
      background: transparent;
      color: var(--text2);
      font-size: 14px;
      padding: 12px 20px;
      border-radius: 12px;
      border: 1.5px solid var(--border2);
    }
    .btn-ghost:hover { border-color: var(--green); color: var(--green); }

    .btn-danger {
      background: transparent;
      color: var(--red);
      font-size: 13px;
      padding: 10px 16px;
      border-radius: 10px;
      border: 1.5px solid #FF3D5A44;
    }
    .btn-danger:hover { background: #FF3D5A12; border-color: var(--red); }

    .nav-tab {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      padding: 8px 4px 10px;
      background: none;
      color: var(--text3);
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.06em;
      border-top: 2px solid transparent;
      transition: all 0.2s;
    }
    .nav-tab.active {
      color: var(--green);
      border-top-color: var(--green);
    }
    .nav-tab svg { width: 20px; height: 20px; }

    .section-title {
      font-family: var(--display);
      font-size: 28px;
      letter-spacing: 0.04em;
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
      border: 1.5px solid var(--border2);
      background: var(--bg3);
      color: var(--text2);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .chip.active {
      border-color: var(--green);
      color: var(--green);
      background: #00E87A12;
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
    .result-val { font-family: var(--mono); font-size: 14px; font-weight: 500; }

    .trade-card {
      background: var(--bg2);
      border: 1.5px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      margin-bottom: 10px;
      transition: border-color 0.2s, transform 0.15s;
    }
    .trade-card:hover { border-color: var(--border2); }

    .inline-form {
      background: var(--bg3);
      border: 1.5px solid var(--border2);
      border-radius: 12px;
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
function PriceBadge({ info, loading }) {
  if (loading) return (
    <div style={{ fontSize: 12, color: "var(--text3)", fontFamily: "var(--mono)", marginTop: 6 }}>
      fetching price...
    </div>
  );
  if (!info) return null;
  const up = info.changePct >= 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
      <span style={{ fontSize: 12, color: "var(--text2)", fontFamily: "var(--mono)" }}>{info.name}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text)", fontWeight: 500 }}>
        ₹{info.price.toFixed(2)}
      </span>
      <span style={{ fontSize: 11, color: up ? "var(--green)" : "var(--red)", fontFamily: "var(--mono)" }}>
        {up ? "▲" : "▼"} {Math.abs(info.changePct).toFixed(2)}%
      </span>
    </div>
  );
}

// ─── TOP BAR ────────────────────────────────────────────────────────────────
function TopBar({ regime, portfolio, page }) {
  const cfg = REGIME_CONFIG[regime];
  return (
    <div style={{
      position: "sticky", top: 0, zIndex: 100,
      background: "rgba(8,12,15,0.92)", backdropFilter: "blur(20px)",
      borderBottom: "1px solid var(--border)",
      padding: "12px 16px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontFamily: "var(--display)", fontSize: 22, letterSpacing: "0.06em", color: "var(--green)", lineHeight: 1 }}>
          TRADESK
        </div>
        <div style={{
          background: cfg.bg,
          border: `1px solid ${cfg.color}44`,
          borderRadius: 6, padding: "3px 8px",
          fontSize: 10, fontFamily: "var(--mono)", fontWeight: 600,
          color: cfg.color, letterSpacing: "0.1em",
          boxShadow: cfg.glow,
        }}>
          {cfg.label}
        </div>
      </div>
      <div style={{
        background: "var(--bg3)", border: "1px solid var(--border2)",
        borderRadius: 10, padding: "6px 12px",
        fontFamily: "var(--mono)", fontSize: 13, color: "var(--text)",
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

  const [livePrices, setLivePrices] = useState({});
  const [refreshing, setRefreshing] = useState(false);

  const refreshPrices = async () => {
    setRefreshing(true);
    const symbols = [...new Set(openTrades.map(t => t.symbol))];
    const results = await Promise.all(symbols.map(async sym => [sym, await fetchStockPrice(sym)]));
    const map = {};
    results.forEach(([sym, r]) => { if (r) map[sym] = r; });
    setLivePrices(map);
    setRefreshing(false);
  };

  const totalUnrealized = openTrades.reduce((s, t) => {
    const lp = livePrices[t.symbol];
    if (!lp) return s;
    return s + (lp.price - t.avgEntry) * (t.remainingQty || t.totalQty || 0);
  }, 0);

  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      {/* Regime Banner */}
      <div className="card" style={{
        marginBottom: 14,
        background: `linear-gradient(135deg, ${cfg.bg} 0%, var(--bg2) 60%)`,
        border: `1.5px solid ${cfg.color}33`,
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
                style={regime === r ? { borderColor: cfg.color, color: cfg.color, background: cfg.bg } : {}}
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
          <div className="big-num" style={{ color: "var(--green)", flex: 1 }}>{formatINR(portfolio)}</div>
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
          <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: totalRisk > 0 ? "var(--amber)" : "var(--text2)", marginTop: 4 }}>
            {formatINR(totalRisk)}
          </div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>{pct(totalRisk, portfolio) || "0.0"}% of portfolio</div>
        </div>
        <div className="card-sm">
          <div className="label">Heat</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: heat > 5 ? "var(--red)" : heat > 2 ? "var(--amber)" : "var(--text2)", marginTop: 4 }}>
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
      </div>

      {/* Open Positions */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div className="section-title" style={{ fontSize: 20 }}>Open Positions</div>
          <div style={{ display: "flex", gap: 8 }}>
            {openTrades.length > 0 && (
              <button className="btn-ghost" style={{ padding: "8px 12px", fontSize: 12, borderRadius: 8 }}
                onClick={refreshPrices} disabled={refreshing}>
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
            <OpenTradeCard key={t.id} trade={t} livePrice={livePrices[t.symbol]} />
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
              <span className="tag" style={{ background: "#FFAA0012", color: "var(--amber)", border: "1px solid #FFAA0033", fontSize: 10 }}>PARTIAL</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
            <span className="tag" style={{ background: "#00E87A15", color: "var(--green)", border: "1px solid #00E87A33" }}>
              {trade.setupType}
            </span>
            <DaysHeldBadge trade={trade} />
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          {livePrice ? (
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 15 }}>₹{livePrice.price.toFixed(2)}</div>
              <div style={{ fontSize: 11, color: livePrice.changePct >= 0 ? "var(--green)" : "var(--red)" }}>
                {livePrice.changePct >= 0 ? "▲" : "▼"} {Math.abs(livePrice.changePct).toFixed(2)}%
              </div>
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
function CalcPage({ portfolio, onSendToJournal }) {
  const [symbol, setSymbol] = useState("");
  const [symbolInfo, setSymbolInfo] = useState(null);
  const [fetchingSym, setFetchingSym] = useState(false);
  const symDebounce = useRef(null);

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

  const handleSymbolChange = (val) => {
    const sym = val.toUpperCase();
    setSymbol(sym);
    setSymbolInfo(null);
    if (symDebounce.current) clearTimeout(symDebounce.current);
    if (sym.length < 2) return;
    symDebounce.current = setTimeout(async () => {
      setFetchingSym(true);
      const result = await fetchStockPrice(sym);
      setFetchingSym(false);
      if (result) setSymbolInfo(result);
    }, 700);
  };

  return (
    <div className="fade-in" style={{ padding: "16px 16px 120px" }}>
      <div style={{ marginBottom: 16 }}>
        <div className="section-title">Calculator</div>
        <div style={{ fontSize: 13, color: "var(--text3)", marginTop: 4 }}>Plan the trade. Know the risk before entry.</div>
      </div>

      {/* Symbol */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Stock Symbol</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="e.g. RELIANCE, TATASTEEL" value={symbol}
            onChange={e => handleSymbolChange(e.target.value)}
            style={{ textTransform: "uppercase", fontFamily: "var(--display)", fontSize: 18, letterSpacing: "0.04em", flex: 1 }} />
          {symbolInfo && (
            <button className="btn-ghost" style={{ padding: "10px 14px", fontSize: 12, whiteSpace: "nowrap" }}
              onClick={() => setEntry(String(symbolInfo.price.toFixed(2)))}>
              Use ₹
            </button>
          )}
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
              background: parseFloat(rr) >= 2 ? "#00E87A12" : "#FFAA0012",
              border: `1px solid ${parseFloat(rr) >= 2 ? "#00E87A33" : "#FFAA0033"}`,
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
          background: "#FF3D5A12", border: "1px solid #FF3D5A33",
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
  const [fetchingSym, setFetchingSym] = useState(false);
  const symDebounce = useRef(null);

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
        fetchStockPrice(prefill.symbol).then(r => setSymbolInfo(r));
      }
      setStep(1);
      setPrefill(null);
    }
  }, [prefill]);

  const handleSymbolChange = (val) => {
    const sym = val.toUpperCase();
    setForm(f => ({ ...f, symbol: sym }));
    setSymbolInfo(null);
    if (symDebounce.current) clearTimeout(symDebounce.current);
    if (sym.length < 2) return;
    symDebounce.current = setTimeout(async () => {
      setFetchingSym(true);
      const result = await fetchStockPrice(sym);
      setFetchingSym(false);
      if (result) setSymbolInfo(result);
    }, 700);
  };

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
          onClick={() => { setStep(0); setSymbolInfo(null); }}>← Back</button>
        <div className="section-title" style={{ fontSize: 22 }}>New Trade</div>
      </div>

      {/* Symbol */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Symbol</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="e.g. RELIANCE, TATASTEEL" value={form.symbol}
            onChange={e => handleSymbolChange(e.target.value)}
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
                background: form.conviction >= v ? "#00E87A20" : "var(--bg3)",
                border: `1.5px solid ${form.conviction >= v ? "var(--green)" : "var(--border2)"}`,
                color: form.conviction >= v ? "var(--green)" : "var(--text3)",
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

  const handleRefreshPrice = async () => {
    setFetchingPrice(true);
    const result = await fetchStockPrice(trade.symbol);
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
              <span className="tag" style={{ background: "#FFAA0012", color: "var(--amber)", border: "1px solid #FFAA0033" }}>PARTIAL</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
            <span className="tag" style={{ background: "#00E87A12", color: "var(--green)", border: "1px solid #00E87A25" }}>
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
                <div style={{ fontSize: 11, color: livePrice.changePct >= 0 ? "var(--green)" : "var(--red)" }}>
                  {livePrice.changePct >= 0 ? "▲" : "▼"} {Math.abs(livePrice.changePct).toFixed(2)}%
                </div>
              </div>
            ) : (
              <div className="tag" style={{ background: "var(--green)15", color: "var(--green)", border: "1px solid var(--green)33" }}>
                <span className="pulse-dot" style={{ background: "var(--green)" }}></span>
                LIVE
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
          background: unrealizedPnl >= 0 ? "#00E87A0A" : "#FF3D5A0A",
          border: `1px solid ${unrealizedPnl >= 0 ? "#00E87A25" : "#FF3D5A25"}`,
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
          <button className="btn-ghost" style={{ padding: "8px 11px", fontSize: 13, borderRadius: 10, color: "var(--red)", borderColor: "#FF3D5A33" }}
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
        background: totalPnl >= 0 ? "#00E87A0A" : "#FF3D5A0A",
        border: `1.5px solid ${totalPnl >= 0 ? "#00E87A33" : "#FF3D5A33"}`,
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
  ];

  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 200,
      background: "rgba(8,12,15,0.95)", backdropFilter: "blur(20px)",
      borderTop: "1px solid var(--border)",
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
  const [regime, setRegime] = useStorage("td_regime", "bull");
  const [regimeSince, setRegimeSince] = useStorage("td_regime_since", null);
  const [portfolio, setPortfolio] = useStorage("td_portfolio", 100000);
  const [trades, setTrades] = useStorage("td_trades", []);
  const [prefill, setPrefill] = useState(null);
  const prevRegimeRef = useRef(regime);

  useEffect(() => {
    if (prevRegimeRef.current !== regime) {
      setRegimeSince(new Date().toISOString());
      prevRegimeRef.current = regime;
    }
  }, [regime]);

  const handleSendToJournal = (data) => {
    setPrefill(data);
    setPage("journal");
  };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", minHeight: "100vh", background: "var(--bg)", position: "relative" }}>
      <GlobalStyle />
      <TopBar regime={regime} portfolio={portfolio} page={page} />
      <NiftyStrip />

      {page === "today" && (
        <TodayPage regime={regime} setRegime={setRegime} regimeSince={regimeSince} portfolio={portfolio} setPortfolio={setPortfolio} trades={trades} setPage={setPage} />
      )}
      {page === "calc" && (
        <CalcPage portfolio={portfolio} onSendToJournal={handleSendToJournal} />
      )}
      {page === "journal" && (
        <JournalPage trades={trades} setTrades={setTrades} prefill={prefill} setPrefill={setPrefill} />
      )}
      {page === "analytics" && (
        <AnalyticsPage trades={trades} portfolio={portfolio} />
      )}

      <BottomNav page={page} setPage={setPage} />
    </div>
  );
}
