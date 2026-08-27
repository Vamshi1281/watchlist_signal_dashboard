const https = require('https');

// RTGI has no listing on Yahoo (likely meant RGTI - Rigetti Computing); QA resolves to an
// empty ECN quote stub with no OHLCV history, so it's dropped (flagged separately for the user).
// QTBS has no listing either (likely meant QBTS - D-Wave Quantum).
// SPXW is CBOE's root symbol for S&P 500 Weekly index options, not an equity/ETF with its own
// price history - no Yahoo listing exists for it, so it's dropped (flagged for the user); SPY
// (already tracked) is the closest tradable proxy for S&P 500 exposure.
const TICKERS = ["AAPL","TSLA","NVDA","MSFT","MSTR","INTU","SMCI","MU","BE","QCOM","RGTI","MARA","GOOGL","CMG","NFLX","TTD","META","SPCX","HOOD","QS","INTC","BABA","SNDK","QBTS","QUBT","WDAY","IREN","PLTR","CRM","AMD","BIDU","DKS","QQQ","SPY","RBLX","COIN","MRVL"];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sma(arr, period, endIdx) {
  if (endIdx - period + 1 < 0) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += arr[i];
  return sum / period;
}

function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function macd(closes) {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null);
  const firstValid = macdLine.findIndex((v) => v != null);
  if (firstValid === -1) return { macdSeries: macdLine, signalSeries: closes.map(() => null) };
  const macdValid = macdLine.slice(firstValid).map((v) => v);
  const signalValid = emaSeries(macdValid, 9);
  const signalSeries = new Array(closes.length).fill(null);
  for (let i = 0; i < signalValid.length; i++) signalSeries[firstValid + i] = signalValid[i];
  return { macdSeries: macdLine, signalSeries };
}

function atr14(highs, lows, closes) {
  const n = closes.length;
  const trueRanges = [];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trueRanges.push(tr);
  }
  const period = Math.min(14, trueRanges.length);
  if (period === 0) return null;
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

