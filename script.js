// ════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════
const CORS_PROXY = "https://corsproxy.io/?";
const OVERALL_TICKERS = ["SPY", "QQQ", "DIA", "IWM", "ARKK", "^VIX"];

// ════════════════════════════════════════════════════════════════
// MATH HELPERS
// ════════════════════════════════════════════════════════════════
function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  let ema = arr[0] ?? 0;
  const out = [ema];
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i] ?? ema;
    ema = v * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function calcSMA(arr, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return null;
    const w = arr.slice(i - period + 1, i + 1).filter(v => v != null);
    return w.length >= Math.floor(period * 0.8)
      ? w.reduce((a, b) => a + b, 0) / w.length
      : null;
  });
}

function calcATR14(closes, highs, lows) {
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    if (!closes[i] || !closes[i-1] || !highs[i] || !lows[i]) continue;
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i-1]),
      Math.abs(lows[i]  - closes[i-1])
    ));
  }
  const last14 = trs.slice(-14);
  return last14.length ? last14.reduce((a, b) => a + b, 0) / last14.length : 0;
}

// RS Rating: 40%×P3 + 20%×P6 + 20%×P9 + 20%×P12 vs SPY, mapped 1–99
function calcRSRating(closes, spyC) {
  function pr(arr, days) {
    const i = arr.length - 1, j = i - days;
    return (j >= 0 && arr[i] && arr[j]) ? (arr[i] - arr[j]) / arr[j] : 0;
  }
  const raw = 0.4 * (pr(closes, 63)  - pr(spyC, 63))
            + 0.2 * (pr(closes, 126) - pr(spyC, 126))
            + 0.2 * (pr(closes, 189) - pr(spyC, 189))
            + 0.2 * (pr(closes, 252) - pr(spyC, 252));
  return Math.max(1, Math.min(99, Math.round(50 + 49 * Math.tanh(raw * 4))));
}

// VARS: rolling 21-day (Sharpe_stock − Sharpe_SPY) for last numBars days
function calcVARSHistory(closes, spyC, numBars = 20, win = 21) {
  const out = [];
  function dailyRet(arr, end, w) {
    const r = [];
    for (let i = end - w + 1; i <= end; i++)
      if (arr[i] && arr[i-1] && arr[i-1] > 0) r.push((arr[i] - arr[i-1]) / arr[i-1]);
    return r;
  }
  function sharpe(r) {
    if (r.length < 3) return 0;
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    const s = Math.sqrt(r.reduce((a, b) => a + (b-m)**2, 0) / r.length);
    return s > 1e-8 ? m / s : 0;
  }
  for (let bar = numBars - 1; bar >= 0; bar--) {
    const ei = closes.length - 1 - bar;
    const es = spyC.length   - 1 - bar;
    if (ei < win || es < win) { out.push(0); continue; }
    out.push(sharpe(dailyRet(closes, ei, win)) - sharpe(dailyRet(spyC, es, win)));
  }
  return out;
}

// Inline SVG histogram for VARS
function varsSVG(vals) {
  const W = 88, H = 32, mid = H / 2;
  const maxA = Math.max(...vals.map(v => Math.abs(v)), 0.2);
  const bw   = W / vals.length;
  const line = `<line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="#333" stroke-width="0.8"/>`;
  const bars = vals.map((v, i) => {
    const h = Math.max(Math.abs(v) / maxA * (mid - 2), 1);
    const x = (i * bw + 0.5).toFixed(1);
    const y = (v >= 0 ? mid - h : mid).toFixed(1);
    return `<rect x="${x}" y="${y}" width="${(bw-1).toFixed(1)}" height="${h.toFixed(1)}" fill="${v >= 0 ? "#3fb950" : "#f85149"}" rx="0.5"/>`;
  }).join("");
  return `<svg width="${W}" height="${H}" style="display:block;margin:auto;"><rect width="${W}" height="${H}" fill="#0d1117" rx="3"/>${line}${bars}</svg>`;
}

// MA cell: ▲/▼ (price vs MA) + ↑/↓ (MA trend over 3 days)
function maCell(price, maArr) {
  const cur  = maArr[maArr.length - 1];
  const prev = maArr[maArr.length - 4];
  if (!cur) return `<td style="color:#555;text-align:center;">—</td>`;
  const above = price > cur, up = prev ? cur > prev : false;
  return `<td style="text-align:center;">` +
    `<span style="color:${above ? "#3fb950" : "#f85149"}">${above ? "▲" : "▼"}</span>` +
    `<span style="color:${up    ? "#3fb950" : "#f85149"};margin-left:3px;">${up ? "↑" : "↓"}</span>` +
    `</td>`;
}

