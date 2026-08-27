const https = require('https');

const COINS = [
  { symbol: 'BTC', id: 'bitcoin' },
  { symbol: 'ETH', id: 'ethereum' },
  { symbol: 'SOL', id: 'solana' },
  { symbol: 'AIOZ', id: 'aioz-network' },
  { symbol: 'SKALE', id: 'skale' },
  { symbol: 'HYPE', id: 'hyperliquid' },
  { symbol: 'POPCAT', id: 'popcat' },
  { symbol: 'KAS', id: 'kaspa' },
  { symbol: 'FET', id: 'fetch-ai' },
];

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

function round2(x) { return Math.round(x * 100) / 100; }
function roundSig(x, sig) {
  if (x === 0) return 0;
  const mag = Math.ceil(Math.log10(Math.abs(x)));
  const factor = Math.pow(10, sig - mag);
  return Math.round(x * factor) / factor;
}
function roundPrice(x) { return x >= 1 ? round2(x) : roundSig(x, 4); }

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
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function macd(closes) {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null);
  const firstValid = macdLine.findIndex((v) => v != null);
  if (firstValid === -1) return { macdSeries: macdLine, signalSeries: closes.map(() => null) };
  const macdValid = macdLine.slice(firstValid);
  const signalValid = emaSeries(macdValid, 9);
  const signalSeries = new Array(closes.length).fill(null);
  for (let i = 0; i < signalValid.length; i++) signalSeries[firstValid + i] = signalValid[i];
  return { macdSeries: macdLine, signalSeries };
}