function rsi(closes, period) {
  // Wilder's RSI over the full series, returns array aligned with closes (null where insufficient data)
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

async function analyze(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1d`;
  let json;
  try {
    json = await fetchJson(url);
  } catch (e) {
    return { symbol, error: 'fetch_failed: ' + e.message };
  }
  const result = json?.chart?.result?.[0];
  if (!result) {
    return { symbol, error: json?.chart?.error?.description || 'no_data' };
  }
  const meta = result.meta;
  const ts = result.timestamp;
  const quote = result.indicators.quote[0];
  const closesRaw = quote.close, volsRaw = quote.volume, highsRaw = quote.high, lowsRaw = quote.low;

  // Clean out nulls (holidays etc.)
  const dates = [], closes = [], vols = [], highs = [], lows = [];
  for (let i = 0; i < ts.length; i++) {
    if (closesRaw[i] == null || volsRaw[i] == null) continue;
    dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
    closes.push(closesRaw[i]);
    vols.push(volsRaw[i]);
    highs.push(highsRaw[i] ?? closesRaw[i]);
    lows.push(lowsRaw[i] ?? closesRaw[i]);
  }
  const n = closes.length;
  if (n < 25) return { symbol, error: 'insufficient_history (' + n + ' bars)' };

  const last = n - 1;
  const price = closes[last];
  const prevClose = closes[last - 1];
  const changePct = ((price - prevClose) / prevClose) * 100;

  // Moving averages: 20/50 (short/medium) when a full year is available; for recent listings
  // (e.g. SPCX, ~52 trading days) fall back to shorter, proportionally-scaled periods so a
  // signal can still be computed, flagged via `limitedHistory`.
  const limitedHistory = n < 55;
  const longPeriod = Math.min(50, Math.max(10, Math.floor(n * 0.85)));
  const shortPeriod = Math.min(20, Math.max(5, Math.floor(longPeriod / 2.5)));
  const sma20 = sma(closes, shortPeriod, last);
  const sma50 = sma(closes, longPeriod, last);
  const sma20Prev = sma(closes, shortPeriod, last - 1);
  const sma50Prev = sma(closes, longPeriod, last - 1);

  let maState = 'neutral', maCrossEvent = null;
  if (sma20 != null && sma50 != null && sma20Prev != null && sma50Prev != null) {
    maState = sma20 > sma50 ? 'bullish' : 'bearish';
    const wasAbove = sma20Prev > sma50Prev;
    const isAbove = sma20 > sma50;
    if (!wasAbove && isAbove) maCrossEvent = 'golden_cross';
    if (wasAbove && !isAbove) maCrossEvent = 'death_cross';
  }

  // RSI 14
  const rsiSeries = rsi(closes, 14);
  const rsi14 = rsiSeries[last];
  let rsiState = 'neutral';
  if (rsi14 != null) {
    if (rsi14 < 30) rsiState = 'oversold';
    else if (rsi14 > 70) rsiState = 'overbought';
  }

  // Volume: recent 5-day avg vs trailing 3-month (63 trading day) avg, direction-weighted (crude OBV-style accumulation)
  const vol5 = vols.slice(last - 4, last + 1).reduce((a, b) => a + b, 0) / 5;
  const lookback3mo = Math.min(63, last);
  const vol3mo = vols.slice(last - lookback3mo + 1, last + 1).reduce((a, b) => a + b, 0) / lookback3mo;
  const volRatio = vol3mo > 0 ? vol5 / vol3mo : 1;

  // Direction-weighted volume over last 10 days -> accumulation vs distribution
  let upVol = 0, downVol = 0;
  for (let i = last - 9; i <= last; i++) {
    if (i <= 0) continue;
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) upVol += vols[i]; else if (diff < 0) downVol += vols[i];
  }
  const volBias = upVol + downVol > 0 ? (upVol - downVol) / (upVol + downVol) : 0; // -1..1

  let volState = 'neutral';
  if (volRatio > 1.15 && volBias > 0.15) volState = 'accumulation';
  else if (volRatio > 1.15 && volBias < -0.15) volState = 'distribution';

  // MACD (12,26,9) — trend/momentum confirmation, needs ~35 bars; skipped (neutral) below that.
  const { macdSeries, signalSeries } = macd(closes);
  const macdVal = macdSeries[last], signalVal = signalSeries[last];
  let macdState = 'neutral';
  if (macdVal != null && signalVal != null) macdState = macdVal > signalVal ? 'bullish' : 'bearish';

  // ATR(14) — realized daily trading range, used to size the stop-loss below support instead of
  // a flat percentage (a low-vol stock gets a tight stop; a high-vol one gets a wide one).
  const atr = atr14(highs, lows, closes);

  // Bollinger Bands (20, 2) — informational only (RSI already covers overbought/oversold), shows
  // where price sits inside its recent volatility envelope.
  const bbPeriod = Math.min(20, n);
  const bbSma = closes.slice(last - bbPeriod + 1, last + 1).reduce((a, b) => a + b, 0) / bbPeriod;
  const bbVariance = closes.slice(last - bbPeriod + 1, last + 1).reduce((a, b) => a + (b - bbSma) ** 2, 0) / bbPeriod;
  const bbStdDev = Math.sqrt(bbVariance);
  const bbUpper = bbSma + 2 * bbStdDev;
  const bbLower = bbSma - 2 * bbStdDev;
  let bbPosition = 'inside';
  if (price > bbUpper) bbPosition = 'above-upper';
  else if (price < bbLower) bbPosition = 'below-lower';

  // 52-week high/low and drawdown
  const high52 = Math.max(...highs);
  const low52 = Math.min(...lows);
  const pctOffHigh = ((price - high52) / high52) * 100;
  const pctOffLow = ((price - low52) / low52) * 100;

  // Reference trade levels — nearest support/resistance from recent range + the long SMA as
  // dynamic support, used to derive a pullback-buy zone, a take-profit zone, and a stop-loss.
  // These are technical reference points (not predictions), attached per-ticker below.
  const rangeLookback = Math.min(20, n);
  const recentLow20 = Math.min(...lows.slice(last - rangeLookback + 1, last + 1));
  const recentHigh20 = Math.max(...highs.slice(last - rangeLookback + 1, last + 1));

  const supportCandidates = [{ level: recentLow20, kind: '20-session range low' }];
  if (sma50 != null) supportCandidates.push({ level: sma50, kind: `${longPeriod}-day moving average` });
  const supportBelow = supportCandidates.filter((c) => c.level < price);
  const support = supportBelow.length
    ? supportBelow.reduce((a, b) => (b.level > a.level ? b : a))
    : { level: price * 0.94, kind: 'no nearby support in range — extrapolated' };

  let resistance;
  if (price < recentHigh20) resistance = { level: recentHigh20, kind: '20-session range high' };
  else if (price < high52) resistance = { level: high52, kind: '52-week high' };
  else resistance = { level: price * 1.06, kind: 'at 52-week highs — extrapolated, no prior resistance' };

  const buyZoneLow = round2(support.level);
  const buyZoneHigh = round2(support.level * 1.02);
  const targetLevel = round2(resistance.level);
  // Stop-loss sized by ATR (1.5x below support) instead of a flat percentage, so a volatile
  // stock gets breathing room and a quiet one gets a tight stop; falls back to 3% if ATR is
  // unavailable (very short history).
  const stopLossLevel = round2(atr != null ? support.level - 1.5 * atr : support.level * 0.97);

  // Expected-move ranges — realized (historical) daily volatility scaled by sqrt(time), the same
  // math behind an options market's "expected move," just built on trailing realized vol instead
  // of implied vol (which this dashboard has no live feed for). This is a probability band, not
  // a price forecast: under a random-walk assumption ~68% of outcomes land inside a 1-sigma band.
  const logReturns = [];
  for (let i = Math.max(1, last - 251); i <= last; i++) {
    if (closes[i - 1] > 0) logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const meanRet = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - meanRet) ** 2, 0) / Math.max(1, logReturns.length - 1);
  const dailyVol = Math.sqrt(variance);
  const annualizedVolPct = round2(dailyVol * Math.sqrt(252) * 100);

  function expectedRange(days) {
    const move = price * dailyVol * Math.sqrt(days);
    return {
      low: round2(Math.max(0, price - move)),
      high: round2(price + move),
      movePct: round2((move / price) * 100),
    };
  }
  const expectedMoves = {
    thisWeek: expectedRange(3),
    nextWeek: expectedRange(8),
    oneMonth: expectedRange(21),
    oneYear: expectedRange(252),
  };

  // Composite score: +1/-1 per indicator (trend, momentum, volume flow, MACD confirmation),
  // plus a crossover-event bonus. Range -5..+5; threshold scales with it (~60% of max).
  let score = 0;
  if (maState === 'bullish') score += 1; else if (maState === 'bearish') score -= 1;
  if (rsiState === 'oversold') score += 1; else if (rsiState === 'overbought') score -= 1;
  if (volState === 'accumulation') score += 1; else if (volState === 'distribution') score -= 1;
  if (macdState === 'bullish') score += 1; else if (macdState === 'bearish') score -= 1;
  if (maCrossEvent === 'golden_cross') score += 1;
  if (maCrossEvent === 'death_cross') score -= 1;

  let signal = 'HOLD';
  if (score >= 3) signal = 'BUY';
  else if (score <= -3) signal = 'SELL';

  // Sparkline: last 90 trading days of closes, plus an aligned long-SMA trend line
  const sparkStart = Math.max(0, last - 89);
  const sparkSlice = closes.slice(sparkStart, last + 1);
  const sparkDates = dates.slice(sparkStart, last + 1);
  const sparkVols = vols.slice(sparkStart, last + 1);
  const sparkSma = [];
  for (let i = sparkStart; i <= last; i++) {
    const v = sma(closes, longPeriod, i);
    sparkSma.push(v != null ? round2(v) : null);
  }

  return {
    symbol,
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency,
    price: round2(price),
    changePct: round2(changePct),
    high52: round2(high52),
    low52: round2(low52),
    pctOffHigh: round2(pctOffHigh),
    pctOffLow: round2(pctOffLow),
    sma20: sma20 != null ? round2(sma20) : null,
    sma50: sma50 != null ? round2(sma50) : null,
    maState, maCrossEvent,
    rsi14: rsi14 != null ? round2(rsi14) : null,
    rsiState,
    volRatio: round2(volRatio),
    volBias: round2(volBias),
    volState,
    score, signal,
    limitedHistory,
    barsAvailable: n,
    sparkline: sparkSlice.map(round2),
    sparkDates,
    sparkVolumes: sparkVols,
    sparkSma,
    smaLabel: `SMA${longPeriod}`,
    supportLevel: round2(support.level),
    supportKind: support.kind,
    resistanceLevel: round2(resistance.level),
    resistanceKind: resistance.kind,
    buyZoneLow, buyZoneHigh, targetLevel, stopLossLevel,
    annualizedVolPct, expectedMoves,
    macd: macdVal != null ? round2(macdVal) : null,
    macdSignal: signalVal != null ? round2(signalVal) : null,
    macdState,
    atr14: atr != null ? round2(atr) : null,
    atrPct: atr != null ? round2((atr / price) * 100) : null,
    bbUpper: round2(bbUpper),
    bbLower: round2(bbLower),
    bbPosition,
  };
}

async function fetchExtendedHours(symbol, regularPrice) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1m&includePrePost=true`;
  let json;
  try {
    json = await fetchJson(url);
  } catch (e) {
    return null;
  }
  const result = json?.chart?.result?.[0];
  if (!result || !result.timestamp?.length) return null;
  const meta = result.meta;
  const closes = result.indicators.quote[0].close;
  let lastIdx = closes.length - 1;
  while (lastIdx >= 0 && closes[lastIdx] == null) lastIdx--;
  if (lastIdx < 0) return null;
  const lastTs = result.timestamp[lastIdx];
  const lastPrice = closes[lastIdx];

  const periods = meta.currentTradingPeriod || {};
  let session = 'regular';
  if (periods.pre && lastTs >= periods.pre.start && lastTs < periods.pre.end) session = 'pre-market';
  else if (periods.post && lastTs >= periods.post.start && lastTs < periods.post.end) session = 'after-hours';
  else if (periods.regular && (lastTs < periods.regular.start || lastTs >= periods.regular.end)) session = periods.post && lastTs >= periods.post.end ? 'after-hours (stale)' : 'closed';

  if (session === 'regular' || session === 'closed') return null; // nothing extended to show

  return {
    extendedSession: session,
    extendedPrice: round2(lastPrice),
    extendedChangePct: round2(((lastPrice - regularPrice) / regularPrice) * 100),
    extendedAsOf: new Date(lastTs * 1000).toISOString(),
  };
}

function round2(x) { return Math.round(x * 100) / 100; }

async function fetchEarnings(symbol, nowMs) {
  const url = `https://stockanalysis.com/api/symbol/s/${symbol}/earnings`;
  let json;
  try {
    json = await fetchJson(url);
  } catch (e) {
    return { earningsError: 'fetch_failed' };
  }
  const rows = json?.data;
  if (!Array.isArray(rows) || rows.length === 0) return { earningsError: 'no_data' };

  const now = new Date(nowMs);
  const future = rows.filter((r) => new Date(r.date) >= now).sort((a, b) => new Date(a.date) - new Date(b.date));
  const past = rows.filter((r) => new Date(r.date) < now && r.eps_actual != null).sort((a, b) => new Date(b.date) - new Date(a.date));

  const next = future[0];
  const last = past[0];
  const daysToEarnings = next ? Math.round((new Date(next.date) - now) / 86400000) : null;

  return {
    nextEarningsDate: next?.date ?? null,
    nextEarningsConfirmed: next?.confirmed ?? null,
    daysToEarnings,
    lastEarningsDate: last?.date ?? null,
    lastEpsActual: last?.eps_actual ?? null,
    lastEpsEst: last?.eps_est ?? null,
    lastEpsSurprisePct: last?.eps_surprise_percent != null ? round2(last.eps_surprise_percent * 100) : null,
  };
}

function summarizeContract(c, nowMs) {
  if (!c) return null;
  const mid = c.bid != null && c.ask != null && c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : (c.last_trade_price ?? null);
  const ivPct = c.iv != null && c.iv > 0.02 && c.iv < 5 ? round2(c.iv * 100) : null; // filter out noisy 0/implausible IV
  return {
    strike: c.strike,
    expiry: c.expiry,
    dte: Math.round((new Date(c.expiry + 'T00:00:00Z') - nowMs) / 86400000),
    bid: c.bid != null ? round2(c.bid) : null,
    ask: c.ask != null ? round2(c.ask) : null,
    mid: mid != null ? round2(mid) : null,
    ivPct,
    openInterest: c.open_interest ?? null,
    volume: c.volume ?? null,
    delta: c.delta != null ? round2(c.delta) : null,
  };
}

async function fetchOptionsChain(symbol, price, supportLevel, targetLevel, nowMs) {
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`;
  let json;
  try {
    json = await fetchJson(url);
  } catch (e) {
    return { optionsError: 'fetch_failed' };
  }
  const raw = json?.data?.options;
  if (!Array.isArray(raw) || raw.length === 0) return { optionsError: 'no_data' };

  const parsed = [];
  for (const o of raw) {
    if (!o.option.startsWith(symbol)) continue;
    const rest = o.option.slice(symbol.length);
    const m = rest.match(/^(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
    if (!m) continue;
    const [, yy, mm, dd, type, strikeStr] = m;
    parsed.push({ ...o, expiry: `20${yy}-${mm}-${dd}`, type, strike: parseInt(strikeStr, 10) / 1000 });
  }
  if (parsed.length === 0) return { optionsError: 'unparseable' };

  const expiries = [...new Set(parsed.map((p) => p.expiry))].sort();
  const dte = (exp) => Math.round((new Date(exp + 'T00:00:00Z') - nowMs) / 86400000);
  // Skip ultra-short-dated (<5 calendar days) expiries — deliberately avoids near-lotto 0-2DTE contracts.
  const eligible = expiries.filter((e) => dte(e) >= 5);
  if (eligible.length === 0) return { optionsError: 'no_eligible_expiry' };
  const nearExpiry = eligible[0];
  const monthlyExpiry = eligible.find((e) => dte(e) >= 25) || eligible[eligible.length - 1];

  function closestByStrike(expiry, type, targetStrike) {
    const pool = parsed.filter((p) => p.expiry === expiry && p.type === type);
    if (pool.length === 0) return null;
    return pool.reduce((a, b) => (Math.abs(b.strike - targetStrike) < Math.abs(a.strike - targetStrike) ? b : a));
  }

  return {
    optionsAsOfPrice: round2(price),
    nearTermCall: summarizeContract(closestByStrike(nearExpiry, 'C', price), nowMs),
    nearTermPut: summarizeContract(closestByStrike(nearExpiry, 'P', price), nowMs),
    monthlyCall: summarizeContract(closestByStrike(monthlyExpiry, 'C', price), nowMs),
    monthlyPut: summarizeContract(closestByStrike(monthlyExpiry, 'P', price), nowMs),
    shortPutNearSupport: summarizeContract(closestByStrike(monthlyExpiry, 'P', supportLevel), nowMs),
    shortCallNearResistance: summarizeContract(closestByStrike(monthlyExpiry, 'C', targetLevel), nowMs),
  };
}

(async () => {
  const nowMs = Date.now();
  const onlySymbols = process.argv.slice(2).map((s) => s.toUpperCase());
  const targets = onlySymbols.length ? TICKERS.filter((t) => onlySymbols.includes(t)) : TICKERS;
  const results = [];
  for (const t of targets) {
    try {
      const r = await analyze(t);
      if (!r.error) {
        const earnings = await fetchEarnings(t, nowMs);
        Object.assign(r, earnings);
        const ext = await fetchExtendedHours(t, r.price);
        if (ext) Object.assign(r, ext);
        const opts = await fetchOptionsChain(t, ext?.extendedPrice ?? r.price, r.supportLevel, r.targetLevel, nowMs);
        Object.assign(r, opts);
      }
      results.push(r);
      console.error(`done: ${t}`);
    } catch (e) {
      results.push({ symbol: t, error: e.message });
      console.error(`error: ${t}: ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  console.log(JSON.stringify({ fetchedAt: new Date(nowMs).toISOString(), results }, null, 2));
})();
