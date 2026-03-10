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
DATA_DIR = BASE_DIR / "data"
CACHE_DIR = BASE_DIR / "cache"
WATCHLIST_PATH = DATA_DIR / "watchlist.json"
NSE_SYMBOLS_CACHE_PATH = CACHE_DIR / "nse_symbols.csv"
NSE_SYMBOLS_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
NSE_CACHE_TTL = timedelta(days=7)
QUOTE_TIMEOUT_SECONDS = 2.0
SEARCH_LIMIT = 10

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


def fetch_ltp_batch(symbols: list[str]) -> dict[str, float | None]:
    if not symbols:
        return {}

    tickers = [f"{symbol}.NS" for symbol in symbols]
    table = yf.download(
        " ".join(tickers),
        period="1d",
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


async def fetch_ltps(symbols: list[str]) -> dict[str, float | None]:
    try:
        return await asyncio.wait_for(asyncio.to_thread(fetch_ltp_batch, symbols), timeout=QUOTE_TIMEOUT_SECONDS)
    except Exception:
        return {symbol: None for symbol in symbols}


@app.get("/api/indices")
async def get_indices() -> dict[str, dict[str, float | None]]:
    nifty50, nifty500 = await asyncio.gather(
        fetch_quote_snapshot_with_timeout("^NSEI"),
        fetch_quote_snapshot_with_timeout("^CRSLDX"),
    )
    return {
        "nifty50": nifty50,
        "nifty500": nifty500,
    }


@app.get("/api/search")
async def search_symbols_endpoint(q: str = Query(..., min_length=1)) -> list[dict[str, Any]]:
    records = search_symbol_records(q)
    ltps = await fetch_ltps([record.symbol for record in records])

    results: list[dict[str, Any]] = []
    for record in records:
        results.append(
            {
                "symbol": record.symbol,
                "name": record.name,
                "ltp": ltps.get(record.symbol),
                "from_watchlist": record.from_watchlist,
            }
        )
    return results
