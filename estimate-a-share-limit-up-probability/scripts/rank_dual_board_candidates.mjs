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
if (!args.input) throw new Error("必须提供 --input");
const output = args.output ?? "/tmp/dual-board-ranking.json";
const maxCurrentChangePct = Number(args["max-current-change-pct"] ?? 5);
const top = Number(args.top ?? 30);
const dataset = JSON.parse(fs.readFileSync(args.input, "utf8"));
const bell = (x, center, width) => Math.max(0, 1 - Math.abs(x - center) / width);
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const round = (x, n = 2) => Number(Number(x).toFixed(n));

function repeatedSelloffCount(rows, t) {
  let count = 0, prior = -99;
  for (let i = Math.max(2, t - 59); i <= t; i++) {
    if (rows[i].change <= -3 && rows[i].amount > rows[i - 1].amount && rows[i].amount > rows[i - 2].amount) {
      if (i - prior > 2) count++;
      prior = i;
    }
  }
  return count;
}
function latestPattern(rows, t) {
  let latest = null;
  for (let end = Math.max(7, t - 20); end <= t; end++) {
    const start = end - 1;
    if (!(rows[start].change < 0 && rows[end].change < 0)) continue;
    const baseline = rows.slice(start - 6, start);
    const baselineAmount = baseline.reduce((sum, row) => sum + row.amount, 0) / baseline.length;
    const selloffAmount = (rows[start].amount + rows[end].amount) / 2;
    const amountRatio = selloffAmount / baselineAmount;
    if (!(amountRatio > 1)) continue;
    const post = rows.slice(end + 1, Math.min(end + 4, t + 1));
    const contractionRatio = post.length
      ? post.reduce((sum, row) => sum + row.amount, 0) / post.length / selloffAmount
      : null;
    if (contractionRatio != null && contractionRatio >= 1) continue;
    const repairPct = (rows[t].close / rows[end].close - 1) * 100;
    latest = {
      startIndex: start, endIndex: end,
      selloffStartDate: rows[start].date, selloffEndDate: rows[end].date,
      twoDayLossPct: (rows[end].close / rows[start - 1].close - 1) * 100,
      selloffAmountRatio: amountRatio,
      contractionRatio,
      repairPct,
      thirdDay: rows[end + 1]?.date ?? null,
      signalAge: t - end,
    };
  }
  return latest;
}
function candidate(item) {
  const rows = item.rows;
  if (rows.length < 60) return null;
  const t = rows.length - 1;
  const stock = item.stock;
  const pattern = latestPattern(rows, t);
  const priorPattern = latestPattern(rows, t - 1);
  if (!pattern && !priorPattern) return null;
  function structural(patternAtDate, index, includeCurrentSize) {
    if (!patternAtDate || index < 59) return null;
    const ma60 = rows.slice(index - 59, index + 1).reduce((sum, row) => sum + row.close, 0) / 60;
    const repeated = repeatedSelloffCount(rows, index);
    const parts = {
      size: includeCurrentSize ? 12 * bell(stock.floatMarketCapYi, 45, 40) : 0,
      twoDayLoss: 12 * bell(patternAtDate.twoDayLossPct, -6, 5),
      selloffAmount: 15 * bell(patternAtDate.selloffAmountRatio, 1.7, 1.2),
      contraction: patternAtDate.contractionRatio == null ? 0 : 15 * bell(patternAtDate.contractionRatio, 0.6, 0.45),
      rebound: 10 * bell(patternAtDate.repairPct, 3, 8),
      ma60Gap: 8 * bell((rows[index].close / ma60 - 1) * 100, -13, 12),
    };
    const repeatedScore = 15 * Math.min(repeated, 7) / 7;
    return {
      score: (Object.values(parts).reduce((sum, value) => sum + value, 0) * 0.85 + repeatedScore)
        / (includeCurrentSize ? 76.2 : 66) * 100,
      ma60GapPct: (rows[index].close / ma60 - 1) * 100,
      repeated,
      parts,
      repeatedScore,
    };
  }
  const priorStructural = structural(priorPattern, t - 1, false);
  const currentStructural = structural(pattern, t, true);
  const prior6Volume = rows.slice(t - 6, t).reduce((sum, row) => sum + row.volume, 0) / 6;
  const turnoverUplift = rows[t].turnover != null && rows.slice(t - 6, t).every(row => row.turnover != null)
    ? rows[t].turnover / (rows.slice(t - 6, t).reduce((sum, row) => sum + row.turnover, 0) / 6)
    : rows[t].volume / prior6Volume;
  const confirmationExtra = 13 * clamp((turnoverUplift - 0.7) / 1.3)
    + 15 * clamp((rows[t].change + 1) / 10);
  const activePattern = pattern ?? priorPattern;
  let stage = "invalidated";
  if (pattern?.signalAge === 0) stage = "awaiting-third-day";
  else if (pattern?.repairPct < 0) stage = "contracting";
  else if (pattern?.repairPct > 8) stage = "extended";
  else if (pattern) stage = "repairing";
  return {
    code: stock.code, name: stock.name, board: stock.board, industry: stock.industry,
    close: rows[t].close, scoreDate: rows[t].date,
    currentChangePct: rows[t].change,
    totalMarketCapYi: stock.totalMarketCapYi,
    floatMarketCapYi: stock.floatMarketCapYi,
    turnoverUplift,
    ma60GapPct: currentStructural?.ma60GapPct ?? priorStructural?.ma60GapPct,
    repeatedSelloffCount: currentStructural?.repeated ?? priorStructural?.repeated,
    priorNightScore: priorStructural?.score ?? null,
    closeConfirmationScore: currentStructural
      ? (Object.values(currentStructural.parts).reduce((sum, value) => sum + value, 0) + confirmationExtra) * 0.85
        + currentStructural.repeatedScore
      : null,
    alreadyLimitUp: rows[t].change >= 19.5,
    stage,
    amountIsProxy: rows.some(row => row.amountIsProxy),
    priorNightEvidence: priorPattern ? {
      scoreDate: rows[t - 1].date,
      selloffStartDate: priorPattern.selloffStartDate,
      selloffEndDate: priorPattern.selloffEndDate,
      twoDayLossPct: round(priorPattern.twoDayLossPct),
      selloffAmountRatio: round(priorPattern.selloffAmountRatio),
      contractionRatio: priorPattern.contractionRatio == null ? null : round(priorPattern.contractionRatio),
      repairPct: round(priorPattern.repairPct),
      ma60GapPct: round(priorStructural.ma60GapPct),
      repeatedSelloffCount: priorStructural.repeated,
    } : null,
    ...activePattern,
  };
}
const candidates = dataset.histories.map(candidate).filter(Boolean);
function percentile(value, values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.filter(item => item <= value).length / sorted.length;
}
const activeCandidates = candidates.filter(row => row.stage !== "invalidated");
const changes = activeCandidates.map(row => row.currentChangePct);
const repairs = activeCandidates.map(row => row.repairPct);
const turnover = activeCandidates.map(row => row.turnoverUplift);
for (const row of activeCandidates) {
  row.strongScore = 100 * (
    0.45 * percentile(row.currentChangePct, changes)
    + 0.35 * percentile(row.repairPct, repairs)
    + 0.20 * percentile(row.turnoverUplift, turnover)
  );
}
for (const row of candidates) {
  for (const key of Object.keys(row)) if (typeof row[key] === "number") row[key] = round(row[key]);
}
const desc = key => candidates.filter(row => Number.isFinite(row[key])).sort((a, b) => b[key] - a[key]);
const report = {
  generatedAt: new Date().toISOString(),
  sourceMeta: {
    requestedEndDate: dataset.requestedEndDate,
    snapshotProvider: dataset.snapshotProvider,
    reportedTotal: dataset.reportedTotal,
    snapshotRows: dataset.snapshotRows,
    snapshotUnique: dataset.snapshotUnique,
    minChangePct: dataset.snapshotMinChangePct,
    maxChangePct: dataset.snapshotMaxChangePct,
    filteredCount: dataset.filteredCount,
    historiesOk: dataset.historiesOk,
    historiesFailed: dataset.historiesFailed?.length ?? 0,
    amountProxyUsed: dataset.amountProxyUsed,
  },
  thresholds: { maxCurrentChangePct },
  methodNotes: {
    priorNight: "严格使用评分日前一交易日(t-1)及更早的量价数据；不使用评分日涨幅、换手、收盘结构、评分日新形态或评分日市值因子。股票池仍按评分日总市值<阈值建立。",
    closeConfirmation: "使用评分日收盘后可得的涨幅、成交活跃度和量价结构，只预测下一交易日以后。",
    amountProxy: dataset.amountProxyUsed
      ? "备用日线不含精确成交额时，使用典型价×成交量代理；仅用于同一股票内部比率。"
      : "使用行情源原始成交额。",
  },
  priorNightRanking: desc("priorNightScore").slice(0, top),
  closeConfirmationRanking: desc("closeConfirmationScore").slice(0, top),
  redBoxRanking: activeCandidates.sort((a, b) => b.selloffAmountRatio - a.selloffAmountRatio).slice(0, top),
  strongUnder5Ranking: activeCandidates.filter(row => Number.isFinite(row.strongScore)).sort((a, b) => b.strongScore - a.strongScore)
    .filter(row => row.currentChangePct < maxCurrentChangePct && !row.alreadyLimitUp)
    .slice(0, top),
  alreadyLimitUp: activeCandidates.filter(row => row.alreadyLimitUp),
  counterexamples: [...candidates]
    .filter(row => row.stage === "invalidated" || row.repairPct < 0)
    .sort((a, b) => a.repairPct - b.repairPct)
    .slice(0, 10),
  nextDayChecklist: [
    "竞价及开盘是否出现异常高开后快速回落",
    "成交活跃度是否继续高于近期同期水平",
    "所属板块是否有可见联动",
    "是否重新放量跌破红框区间低点；若是则形态失效",
  ],
};
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  output,
  redBoxCandidates: candidates.length,
  priorNightTop: report.priorNightRanking.slice(0, 5).map(row => `${row.code} ${row.name}`),
  confirmationTop: report.closeConfirmationRanking.slice(0, 5).map(row => `${row.code} ${row.name}`),
  strongUnder5Top: report.strongUnder5Ranking.slice(0, 10).map(row => `${row.code} ${row.name}`),
}, null, 2));
