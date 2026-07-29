#!/usr/bin/env node
import fs from "node:fs";

function argsOf(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i];
  }
  return out;
}
const args = argsOf(process.argv);
const output = args.output ?? "/tmp/dual-board-data.json";
const maxCapYi = Number(args["max-market-cap-yi"] ?? 100);
const limit = args.limit ? Number(args.limit) : Infinity;
const concurrency = Number(args.concurrency ?? 10);
const endDate = args.date ?? new Date().toISOString().slice(0, 10);
const endCompact = endDate.replaceAll("-", "");
const start = new Date(`${endDate}T00:00:00Z`);
start.setUTCDate(start.getUTCDate() - 360);
const startCompact = start.toISOString().slice(0, 10).replaceAll("-", "");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function text(url, attempts = 5) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, {
        headers: { Referer: "https://quote.eastmoney.com/" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      last = error;
      await sleep(600 * (i + 1));
    }
  }
  throw last;
}
const json = async url => JSON.parse(await text(url));

function market(code) {
  return code.startsWith("68") ? 1 : 0;
}
function board(code) {
  return code.startsWith("68") ? "科创板" : "创业板";
}
function eastSnapshotUrl(page) {
  const url = new URL("https://push2.eastmoney.com/api/qt/clist/get");
  const query = {
    pn: page, pz: 100, po: 1, np: 1, fltt: 2, invt: 2, fid: "f12",
    fs: "m:0+t:80,m:1+t:23",
    fields: "f12,f14,f2,f3,f8,f20,f21,f100",
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}
async function eastSnapshot() {
  const first = await json(eastSnapshotUrl(1));
  const reportedTotal = first.data.total;
  const pages = [first];
  for (let page = 2; page <= Math.ceil(reportedTotal / 100); page++) {
    pages.push(await json(eastSnapshotUrl(page)));
    await sleep(120);
  }
  const rows = pages.flatMap(page => page.data?.diff ?? []).map(row => ({
    code: row.f12, name: row.f14, board: board(row.f12),
    symbol: `${market(row.f12) ? "sh" : "sz"}${row.f12}`,
    close: Number(row.f2), changePct: Number(row.f3), turnover: Number(row.f8),
    totalMarketCapYi: Number(row.f20) / 1e8,
    floatMarketCapYi: Number(row.f21) / 1e8,
    industry: row.f100,
  }));
  const unique = new Map(rows.map(row => [row.code, row]));
  if (rows.length !== reportedTotal || unique.size !== reportedTotal) {
    throw new Error(`东方财富分页不完整: total=${reportedTotal}, rows=${rows.length}, unique=${unique.size}`);
  }
  return { provider: "eastmoney", reportedTotal, rows: [...unique.values()] };
}
async function sinaNode(node) {
  const rows = [];
  for (let page = 1; page <= 30; page++) {
    const url = new URL("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData");
    const query = { page, num: 100, sort: "symbol", asc: 1, node, symbol: "", _s_r_a: "page" };
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const batch = await json(url);
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < 100) break;
    await sleep(120);
  }
  return rows;
}
async function sinaSnapshot(primaryError) {
  const raw = [...await sinaNode("cyb"), ...await sinaNode("kcb")];
  const rows = raw.map(row => ({
    code: row.code, name: row.name, board: board(row.code), symbol: row.symbol,
    close: Number(row.trade), changePct: Number(row.changepercent),
    turnover: Number(row.turnoverratio),
    totalMarketCapYi: Number(row.mktcap) / 10000,
    floatMarketCapYi: Number(row.nmc) / 10000,
    industry: null,
  }));
  return {
    provider: "sina",
    reportedTotal: null,
    primaryError: String(primaryError),
    rows: [...new Map(rows.map(row => [row.code, row])).values()],
  };
}

