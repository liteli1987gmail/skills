#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? argv[++i] : true;
  }
  return out;
}

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const scale = (value, low, high) => clamp((value - low) / (high - low));
const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const round = (value, digits = 2) => Number(value.toFixed(digits));

function earningsValue(status) {
  const values = {
    profit: 1,
    turnaround: 1,
    increase: 0.9,
    positive_decrease: 0.6,
    no_forecast: 0.5,
    mixed: 0.25,
    loss: 0,
  };
  return Object.hasOwn(values, status) ? values[status] : null;
}

const FIELD_ALIASES = {
  closePrice: ["close"],
  chipAvgCost: ["averageCost"],
  chipProfitRate: ["profitRate"],
  chipConcentration70: ["concentration70"],
  chipConcentration90: ["concentration90"],
};

function normalizeStock(stock, index) {
  if (!stock || typeof stock !== "object" || Array.isArray(stock)) {
    throw new Error(`stocks[${index}] must be an object`);
  }
  const normalized = { ...stock };
  const aliasesUsed = [];
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    const canonicalMissing = normalized[canonical] === null || normalized[canonical] === undefined || normalized[canonical] === "";
    if (!canonicalMissing) continue;
    const alias = aliases.find((key) => normalized[key] !== null && normalized[key] !== undefined && normalized[key] !== "");
    if (!alias) continue;
    normalized[canonical] = normalized[alias];
    aliasesUsed.push(`${alias}->${canonical}`);
  }
  return { stock: normalized, aliasesUsed };
}