// ════════════════════════════════════════════════════════════════
// FETCH TICKER DATA (2 years of daily OHLC)
// ════════════════════════════════════════════════════════════════
async function fetchTickerData(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2y`;
  try {
    const res  = await fetch(CORS_PROXY + encodeURIComponent(url));
    const json = await res.json();
    const r    = json.chart.result[0];
    const q    = r.indicators.quote[0];
    const meta = r.meta;
    function fillNulls(arr) {
      let last = arr.find(v => v != null) ?? 0;
      return arr.map(v => { if (v != null) last = v; return last; });
    }
    return {
      ticker,
      display: ticker.replace("^", ""),
      price:     meta.regularMarketPrice,
      prevClose: meta.chartPreviousClose,
      closes: fillNulls(q.close),
      highs:  fillNulls(q.high),
      lows:   fillNulls(q.low),
    };
  } catch(e) {
    return { ticker, display: ticker.replace("^",""), error: true };
  }
}

// ════════════════════════════════════════════════════════════════
// BUILD OVERALL TABLE
// ════════════════════════════════════════════════════════════════
async function buildOverallTable() {
  const tbody = document.getElementById("table-body");
  tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:#aaa;">Loading data…</td></tr>`;

  const allData = await Promise.all(OVERALL_TICKERS.map(fetchTickerData));
  const spyRow  = allData.find(d => d.ticker === "SPY");
  const spyC    = spyRow && !spyRow.error ? spyRow.closes : [];

  tbody.innerHTML = "";

  allData.forEach((d, i) => {
    if (d.error) {
      tbody.innerHTML += `<tr><td>${i+1}</td><td><b>${d.display}</b></td>
        <td colspan="9" style="color:#f85149">Failed to load</td></tr>`;
      return;
    }

    const { display, price, prevClose, closes, highs, lows } = d;
    const isVIX = display === "VIX";

    const ema10  = calcEMA(closes, 10);
    const ema20  = calcEMA(closes, 20);
    const sma50  = calcSMA(closes, 50);
    const sma200 = calcSMA(closes, 200);
    const n = closes.length;

    // Daily Δ (prev completed day)
    const dailyChg = n >= 2 && closes[n-2] > 0
      ? ((closes[n-1] - closes[n-2]) / closes[n-2] * 100).toFixed(2) : null;

    // Live Δ (today vs prev close)
    const liveChg = prevClose > 0
      ? ((price - prevClose) / prevClose * 100).toFixed(2) : null;

    // ATRx/50MA
    let atrxStr = "—", atrxColor = "#e6edf3";
    if (!isVIX) {
      const s50 = sma50[sma50.length - 1];
      if (s50) {
        const atr = calcATR14(closes, highs, lows);
        if (atr > 0 && price > 0) {
          const val = ((price - s50) / s50) / (atr / price);
          atrxStr   = val.toFixed(2);
          const av  = parseFloat(atrxStr);
          if      (av >=  7) atrxColor = "#f85149";
          else if (av >=  4) atrxColor = "#d29922";
          else if (av <= -4) atrxColor = "#58a6ff";
        }
      }
    }

    // RS Rating
    let rsStr = "—", rsColor = "#e6edf3";
    if (!isVIX && spyC.length > 200) {
      const rs = calcRSRating(closes, spyC);
      rsStr = String(rs);
      if      (rs >= 80) rsColor = "#3fb950";
      else if (rs >= 60) rsColor = "#7ee787";
      else if (rs <= 40) rsColor = "#f85149";
    }

    // VARS sparkline
    let varsCell = `<td style="color:#555;text-align:center;">—</td>`;
    if (!isVIX && spyC.length > 42) {
      const v = calcVARSHistory(closes, spyC, 20, 21);
      varsCell = `<td style="padding:3px 8px;">${varsSVG(v)}</td>`;
    }

    // Format % change
    function fmtPct(v) {
      if (v === null) return { str: "—", cls: "" };
      return {
        str: (parseFloat(v) >= 0 ? "+" : "") + v + "%",
        cls: parseFloat(v) >= 0 ? "positive" : "negative"
      };
    }
    const dc = fmtPct(dailyChg), lc = fmtPct(liveChg);

    tbody.innerHTML += `<tr onclick="openChart('${display}')">
      <td>${i+1}</td>
      <td><b>${display}</b></td>
      <td class="${dc.cls}">${dc.str}</td>
      <td class="${lc.cls}">${lc.str}</td>
      ${maCell(price, ema10)}
      ${maCell(price, ema20)}
      ${maCell(price, sma50)}
      ${maCell(price, sma200)}
      <td style="color:${atrxColor}">${atrxStr}</td>
      <td style="color:${rsColor};font-weight:bold;">${rsStr}</td>
      ${varsCell}
    </tr>`;
  });
}

