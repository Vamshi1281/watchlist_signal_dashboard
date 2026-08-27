const fs = require('fs');
const path = require('path');

const stocksRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'stocks_output.json'), 'utf8'));
const cryptoRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'crypto_output.json'), 'utf8'));

function processResults(raw) {
  const all = raw.results;
  const ok = all.filter((s) => !s.error);
  const failed = all.filter((s) => s.error);
  const signalOrder = { BUY: 0, HOLD: 1, SELL: 2 };
  ok.sort((a, b) => {
    if (signalOrder[a.signal] !== signalOrder[b.signal]) return signalOrder[a.signal] - signalOrder[b.signal];
    if (a.signal === 'SELL') return a.score - b.score;
    return b.score - a.score;
  });
  const counts = { BUY: 0, HOLD: 0, SELL: 0 };
  ok.forEach((s) => counts[s.signal]++);
  return { fetchedAt: raw.fetchedAt, ok, failed, counts };
}

const stocksData = processResults(stocksRaw);
const cryptoData = processResults(cryptoRaw);
stocksData.earningsSoonCount = stocksData.ok.filter(isEarningsSoon).length;

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtPct(x) { return (x > 0 ? '+' : '') + x.toFixed(2) + '%'; }
function fmtMoney(x) {
  const abs = Math.abs(x);
  let decimals = 2;
  if (abs > 0 && abs < 1) decimals = abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 8;
  return '$' + x.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtVol(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(v);
}

const STATUS = { BUY: 'var(--good)', HOLD: 'var(--warning)', SELL: 'var(--critical)' };
const STATUS_ICON = {
  BUY: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none"><path d="M8 3v10M8 3l4 4M8 3L4 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  HOLD: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none"><circle cx="8" cy="8" r="1.6" fill="currentColor"/><circle cx="3.2" cy="8" r="1.6" fill="currentColor"/><circle cx="12.8" cy="8" r="1.6" fill="currentColor"/></svg>',
  SELL: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none"><path d="M8 13V3M8 13l4-4M8 13L4 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function sparkSvg(s) {
  const w = 300, h = 60;
  const prices = s.sparkline, sma = s.sparkSma;
  const vals = prices.concat(sma.filter((v) => v != null));
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = (max - min) || 1;
  const n = prices.length;
  const xStep = n > 1 ? w / (n - 1) : w;
  const y = (v) => (h - 4) - ((v - min) / range) * (h - 8);

  const pricePts = prices.map((v, i) => [i * xStep, y(v)]);
  const pricePath = pricePts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');

  let smaPath = '', started = false;
  sma.forEach((v, i) => {
    if (v == null) { started = false; return; }
    smaPath += (started ? 'L' : 'M') + (i * xStep).toFixed(1) + ',' + y(v).toFixed(1) + ' ';
    started = true;
  });

  const lastPt = pricePts[pricePts.length - 1];
  const color = STATUS[s.signal];

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" class="spark" role="img" aria-label="${esc(s.symbol)} price trend over the last ${n} days, ${s.smaLabel} overlay">
    <line x1="0" y1="${h - 4}" x2="${w}" y2="${h - 4}" class="spark-baseline"/>
    ${smaPath ? `<path d="${smaPath.trim()}" class="spark-sma" fill="none"/>` : ''}
    <path d="${pricePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="2.75" fill="${color}"/>
  </svg>`;
}

function volSvg(s) {
  const w = 300, h = 22;
  const vols = s.sparkVolumes;
  const n = vols.length;
  const max = Math.max(...vols) || 1;
  const xStep = w / n;
  const barW = Math.max(1, xStep * 0.68);
  const highlightN = Math.min(10, n);
  const highlightColor = s.volState === 'accumulation' ? 'var(--good)' : s.volState === 'distribution' ? 'var(--critical)' : 'var(--ink-muted)';
  const bars = vols.map((v, i) => {
    const bh = Math.max(1, (v / max) * (h - 2));
    const isRecent = i >= n - highlightN;
    const fill = isRecent ? highlightColor : 'var(--gridline-strong)';
    const op = isRecent ? '0.9' : '0.6';
    return `<rect x="${(i * xStep).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${fill}" opacity="${op}"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" class="volbars" role="img" aria-label="${esc(s.symbol)} daily volume, last 10 days highlighted">${bars}</svg>`;
}

function rsiGauge(s) {
  const w = 100;
  const clamp = (x) => Math.max(0, Math.min(100, x));
  const v = s.rsi14 == null ? 50 : clamp(s.rsi14);
  const markerX = (v / 100) * w;
  const color = s.rsiState === 'oversold' ? 'var(--good)' : s.rsiState === 'overbought' ? 'var(--critical)' : 'var(--ink-secondary)';
  return `<svg viewBox="0 0 ${w} 10" width="100%" height="10" preserveAspectRatio="none" class="rsi-gauge" role="img" aria-label="RSI ${s.rsi14 == null ? 'unavailable' : s.rsi14.toFixed(1)}">
    <rect x="0" y="3" width="30" height="4" rx="2" fill="var(--good)" opacity="0.25"/>
    <rect x="30" y="3" width="40" height="4" rx="2" fill="var(--gridline-strong)" opacity="0.6"/>
    <rect x="70" y="3" width="30" height="4" rx="2" fill="var(--critical)" opacity="0.25"/>
    <circle cx="${markerX.toFixed(1)}" cy="5" r="3.4" fill="${color}" stroke="var(--surface)" stroke-width="1.2"/>
  </svg>`;
}

function stateRow(label, valueText, state) {
  const cls = state === 'up' ? 'is-good' : state === 'down' ? 'is-critical' : 'is-neutral';
  const dot = `<span class="dot ${cls}"></span>`;
  return `<div class="ind-row"><span class="ind-label">${label}</span><span class="ind-value ${cls}">${dot}${valueText}</span></div>`;
}

function fmtShortDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function earningsBlock(s) {
  if (s.earningsError || !s.nextEarningsDate) {
    return `<div class="ind-row"><span class="ind-label">Next earnings</span><span class="ind-value is-neutral">n/a</span></div>`;
  }
  const soon = s.daysToEarnings != null && s.daysToEarnings >= 0 && s.daysToEarnings <= 14;
  const dateText = `${fmtShortDate(s.nextEarningsDate)} · ${s.daysToEarnings}d${s.nextEarningsConfirmed ? '' : ' (est.)'}`;
  let surpriseLine = '';
  if (s.lastEpsSurprisePct != null) {
    const beat = s.lastEpsSurprisePct >= 0;
    // A small EPS estimate base (common for names with volatile GAAP swings, e.g. fair-value
    // accounting on treasury assets) can blow the percent surprise up to a triple-digit,
    // misleading figure — fall back to the raw $ actual-vs-estimate for those.
    const extreme = Math.abs(s.lastEpsSurprisePct) > 150;
    const magnitude = extreme
      ? `EPS ${beat ? 'beat' : 'missed'} — actual ${s.lastEpsActual >= 0 ? '$' + s.lastEpsActual.toFixed(2) : '-$' + Math.abs(s.lastEpsActual).toFixed(2)} vs. est ${s.lastEpsEst >= 0 ? '$' + s.lastEpsEst.toFixed(2) : '-$' + Math.abs(s.lastEpsEst).toFixed(2)}`
      : `EPS ${beat ? 'beat' : 'missed'} by ${Math.abs(s.lastEpsSurprisePct).toFixed(1)}%`;
    surpriseLine = `<div class="ind-row"><span class="ind-label">Last print (${fmtShortDate(s.lastEarningsDate)})</span><span class="ind-value ${beat ? 'is-good' : 'is-critical'}"><span class="dot ${beat ? 'is-good' : 'is-critical'}"></span>${magnitude}</span></div>`;
  }
  return `<div class="ind-row"><span class="ind-label">Next earnings${soon ? ' <span class=\"soon-flag\">SOON</span>' : ''}</span><span class="ind-value ${soon ? 'is-warning' : 'is-neutral'}"><span class="dot ${soon ? 'is-warning' : ''}"></span>${dateText}</span></div>${surpriseLine}`;
}

function isEarningsSoon(s) {
  return s.daysToEarnings != null && s.daysToEarnings >= 0 && s.daysToEarnings <= 14;
}

function extendedHoursLine(s) {
  if (!s.extendedSession) return '';
  const label = s.extendedSession === 'pre-market' ? 'Pre-market' : 'After hours';
  const cls = s.extendedChangePct > 0 ? 'is-good' : s.extendedChangePct < 0 ? 'is-critical' : 'is-neutral';
  return `<div class="ext-hours ${cls}"><span class="ext-dot"></span>${label}: ${fmtMoney(s.extendedPrice)} <span class="ext-pct">(${fmtPct(s.extendedChangePct)})</span></div>`;
}

function stopLossKind(s) {
  if (s.atr14 != null) return '1.5&times; ATR below support';
  if (s.avgDailyMove != null) return '1.5&times; avg. daily move below support';
  return '3% below support';
}

function tradeLevels(s) {
  return `<div class="levels">
    <div class="level-row">
      <span class="level-label">Buy zone</span>
      <span class="level-value is-good">${fmtMoney(s.buyZoneLow)}&ndash;${fmtMoney(s.buyZoneHigh)}</span>
      <span class="level-kind">near ${esc(s.supportKind)}</span>
    </div>
    <div class="level-row">
      <span class="level-label">Target</span>
      <span class="level-value is-good">${fmtMoney(s.targetLevel)}</span>
      <span class="level-kind">${esc(s.resistanceKind)}</span>
    </div>
    <div class="level-row">
      <span class="level-label">Stop-loss</span>
      <span class="level-value is-critical">${fmtMoney(s.stopLossLevel)}</span>
      <span class="level-kind">${stopLossKind(s)}</span>
    </div>
  </div>`;
}

function expectedMovesBlock(s) {
  const rows = [
    ['This week', s.expectedMoves.thisWeek],
    ['Next week', s.expectedMoves.nextWeek],
    ['1 month', s.expectedMoves.oneMonth],
    ['1 year', s.expectedMoves.oneYear],
  ];
  const cells = rows.map(([label, r]) => `
    <div class="move-row">
      <span class="move-label">${label}</span>
      <span class="move-range">${fmtMoney(r.low)}&ndash;${fmtMoney(r.high)}</span>
      <span class="move-pct">&plusmn;${r.movePct.toFixed(0)}%</span>
    </div>`).join('');
  return `<div class="moves">
    <div class="moves-head">Expected range <span class="moves-vol">(${s.annualizedVolPct.toFixed(0)}% annualized volatility)</span></div>
    ${cells}
    <div class="moves-note">~68% historical probability band from realized volatility — not a forecast.</div>
  </div>`;
}

const OPTIONS_RATIONALE = {
  BUY: {
    long: 'Long call — defined-risk bullish bet; premium erodes with time (theta), so the move needs to happen before expiry.',
    short: 'Cash-secured put near support — collects premium on the bullish view; if assigned, you buy shares at the strike, effectively an entry order that pays you to wait.',
  },
  SELL: {
    long: 'Long put — defined-risk bearish bet; same theta decay as a long call, pointed down.',
    short: 'Covered/short call near resistance — collects premium on the bearish view but caps upside; uncapped risk if sold naked (no shares held) and wrong.',
  },
  HOLD: {
    long: 'A mixed score is a weak setup for a directional long option — theta works against you while the indicators disagree with each other.',
    short: 'Neutral premium-selling (credit spreads, iron condors) fits better here than a single-leg bet, since it profits from the stock staying range-bound.',
  },
};

function fmtContract(c, side) {
  if (!c) return `<span class="contract-na">no quote available</span>`;
  const spread = c.bid != null && c.ask != null ? ((c.ask - c.bid)).toFixed(2) : null;
  return `<span class="contract">
    <span class="contract-strike">$${c.strike}${side === 'call' ? 'C' : 'P'}</span>
    <span class="contract-exp">${fmtShortDate(c.expiry)} &middot; ${c.dte}d</span>
    <span class="contract-mid">${c.mid != null ? '$' + c.mid.toFixed(2) : 'n/a'}</span>
    <span class="contract-meta">${c.bid != null ? '$' + c.bid.toFixed(2) : '&mdash;'}/${c.ask != null ? '$' + c.ask.toFixed(2) : '&mdash;'}${c.ivPct != null ? ' &middot; IV ' + c.ivPct.toFixed(0) + '%' : ''}${c.openInterest != null ? ' &middot; OI ' + c.openInterest.toLocaleString() : ''}</span>
  </span>`;
}

function optionsAngle(s) {
  if (s.optionsError || (!s.nearTermCall && !s.nearTermPut)) {
    return `<div class="options-angle">
      <div class="oa-head">Options angle</div>
      <div class="oa-empty">No tradable options quotes found for this ticker right now.</div>
    </div>`;
  }
  const a = OPTIONS_RATIONALE[s.signal];
  const longSide = s.signal === 'SELL' ? 'put' : 'call';
  const longNear = longSide === 'call' ? s.nearTermCall : s.nearTermPut;
  const longMonthly = longSide === 'call' ? s.monthlyCall : s.monthlyPut;
  const shortContract = s.signal === 'SELL' ? s.shortCallNearResistance : s.shortPutNearSupport;
  const shortSide = s.signal === 'SELL' ? 'call' : 'put';

  return `<div class="options-angle">
    <div class="oa-head">Options angle <span class="oa-sub">(real quotes, delayed — see note below)</span></div>
    <div class="oa-row">
      <span class="oa-tag oa-long">LONG</span>
      <div class="oa-body">
        <div class="oa-text">${a.long}</div>
        <div class="oa-contracts">${fmtContract(longNear, longSide)}${longMonthly ? fmtContract(longMonthly, longSide) : ''}</div>
      </div>
    </div>
    <div class="oa-row">
      <span class="oa-tag oa-short">SHORT</span>
      <div class="oa-body">
        <div class="oa-text">${a.short}</div>
        <div class="oa-contracts">${fmtContract(shortContract, shortSide)}</div>
      </div>
    </div>
  </div>`;
}

function card(s, kind) {
  const changeCls = s.changePct > 0 ? 'is-good' : s.changePct < 0 ? 'is-critical' : 'is-neutral';
  const maText = s.maCrossEvent === 'golden_cross' ? 'Golden cross (new)' : s.maCrossEvent === 'death_cross' ? 'Death cross (new)' : s.maState === 'bullish' ? 'Short MA above long MA' : s.maState === 'bearish' ? 'Short MA below long MA' : 'Flat';
  const maState = s.maCrossEvent === 'golden_cross' || s.maState === 'bullish' ? 'up' : s.maCrossEvent === 'death_cross' || s.maState === 'bearish' ? 'down' : 'flat';
  const rsiText = s.rsi14 == null ? 'n/a' : `${s.rsi14.toFixed(1)} — ${s.rsiState === 'oversold' ? 'Oversold' : s.rsiState === 'overbought' ? 'Overbought' : 'Neutral'}`;
  const rsiState = s.rsiState === 'oversold' ? 'up' : s.rsiState === 'overbought' ? 'down' : 'flat';
  const volText = s.volState === 'accumulation' ? 'Accumulation (buying pressure)' : s.volState === 'distribution' ? 'Distribution (selling pressure)' : 'No unusual flow';
  const volState = s.volState === 'accumulation' ? 'up' : s.volState === 'distribution' ? 'down' : 'flat';
  const macdText = s.macdState === 'neutral' ? 'n/a (insufficient history)' : `${s.macdState === 'bullish' ? 'Above' : 'Below'} signal line (${s.macd} vs ${s.macdSignal})`;
  const macdDir = s.macdState === 'bullish' ? 'up' : s.macdState === 'bearish' ? 'down' : 'flat';
  const bbText = s.bbPosition === 'above-upper' ? `Above upper band (${fmtMoney(s.bbUpper)})` : s.bbPosition === 'below-lower' ? `Below lower band (${fmtMoney(s.bbLower)})` : `Inside band (${fmtMoney(s.bbLower)}&ndash;${fmtMoney(s.bbUpper)})`;
  const bbDir = s.bbPosition === 'above-upper' ? 'down' : s.bbPosition === 'below-lower' ? 'up' : 'flat';
  const rangeRow = s.atr14 != null
    ? stateRow('Daily range (ATR‑14)', `${fmtMoney(s.atr14)} (${s.atrPct}% of price)`, 'flat')
    : stateRow('Daily range (avg. move)', s.avgDailyMove != null ? `${fmtMoney(s.avgDailyMove)} (${s.avgDailyMovePct}% of price)` : 'n/a', 'flat');
  const highLabel = kind === 'crypto' ? '365d high' : '52w high';

  return `<article class="card" data-signal="${s.signal}" data-earnings-soon="${isEarningsSoon(s)}">
    <header class="card-head">
      <div class="card-title">
        <span class="ticker">${esc(s.symbol)}</span>
        <span class="company">${esc(s.name)}</span>
      </div>
      <span class="badge badge-${s.signal.toLowerCase()}">${STATUS_ICON[s.signal]}${s.signal}</span>
    </header>

    <div class="price-row">
      <span class="price">${fmtMoney(s.price)}</span>
      <span class="change ${changeCls}">${fmtPct(s.changePct)} today</span>
      <span class="off-high">${s.pctOffHigh.toFixed(1)}% off ${highLabel}</span>
    </div>
    ${kind === 'stock' ? extendedHoursLine(s) : ''}

    ${sparkSvg(s)}
    ${volSvg(s)}
    <div class="spark-caption">
      <span><i class="swatch swatch-price" style="--c:${STATUS[s.signal]}"></i>Price</span>
      <span><i class="swatch swatch-sma"></i>${esc(s.smaLabel)} trend</span>
      <span class="volcap">Volume (last 10d ${s.volState === 'neutral' ? 'flat' : s.volState})</span>
    </div>

    <div class="indicators">
      ${stateRow('Trend (MA cross)', maText, maState)}
      ${stateRow('Momentum (RSI‑14)', rsiText, rsiState)}
      ${rsiGauge(s)}
      ${stateRow('Momentum (MACD)', macdText, macdDir)}
      ${stateRow('Volume flow', volText, volState)}
      ${stateRow('Volatility (Bollinger)', bbText, bbDir)}
      ${rangeRow}
    </div>

    ${tradeLevels(s)}
    ${expectedMovesBlock(s)}
    ${kind === 'stock' ? optionsAngle(s) : ''}

    ${kind === 'stock' ? `<div class="indicators earnings-block">${earningsBlock(s)}</div>` : ''}

    <footer class="card-foot">
      <span>Score ${s.score > 0 ? '+' : ''}${s.score} / 5</span>
      ${s.limitedHistory ? `<span class="flag-limited">Limited history (${s.barsAvailable} sessions — recent listing)</span>` : ''}
    </footer>
  </article>`;
}

function tableRow(s, kind) {
  const earningsCell = s.nextEarningsDate
    ? `${fmtShortDate(s.nextEarningsDate)} (${s.daysToEarnings}d)${isEarningsSoon(s) ? ' <span class="soon-flag">SOON</span>' : ''}`
    : 'n/a';
  return `<tr data-signal="${s.signal}" data-earnings-soon="${isEarningsSoon(s)}">
    <td class="tk">${esc(s.symbol)}</td>
    <td>${esc(s.name)}</td>
    <td class="num">${fmtMoney(s.price)}</td>
    <td class="num ${s.changePct > 0 ? 'is-good' : s.changePct < 0 ? 'is-critical' : ''}">${fmtPct(s.changePct)}</td>
    <td class="num">${s.pctOffHigh.toFixed(1)}%</td>
    <td>${s.maState}${s.maCrossEvent ? ' (' + s.maCrossEvent.replace('_', ' ') + ')' : ''}</td>
    <td class="num">${s.rsi14 == null ? 'n/a' : s.rsi14.toFixed(1)} (${s.rsiState})</td>
    <td>${s.macdState}</td>
    <td>${s.volState}</td>
    ${kind === 'stock' ? `<td>${earningsCell}</td>` : ''}
    <td class="num">${s.score > 0 ? '+' : ''}${s.score}</td>
    <td><span class="badge badge-${s.signal.toLowerCase()} sm">${s.signal}</span></td>
  </tr>`;
}

const STOCK_MANUAL_NOTES = [
  'You listed <strong>RTGI</strong>, which isn’t a listed ticker — swapped in <strong>RGTI</strong> (Rigetti Computing), the closest real match, shown below instead.',
  'You listed <strong>QA</strong>, which resolves to an empty exchange quote stub with no price/volume history — not a tradable equity ticker, so it was dropped.',
  'You listed <strong>QTBS</strong>, which isn’t a listed ticker either — swapped in <strong>QBTS</strong> (D‑Wave Quantum), the closest real match, shown below instead.',
];
const CRYPTO_MANUAL_NOTES = [];

function fmtFetchedLabel(iso) {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York' }) + ' ET';
}

function buildPanel(data, kind, opts) {
  const { ok, failed, counts, fetchedAt } = data;
  const earningsSoonCount = kind === 'stock' ? data.earningsSoonCount : 0;
  const cardsHtml = ok.map((s) => card(s, kind)).join('\n');
  const rowsHtml = ok.map((s) => tableRow(s, kind)).join('\n');
  const fetchedLabel = fmtFetchedLabel(fetchedAt);
  const manualNotes = kind === 'stock' ? STOCK_MANUAL_NOTES : CRYPTO_MANUAL_NOTES;

  return `
  <div class="hero">
    <span class="eyebrow">${esc(opts.eyebrow)}</span>
    <h1>${esc(opts.title)}</h1>
    <p class="sub">${opts.subtitle}</p>
    <div class="meta-line">SNAPSHOT — NOT AUTO-REFRESHING · PULLED ${esc(fetchedLabel).toUpperCase()} · ${esc(opts.historyLabel)} · SOURCE: ${esc(opts.sourceLabel)}</div>
  </div>

  ${opts.disclaimers.map((d) => `<div class="disclaimer"><strong>${d.title}</strong> ${d.body}</div>`).join('\n')}

  ${manualNotes.length || failed.length ? `<div class="data-notes"><strong>Data notes:</strong><br>${manualNotes.map((n) => '• ' + n).concat(failed.map((f) => `• <strong>${esc(f.symbol)}</strong>: ${esc(f.error)}`)).join('<br>')}</div>` : ''}

  <div class="summary">
    <div class="stat-tile buy"><div class="n">${counts.BUY}</div><div class="l">Buy signal</div></div>
    <div class="stat-tile hold"><div class="n">${counts.HOLD}</div><div class="l">Hold / mixed</div></div>
    <div class="stat-tile sell"><div class="n">${counts.SELL}</div><div class="l">Sell signal</div></div>
    <div class="stat-tile"><div class="n">${ok.length}</div><div class="l">${esc(opts.assetNoun)} tracked</div></div>
  </div>

  <div class="toolbar">
    <div class="filters" role="group" aria-label="Filter by signal">
      <button class="chip active" data-filter="ALL">All (${ok.length})</button>
      <button class="chip" data-filter="BUY">Buy (${counts.BUY})</button>
      <button class="chip" data-filter="HOLD">Hold (${counts.HOLD})</button>
      <button class="chip" data-filter="SELL">Sell (${counts.SELL})</button>
      ${kind === 'stock' ? `<button class="chip" data-filter="EARNINGS_SOON">Earnings ≤14d (${earningsSoonCount})</button>` : ''}
    </div>
    <button class="view-toggle" data-view-toggle>View as table</button>
  </div>

  <div class="grid" data-card-grid>
    ${cardsHtml}
  </div>

  <div class="table-wrap" data-table-wrap hidden>
    <table class="data-table">
      <thead>
        <tr>
          <th>${esc(opts.symbolLabel)}</th><th>Name</th><th class="num">Price</th><th class="num">Change</th>
          <th class="num">Off ${kind === 'crypto' ? '365d' : '52w'} high</th><th>Trend</th><th class="num">RSI‑14</th><th>MACD</th><th>Volume flow</th>
          ${kind === 'stock' ? '<th>Next earnings</th>' : ''}<th class="num">Score</th><th>Signal</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  </div>

  <div class="methodology">
    <h2>How the signal is built</h2>
    <div class="method-grid">
      ${opts.methodologyCards.join('\n')}
    </div>
    <p class="fine-print">
      Four technical indicators (trend, RSI, volume flow, MACD) each contribute +1 (bullish) or −1 (bearish) to a composite score (range −5 to +5, including the crossover-event bonus). Score ≥ +3 → <strong style="color:var(--good)">BUY</strong>; ≤ −3 → <strong style="color:var(--critical)">SELL</strong>; anything in between → <strong style="color:var(--warning)">HOLD</strong>. This is a simple, transparent heuristic — not a backtested strategy, and it says nothing about valuation or whether ${opts.assetNoun.toLowerCase()} is a good long-term holding.
    </p>
    <p class="fine-print" style="margin-top:10px;">
      <strong style="color:var(--ink-primary);">Refresh cadence:</strong> this page is a static snapshot generated once, not a live feed — re-run it whenever you want current numbers.
    </p>
  </div>`;
}

const stockPanel = buildPanel(stocksData, 'stock', {
  eyebrow: 'Trend · Momentum · Volume Flow',
  title: 'Watchlist Signal Board',
  subtitle: `Rules-based technical read on your ${stocksData.ok.length}-ticker stock watchlist — trend, momentum, volume flow, and volatility combined into one buy / hold / sell signal per stock, plus real options quotes and after-hours pricing.`,
  historyLabel: '1Y DAILY HISTORY',
  sourceLabel: 'PUBLIC DELAYED MARKET DATA (EQUITIES + CBOE OPTIONS)',
  assetNoun: 'Tickers',
  symbolLabel: 'Ticker',
  disclaimers: [
    {
      title: 'Not financial advice.',
      body: `Signals are derived purely from historical price and volume — moving-average trend, RSI‑14 momentum, MACD, and a 10‑day volume-flow proxy for "who's buying/selling." They ignore news, fundamentals, and real order-flow/institutional data, and a rule that scores today can flip tomorrow. The buy/target/stop-loss levels on each card are mechanically derived from recent support and resistance — not a prediction that price will reach them, and not a substitute for your own risk tolerance and position sizing. Each card also shows the next confirmed/estimated earnings date and the last quarter's EPS surprise as context — earnings dates don't feed the score, since a stock can be technically "bullish" right into a print that erases it overnight. This page is a point-in-time snapshot, not a live feed.`,
    },
    {
      title: 'On options and "expected ranges."',
      body: `The options quotes on each card (strike, expiry, bid/ask, IV, open interest) are real, pulled from CBOE's public delayed feed at the same time as the price data — typically delayed up to ~15 minutes, and wider/thinner on small-cap names, so treat bid/ask as a starting point, not a fill price. Contracts expiring in under 5 calendar days are deliberately excluded — that's the "lotto" zone (cheap, high-odds-of-total-loss, pure time-decay bets), and this dashboard won't surface them even as informational rows. Showing a real quote is still not a recommendation to trade it. The weekly/monthly/yearly ranges are a separate statistical <em>expected-move band</em> from each stock's own realized historical volatility (~68% band, same math options desks use, built on historical vol since this feed doesn't expose full-chain implied vol as a standalone series) — not a price target and not a forecast of where the stock will actually go.`,
    },
  ],
  methodologyCards: [
    `<div class="method-card"><h3>Trend — SMA crossover</h3><p>Short moving average vs. a longer one (20/50-day for most tickers, scaled down for recent listings). Short above long = bullish; a fresh crossover (golden/death cross) counts extra.</p></div>`,
    `<div class="method-card"><h3>Momentum — RSI‑14 &amp; MACD</h3><p>RSI‑14 below 30 = oversold, above 70 = overbought. MACD (12/26/9) adds trend confirmation: the fast EMA vs. slow EMA line above or below its own signal line.</p></div>`,
    `<div class="method-card"><h3>Volume flow — accumulation/distribution</h3><p>Compares 5‑day vs. 3‑month average volume, weighted by whether the heavier volume came on up days (accumulation — people stepping in) or down days (distribution — people exiting).</p></div>`,
    `<div class="method-card"><h3>Volatility — Bollinger Bands &amp; ATR‑14</h3><p>Bollinger (20, 2σ) shows price against its own recent volatility envelope — informational, not scored, since RSI already covers overbought/oversold. ATR‑14 (average true range) sizes the stop-loss below support instead of a flat percentage.</p></div>`,
    `<div class="method-card"><h3>Trade levels — support &amp; resistance</h3><p>Buy zone = nearest support below price (the higher of the 20‑session range low or the long moving average). Target = nearest resistance above price (20‑session range high, then the 52‑week high). Stop-loss = 1.5&times; ATR below the buy zone. Mechanical, not predictive — price can blow through any of these.</p></div>`,
    `<div class="method-card"><h3>Earnings — context, not a score input</h3><p>Each card shows the next confirmed/estimated report date and the last quarter's EPS surprise. A stock within 14 days of reporting is flagged <span class="soon-flag">SOON</span> — technical signals are least reliable right before a print, since a beat or miss can gap the price straight through any trend line.</p></div>`,
  ],
});

const cryptoPanel = buildPanel(cryptoData, 'crypto', {
  eyebrow: 'Trend · Momentum · Volume Flow · 24/7',
  title: 'Crypto Signal Board',
  subtitle: `Same technical framework applied to your ${cryptoData.ok.length}-asset crypto watchlist — adapted for a market that never closes and a free data feed with close-only (no intraday high/low) price history.`,
  historyLabel: '1Y DAILY HISTORY',
  sourceLabel: 'COINGECKO PUBLIC API, DELAYED',
  assetNoun: 'Assets',
  symbolLabel: 'Asset',
  disclaimers: [
    {
      title: 'Not financial advice — and less complete data than the stock tab.',
      body: `Same signal math as the stock tab (trend, RSI, MACD, volume flow), but crypto trades 24/7 with no earnings calendar and no after-hours distinction, so those two features are dropped rather than faked. The free data feed also has no true intraday high/low, so "ATR" here is really a 14‑day average absolute daily move (close-to-close) — a reasonable stand-in, not the textbook indicator. Low-cap alts on this list (SKALE, POPCAT, AIOZ, KAS, QUBT-adjacent tokens) can have thin order books where a single historical outlier day dominates the realized-volatility estimate — check the "annualized volatility" figure against the sparkline before trusting a wide expected-move band at face value.`,
    },
    {
      title: 'Options are not covered for crypto.',
      body: `Unlike the stock tab, this dashboard does not pull crypto options (e.g. Deribit BTC/ETH contracts) — most of these nine assets don't have liquid listed options at all, and mixing "real quotes for 2 of 9" with "nothing for the rest" would be more confusing than showing none. Ask if you specifically want BTC/ETH options added as their own thing.`,
    },
  ],
  methodologyCards: [
    `<div class="method-card"><h3>Trend — SMA crossover</h3><p>Short moving average vs. a longer one (20/50-day, scaled down for shorter histories). Short above long = bullish; a fresh crossover (golden/death cross) counts extra.</p></div>`,
    `<div class="method-card"><h3>Momentum — RSI‑14 &amp; MACD</h3><p>RSI‑14 below 30 = oversold, above 70 = overbought. MACD (12/26/9) adds trend confirmation from the fast/slow EMA relationship.</p></div>`,
    `<div class="method-card"><h3>Volume flow — accumulation/distribution</h3><p>Compares 5‑day vs. 3‑month average traded volume (USD), weighted by whether the heavier volume came on up days or down days.</p></div>`,
    `<div class="method-card"><h3>Volatility — Bollinger Bands &amp; avg. daily move</h3><p>Bollinger (20, 2σ) is informational only. The "avg. daily move" (14-day mean absolute close-to-close change) substitutes for true ATR, since this feed has no intraday high/low.</p></div>`,
    `<div class="method-card"><h3>Trade levels — support &amp; resistance</h3><p>Buy zone = nearest support below price (20‑day range low or the long moving average). Target = nearest resistance (20‑day range high, then the 365‑day high). Stop-loss = 1.5&times; the avg. daily move below the buy zone.</p></div>`,
  ],
});

const html = `<!doctype html>
<title>Watchlist Signal Board</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: light;
    --page: #f3f4f6;
    --surface: #fbfcfe;
    --surface-raised: #ffffff;
    --ink-primary: #0b0e14;
    --ink-secondary: #4d5566;
    --ink-muted: #838a9a;
    --gridline: #e1e4ea;
    --gridline-strong: #c7ccd6;
    --baseline: #c7ccd6;
    --border: rgba(11,14,20,0.09);
    --accent: #2451c4;
    --accent-ink: #ffffff;
    --good: #0ca30c;
    --warning: #9a6a08;
    --warning-fill: #fab219;
    --critical: #d03b3b;
    --delta-good: #006300;
    --font-display: "Big Shoulders Display", "Arial Narrow", sans-serif;
    --font-body: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --page: #0a0c10;
      --surface: #12151c;
      --surface-raised: #171b23;
      --ink-primary: #f2f4f8;
      --ink-secondary: #aab0bf;
      --ink-muted: #767e8e;
      --gridline: #232833;
      --gridline-strong: #323a48;
      --baseline: #323a48;
      --border: rgba(242,244,248,0.10);
      --accent: #6e9bf5;
      --accent-ink: #0a0c10;
      --good: #0ca30c;
      --warning: #fab219;
      --warning-fill: #fab219;
      --critical: #e66767;
      --delta-good: #0ca30c;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --page: #0a0c10;
    --surface: #12151c;
    --surface-raised: #171b23;
    --ink-primary: #f2f4f8;
    --ink-secondary: #aab0bf;
    --ink-muted: #767e8e;
    --gridline: #232833;
    --gridline-strong: #323a48;
    --baseline: #323a48;
    --border: rgba(242,244,248,0.10);
    --accent: #6e9bf5;
    --accent-ink: #0a0c10;
    --good: #0ca30c;
    --warning: #fab219;
    --warning-fill: #fab219;
    --critical: #e66767;
    --delta-good: #0ca30c;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    color: var(--ink-primary);
    font-family: var(--font-body);
    -webkit-font-smoothing: antialiased;
  }
  @media (prefers-reduced-motion: no-preference) {
    .chip, .view-toggle, .card { transition: background-color .15s ease, border-color .15s ease, transform .1s ease; }
  }
  a { color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 28px 20px 64px; }

  .hero { margin-bottom: 22px; padding-bottom: 18px; border-bottom: 2px solid var(--ink-primary); }
  .eyebrow {
    display: block; font-family: var(--font-mono); font-size: 11.5px; font-weight: 500;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); margin-bottom: 8px;
  }
  .hero h1 {
    font-family: var(--font-display); font-weight: 800; font-size: 44px; line-height: 0.95;
    margin: 0 0 10px; letter-spacing: 0.005em; text-transform: uppercase; text-wrap: balance;
  }
  .hero p.sub { margin: 0; color: var(--ink-secondary); font-size: 15px; max-width: 62ch; line-height: 1.5; }
  .meta-line { margin-top: 12px; font-size: 12px; color: var(--ink-muted); font-family: var(--font-mono); }

  .disclaimer {
    margin: 18px 0 22px;
    padding: 13px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--warning-fill);
    border-radius: 8px;
    font-size: 13px;
    color: var(--ink-secondary);
    line-height: 1.5;
  }
  .disclaimer strong { color: var(--ink-primary); }

  .data-notes {
    margin: 0 0 22px;
    padding: 12px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12.5px;
    color: var(--ink-secondary);
    line-height: 1.6;
  }
  .data-notes strong { color: var(--ink-primary); }

  .summary { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
  .stat-tile {
    flex: 1 1 140px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 16px;
  }
  .stat-tile .n { font-family: var(--font-mono); font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat-tile .l { font-size: 11.5px; color: var(--ink-secondary); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat-tile.buy .n { color: var(--good); }
  .stat-tile.hold .n { color: var(--warning); }
  .stat-tile.sell .n { color: var(--critical); }

  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  .filters { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    appearance: none; border: 1px solid var(--border); background: var(--surface);
    color: var(--ink-secondary); font-size: 13px; font-weight: 500; padding: 7px 14px; border-radius: 999px;
    cursor: pointer; font-family: var(--font-body);
  }
  .chip:hover { background: var(--gridline); }
  .chip.active { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .view-toggle {
    border: 1px solid var(--border); background: var(--surface); color: var(--ink-secondary);
    font-size: 13px; padding: 7px 14px; border-radius: 8px; cursor: pointer; font-family: var(--font-body);
  }
  .view-toggle:hover { background: var(--gridline); }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 14px;
  }
  .card {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--stripe, var(--gridline-strong));
    border-radius: 10px;
    padding: 16px 16px 14px;
  }
  .card[data-signal="BUY"] { --stripe: var(--good); }
  .card[data-signal="HOLD"] { --stripe: var(--warning-fill); }
  .card[data-signal="SELL"] { --stripe: var(--critical); }
  .card[hidden] { display: none; }
  .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .card-title { display: flex; flex-direction: column; }
  .ticker { font-family: var(--font-mono); font-size: 18px; font-weight: 600; letter-spacing: 0.01em; }
  .company { font-size: 12px; color: var(--ink-muted); margin-top: 1px; }

  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    padding: 5px 10px; border-radius: 999px; white-space: nowrap;
  }
  .badge svg { flex: none; }
  .badge-buy { background: color-mix(in srgb, var(--good) 16%, transparent); color: var(--good); }
  .badge-hold { background: color-mix(in srgb, var(--warning-fill) 20%, transparent); color: var(--warning); }
  .badge-sell { background: color-mix(in srgb, var(--critical) 16%, transparent); color: var(--critical); }
  .badge.sm { font-size: 10.5px; padding: 3px 8px; }

  .price-row { display: flex; align-items: baseline; gap: 10px; margin: 10px 0 8px; flex-wrap: wrap; }
  .price { font-family: var(--font-mono); font-size: 19px; font-weight: 600; }
  .change { font-family: var(--font-mono); font-size: 12.5px; font-weight: 600; }
  .change.is-good { color: var(--delta-good); }
  .change.is-critical { color: var(--critical); }
  .off-high { font-size: 11.5px; color: var(--ink-muted); margin-left: auto; font-family: var(--font-mono); }

  .ext-hours {
    display: inline-flex; align-items: center; gap: 5px; font-family: var(--font-mono);
    font-size: 11.5px; font-weight: 600; margin: -4px 0 10px;
  }
  .ext-hours.is-good { color: var(--delta-good); }
  .ext-hours.is-critical { color: var(--critical); }
  .ext-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; animation: pulse 2s ease-in-out infinite; }
  .ext-pct { color: var(--ink-muted); font-weight: 500; }
  @media (prefers-reduced-motion: reduce) { .ext-dot { animation: none; } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

  .levels { margin: 10px 0; padding: 10px 11px; background: var(--page); border: 1px solid var(--gridline); border-radius: 8px; display: flex; flex-direction: column; gap: 4px; }
  .level-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
  .level-label { color: var(--ink-secondary); width: 62px; flex: none; }
  .level-value { font-family: var(--font-mono); font-weight: 600; }
  .level-kind { color: var(--ink-muted); font-size: 11px; margin-left: auto; text-align: right; }

  .moves { margin: 4px 0 10px; padding-top: 8px; border-top: 1px solid var(--gridline); }
  .moves-head { font-size: 11px; font-weight: 600; color: var(--ink-secondary); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 6px; }
  .moves-vol { font-weight: 400; text-transform: none; letter-spacing: normal; color: var(--ink-muted); }
  .move-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; padding: 2px 0; }
  .move-label { color: var(--ink-secondary); width: 62px; flex: none; }
  .move-range { font-family: var(--font-mono); font-weight: 500; }
  .move-pct { font-family: var(--font-mono); color: var(--ink-muted); margin-left: auto; font-size: 11px; }
  .moves-note { font-size: 10.5px; color: var(--ink-muted); margin-top: 4px; font-style: italic; }

  .options-angle { margin: 4px 0 0; padding-top: 8px; border-top: 1px solid var(--gridline); }
  .oa-head { font-size: 11px; font-weight: 600; color: var(--ink-secondary); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 6px; }
  .oa-sub { font-weight: 400; text-transform: none; letter-spacing: normal; color: var(--ink-muted); font-size: 10.5px; }
  .oa-row { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.45; padding: 6px 0; }
  .oa-row + .oa-row { border-top: 1px dashed var(--gridline); }
  .oa-tag { flex: none; font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: 0.04em; padding: 2px 6px; border-radius: 4px; margin-top: 1px; }
  .oa-long { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
  .oa-short { background: var(--gridline); color: var(--ink-secondary); }
  .oa-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1; }
  .oa-text { color: var(--ink-secondary); }
  .oa-empty { font-size: 12px; color: var(--ink-muted); font-style: italic; }
  .oa-contracts { display: flex; flex-direction: column; gap: 5px; }
  .contract {
    display: grid; grid-template-columns: auto auto 1fr; gap: 3px 8px; align-items: baseline;
    background: var(--page); border: 1px solid var(--gridline); border-radius: 6px; padding: 6px 8px;
    font-family: var(--font-mono); font-size: 11px;
  }
  .contract-strike { font-weight: 700; color: var(--ink-primary); }
  .contract-exp { color: var(--ink-muted); }
  .contract-mid { grid-column: 3; text-align: right; font-weight: 600; color: var(--ink-primary); }
  .contract-meta { grid-column: 1 / -1; color: var(--ink-muted); font-size: 10.5px; }
  .contract-na { font-size: 11px; color: var(--ink-muted); font-style: italic; font-family: var(--font-body); }

  .spark { display: block; margin-top: 2px; }
  .spark-baseline { stroke: var(--baseline); stroke-width: 1; }
  .spark-sma { stroke: var(--ink-muted); stroke-width: 1.25; stroke-dasharray: 3 2; opacity: 0.8; }
  .volbars { display: block; margin-top: 2px; }

  .spark-caption { display: flex; gap: 12px; font-size: 10.5px; color: var(--ink-muted); margin: 4px 0 12px; flex-wrap: wrap; }
  .spark-caption span { display: inline-flex; align-items: center; gap: 4px; }
  .swatch { width: 10px; height: 2px; border-radius: 1px; background: var(--c, var(--ink-muted)); display: inline-block; }
  .swatch-sma { background: var(--ink-muted); background-image: linear-gradient(90deg, var(--ink-muted) 60%, transparent 40%); background-size: 4px 2px; }
  .volcap { margin-left: auto; }

  .indicators { display: flex; flex-direction: column; gap: 5px; padding-top: 8px; border-top: 1px solid var(--gridline); }
  .ind-row { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; gap: 10px; }
  .ind-label { color: var(--ink-secondary); }
  .ind-value { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; text-align: right; font-family: var(--font-mono); font-size: 12px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--ink-muted); }
  .dot.is-good { background: var(--good); }
  .dot.is-critical { background: var(--critical); }
  .dot.is-warning { background: var(--warning-fill); }
  .ind-value.is-good { color: var(--delta-good); }
  .ind-value.is-critical { color: var(--critical); }
  .ind-value.is-warning { color: var(--warning); }
  .rsi-gauge { margin: -2px 0 2px; }
  .earnings-block { margin-top: 8px; padding-top: 8px; }
  .soon-flag {
    display: inline-block; font-family: var(--font-body); font-size: 9.5px; font-weight: 700;
    letter-spacing: 0.05em; color: #2b1d00; background: var(--warning-fill);
    padding: 1px 5px; border-radius: 4px; margin-left: 4px; vertical-align: 1px;
  }

  .card-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--gridline); font-size: 11px; color: var(--ink-muted); font-family: var(--font-mono); }
  .flag-limited { color: var(--warning); font-weight: 600; }

  table.data-table { width: 100%; border-collapse: collapse; font-size: 13px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  table.data-table th, table.data-table td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--gridline); white-space: nowrap; }
  table.data-table th { color: var(--ink-secondary); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.03em; }
  table.data-table td.num, table.data-table th.num { text-align: right; font-family: var(--font-mono); }
  table.data-table td.tk { font-family: var(--font-mono); font-weight: 600; }
  table.data-table tbody tr:last-child td { border-bottom: none; }
  table.data-table tr[hidden] { display: none; }
  .is-good { color: var(--delta-good); }
  .is-critical { color: var(--critical); }

  .table-wrap { overflow-x: auto; border-radius: 10px; }
  .table-wrap[hidden], .grid[hidden] { display: none; }

  .methodology { margin-top: 36px; padding-top: 20px; border-top: 1px solid var(--gridline); }
  .methodology h2 { font-family: var(--font-display); font-weight: 700; text-transform: uppercase; letter-spacing: 0.01em; font-size: 22px; margin: 0 0 12px; }
  .methodology .method-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 14px; }
  .methodology .method-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 13px 15px; }
  .methodology .method-card h3 { font-size: 13px; margin: 0 0 6px; }
  .methodology .method-card p { font-size: 12.5px; color: var(--ink-secondary); margin: 0; line-height: 1.55; }
  .methodology .fine-print { font-size: 12px; color: var(--ink-muted); line-height: 1.6; max-width: 820px; }

  .tabbar { display: flex; gap: 4px; margin-bottom: 24px; border-bottom: 2px solid var(--ink-primary); }
  .tab-btn {
    appearance: none; border: none; background: transparent; cursor: pointer;
    font-family: var(--font-display); font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
    font-size: 17px; color: var(--ink-muted); padding: 10px 20px 12px; border-bottom: 3px solid transparent;
    margin-bottom: -2px; transition: color .12s;
  }
  .tab-btn:hover { color: var(--ink-secondary); }
  .tab-btn.active { color: var(--ink-primary); border-bottom-color: var(--accent); }
  .panel[hidden] { display: none; }

  @media (max-width: 480px) {
    .wrap { padding: 20px 14px 48px; }
    .off-high { margin-left: 0; }
    .tab-btn { padding: 8px 14px 10px; font-size: 15px; }
  }
</style>

<div class="wrap">
  <div class="tabbar" role="tablist" aria-label="Asset class">
    <button class="tab-btn active" data-tab="stocks" role="tab" aria-selected="true">Stocks</button>
    <button class="tab-btn" data-tab="crypto" role="tab" aria-selected="false">Crypto</button>
  </div>

  <div class="panel" data-panel="stocks">
    ${stockPanel}
  </div>

  <div class="panel" data-panel="crypto" hidden>
    ${cryptoPanel}
  </div>
</div>

<script>
  (function () {
    function wirePanel(panel) {
      var chips = panel.querySelectorAll('.chip');
      var cards = panel.querySelectorAll('[data-card-grid] .card');
      var rows = panel.querySelectorAll('tbody tr');
      chips.forEach(function (chip) {
        chip.addEventListener('click', function () {
          chips.forEach(function (c) { c.classList.remove('active'); });
          chip.classList.add('active');
          var f = chip.getAttribute('data-filter');
          function matches(el) {
            if (f === 'ALL') return true;
            if (f === 'EARNINGS_SOON') return el.getAttribute('data-earnings-soon') === 'true';
            return el.getAttribute('data-signal') === f;
          }
          cards.forEach(function (card) { card.hidden = !matches(card); });
          rows.forEach(function (row) { row.hidden = !matches(row); });
        });
      });

      var viewToggle = panel.querySelector('[data-view-toggle]');
      var grid = panel.querySelector('[data-card-grid]');
      var tableWrap = panel.querySelector('[data-table-wrap]');
      var showingTable = false;
      viewToggle.addEventListener('click', function () {
        showingTable = !showingTable;
        grid.hidden = showingTable;
        tableWrap.hidden = !showingTable;
        viewToggle.textContent = showingTable ? 'View as cards' : 'View as table';
      });
    }

    document.querySelectorAll('.panel').forEach(wirePanel);

    var tabBtns = document.querySelectorAll('.tab-btn');
    var panels = document.querySelectorAll('.panel');
    tabBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.getAttribute('data-tab');
        tabBtns.forEach(function (b) {
          var isActive = b === btn;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        panels.forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== target; });
      });
    });
  })();
</script>
`;

fs.writeFileSync(path.join(__dirname, 'dashboard.html'), html);
console.log('wrote dashboard.html, bytes:', Buffer.byteLength(html));
console.log('stocks:', stocksData.ok.length, 'failed:', stocksData.failed.length);
console.log('crypto:', cryptoData.ok.length, 'failed:', cryptoData.failed.length);