function scoreStock(stock) {
  const factors = [];
  const add = (key, label, weight, value) => {
    if (value === null || !Number.isFinite(value)) return;
    factors.push({ key, label, weight, value: clamp(value) });
  };

  let costGapPct = null;
  if (finite(stock.closePrice) && finite(stock.chipAvgCost) && Number(stock.chipAvgCost) > 0) {
    costGapPct = 100 * (Number(stock.closePrice) / Number(stock.chipAvgCost) - 1);
    add("costPosition", "成本位置", 20, scale(costGapPct, -35, 10));
  }
  if (finite(stock.chipProfitRate)) {
    add("profitRate", "获利盘", 20, Number(stock.chipProfitRate) / 100);
  }
  if (finite(stock.chipConcentration70)) {
    add("concentration", "筹码集中", 15, 1 - scale(Number(stock.chipConcentration70), 10, 35));
  } else if (finite(stock.chipConcentration90)) {
    add("concentration", "筹码集中", 15, 1 - scale(Number(stock.chipConcentration90), 15, 45));
  }
  if (finite(stock.postEventReturnPct)) {
    add("postEventRecovery", "事件后修复", 15, scale(Number(stock.postEventReturnPct), -15, 15));
  }
  if (finite(stock.volumeSupportScore)) {
    add("volumeSupport", "量价承接", 15, Number(stock.volumeSupportScore) / 100);
  }
  add("earnings", "业绩状态", 15, earningsValue(stock.earningsStatus));

  const availableWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
  const weighted = factors.reduce((sum, factor) => sum + factor.weight * factor.value, 0);
  const positiveScore = availableWeight ? 100 * weighted / availableWeight : null;
  const reverseScore = positiveScore === null ? null : 100 - positiveScore;
  const chipFactorCount = factors.filter((factor) => ["costPosition", "profitRate", "concentration"].includes(factor.key)).length;
  const coverage = availableWeight / 100;
  const excludedByHardRisk = stock.hardRisk === true || stock.tradeable === false;
  const eligible = coverage >= 0.6 && chipFactorCount >= 2 && !excludedByHardRisk;

  const positiveReasons = [...factors]
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((factor) => `${factor.label}:${round(100 * factor.value, 1)}`);
  const reverseReasons = [...factors]
    .sort((a, b) => a.value - b.value)
    .slice(0, 3)
    .map((factor) => `${factor.label}:${round(100 * (1 - factor.value), 1)}`);

  return {
    code: String(stock.code || ""),
    name: stock.name || "",
    positiveScore: positiveScore === null ? null : round(positiveScore),
    reverseScore: reverseScore === null ? null : round(reverseScore),
    coverage: round(coverage),
    eligible,
    excludedByHardRisk,
    reversalTriggerObserved: eligible && stock.reversalTrigger === true,
    costGapPct: costGapPct === null ? null : round(costGapPct),
    positiveReasons,
    reverseReasons,
    factors: factors.map((factor) => ({
      ...factor,
      value: round(factor.value, 4),
      positiveContribution: round(factor.weight * factor.value, 4),
      reverseContribution: round(factor.weight * (1 - factor.value), 4),
    })),
    riskFlags: Array.isArray(stock.riskFlags) ? stock.riskFlags : [],
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  console.error("Usage: node score-dual-perspectives.mjs --input file.json|\"-\" [--output file.json] [--top 10] [--min-score 60]");
  process.exit(2);
}

const raw = args.input === "-" ? readFileSync(0, "utf8") : readFileSync(args.input, "utf8");
const input = JSON.parse(raw);
if (!Array.isArray(input.stocks)) throw new Error("Input must contain a stocks array");

const normalizedEntries = input.stocks.map(normalizeStock);
const scored = normalizedEntries.map(({ stock }) => scoreStock(stock));
const eligible = scored.filter((stock) => stock.eligible);
const requestedTop = Number(args.top ?? input.top ?? 10);
const top = Number.isFinite(requestedTop) ? Math.max(1, Math.floor(requestedTop)) : 10;
const requestedMinScore = Number(args["min-score"] ?? input.minScore ?? 60);
const minScore = Number.isFinite(requestedMinScore) ? clamp(requestedMinScore, 0, 100) : 60;
const positiveRanking = [...eligible].sort((a, b) => b.positiveScore - a.positiveScore).slice(0, top);
const reverseRanking = [...eligible].sort((a, b) => b.reverseScore - a.reverseScore).slice(0, top);
const positiveCandidates = positiveRanking.filter((stock) => stock.positiveScore >= minScore);
const reverseCandidates = reverseRanking.filter((stock) => stock.reverseScore >= minScore);
const reverseWatchlist = reverseCandidates.filter((stock) => !stock.reversalTriggerObserved);
const reverseTriggered = reverseCandidates.filter((stock) => stock.reversalTriggerObserved);
const parityComparable = scored.filter((stock) => stock.positiveScore !== null);
const parityFailures = parityComparable.filter((stock) => Math.abs(stock.positiveScore + stock.reverseScore - 100) > 0.02);
const inputAliasesUsed = normalizedEntries.flatMap(({ stock, aliasesUsed }) => (
  aliasesUsed.length ? [{ code: String(stock.code || ""), aliases: aliasesUsed }] : []
));
const validationWarnings = [];
if (!eligible.length) validationWarnings.push("No stocks passed factor coverage, chip field, and hard-risk eligibility checks");
if (inputAliasesUsed.length) validationWarnings.push("Input field aliases were normalized; use canonical names for reproducibility");

const result = {
  generatedAt: new Date().toISOString(),
  asOfDate: input.asOfDate || null,
  inputCount: input.stocks.length,
  eligibleCount: eligible.length,
  ineligibleCount: scored.length - eligible.length,
  minScore,
  rankingReady: eligible.length > 0,
  parityCheckPassed: parityComparable.length ? parityFailures.length === 0 : null,
  validationWarnings,
  inputAliasesUsed,
  positiveRanking,
  positiveCandidates,
  reverseRanking,
  reverseWatchlist,
  reverseTriggered,
  allStocks: scored,
};

const output = `${JSON.stringify(result, null, 2)}\n`;
if (args.output) writeFileSync(args.output, output);
else process.stdout.write(output);
