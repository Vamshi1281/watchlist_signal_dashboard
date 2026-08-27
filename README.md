# Watchlist Signal Dashboard

A rules-based technical-signal dashboard (buy/hold/sell) for a personal stock + crypto
watchlist, published as a private Claude Artifact and regenerated on request by Claude.

**Live dashboard:** https://claude.ai/code/artifact/c05872e6-3e51-4179-9448-7b246b201145
(private — requires being signed into the owner's Claude account to view)

This repo holds the three scripts that produce it. There is no build step and no
dependencies beyond Node's built-in modules (`https`, `fs`, `path`) — clone and run.

## What "refresh the dashboard" means

Say "refresh" (or similar) to Claude in a session that has access to this repo and the
live dashboard URL above, and it should:

1. Get the current scripts (clone this repo, or `curl` the three raw files if a full
   clone isn't convenient).
2. Run, in order:
   ```
   node fetch_stocks.js  > stocks_output.json
   node fetch_crypto.js  > crypto_output.json   # rate-limited, ~2-3 min, has built-in delays — let it finish
   node generate_dashboard.js                    # reads both JSON files, writes dashboard.html
   ```
3. **Before publishing:** sanity-check that most tickers actually succeeded (not just
   that the JSON has a `results` array — a technically-valid JSON where every entry has
   an `error` field is not safe to publish). See "Known failure mode" below.
4. Publish `dashboard.html` via the Artifact tool with `url` set to the live dashboard
   URL above, so it updates in place rather than creating a new artifact. Title:
   "Watchlist Signal Board", favicon: 📈.

## Files

| File | Purpose |
|---|---|
| `fetch_stocks.js` | Pulls 1y daily price/volume history per stock ticker from Yahoo Finance's chart API, computes technical indicators, and (for stocks only) earnings context from stockanalysis.com and real options quotes from CBOE's delayed-quotes feed. Writes one JSON object per ticker. |
| `fetch_crypto.js` | Same indicator framework adapted for crypto: CoinGecko's free `market_chart` API (close-price + volume only, no intraday high/low, so no true ATR — see `avgDailyMove` fallback in the code), 24/7-market horizon scaling, no earnings/after-hours/options sections. |
| `generate_dashboard.js` | Reads `stocks_output.json` + `crypto_output.json`, renders the full self-contained dashboard HTML (tabbed Stocks / Crypto, cards + table view, search box, methodology section) and writes `dashboard.html`. No external JS dependencies — inline `<style>`/`<script>` only, Google Fonts for type. |

Both fetch scripts also accept ticker symbols as CLI args to refresh a subset, e.g.
`node fetch_stocks.js NVDA AAPL` (useful for a quick single-ticker check without waiting
on the full watchlist).

## Current watchlist

**Stocks (37):** AAPL, TSLA, NVDA, MSFT, MSTR, INTU, SMCI, MU, BE, QCOM, RGTI, MARA,
GOOGL, CMG, NFLX, TTD, META, SPCX, HOOD, QS, INTC, BABA, SNDK, QBTS, QUBT, WDAY, IREN,
PLTR, CRM, AMD, BIDU, DKS, QQQ, SPY, RBLX, COIN, MRVL

**Crypto (9):** BTC, ETH, SOL, AIOZ, SKALE, HYPE, POPCAT, KAS, FET

Edit the `TICKERS` / `COINS` array at the top of the respective fetch script to change
the watchlist — the rest of the pipeline adapts automatically (indicators, layout,
formatting all key off what's actually in the fetched data, not a hardcoded list).

**Tickers requested but not trackable, and what stands in for them:**
- `RTGI` → not listed; almost certainly meant **RGTI** (Rigetti Computing), used instead.
- `QA` → resolves to an empty exchange-quote stub with no price/volume history; dropped.
- `QTBS` → not listed; almost certainly meant **QBTS** (D-Wave Quantum), used instead.
- `SPXW` → CBOE's root symbol for S&P 500 *Weekly index options*, not a stock/ETF with
  its own price history; no listing to track. **SPY** (already on the list) is the
  closest tradable proxy for S&P 500 exposure.

## Methodology (what the signal actually means)

Four technical indicators, each contributing +1 (bullish), −1 (bearish), or 0 (neutral)
to a composite score, range −5 to +5:

- **Trend** — short SMA vs. long SMA (20/50-day for most tickers, scaled down for
  short-history listings). A fresh golden/death cross adds an extra ±1 on top of the
  trend vote itself.
- **Momentum (RSI-14)** — Wilder's RSI; below 30 = oversold (+1), above 70 =
  overbought (−1).
- **Volume flow** — 5-day vs. 3-month average volume, direction-weighted by whether the
  heavier volume landed on up days (accumulation, +1) or down days (distribution, −1).
- **MACD (12/26/9)** — fast EMA vs. slow EMA line, above (+1) or below (−1) its own
  signal line.

**Score ≥ +3 → BUY. Score ≤ −3 → SELL. Otherwise → HOLD.**

Also computed per ticker, informational only (not scored):
- **Bollinger Bands (20, 2σ)** and, for stocks, **ATR-14** (crypto substitutes a 14-day
  average absolute daily move, since the free CoinGecko feed has no intraday high/low).
- **Trade levels** — a buy zone near the nearest support, a target near the nearest
  resistance, and a stop-loss sized off ATR (or the crypto avg-move proxy). Mechanical
  support/resistance math, not a prediction.
- **Expected-move ranges** (this week / next week / 1 month / 1 year) — a ~68%
  probability band from each asset's own realized historical volatility, the same math
  behind an options market's "expected move," built on realized vol since neither feed
  used here exposes implied vol as a standalone series.
- **Stocks only:** next earnings date + last quarter's EPS surprise (context, not scored
  — a stock can be technically bullish right into a print that erases it), and real
  options quotes (CBOE delayed feed) for both a long (call/put matching the signal
  direction) and a short (cash-secured put near support / covered call near resistance)
  angle, at near-term and monthly expiries. Contracts under 5 calendar days to expiry
  are deliberately excluded — that's the "lotto" zone (cheap, high-odds-of-total-loss,
  pure time-decay bets) — this dashboard won't surface them even as informational rows.

**This is a transparent heuristic, not a backtested strategy or financial advice.** It
says nothing about valuation or whether something is a good long-term holding.

## Known failure mode — do not re-enable a cloud-scheduled routine as-is

An hourly scheduled cloud routine (Claude's `RemoteTrigger`/routines feature) was built
once to auto-refresh this dashboard and had to be disabled. Two causes, both must be
fixed before trying again:

1. **Data fetch fails entirely from Anthropic's cloud sandbox.** All four data
   providers (Yahoo Finance, stockanalysis.com, CBOE, CoinGecko) failed simultaneously —
   scripts exited 0, but every single ticker came back with an `error` field. This is
   almost certainly the providers blocking the cloud sandbox's datacenter IP range as
   anti-bot protection, not a script bug. Only a paid data API that explicitly permits
   server/datacenter traffic (Polygon.io, Alpha Vantage, etc.) would make a cloud-hosted
   scheduled refresh viable.
2. **The routine's publish preflight was too weak.** It only checked that the output
   JSON had a `results` array — not that fetches actually succeeded — so it proceeded to
   try to publish an all-empty, all-error dashboard over the live one. The Artifact
   tool's own "you must view the live version before publishing" safety check blocked
   this twice, but the routine eventually got past it and briefly overwrote the live
   dashboard before it was caught and manually restored. **Any future automation must
   reject publishing if more than ~20% of tickers errored**, not just check JSON shape.

Refreshing manually (from an environment with normal internet access — a local machine,
not a cloud sandbox) has no such problem and is the supported way to update this
dashboard today.

## Refreshing locally on a schedule (a working alternative to the cloud routine)

Since the failure above is specific to Anthropic's cloud sandbox IP range, running this
pipeline from a machine with ordinary internet access (e.g. via Windows Task Scheduler
invoking headless Claude Code, or any cron-capable machine you control) does not hit the
same block — that's the one alternative confirmed not to have this problem, at the cost
of only running while that machine is on.