function rsi(closes, period) {
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

async function analyze(coin) {
  const url = `https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart?vs_currency=usd&days=365`;
  let json;
  try {
    json = await fetchJson(url);
  } catch (e) {
    return { symbol: coin.symbol, error: 'fetch_failed: ' + e.message };
  }
  if (!json.prices || json.error) {
    return { symbol: coin.symbol, error: json.status?.error_message || json.error || 'no_data' };
  }

  // market_chart gives [timestamp, price] / [timestamp, volume] points, ~daily granularity for
  // a 365-day window. No intraday OHLC on the free tier, so support/resistance and volatility
  // are built from the close-price series only (no true high/low, hence no true ATR — see the
  // "avg daily move" fallback below).
  const priceRows = json.prices;
  const volRows = json.total_volumes;
  const dates = priceRows.map((p) => new Date(p[0]).toISOString().slice(0, 10));
  const closes = priceRows.map((p) => p[1]);
  const vols = volRows.map((v) => v[1]);
  const n = closes.length;
  if (n < 25) return { symbol: coin.symbol, error: 'insufficient_history (' + n + ' bars)' };

  const last = n - 1;
  const price = closes[last];
  const prevClose = closes[last - 1];
  const changePct = ((price - prevClose) / prevClose) * 100;

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
    const wasAbove = sma20Prev > sma50Prev, isAbove = sma20 > sma50;
    if (!wasAbove && isAbove) maCrossEvent = 'golden_cross';
    if (wasAbove && !isAbove) maCrossEvent = 'death_cross';
  }

  const rsiSeries = rsi(closes, 14);
  const rsi14 = rsiSeries[last];
  let rsiState = 'neutral';
  if (rsi14 != null) { if (rsi14 < 30) rsiState = 'oversold'; else if (rsi14 > 70) rsiState = 'overbought'; }

  const { macdSeries, signalSeries } = macd(closes);
  const macdVal = macdSeries[last], signalVal = signalSeries[last];
  let macdState = 'neutral';
  if (macdVal != null && signalVal != null) macdState = macdVal > signalVal ? 'bullish' : 'bearish';

  const vol5 = vols.slice(last - 4, last + 1).reduce((a, b) => a + b, 0) / 5;
  const lookback3mo = Math.min(90, last);
  const vol3mo = vols.slice(last - lookback3mo + 1, last + 1).reduce((a, b) => a + b, 0) / lookback3mo;
  const volRatio = vol3mo > 0 ? vol5 / vol3mo : 1;
  let upVol = 0, downVol = 0;
  for (let i = last - 9; i <= last; i++) {
    if (i <= 0) continue;
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) upVol += vols[i]; else if (diff < 0) downVol += vols[i];
  }
  const volBias = upVol + downVol > 0 ? (upVol - downVol) / (upVol + downVol) : 0;
  let volState = 'neutral';
  if (volRatio > 1.15 && volBias > 0.15) volState = 'accumulation';
  else if (volRatio > 1.15 && volBias < -0.15) volState = 'distribution';

  const high365 = Math.max(...closes);
  const low365 = Math.min(...closes);
  const pctOffHigh = ((price - high365) / high365) * 100;
  const pctOffLow = ((price - low365) / low365) * 100;

  const rangeLookback = Math.min(20, n);
  const recentLow20 = Math.min(...closes.slice(last - rangeLookback + 1, last + 1));
  const recentHigh20 = Math.max(...closes.slice(last - rangeLookback + 1, last + 1));

  const supportCandidates = [{ level: recentLow20, kind: '20-day range low' }];
  if (sma50 != null) supportCandidates.push({ level: sma50, kind: `${longPeriod}-day moving average` });
  const supportBelow = supportCandidates.filter((c) => c.level < price);
  const support = supportBelow.length
    ? supportBelow.reduce((a, b) => (b.level > a.level ? b : a))
    : { level: price * 0.85, kind: 'no nearby support in range — extrapolated' };

  let resistance;
  if (price < recentHigh20) resistance = { level: recentHigh20, kind: '20-day range high' };
  else if (price < high365) resistance = { level: high365, kind: '365-day high' };
  else resistance = { level: price * 1.15, kind: 'at 365-day highs — extrapolated, no prior resistance' };

  // No true intraday high/low on this feed, so no true ATR — approximated with the 14-day
  // average absolute daily move (close-to-close), labeled distinctly from stock ATR on the page.
  let sumAbsMove = 0;
  const moveLookback = Math.min(14, last);
  for (let i = last - moveLookback + 1; i <= last; i++) sumAbsMove += Math.abs(closes[i] - closes[i - 1]);
  const avgDailyMove = sumAbsMove / moveLookback;

  const buyZoneLow = roundPrice(support.level);
  const buyZoneHigh = roundPrice(support.level * 1.03);
  const targetLevel = roundPrice(resistance.level);
  const stopLossLevel = roundPrice(support.level - 1.5 * avgDailyMove);

  const bbPeriod = Math.min(20, n);
  const bbSma = closes.slice(last - bbPeriod + 1, last + 1).reduce((a, b) => a + b, 0) / bbPeriod;
  const bbVariance = closes.slice(last - bbPeriod + 1, last + 1).reduce((a, b) => a + (b - bbSma) ** 2, 0) / bbPeriod;
  const bbStdDev = Math.sqrt(bbVariance);
  const bbUpper = bbSma + 2 * bbStdDev, bbLower = bbSma - 2 * bbStdDev;
  let bbPosition = 'inside';
  if (price > bbUpper) bbPosition = 'above-upper'; else if (price < bbLower) bbPosition = 'below-lower';

  let score = 0;
  if (maState === 'bullish') score += 1; else if (maState === 'bearish') score -= 1;
  if (rsiState === 'oversold') score += 1; else if (rsiState === 'overbought') score -= 1;
  if (volState === 'accumulation') score += 1; else if (volState === 'distribution') score -= 1;
  if (macdState === 'bullish') score += 1; else if (macdState === 'bearish') score -= 1;
  if (maCrossEvent === 'golden_cross') score += 1;
  if (maCrossEvent === 'death_cross') score -= 1;
  let signal = 'HOLD';
  if (score >= 3) signal = 'BUY'; else if (score <= -3) signal = 'SELL';

  // Crypto trades every calendar day (365/yr), unlike stocks' ~252 trading days — the vol
  // scaling and horizon day-counts below use calendar days accordingly.
  const logReturns = [];
  for (let i = Math.max(1, last - 364); i <= last; i++) {
    if (closes[i - 1] > 0) logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const meanRet = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - meanRet) ** 2, 0) / Math.max(1, logReturns.length - 1);
  const dailyVol = Math.sqrt(variance);
  const annualizedVolPct = round2(dailyVol * Math.sqrt(365) * 100);
  function expectedRange(days) {
    const move = price * dailyVol * Math.sqrt(days);
    return { low: roundPrice(Math.max(0, price - move)), high: roundPrice(price + move), movePct: round2((move / price) * 100) };
  }
  const expectedMoves = {
    thisWeek: expectedRange(4),
    nextWeek: expectedRange(11),
    oneMonth: expectedRange(30),
    oneYear: expectedRange(365),
  };

  const sparkStart = Math.max(0, last - 89);
  const sparkSlice = closes.slice(sparkStart, last + 1);
  const sparkDates = dates.slice(sparkStart, last + 1);
  const sparkVols = vols.slice(sparkStart, last + 1);
  const sparkSma = [];
  for (let i = sparkStart; i <= last; i++) {
    const v = sma(closes, longPeriod, i);
    sparkSma.push(v != null ? roundPrice(v) : null);
  }

  return {
    symbol: coin.symbol,
    name: coin.id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
    price: roundPrice(price),
    changePct: round2(changePct),
    high52: roundPrice(high365), low52: roundPrice(low365),
    pctOffHigh: round2(pctOffHigh), pctOffLow: round2(pctOffLow),
    sma20: sma20 != null ? roundPrice(sma20) : null,
    sma50: sma50 != null ? roundPrice(sma50) : null,
    maState, maCrossEvent,
    rsi14: rsi14 != null ? round2(rsi14) : null, rsiState,
    volRatio: round2(volRatio), volBias: round2(volBias), volState,
    score, signal, limitedHistory, barsAvailable: n,
    sparkline: sparkSlice.map(roundPrice), sparkDates, sparkVolumes: sparkVols, sparkSma,
    smaLabel: `SMA${longPeriod}`,
    supportLevel: roundPrice(support.level), supportKind: support.kind,
    resistanceLevel: roundPrice(resistance.level), resistanceKind: resistance.kind,
    buyZoneLow, buyZoneHigh, targetLevel, stopLossLevel,
    annualizedVolPct, expectedMoves,
    macd: macdVal != null ? roundPrice(macdVal) : null,
    macdSignal: signalVal != null ? roundPrice(signalVal) : null, macdState,
    avgDailyMove: roundPrice(avgDailyMove),
    avgDailyMovePct: round2((avgDailyMove / price) * 100),
    bbUpper: roundPrice(bbUpper), bbLower: roundPrice(bbLower), bbPosition,
  };
}

(async () => {
  const nowMs = Date.now();
  const onlySymbols = process.argv.slice(2).map((s) => s.toUpperCase());
  const targets = onlySymbols.length ? COINS.filter((c) => onlySymbols.includes(c.symbol)) : COINS;
  const results = [];
  for (const coin of targets) {
    try {
      const r = await analyze(coin);
      results.push(r);
      console.error(`done: ${coin.symbol}`);
    } catch (e) {
      results.push({ symbol: coin.symbol, error: e.message });
      console.error(`error: ${coin.symbol}: ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 15000)); // CoinGecko free tier is rate-limit sensitive
  }
  console.log(JSON.stringify({ fetchedAt: new Date(nowMs).toISOString(), results }, null, 2));
})();