buildOverallTable();

// ════════════════════════════════════════════════════════════════
// FEAR & GREED + PUT/CALL FROM CNN
// ════════════════════════════════════════════════════════════════
async function loadFearGreed() {
  const url = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata/";
  try {
    const res  = await fetch(CORS_PROXY + encodeURIComponent(url));
    const json = await res.json();
    const cur  = json.fear_and_greed;
    const score = Math.round(cur.score);
    const history = json.fear_and_greed_historical.data;
    const prev  = history.length >= 2 ? Math.round(history[history.length - 2].y) : "–";
    const dated = new Date(cur.timestamp).toLocaleDateString("en-US",
      { month: "short", day: "numeric", year: "numeric" });

    function fgClass(s) {
      if (s <= 24) return "fg-extreme-fear";
      if (s <= 44) return "fg-fear";
      if (s <= 55) return "fg-neutral";
      if (s <= 74) return "fg-greed";
      return "fg-extreme-greed";
    }
    function fgLabel(rating) {
      return rating.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }

    document.getElementById("fg-score").textContent   = score;
    document.getElementById("fg-score").className     = fgClass(score);
    document.getElementById("fg-label").textContent   = fgLabel(cur.rating);
    document.getElementById("fg-label").className     = fgClass(score);
    document.getElementById("fg-prev").textContent    = `Previous close: ${prev}`;
    document.getElementById("fg-updated").textContent = `Updated: ${dated}`;

    const pc      = json.put_call_options;
    const pcScore = Math.round(pc.score);
    document.getElementById("pc-score").textContent = pcScore;
    document.getElementById("pc-score").className   = fgClass(pcScore);
    document.getElementById("pc-label").textContent = fgLabel(pc.rating);
    document.getElementById("pc-label").className   = fgClass(pcScore);
  } catch(e) {
    document.getElementById("fg-label").textContent = "Unable to load — try refreshing";
    document.getElementById("pc-label").textContent = "Unable to load";
  }
}
loadFearGreed();

// ════════════════════════════════════════════════════════════════
// NAAIM EXPOSURE INDEX
// ════════════════════════════════════════════════════════════════
async function loadNAAIM() {
  const url = "https://naaim.org/programs/naaim-exposure-index/";
  try {
    const res  = await fetch(CORS_PROXY + encodeURIComponent(url));
    const html = await res.text();
    const scoreMatch = html.match(/number\s+is\*?[\s\S]{0,60}?<\/h4>[\s\S]{0,80}?([\d]{1,3}\.[\d]{1,2})/i);
    const tableMatch = [...html.matchAll(/\|\s*[\d\/]+\s*\|\s*([\d\-\.]+)\s*\|/g)];
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;
    const prev  = tableMatch.length >= 2 ? parseFloat(tableMatch[1][1]) : null;
    if (score !== null) {
      let colour = "#d29922";
      if (score >= 75) colour = "#3fb950";
      if (score < 40)  colour = "#f85149";
      document.getElementById("naaim-score").textContent  = score.toFixed(2);
      document.getElementById("naaim-score").style.color  = colour;
      document.getElementById("naaim-label").textContent  =
        score >= 75 ? "Bullish / Fully Invested" :
        score >= 40 ? "Moderate / Mixed Exposure" : "Defensive / Reducing Risk";
      if (prev !== null)
        document.getElementById("naaim-prev").textContent = `Previous week: ${prev.toFixed(2)}`;
    } else {
      document.getElementById("naaim-label").textContent = "Visit NAAIM.org for latest data";
    }
  } catch(e) {
    document.getElementById("naaim-label").textContent = "Unable to load — try refreshing";
  }
}
loadNAAIM();

