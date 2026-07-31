#!/usr/bin/env node

const args = Object.fromEntries(process.argv.slice(2).flatMap((v, i, a) =>
  v.startsWith("--") ? [[v.slice(2), a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : true]] : []
));

const board = args.board || "gem";
const date1 = args.date1;
const date2 = args.date2;
const maxCap = Number(args["max-cap"] || 100);
const concurrency = Number(args.concurrency || 24);
const model = args.model || "local-relative";

if (!date1 || !date2) {
  console.error("Usage: node scan-volume-retreat.js --board gem|star|main|all --date1 YYYY-MM-DD --date2 YYYY-MM-DD [--max-cap 100] [--model local-relative|high-volume-selloff]");
  process.exit(2);
}

const prefixesByBoard = {
  gem: ["300", "301"],
  star: ["688"],
  main: ["000", "001", "002", "600", "601", "603", "605"],
};
prefixesByBoard.all = [...prefixesByBoard.gem, ...prefixesByBoard.star, ...prefixesByBoard.main];
const prefixes = prefixesByBoard[board];
if (!prefixes) throw new Error(`Unknown board: ${board}`);

async function fetchRetry(url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, { headers: { Referer: "https://gu.qq.com/" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

function symbolsForPrefixes() {
  const symbols = [];
  for (const prefix of prefixes) {
    for (let n = 0; n < 1000; n++) {
      const code = prefix + String(n).padStart(3, "0");
      symbols.push((code.startsWith("6") ? "sh" : "sz") + code);
    }
  }
  return symbols;
}

async function discoverUniverse() {
  const symbols = symbolsForPrefixes();
  const batches = [];
  for (let i = 0; i < symbols.length; i += 80) batches.push(symbols.slice(i, i + 80));
  const universe = [];
  let cursor = 0;

  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      try {
        const buffer = await (await fetchRetry(`https://qt.gtimg.cn/q=${batch.join(",")}`)).arrayBuffer();
        const text = new TextDecoder("gbk").decode(buffer);
        for (const line of text.split(";")) {
          const match = line.match(/v_(s[hz]\d+)="([^"]*)"/);
          if (!match) continue;
          const fields = match[2].split("~");
          const capYi = Number(fields[45]);
          if (fields[1] && fields[2] && capYi > 0 && capYi < maxCap) {
            universe.push({ symbol: match[1], code: fields[2], name: fields[1], capYi });
          }
        }
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(12, concurrency) }, worker));
  return universe;
}

function enrichRows(raw) {
  const rows = raw.map(a => ({
    date: a[0], open: Number(a[1]), close: Number(a[2]),
    high: Number(a[3]), low: Number(a[4]), lots: Number(a[5]),
  }));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    row.change = i ? 100 * (row.close / rows[i - 1].close - 1) : 0;
    row.amount = ((row.open + row.high + row.low + row.close) / 4) * row.lots * 100;
  }
  return rows;
}

function analyzeLocalRelative(stock, rows) {
  const i = rows.findIndex(r => r.date === date1);
  const k = rows.findIndex(r => r.date === date2);
  if (i < 15 || k < 0 || k + 5 >= rows.length) return null;
  const first = rows[i], second = rows[k];
  if (!(first.change < 0 && second.change < 0)) return null;
  const targetAvg = (first.amount + second.amount) / 2;
  const prior15 = rows.slice(i - 15, i);
  const prior15Sum = prior15.reduce((s, r) => s + r.amount, 0);
  const prior15Avg = prior15Sum / 15;
  const surrounding = [...rows.slice(i - 5, i), ...rows.slice(k + 1, k + 6)];
  const surroundingAvg = surrounding.reduce((s, r) => s + r.amount, 0) / 10;
  const cumulative = 100 * (second.close / rows[i - 1].close - 1);
  const localRatio = targetAvg / surroundingAvg;
  const longRatio = prior15Avg / targetAvg;
  const raw = prior15Avg > targetAvg && targetAvg > surroundingAvg;
  if (!raw) return null;
  const strong = cumulative <= -8 && localRatio >= 1.2 && longRatio >= 1.5;
  const distance = Math.min(localRatio / 1.2 - 1, longRatio / 1.5 - 1);
  return {
    ...stock, date1, date2,
    day1: { close: first.close, changePct: first.change, amount: first.amount },
    day2: { close: second.close, changePct: second.change, amount: second.amount },
    cumulativeChangePct: cumulative,
    prior15Sum, prior15Avg, targetAvg, surroundingAvg, localRatio, longRatio,
    raw, strong, edge: strong && distance < 0.05,
    amountSource: "ohlc4_proxy",
  };
}

function analyzeHighVolumeSelloff(stock, rows) {
  const i = rows.findIndex(r => r.date === date1);
  const k = rows.findIndex(r => r.date === date2);
  if (i < 15 || k < 15) return null;
  const indexes = [i, k];
  const comparisons = indexes.map(index => {
    const day = rows[index];
    const upDays = rows.slice(index - 15, index).filter(r => r.change > 0);
    const benchmark = upDays.reduce((s, r) => s + r.amount, 0) / upDays.length;
    return { date: day.date, close: day.close, changePct: day.change, amount: day.amount, benchmark, ratio: day.amount / benchmark };
  });
  if (!comparisons.every(x => x.changePct < 0 && x.ratio > 1)) return null;
  return {
    ...stock, date1, date2, comparisons,
    amountTrend: comparisons[1].amount < comparisons[0].amount ? "decreasing" : "increasing",
    raw: true, strong: comparisons.every(x => x.ratio >= 1.2),
    amountSource: "ohlc4_proxy",
  };
}

async function main() {
  const universe = await discoverUniverse();
  const matches = [];
  const failures = [];
  let cursor = 0;

  async function worker() {
    while (cursor < universe.length) {
      const stock = universe[cursor++];
      try {
        const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${stock.symbol},day,,,180,qfq`;
        const json = await (await fetchRetry(url)).json();
        const raw = json.data?.[stock.symbol]?.qfqday;
        if (!raw) throw new Error("missing qfqday");
        const rows = enrichRows(raw);
        const result = model === "high-volume-selloff"
          ? analyzeHighVolumeSelloff(stock, rows)
          : analyzeLocalRelative(stock, rows);
        if (result) matches.push(result);
      } catch (error) {
        failures.push({ code: stock.code, error: String(error.message || error) });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  matches.sort((a, b) => Number(b.strong) - Number(a.strong) ||
    ((b.localRatio || 0) * (b.longRatio || 0)) - ((a.localRatio || 0) * (a.longRatio || 0)));

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    board, date1, date2, maxCapYi: maxCap, model,
    amountSource: "ohlc4_proxy",
    universeCount: universe.length,
    historiesFailed: failures.length,
    rawMatchCount: matches.length,
    strongMatchCount: matches.filter(x => x.strong).length,
    matches,
    failures,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
