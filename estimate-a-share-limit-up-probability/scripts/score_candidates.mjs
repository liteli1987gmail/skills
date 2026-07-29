#!/usr/bin/env node
import fs from "node:fs";

function clamp(x, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}

function bell(x, center, width) {
  return Math.max(0, 1 - Math.abs(x - center) / width);
}

function finite(row, key) {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${key} for ${row.code ?? "unknown"}`);
  return value;
}

function score(row) {
  const parts = {
    size: 12 * bell(finite(row, "floatMarketCapYi"), 45, 40),
    twoDayLoss: 12 * bell(finite(row, "twoDayLossPct"), -6, 5),
    selloffAmount: 15 * bell(finite(row, "selloffAmountRatio"), 1.7, 1.2),
    contraction: 15 * bell(finite(row, "contractionRatio"), 0.6, 0.45),
    rebound: 10 * bell(finite(row, "reboundPct"), 3, 8),
    ma60Gap: 8 * bell(finite(row, "ma60GapPct"), -13, 12),
    turnover: 13 * clamp((finite(row, "turnoverUplift") - 0.7) / 1.3),
    currentStrength: 15 * clamp((finite(row, "currentChangePct") + 1) / 10),
  };
  const baseScore = Object.values(parts).reduce((sum, value) => sum + value, 0);
  const repeatedSelloffScore = 15 * Math.min(Math.max(finite(row, "repeatedSelloffCount"), 0), 7) / 7;
  return {
    ...row,
    baseScore: Number(baseScore.toFixed(1)),
    repeatedSelloffScore: Number(repeatedSelloffScore.toFixed(1)),
    matchScore: Number((baseScore * 0.85 + repeatedSelloffScore).toFixed(1)),
    components: Object.fromEntries(
      Object.entries(parts).map(([key, value]) => [key, Number(value.toFixed(1))]),
    ),
  };
}

const input = process.argv[2] ? fs.readFileSync(process.argv[2], "utf8") : fs.readFileSync(0, "utf8");
const rows = JSON.parse(input);
if (!Array.isArray(rows)) throw new Error("Input must be a JSON array");
const output = rows.map(score).sort((a, b) => b.matchScore - a.matchScore);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