async function eastHistory(stock) {
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  const query = {
    secid: `${market(stock.code)}.${stock.code}`,
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    klt: 101, fqt: 1, beg: startCompact, end: endCompact, lmt: 180,
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const payload = await json(url);
  return (payload.data?.klines ?? []).map(line => {
    const x = line.split(",");
    return {
      date: x[0], open: +x[1], close: +x[2], high: +x[3], low: +x[4],
      volume: +x[5], amount: +x[6], change: +x[8], turnover: +x[10],
      amountIsProxy: false,
    };
  });
}
async function tencentHistory(stock) {
  const url = new URL("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get");
  url.searchParams.set("param", `${stock.symbol},day,${startCompact},${endCompact},180,qfq`);
  const payload = await json(url);
  const block = payload.data?.[stock.symbol];
  const lines = block?.qfqday ?? block?.day ?? [];
  const rows = lines.map(line => {
    const open = +line[1], close = +line[2], high = +line[3], low = +line[4], volume = +line[5];
    return {
      date: line[0], open, close, high, low, volume,
      amount: (open + high + low + close) / 4 * volume,
      change: 0, turnover: null, amountIsProxy: true,
    };
  });
  for (let i = 1; i < rows.length; i++) rows[i].change = (rows[i].close / rows[i - 1].close - 1) * 100;
  return rows;
}
async function sinaHistory(stock) {
  const url = new URL("https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_kline_=/CN_MarketDataService.getKLineData");
  url.searchParams.set("symbol", stock.symbol);
  url.searchParams.set("scale", "240");
  url.searchParams.set("ma", "no");
  url.searchParams.set("datalen", "180");
  const body = await text(url);
  const match = body.match(/\((\[[\s\S]*\])\)\s*;?\s*$/);
  if (!match) throw new Error("新浪日线JSONP解析失败");
  const lines = JSON.parse(match[1]).filter(row => row.day <= endDate);
  const rows = lines.map(line => {
    const open = +line.open, close = +line.close, high = +line.high, low = +line.low, volume = +line.volume;
    return {
      date: line.day, open, close, high, low, volume,
      amount: (open + high + low + close) / 4 * volume,
      change: 0, turnover: null, amountIsProxy: true,
    };
  });
  for (let i = 1; i < rows.length; i++) rows[i].change = (rows[i].close / rows[i - 1].close - 1) * 100;
  return rows;
}
async function history(stock, preferEast) {
  if (preferEast) {
    try {
      const rows = await eastHistory(stock);
      if (rows.length >= 60) return { rows, provider: "eastmoney" };
    } catch {}
  }
  try {
    const rows = await tencentHistory(stock);
    if (rows.length >= 60) return { rows, provider: "tencent" };
  } catch {}
  const rows = await sinaHistory(stock);
  if (rows.length < 60) throw new Error(`日线不足60日: ${rows.length}`);
  return { rows, provider: "sina" };
}

let snapshot;
try {
  snapshot = await eastSnapshot();
} catch (error) {
  snapshot = await sinaSnapshot(error);
}
const fullRows = snapshot.rows;
const tradable = fullRows.filter(stock =>
  /^(300|301|688|689)/.test(stock.code)
  && !stock.name.includes("ST")
  && Number.isFinite(stock.close) && stock.close > 0
  && Number.isFinite(stock.totalMarketCapYi)
  && stock.totalMarketCapYi > 0 && stock.totalMarketCapYi < maxCapYi
).slice(0, limit);

const histories = [];
let cursor = 0;
async function worker() {
  while (cursor < tradable.length) {
    const stock = tradable[cursor++];
    try {
      const result = await history(stock, snapshot.provider === "eastmoney");
      histories.push({ stock, ...result });
    } catch (error) {
      histories.push({ stock, rows: [], error: String(error) });
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const changes = fullRows.map(row => row.changePct).filter(Number.isFinite);
const result = {
  generatedAt: new Date().toISOString(),
  requestedEndDate: endDate,
  snapshotProvider: snapshot.provider,
  primaryError: snapshot.primaryError ?? null,
  reportedTotal: snapshot.reportedTotal,
  snapshotRows: fullRows.length,
  snapshotUnique: new Set(fullRows.map(row => row.code)).size,
  snapshotMinChangePct: Math.min(...changes),
  snapshotMaxChangePct: Math.max(...changes),
  maxMarketCapYi: maxCapYi,
  filteredCount: tradable.length,
  historiesOk: histories.filter(item => item.rows.length >= 60).length,
  historiesFailed: histories.filter(item => item.rows.length < 60).map(item => ({
    code: item.stock.code, name: item.stock.name, error: item.error,
  })),
  amountProxyUsed: histories.some(item => item.provider && item.provider !== "eastmoney"),
  histories,
};
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  output, snapshotProvider: result.snapshotProvider, reportedTotal: result.reportedTotal,
  snapshotRows: result.snapshotRows, snapshotUnique: result.snapshotUnique,
  minChangePct: result.snapshotMinChangePct, maxChangePct: result.snapshotMaxChangePct,
  filteredCount: result.filteredCount, historiesOk: result.historiesOk,
  failures: result.historiesFailed.length, amountProxyUsed: result.amountProxyUsed,
}, null, 2));
