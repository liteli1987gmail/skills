#!/usr/bin/env node

import { writeFileSync } from "node:fs";

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

function normalizeCode(raw) {
  const match = String(raw).trim().toLowerCase().match(/^(?:(sh|sz|bj))?(\d{6})$/);
  if (!match) throw new Error(`Invalid A-share code: ${raw}`);
  return match[2];
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : "";
}

function classify(row) {
  const lower = Number(row.PREDICT_AMT_LOWER);
  const upper = Number(row.PREDICT_AMT_UPPER);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return "unknown";
  if (lower < 0 && upper < 0) return "loss";
  if (lower > 0 && upper > 0) return "profit";
  return "mixed";
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchPayload(url, attempts, timeoutMs) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Referer: "https://data.eastmoney.com/", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!text.trim()) throw new Error("empty response");
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error("invalid JSON response");
      }
      if (payload?.success !== true || Number(payload?.code) !== 0 || !Array.isArray(payload?.result?.data)) {
        throw new Error(`invalid response envelope: success=${payload?.success}, code=${payload?.code}, dataIsArray=${Array.isArray(payload?.result?.data)}`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(400 * attempt);
    }
  }
  throw lastError;
}

async function query(code, asOf, reportDate, attempts, timeoutMs) {
  const url = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
  url.searchParams.set("reportName", "RPT_PUBLIC_OP_NEWPREDICT");
  url.searchParams.set("columns", "ALL");
  url.searchParams.set("filter", `(SECURITY_CODE=\"${code}\")`);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("sortColumns", "NOTICE_DATE");
  url.searchParams.set("sortTypes", "-1");

  const payload = await fetchPayload(url, attempts, timeoutMs);
  let rows = payload.result.data;
  rows = rows.filter((row) => String(row.PREDICT_FINANCE_CODE) === "004");
  if (asOf) rows = rows.filter((row) => dateOnly(row.NOTICE_DATE) <= asOf);
  if (reportDate) rows = rows.filter((row) => dateOnly(row.REPORT_DATE) === reportDate);
  rows.sort((a, b) => {
    const reportOrder = dateOnly(b.REPORT_DATE).localeCompare(dateOnly(a.REPORT_DATE));
    return reportOrder || dateOnly(b.NOTICE_DATE).localeCompare(dateOnly(a.NOTICE_DATE));
  });
  const row = rows[0];
  if (!row) return {
    code,
    status: "no_forecast_unverified",
    screeningStatus: "no_forecast",
    officialVerificationRequired: true,
    note: "东方财富初筛在指定条件下无记录；完成巨潮资讯或交易所官方检索前不得按 no_forecast 计分",
  };
  return {
    code,
    name: row.SECURITY_NAME_ABBR,
    status: classify(row),
    predictType: row.PREDICT_TYPE,
    noticeDate: dateOnly(row.NOTICE_DATE),
    reportDate: dateOnly(row.REPORT_DATE),
    profitLower: Number(row.PREDICT_AMT_LOWER),
    profitUpper: Number(row.PREDICT_AMT_UPPER),
    content: row.PREDICT_CONTENT || "",
    reason: row.CHANGE_REASON_EXPLAIN || "",
    officialVerificationRequired: ["loss", "mixed"].includes(classify(row)),
  };
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      try {
        results[index] = await mapper(values[index]);
      } catch (error) {
        results[index] = { code: values[index], status: "query_failed", error: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

const args = parseArgs(process.argv.slice(2));
if (!args.codes) {
  console.error("Usage: node query-earnings-forecasts.mjs --codes 300227,301313 [--as-of YYYY-MM-DD] [--report-date YYYY-MM-DD]");
  process.exit(2);
}

const codes = [...new Set(String(args.codes).split(",").map(normalizeCode))];
const asOf = args["as-of"] || new Date().toISOString().slice(0, 10);
const reportDate = args["report-date"] || "";
const attempts = Math.max(1, Number(args.attempts || 3));
const timeoutMs = Math.max(1000, Number(args["timeout-ms"] || 15000));
const stocks = await mapLimit(codes, Number(args.concurrency || 6), (code) => query(code, asOf, reportDate, attempts, timeoutMs));
const result = {
  generatedAt: new Date().toISOString(),
  source: "Eastmoney structured forecast cross-check; verify loss rows with CNInfo/SZSE/SSE",
  asOfDate: asOf,
  reportDate: reportDate || null,
  attempts,
  timeoutMs,
  requestedCount: codes.length,
  successCount: stocks.filter((row) => row.status !== "query_failed").length,
  failedCodes: stocks.filter((row) => row.status === "query_failed").map((row) => row.code),
  stocks,
};

const output = `${JSON.stringify(result, null, 2)}\n`;
if (args.output) writeFileSync(args.output, output);
else process.stdout.write(output);
