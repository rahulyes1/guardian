from __future__ import annotations

import asyncio
import csv
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.request import urlopen

import yfinance as yf
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

BASE_DIR = Path(__file__).resolve().parent
_TMP = Path("/tmp")
DATA_DIR = _TMP / "tradesk_data" if not (BASE_DIR / "data").exists() else BASE_DIR / "data"
CACHE_DIR = _TMP / "tradesk_cache" if not (BASE_DIR / "cache").exists() else BASE_DIR / "cache"
WATCHLIST_PATH = DATA_DIR / "watchlist.json"
NSE_SYMBOLS_CACHE_PATH = CACHE_DIR / "nse_symbols.csv"
NSE_SYMBOLS_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
NSE_CACHE_TTL = timedelta(days=7)
QUOTE_TIMEOUT_SECONDS = 4.0
SEARCH_LIMIT = 10
IST = timezone(timedelta(hours=5, minutes=30))

app = FastAPI(title="Tradesk API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@dataclass(slots=True)
class SymbolRecord:
    symbol: str
    name: str
    from_watchlist: bool = False


def ensure_data_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ist_now() -> datetime:
    return datetime.now(IST)


def is_market_open_ist(now: datetime | None = None) -> bool:
    ts = now or ist_now()
    day = ts.weekday()
    if day >= 5:
        return False
    mins = ts.hour * 60 + ts.minute
    return (9 * 60 + 15) <= mins <= (15 * 60 + 30)


def should_refresh_cache(path: Path, ttl: timedelta) -> bool:
    if not path.exists():
        return True
    modified_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    return utc_now() - modified_at >= ttl


def refresh_nse_symbol_cache() -> Path:
    ensure_data_dirs()
    if not should_refresh_cache(NSE_SYMBOLS_CACHE_PATH, NSE_CACHE_TTL):
        return NSE_SYMBOLS_CACHE_PATH

    try:
        with urlopen(NSE_SYMBOLS_URL, timeout=15) as response:
            payload = response.read()
        NSE_SYMBOLS_CACHE_PATH.write_bytes(payload)
    except Exception:
        if not NSE_SYMBOLS_CACHE_PATH.exists():
            raise

    return NSE_SYMBOLS_CACHE_PATH


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows: list[dict[str, str]] = []
        for row in reader:
            normalized = {(key or "").strip(): (value or "").strip() for key, value in row.items()}
            if normalized:
                rows.append(normalized)
        return rows


def load_nse_symbols() -> list[SymbolRecord]:
    path = refresh_nse_symbol_cache()
    records: list[SymbolRecord] = []
    for row in read_csv_rows(path):
        symbol = row.get("SYMBOL", "").upper()
        name = row.get("NAME OF COMPANY", "")
        series = row.get("SERIES", "")
        if not symbol or not name:
            continue
        if series and series not in {"EQ", "BE", "BZ", "SM"}:
            continue
        records.append(SymbolRecord(symbol=symbol, name=name))
    return records


def load_watchlist_symbols() -> list[SymbolRecord]:
    ensure_data_dirs()
    if not WATCHLIST_PATH.exists():
        return []

    try:
        payload = json.loads(WATCHLIST_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []

    items: list[dict[str, Any]]
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict) and isinstance(payload.get("items"), list):
        items = payload["items"]
    else:
        return []

    records: list[SymbolRecord] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        symbol = str(item.get("symbol", "")).strip().upper()
        name = str(item.get("name", "")).strip()
        if symbol:
            records.append(SymbolRecord(symbol=symbol, name=name or symbol, from_watchlist=True))
    return records


def merged_symbol_records() -> list[SymbolRecord]:
    nse_records = load_nse_symbols()
    nse_by_symbol = {record.symbol: record for record in nse_records}
    merged: dict[str, SymbolRecord] = {record.symbol: record for record in nse_records}

    for record in load_watchlist_symbols():
        fallback_name = nse_by_symbol.get(record.symbol).name if record.symbol in nse_by_symbol else record.symbol
        merged[record.symbol] = SymbolRecord(
            symbol=record.symbol,
            name=record.name or fallback_name,
            from_watchlist=True,
        )

    return list(merged.values())


def rank_symbol_match(record: SymbolRecord, query: str) -> tuple[int, int, str]:
    symbol = record.symbol.lower()
    name = record.name.lower()

    if symbol == query:
        base_rank = 0
    elif symbol.startswith(query):
        base_rank = 1
    elif name.startswith(query):
        base_rank = 2
    elif query in symbol:
        base_rank = 3
    else:
        base_rank = 4

    watchlist_bias = 0 if record.from_watchlist else 1
    return (base_rank, watchlist_bias, record.symbol)


def search_symbol_records(query: str) -> list[SymbolRecord]:
    q = query.strip().lower()
    if len(q) < 2:
        return []

    matches = [
        record
        for record in merged_symbol_records()
        if q in record.symbol.lower() or q in record.name.lower()
    ]
    matches.sort(key=lambda record: rank_symbol_match(record, q))
    return matches[:SEARCH_LIMIT]


def _fast_info_get(fast_info: Any, *keys: str) -> float | None:
    if not fast_info:
        return None

    for key in keys:
        try:
            value = fast_info.get(key) if hasattr(fast_info, "get") else fast_info[key]
        except Exception:
            value = getattr(fast_info, key, None)
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def fetch_quote_snapshot(symbol: str) -> dict[str, float | None]:
    ticker = yf.Ticker(symbol)
    fast_info = getattr(ticker, "fast_info", None)

    price = _fast_info_get(fast_info, "lastPrice", "last_price", "regularMarketPrice")
    prev_close = _fast_info_get(fast_info, "previousClose", "previous_close", "regularMarketPreviousClose")

    if price is None or prev_close is None:
        history = ticker.history(period="5d", interval="1d", auto_adjust=False)
        closes = history["Close"].dropna().tolist() if not history.empty and "Close" in history else []
        if price is None and closes:
            price = float(closes[-1])
        if prev_close is None:
            if len(closes) >= 2:
                prev_close = float(closes[-2])
            elif closes:
                prev_close = float(closes[-1])

    change = (price - prev_close) if price is not None and prev_close is not None else None
    change_pct = ((change / prev_close) * 100) if change is not None and prev_close not in (None, 0) else None
    return {
        "price": round(price, 2) if price is not None else None,
        "prev_close": round(prev_close, 2) if prev_close is not None else None,
        "change": round(change, 2) if change is not None else None,
        "change_pct": round(change_pct, 2) if change_pct is not None else None,
    }


async def fetch_quote_snapshot_with_timeout(symbol: str) -> dict[str, float | None]:
    try:
        return await asyncio.wait_for(asyncio.to_thread(fetch_quote_snapshot, symbol), timeout=QUOTE_TIMEOUT_SECONDS)
    except Exception:
        return {"price": None, "prev_close": None, "change": None, "change_pct": None}


def fetch_close_ltp_batch(symbols: list[str]) -> dict[str, float | None]:
    if not symbols:
        return {}

    tickers = [to_yahoo_symbol(symbol) for symbol in symbols]
    table = yf.download(
        " ".join(tickers),
        period="5d",
        interval="1d",
        progress=False,
        auto_adjust=False,
        threads=True,
    )
    if table is None or getattr(table, "empty", True):
        return {symbol: None for symbol in symbols}

    results: dict[str, float | None] = {}
    columns = getattr(table, "columns", None)
    is_multi = getattr(columns, "nlevels", 1) > 1

    if is_multi:
        close_table = table["Close"] if "Close" in columns.get_level_values(0) else None
        for symbol, ticker in zip(symbols, tickers):
            price = None
            if close_table is not None and ticker in close_table:
                series = close_table[ticker].dropna()
                if not series.empty:
                    price = float(series.iloc[-1])
            results[symbol] = round(price, 2) if price is not None else None
        return results

    close_series = table["Close"].dropna() if "Close" in columns else None
    value = float(close_series.iloc[-1]) if close_series is not None and not close_series.empty else None
    return {symbols[0]: round(value, 2) if value is not None else None}


async def fetch_close_ltps(symbols: list[str]) -> dict[str, float | None]:
    try:
        return await asyncio.wait_for(asyncio.to_thread(fetch_close_ltp_batch, symbols), timeout=QUOTE_TIMEOUT_SECONDS)
    except Exception:
        return {symbol: None for symbol in symbols}


def to_yahoo_symbol(symbol: str) -> str:
    normalized = symbol.strip().upper()
    if not normalized:
        return normalized
    if normalized.startswith("^") or "." in normalized:
        return normalized
    return f"{normalized}.NS"


async def fetch_quotes_for_symbols(symbols: list[str]) -> dict[str, dict[str, float | None]]:
    unique_symbols = [symbol.strip().upper() for symbol in symbols if symbol and symbol.strip()]
    if not unique_symbols:
        return {}

    snapshots = await asyncio.gather(
        *[fetch_quote_snapshot_with_timeout(to_yahoo_symbol(symbol)) for symbol in unique_symbols]
    )
    return {symbol: snapshot for symbol, snapshot in zip(unique_symbols, snapshots)}

@app.get("/api/indices")
async def get_indices() -> dict[str, Any]:
    now_utc = utc_now()
    live = is_market_open_ist()
    nifty50, nifty500 = await asyncio.gather(
        fetch_quote_snapshot_with_timeout("^NSEI"),
        fetch_quote_snapshot_with_timeout("^CRSLDX"),
    )
    if nifty500.get("price") is None:
        alt_nifty500 = await fetch_quote_snapshot_with_timeout("^CNX500")
        if alt_nifty500.get("price") is not None:
            nifty500 = alt_nifty500

    missing_symbols: list[str] = []
    if nifty50.get("price") is None:
        missing_symbols.append("^NSEI")
    if nifty500.get("price") is None:
        missing_symbols.append("^CRSLDX")
    close_ltps = await fetch_close_ltps(missing_symbols) if missing_symbols else {}

    if nifty50.get("price") is None and close_ltps.get("^NSEI") is not None:
        nifty50["price"] = close_ltps["^NSEI"]
    if nifty500.get("price") is None and close_ltps.get("^CRSLDX") is not None:
        nifty500["price"] = close_ltps["^CRSLDX"]

    return {
        "nifty50": nifty50,
        "nifty500": nifty500,
        "as_of": now_utc.isoformat(),
        "is_live": live,
    }


@app.get("/api/quotes")
async def get_quotes(symbols: str = Query(..., min_length=1)) -> dict[str, Any]:
    symbol_list = list(dict.fromkeys([part.strip().upper() for part in symbols.split(",") if part.strip()]))
    if not symbol_list:
        return {"quotes": {}, "as_of": utc_now().isoformat(), "is_live": is_market_open_ist()}

    symbol_name_lookup = {record.symbol: record.name for record in merged_symbol_records()}
    snapshots = await fetch_quotes_for_symbols(symbol_list)
    missing_symbols = [symbol for symbol in symbol_list if snapshots.get(symbol, {}).get("price") is None]
    close_ltps = await fetch_close_ltps(missing_symbols) if missing_symbols else {}
    as_of = utc_now().isoformat()
    live = is_market_open_ist()

    quotes: dict[str, dict[str, Any]] = {}
    for symbol in symbol_list:
        snapshot = snapshots.get(symbol, {"price": None, "prev_close": None, "change": None, "change_pct": None})
        price = snapshot.get("price")
        if price is None:
            price = close_ltps.get(symbol)
        quotes[symbol] = {
            "name": symbol_name_lookup.get(symbol, symbol),
            "price": price,
            "change": snapshot.get("change"),
            "change_pct": snapshot.get("change_pct"),
            "as_of": as_of,
            "is_live": live,
        }

    return {
        "quotes": quotes,
        "as_of": as_of,
        "is_live": live,
    }


@app.get("/api/search")
async def search_symbols_endpoint(q: str = Query(..., min_length=1)) -> list[dict[str, Any]]:
    records = search_symbol_records(q)
    snapshots = await fetch_quotes_for_symbols([record.symbol for record in records])
    missing_symbols = [record.symbol for record in records if snapshots.get(record.symbol, {}).get("price") is None]
    close_ltps = await fetch_close_ltps(missing_symbols) if missing_symbols else {}

    results: list[dict[str, Any]] = []
    for record in records:
        snapshot = snapshots.get(record.symbol, {})
        price = snapshot.get("price")
        if price is None:
            price = close_ltps.get(record.symbol)
        results.append(
            {
                "symbol": record.symbol,
                "name": record.name,
                "ltp": price,
                "from_watchlist": record.from_watchlist,
            }
        )
    return results
