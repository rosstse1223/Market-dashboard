// ── EDIT YOUR WATCHLIST HERE ──────────────────────────────────
const TICKERS = ["NVDA","AAPL","MSFT","META","GOOGL","AMZN","TSLA","AMD","SMCI","PLTR"];
// ─────────────────────────────────────────────────────────────

const CORS_PROXY = "https://corsproxy.io/?";

async function fetchQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=60d`;
  try {
    const res = await fetch(CORS_PROXY + encodeURIComponent(url));
    const json = await res.json();
    const meta = json.chart.result[0].meta;
    const closes = json.chart.result[0].indicators.quote[0].close;
    const highs  = json.chart.result[0].indicators.quote[0].high;
    const lows   = json.chart.result[0].indicators.quote[0].low;
    const volumes= json.chart.result[0].indicators.quote[0].volume;
    const valid  = closes.filter(c => c !== null);

    const price  = meta.regularMarketPrice;
    const prev   = meta.chartPreviousClose;
    const changePct = ((price - prev) / prev * 100).toFixed(2);
    const vol    = volumes[volumes.length - 1];

    // EMA helper
    function ema(data, period) {
      const k = 2 / (period + 1);
      let e = data[0];
      for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
      return e;
    }

    // SMA helper
    function sma(data, period) {
      const slice = data.slice(-period);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    }

    const ema10 = ema(valid, 10);
    const ema20 = ema(valid, 20);
    const sma50 = sma(valid, Math.min(50, valid.length));

    // Grade
    let grade = "C";
    if (ema10 > ema20 && ema20 > sma50) grade = "A";
    else if (ema10 > sma50 || ema20 > sma50) grade = "B";

    // ATR (14-day)
    let atrSum = 0, atrCount = 0;
    const len = Math.min(valid.length, highs.filter(h=>h).length, lows.filter(l=>l).length);
    for (let i = 1; i < len; i++) {
      const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
      atrSum += tr; atrCount++;
    }
    const atr = atrCount > 0 ? atrSum / atrCount : 1;
    const atrx = ((price - sma50) / atr).toFixed(2);

    // 1M-VARS (placeholder — real calc needs SPY correlation)
    const vars = (50 + (parseFloat(changePct) * 3)).toFixed(0);
    const varsClamped = Math.max(0, Math.min(100, parseFloat(vars)));

    return { ticker, price, changePct, grade, atrx, vars: varsClamped, vol };
  } catch(e) {
    return { ticker, price: "—", changePct: "—", grade: "—", atrx: "—", vars: "—", vol: "—" };
  }
}

async function buildTable() {
  const tbody = document.getElementById("table-body");
  tbody.innerHTML = "";
  const results = await Promise.all(TICKERS.map(fetchQuote));

  results.forEach((d, i) => {
    const changeClass = parseFloat(d.changePct) >= 0 ? "positive" : "negative";
    const gradeClass  = `grade-${d.grade}`;
    const changeStr   = d.changePct !== "—" ? (parseFloat(d.changePct) >= 0 ? "+" : "") + d.changePct + "%" : "—";
    const volStr      = d.vol !== "—" ? (d.vol / 1e6).toFixed(1) + "M" : "—";
    const priceStr    = d.price !== "—" ? "$" + parseFloat(d.price).toFixed(2) : "—";

    const row = `<tr>
      <td>${i + 1}</td>
      <td><b>${d.ticker}</b></td>
      <td>${priceStr}</td>
      <td class="${changeClass}">${changeStr}</td>
      <td class="${gradeClass}">${d.grade}</td>
      <td>${d.atrx}</td>
      <td>${d.vars !== "—" ? d.vars + "%" : "—"}</td>
      <td>${volStr}</td>
    </tr>`;
    tbody.innerHTML += row;
  });
}

buildTable();

// ── FEAR & GREED INDEX ────────────────────────────────────────
async function loadFearGreed() {
  const url = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata/2024-01-01";
  try {
    const res = await fetch(CORS_PROXY + encodeURIComponent(url));
    const json = await res.json();
    const current = json.fear_and_greed;
    const score = Math.round(current.score);
    const rating = current.rating;          // e.g. "Fear", "Greed"
    const prevScore = Math.round(json.fear_and_greed_historical.data.slice(-2)[0].y);

    // Color class
    let cls = "fg-neutral";
    if (score <= 24)      cls = "fg-extreme-fear";
    else if (score <= 44) cls = "fg-fear";
    else if (score <= 55) cls = "fg-neutral";
    else if (score <= 74) cls = "fg-greed";
    else                  cls = "fg-extreme-greed";

    // Capitalise label nicely
    const label = rating.replace(/_/g, " ")
                         .toLowerCase()
                         .replace(/\b\w/g, c => c.toUpperCase());

    document.getElementById("fg-score").textContent = score;
    document.getElementById("fg-score").className = cls;
    document.getElementById("fg-label").textContent = label;
    document.getElementById("fg-label").className = cls;
    document.getElementById("fg-prev").textContent = `Previous: ${prevScore}`;
  } catch(e) {
    document.getElementById("fg-label").textContent = "Unable to load";
  }
}

loadFearGreed();
// ─────────────────────────────────────────────────────────────

