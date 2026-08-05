#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { writeFileSync } from "node:fs";

const PACKAGE = "westock-data-clawhub@1.0.4";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? argv[++i] : true;
  }
  return out;
}

function normalizeCode(raw) {
  const value = String(raw).trim().toLowerCase();
  const match = value.match(/^(?:(sh|sz|bj))?(\d{6})$/);
  if (!match) throw new Error(`Invalid A-share code: ${raw}`);
  const explicitExchange = match[1] || null;
  const digits = match[2];
  let exchange;
  if (/^(000|001|002|003|300|301)/.test(digits)) exchange = "sz";
  else if (/^(500|510|511|512|513|515|516|517|518|560|561|562|563|588|600|601|603|605|688|689)/.test(digits)) exchange = "sh";
  else if (/^[489]/.test(digits)) exchange = "bj";
  else throw new Error(`Unsupported A-share code: ${raw}`);
  if (explicitExchange && explicitExchange !== exchange) {
    throw new Error(`Exchange prefix mismatch: ${raw} should use ${exchange}`);
  }
  return `${exchange}${digits}`;
}

function commandExists(command, env) {
  const result = spawnSync(command, ["--version"], { env, encoding: "utf8" });
  return result.status === 0;
}

function chooseRunner(requested, env) {
  if (requested && requested !== "auto") {
    if (!commandExists(requested, env)) throw new Error(`Runner not available: ${requested}`);
    return requested;
  }
  for (const command of ["npx", "pnpm", "westock-data-clawhub"]) {
    if (commandExists(command, env)) return command;
  }
  throw new Error("No npx, pnpm, or westock-data-clawhub executable found");
}

function runChip(runner, codes, date, env) {
  let args;
  if (runner === "npx") args = ["-y", PACKAGE, "chip", codes.join(",")];
  else if (runner === "pnpm") args = ["dlx", PACKAGE, "chip", codes.join(",")];
  else args = ["chip", codes.join(",")];
  if (date) args.push("--date", date);
  const result = spawnSync(runner, args, {
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `exit ${result.status}`).trim());
  }
  return result.stdout;
}

function parseMarkdown(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (!cells.length || cells.every((cell) => /^-+$/.test(cell))) continue;
    for (let i = 0; i + 7 < cells.length; i += 8) {
      const group = cells.slice(i, i + 8);
      if (!/^(sh|sz|bj)\d{6}$/.test(group[0]) || group[1] === "-") continue;
      const numeric = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      records.push({
        symbol: group[0],
        code: group[0].slice(2),
        name: group[1],
        date: group[2],
        closePrice: numeric(group[3]),
        chipProfitRate: numeric(group[4]),
        chipAvgCost: numeric(group[5]),
        chipConcentration90: numeric(group[6]),
        chipConcentration70: numeric(group[7]),
      });
    }
  }
  return [...new Map(records.map((record) => [record.symbol, record])).values()];
}

const args = parseArgs(process.argv.slice(2));
if (!args.codes) {
  console.error("Usage: node query-tencent-chip.mjs --codes 300227,301313 [--date YYYY-MM-DD] [--output file.json]");
  process.exit(2);
}

const requested = [...new Set(String(args.codes).split(",").map(normalizeCode))];
const env = { ...process.env };
env.PATH = `${dirname(process.execPath)}:${env.PATH || ""}`;
const runner = chooseRunner(args.runner || "auto", env);
let records = [];
let batchError = null;
const retryFailures = [];
try {
  records = parseMarkdown(runChip(runner, requested, args.date, env));
} catch (error) {
  batchError = String(error?.message || error);
}
const received = new Set(records.map((record) => record.symbol));
const missing = requested.filter((code) => !received.has(code));

for (const code of missing) {
  try {
    const retry = parseMarkdown(runChip(runner, [code], args.date, env));
    records.push(...retry);
  } catch (error) {
    retryFailures.push({ symbol: code, code: code.slice(2), error: String(error?.message || error) });
  }
}

records = [...new Map(records.map((record) => [record.symbol, record])).values()];
const finalReceived = new Set(records.map((record) => record.symbol));
const result = {
  generatedAt: new Date().toISOString(),
  source: "Tencent Portfolio via westock-data-clawhub",
  package: PACKAGE,
  requestedCount: requested.length,
  successCount: records.length,
  batchError,
  failedCodes: requested.filter((code) => !finalReceived.has(code)),
  retryFailures,
  stocks: records,
};

const output = `${JSON.stringify(result, null, 2)}\n`;
if (args.output) writeFileSync(args.output, output);
else process.stdout.write(output);