// ════════════════════════════════════════════════════════════════
// NET NEW HIGHS/LOWS (NYSE + NASDAQ + AMEX)
// ════════════════════════════════════════════════════════════════
async function loadNetNewHL() {
  async function fetchLatest(ticker) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`;
    try {
      const res  = await fetch(CORS_PROXY + encodeURIComponent(url));
      const json = await res.json();
      const c    = json.chart.result[0].indicators.quote[0].close;
      for (let i = c.length - 1; i >= 0; i--) if (c[i] !== null) return Math.round(c[i]);
      return 0;
    } catch(e) { return 0; }
  }
  try {
    const [nyH, nyL, naH, naL, axH, axL] = await Promise.all([
      fetchLatest("NYHGH"), fetchLatest("NYLOW"),
      fetchLatest("NAHGH"), fetchLatest("NALOW"),
      fetchLatest("AXHGH"), fetchLatest("AXLOW")
    ]);
    const nyNet = nyH - nyL, naNet = naH - naL, axNet = axH - axL;
    const total = nyNet + naNet + axNet;
    const scoreEl = document.getElementById("nnhl-score");
    const labelEl = document.getElementById("nnhl-label");
    const barEl   = document.getElementById("nnhl-bar");
    const brkEl   = document.getElementById("nnhl-breakdown");
    scoreEl.textContent = (total >= 0 ? "+" : "") + total;
    if (total > 100) {
      scoreEl.style.color = "#3fb950"; labelEl.style.color = "#3fb950";
      labelEl.textContent = "✅ Healthy Breadth — Bullish";
    } else if (total > 0) {
      scoreEl.style.color = "#7ee787"; labelEl.style.color = "#d29922";
      labelEl.textContent = "🟡 Slight Majority — Cautiously Bullish";
    } else if (total > -100) {
      scoreEl.style.color = "#e3834a"; labelEl.style.color = "#e3834a";
      labelEl.textContent = "🟠 Net Negative — Cautious";
    } else {
      scoreEl.style.color = "#f85149"; labelEl.style.color = "#f85149";
      labelEl.textContent = "🔴 Broad Weakness — Bearish";
    }
    const pct = Math.min(Math.max(50 + (total / 500) * 50, 2), 98);
    barEl.style.width      = pct + "%";
    barEl.style.background = total >= 0 ? "#3fb950" : "#f85149";
    function nc(v) { return v >= 0 ? "#3fb950" : "#f85149"; }
    brkEl.innerHTML =
      `<b>NYSE</b>: +${nyH} / −${nyL} = <b style="color:${nc(nyNet)}">${nyNet>=0?"+":""}${nyNet}</b><br>` +
      `<b>NASDAQ</b>: +${naH} / −${naL} = <b style="color:${nc(naNet)}">${naNet>=0?"+":""}${naNet}</b><br>` +
      `<b>AMEX</b>: +${axH} / −${axL} = <b style="color:${nc(axNet)}">${axNet>=0?"+":""}${axNet}</b>`;
  } catch(e) {
    document.getElementById("nnhl-label").textContent = "Unable to load — try refreshing";
  }
}
loadNetNewHL();

// ════════════════════════════════════════════════════════════════
// CHART MODAL
// ════════════════════════════════════════════════════════════════
let currentTicker = "";

function openChart(ticker) {
  currentTicker = ticker;
  const interval = document.getElementById("modal-interval").value;
  const src = `https://www.tradingview.com/widgetembed/?frameElementId=modal_chart`
    + `&symbol=${encodeURIComponent(ticker)}`
    + `&interval=${interval}`
    + `&theme=dark&style=1&locale=en`
    + `&timezone=America%2FNew_York`
    + `&withdateranges=1&hidesidetoolbar=0`
    + `&saveimage=0&hideideas=1`;
  document.getElementById("modal-chart-iframe").src = src;
  document.getElementById("modal-ticker-label").textContent = `📈 ${ticker}`;
  document.getElementById("chart-modal").classList.add("active");
  document.body.style.overflow = "hidden";
}

function reloadChart() { if (currentTicker) openChart(currentTicker); }

function closeChart() {
  document.getElementById("chart-modal").classList.remove("active");
  document.getElementById("modal-chart-iframe").src = "";
  document.body.style.overflow = "";
}

function closeModal(e) { if (e.target.id === "chart-modal") closeChart(); }

document.addEventListener("keydown", e => { if (e.key === "Escape") closeChart(); });
