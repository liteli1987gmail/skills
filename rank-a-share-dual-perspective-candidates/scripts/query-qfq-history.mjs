#!/usr/bin/env node

import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROVIDERS = ["tencent", "eastmoney", "sina"];
const PROVIDER_LABELS = {
  tencent: "腾讯前复权日线",
  eastmoney: "东方财富前复权日线",
  sina: "新浪历史日线 + qfq.js 前复权因子",
};

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    out[key] = next && !next.startsWith("--") ? argv[++index] : true;
  }
  return out;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const compactDate = (value) => value.replaceAll("-", "");
const round = (value, digits = 6) => Number(value.toFixed(digits));

function numericOption(value, fallback, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a valid calendar date`);
  }
  return value;
}

export function normalizeSecurity(value) {
  const raw = String(value || "").trim().toLowerCase();
  const match = raw.match(/^(?:(sh|sz|bj))?(\d{6})$/);
  if (!match) throw new Error(`Invalid A-share code: ${value}`);
  const explicitExchange = match[1] || null;
  const code = match[2];
  let exchange;
  if (/^(000|001|002|003|300|301)/.test(code)) exchange = "sz";
  else if (/^(500|510|511|512|513|515|516|517|518|560|561|562|563|588|600|601|603|605|688|689)/.test(code)) exchange = "sh";
  else if (/^(4|8|9)/.test(code)) exchange = "bj";
  else throw new Error(`Unsupported A-share code: ${value}`);
  if (explicitExchange && explicitExchange !== exchange) {
    throw new Error(`Exchange prefix mismatch: ${value} should use ${exchange}`);
  }
  return { code, symbol: `${exchange}${code}`, exchange };
}

function eastmoneySecid(security) {
  if (security.exchange === "sh") return `1.${security.code}`;
  if (security.exchange === "sz") return `0.${security.code}`;
  throw new Error(`东方财富 secid mapping for ${security.symbol} is not configured`);
}

function requestedLimit(startDate, endDate, minBars) {
  const spanDays = Math.max(1, (Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1);
  return Math.min(1023, Math.max(60, minBars * 3, Math.ceil(spanDays * 1.8) + 30));
}

function normalizeBar(row, context) {
  const bar = {
    date: String(row.date),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    amountProxy: row.amountProxy === null || row.amountProxy === undefined ? null : Number(row.amountProxy),
    volumeUnit: row.volumeUnit || context.volumeUnit,
    sourceVolume: row.sourceVolume === null || row.sourceVolume === undefined ? Number(row.volume) : Number(row.sourceVolume),
    sourceVolumeUnit: row.sourceVolumeUnit || row.volumeUnit || context.volumeUnit,
    amountIsProxy: row.amountIsProxy === true,
  };
  return bar;
}

function filterWindow(rows, startDate, endDate) {
  return rows
    .filter((row) => row.date >= startDate && row.date <= endDate)
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function parseTencentPayload(text, security) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const marker = /WAF|501|<html|<!doctype/i.test(text) ? "WAF/HTML response" : "invalid JSON";
    throw new Error(`腾讯返回${marker}`);
  }
  const block = payload?.data?.[security.symbol];
  const raw = block?.qfqday;
  if (!Array.isArray(raw) || raw.length === 0) {
    if (Array.isArray(block?.day) && block.day.length) {
      throw new Error("腾讯仅返回未复权 day，拒绝冒充 qfqday");
    }
    throw new Error("腾讯 qfqday 为空或字段缺失");
  }
  return raw.map((line) => {
    const open = Number(line[1]);
    const close = Number(line[2]);
    const high = Number(line[3]);
    const low = Number(line[4]);
    const sourceVolume = Number(line[5]);
    const volume = sourceVolume * 100;
    return normalizeBar({
      date: line[0], open, high, low, close, volume,
      amount: null,
      amountProxy: round(((open + high + low + close) / 4) * volume, 2),
      amountIsProxy: true,
      volumeUnit: "shares", sourceVolume, sourceVolumeUnit: "lots",
    }, {});
  });
}

export function parseEastmoneyPayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("东方财富返回空响应或无效 JSON");
  }
  const lines = payload?.data?.klines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("东方财富 fqt=1 K线为空或字段缺失");
  }
  return lines.map((line) => {
    const fields = String(line).split(",");
    const open = Number(fields[1]);
    const close = Number(fields[2]);
    const high = Number(fields[3]);
    const low = Number(fields[4]);
    const sourceVolume = Number(fields[5]);
    const volume = sourceVolume * 100;
    return normalizeBar({
      date: fields[0], open, close, high, low,
      volume, amount: fields[6], amountProxy: round(((open + high + low + close) / 4) * volume, 2),
      amountIsProxy: false, volumeUnit: "shares", sourceVolume, sourceVolumeUnit: "lots",
    }, {});
  });
}

export function parseSinaHistory(text) {
  const match = text.match(/var\s+_kline_\s*=\s*\((\[[\s\S]*?\])\)\s*;?/);
  if (!match) throw new Error("新浪历史日线 JSONP 解析失败");
  let rows;
  try {
    rows = JSON.parse(match[1]);
  } catch {
    throw new Error("新浪历史日线数据不是有效 JSON");
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("新浪历史日线为空");
  return rows.map((row) => ({
    date: row.day,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }));
}

export function parseSinaQfqFactors(text) {
  const equals = text.indexOf("=");
  if (equals < 0) throw new Error("新浪 qfq.js 缺少赋值内容");
  const afterAssignment = text.slice(equals + 1);
  const commentIndex = afterAssignment.indexOf("/*");
  const raw = (commentIndex >= 0 ? afterAssignment.slice(0, commentIndex) : afterAssignment)
    .trim()
    .replace(/;\s*$/, "");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("新浪 qfq.js 不是有效 JSON");
  }
  const factors = payload?.data?.map((row) => ({ date: String(row.d), factor: Number(row.f) }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.factor) && row.factor > 0)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (!factors?.length) throw new Error("新浪 qfq.js 无有效前复权因子");
  return factors;
}

export function applySinaQfq(rawRows, factors) {
  let factorIndex = -1;
  return [...rawRows]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((row) => {
      while (factorIndex + 1 < factors.length && factors[factorIndex + 1].date <= row.date) {
        factorIndex += 1;
      }
      if (factorIndex < 0) return null;
      const factor = factors[factorIndex].factor;
      const open = round(row.open / factor, 2);
      const high = round(row.high / factor, 2);
      const low = round(row.low / factor, 2);
      const close = round(row.close / factor, 2);
      return normalizeBar({
        date: row.date, open, high, low, close, volume: row.volume,
        amount: null,
        amountProxy: round(((open + high + low + close) / 4) * row.volume, 2),
        amountIsProxy: true,
        volumeUnit: "shares", sourceVolume: row.volume, sourceVolumeUnit: "shares",
      }, {});
    })
    .filter(Boolean);
}

export function validateBars(rows, { startDate, endDate, minBars, requiredDates = [] }) {
  const windowRows = filterWindow(rows, startDate, endDate);
  const errors = [];
  const seen = new Set();
  for (const bar of windowRows) {
    if (seen.has(bar.date)) errors.push(`duplicate_date:${bar.date}`);
    seen.add(bar.date);
    const numbers = [bar.open, bar.high, bar.low, bar.close, bar.volume];
    if (!numbers.every(Number.isFinite)) errors.push(`non_finite:${bar.date}`);
    if ([bar.open, bar.high, bar.low, bar.close].some((value) => value <= 0)) errors.push(`non_positive_price:${bar.date}`);
    if (bar.volume < 0) errors.push(`negative_volume:${bar.date}`);
    if (bar.high < Math.max(bar.open, bar.close, bar.low)) errors.push(`invalid_high:${bar.date}`);
    if (bar.low > Math.min(bar.open, bar.close, bar.high)) errors.push(`invalid_low:${bar.date}`);
  }
  const missingRequiredDates = requiredDates.filter((date) => !seen.has(date));
  if (windowRows.length < minBars) errors.push(`insufficient_bars:${windowRows.length}<${minBars}`);
  if (missingRequiredDates.length) errors.push(`missing_required_dates:${missingRequiredDates.join(",")}`);
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    missingRequiredDates,
    bars: windowRows,
    firstDate: windowRows[0]?.date ?? null,
    lastDate: windowRows.at(-1)?.date ?? null,
  };
}

function urlSet(security, startDate, endDate, limit) {
  const tencent = new URL("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get");
  tencent.searchParams.set("param", `${security.symbol},day,${compactDate(startDate)},${compactDate(endDate)},${limit},qfq`);

  let eastmoney = null;
  if (security.exchange !== "bj") {
    eastmoney = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
    const query = {
      secid: eastmoneySecid(security), fields1: "f1,f2,f3,f4,f5,f6",
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
      klt: "101", fqt: "1", beg: compactDate(startDate), end: compactDate(endDate), lmt: String(limit),
    };
    for (const [key, value] of Object.entries(query)) eastmoney.searchParams.set(key, value);
  }

  let sinaHistory = null;
  let sinaFactor = null;
  if (security.exchange !== "bj") {
    sinaHistory = new URL("https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_kline_=/CN_MarketDataService.getKLineData");
    const query = { symbol: security.symbol, scale: "240", ma: "no", datalen: String(limit) };
    for (const [key, value] of Object.entries(query)) sinaHistory.searchParams.set(key, value);
    sinaFactor = new URL(`https://finance.sina.com.cn/realstock/company/${security.symbol}/qfq.js`);
  }
  return { tencent, eastmoney, sinaHistory, sinaFactor };
}

class HttpError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

async function fetchText(url, { provider, timeoutMs, retries }) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Referer: provider === "tencent" ? "https://gu.qq.com/" : provider === "eastmoney" ? "https://quote.eastmoney.com/" : "https://finance.sina.com.cn/",
          Accept: "application/json,text/plain,*/*",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        const hint = /WAF|<html|<!doctype/i.test(text) ? "; WAF/HTML" : "";
        throw new HttpError(`HTTP ${response.status}${hint}`, response.status);
      }
      if (!text.trim()) throw new HttpError("empty response", response.status);
      return { text, httpStatus: response.status, attempt, durationMs: Date.now() - started };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(350 * attempt);
    }
  }
  throw lastError;
}

async function fetchProvider(provider, security, options) {
  const urls = urlSet(security, options.startDate, options.endDate, options.limit);
  if (provider === "tencent") {
    const response = await fetchText(urls.tencent, { ...options, provider });
    return { rows: parseTencentPayload(response.text, security), urls: [String(urls.tencent)], response };
  }
  if (provider === "eastmoney") {
    if (!urls.eastmoney) throw new Error(`东方财富暂不支持 ${security.exchange} 映射`);
    const response = await fetchText(urls.eastmoney, { ...options, provider });
    return { rows: parseEastmoneyPayload(response.text), urls: [String(urls.eastmoney)], response };
  }
  if (provider === "sina") {
    if (!urls.sinaHistory || !urls.sinaFactor) throw new Error(`新浪暂不支持 ${security.exchange} 行情`);
    const history = await fetchText(urls.sinaHistory, { ...options, provider });
    const factors = await fetchText(urls.sinaFactor, { ...options, provider });
    const rows = applySinaQfq(parseSinaHistory(history.text), parseSinaQfqFactors(factors.text));
    return {
      rows,
      urls: [String(urls.sinaHistory), String(urls.sinaFactor)],
      response: {
        httpStatus: 200,
        attempt: Math.max(history.attempt, factors.attempt),
        durationMs: history.durationMs + factors.durationMs,
      },
    };
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

function defaultCacheDir() {
  const explicit = process.env.A_SHARE_QFQ_CACHE_DIR;
  if (explicit) return explicit;
  return path.join(os.homedir(), "Documents", "抱拙居士", "研究输出", ".cache", "a-share-qfq");
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readCache(cacheFile) {
  if (!await fileExists(cacheFile)) return null;
  try {
    return JSON.parse(await readFile(cacheFile, "utf8"));
  } catch {
    return null;
  }
}

function cacheCovers(record, request) {
  return record?.schemaVersion === "1.0"
    && record?.adjustment === "qfq"
    && record?.request?.startDate <= request.startDate
    && record?.request?.endDate >= request.endDate
    && Array.isArray(record?.bars)
    && record?.barsSha256 === barsHash(record.bars);
}

export function barsHash(bars) {
  return `sha256:${createHash("sha256").update(JSON.stringify(bars)).digest("hex")}`;
}

function cacheAgeHours(record) {
  const created = Date.parse(record?.fetchedAt || "");
  return Number.isFinite(created) ? (Date.now() - created) / 3600000 : Infinity;
}

async function writeCache(cacheFile, record) {
  await mkdir(path.dirname(cacheFile), { recursive: true });
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temporary, cacheFile);
}

function errorMessage(error) {
  return String(error?.message || error).replace(/\s+/g, " ").slice(0, 300);
}

export async function resolveWithFallback({
  security,
  providers,
  providerFetcher,
  cachedRecord,
  request,
  cacheMaxAgeHours,
  refresh,
  offline,
}) {
  const attempts = [];
  const cachedValidation = cacheCovers(cachedRecord, request)
    ? validateBars(cachedRecord.bars, request)
    : { valid: false, errors: ["cache_not_covering_request"], bars: [] };
  const ageHours = cacheAgeHours(cachedRecord);

  if (!refresh && cachedValidation.valid && ageHours <= cacheMaxAgeHours) {
    attempts.push({ provider: "cache", status: "success", freshness: "fresh", ageHours: round(ageHours, 3), rowCount: cachedValidation.bars.length });
    return {
      status: "success", provider: cachedRecord.provider, providerLabel: cachedRecord.providerLabel,
      retrievalMode: "fresh_cache", degraded: cachedRecord.provider !== providers[0], sourceUrls: cachedRecord.sourceUrls || [],
      bars: cachedValidation.bars, attempts, fetchedAt: cachedRecord.fetchedAt,
      warnings: [],
    };
  }

  if (!offline) {
    for (const provider of providers) {
      const started = Date.now();
      try {
        const result = await providerFetcher(provider, security);
        const validation = validateBars(result.rows, request);
        if (!validation.valid) throw new Error(validation.errors.join(";"));
        attempts.push({
          provider, status: "success", httpStatus: result.response?.httpStatus ?? null,
          retriesUsed: Math.max(0, (result.response?.attempt ?? 1) - 1),
          durationMs: result.response?.durationMs ?? Date.now() - started,
          rowCount: validation.bars.length,
        });
        return {
          status: "success", provider, providerLabel: PROVIDER_LABELS[provider], retrievalMode: "live",
          degraded: provider !== providers[0], sourceUrls: result.urls || [], bars: validation.bars,
          attempts, fetchedAt: new Date().toISOString(), warnings: [],
        };
      } catch (error) {
        attempts.push({
          provider, status: "failed", httpStatus: error?.status ?? null,
          durationMs: Date.now() - started, error: errorMessage(error),
        });
      }
    }
  }

  if (cachedValidation.valid) {
    attempts.push({ provider: "cache", status: "success", freshness: "stale", ageHours: round(ageHours, 3), rowCount: cachedValidation.bars.length });
    return {
      status: "success", provider: cachedRecord.provider, providerLabel: cachedRecord.providerLabel,
      retrievalMode: "stale_cache", degraded: true, sourceUrls: cachedRecord.sourceUrls || [],
      bars: cachedValidation.bars, attempts, fetchedAt: cachedRecord.fetchedAt,
      warnings: [`使用过期缓存，缓存年龄 ${round(ageHours, 1)} 小时；不得表述为最新行情`],
    };
  }

  attempts.push({ provider: "cache", status: "failed", error: cachedValidation.errors.join(";") });
  return {
    status: "failed", provider: null, providerLabel: null, retrievalMode: null,
    degraded: true, sourceUrls: [], bars: [], attempts, fetchedAt: null,
    warnings: ["所有实时源与可用缓存均失败；不得解释为无行情或无候选"],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.codes || !args.start || !args.end) {
    console.error("Usage: node query-qfq-history.mjs --codes 300649,300998 --start YYYY-MM-DD --end YYYY-MM-DD --output result.json [--required-dates YYYY-MM-DD,...] [--cache-dir path] [--refresh] [--offline] [--strict]");
    process.exit(2);
  }

  const startDate = normalizeDate(args.start, "--start");
  const endDate = normalizeDate(args.end, "--end");
  if (startDate > endDate) throw new Error("--start must not be later than --end");
  const requiredDates = String(args["required-dates"] || "").split(",").map((value) => value.trim()).filter(Boolean);
  requiredDates.forEach((value) => normalizeDate(value, "--required-dates"));
  if (requiredDates.some((date) => date < startDate || date > endDate)) {
    throw new Error("Every --required-dates value must fall inside --start and --end");
  }
  const minBars = numericOption(args["min-bars"], Math.max(2, requiredDates.length), "--min-bars", { min: 1, max: 1023, integer: true });
  const retries = numericOption(args.retries, 2, "--retries", { min: 1, max: 8, integer: true });
  const timeoutMs = numericOption(args["timeout-ms"], 15000, "--timeout-ms", { min: 1000, max: 120000, integer: true });
  const concurrency = numericOption(args.concurrency, 3, "--concurrency", { min: 1, max: 10, integer: true });
  const cacheMaxAgeHours = numericOption(args["cache-max-age-hours"], 24, "--cache-max-age-hours", { min: 0, max: 87600 });
  const cacheDir = path.resolve(String(args["cache-dir"] || defaultCacheDir()));
  const providers = String(args.providers || DEFAULT_PROVIDERS.join(",")).split(",").map((value) => value.trim()).filter(Boolean);
  if (!providers.length || providers.some((provider) => !DEFAULT_PROVIDERS.includes(provider))) {
    throw new Error(`--providers must be a comma-separated subset of ${DEFAULT_PROVIDERS.join(",")}`);
  }
  const securities = [...new Map(String(args.codes).split(",").map(normalizeSecurity).map((item) => [item.code, item])).values()];
  const request = { startDate, endDate, minBars, requiredDates };
  const limit = requestedLimit(startDate, endDate, minBars);
  const stocks = [];
  let cursor = 0;

  async function worker() {
    while (cursor < securities.length) {
      const security = securities[cursor++];
      const cacheFile = path.join(cacheDir, `${security.symbol}.qfq.json`);
      const cachedRecord = await readCache(cacheFile);
      const result = await resolveWithFallback({
        security, providers,
        providerFetcher: (provider, item) => fetchProvider(provider, item, { startDate, endDate, limit, retries, timeoutMs }),
        cachedRecord, request, cacheMaxAgeHours,
        refresh: args.refresh === true,
        offline: args.offline === true,
      });
      const stock = {
        code: security.code, symbol: security.symbol, adjustment: "qfq", ...result,
        quality: result.status === "success"
          ? (() => {
              const { bars: _bars, ...quality } = validateBars(result.bars, request);
              return quality;
            })()
          : { valid: false, errors: ["no_usable_history"] },
        preferredAmountField: result.status === "success" && result.bars.every((bar) => Number.isFinite(bar.amount))
          ? "amount"
          : "amountProxy",
        cacheFile,
        cacheWriteStatus: "not_attempted",
      };
      stocks.push(stock);
      if (result.status === "success" && result.retrievalMode === "live") {
        try {
          await writeCache(cacheFile, {
            schemaVersion: "1.0", adjustment: "qfq", code: security.code, symbol: security.symbol,
            provider: result.provider, providerLabel: result.providerLabel, sourceUrls: result.sourceUrls,
            fetchedAt: result.fetchedAt, request: { startDate, endDate },
            barsSha256: barsHash(result.bars), bars: result.bars,
          });
          stock.cacheWriteStatus = "written";
        } catch (error) {
          stock.cacheWriteStatus = "failed";
          stock.warnings.push(`实时行情有效但缓存写入失败: ${errorMessage(error)}`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  stocks.sort((left, right) => left.code.localeCompare(right.code));
  const providerCounts = Object.fromEntries(DEFAULT_PROVIDERS.map((provider) => [provider, stocks.filter((stock) => stock.provider === provider).length]));
  const output = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    request: {
      codes: securities.map((security) => security.code), startDate, endDate, requiredDates,
      minBars, providers, concurrency, retries, timeoutMs, cacheDir, cacheMaxAgeHours,
      refresh: args.refresh === true, offline: args.offline === true,
    },
    summary: {
      requestedCount: securities.length,
      successCount: stocks.filter((stock) => stock.status === "success").length,
      failedCount: stocks.filter((stock) => stock.status === "failed").length,
      liveCount: stocks.filter((stock) => stock.retrievalMode === "live").length,
      freshCacheCount: stocks.filter((stock) => stock.retrievalMode === "fresh_cache").length,
      staleCacheCount: stocks.filter((stock) => stock.retrievalMode === "stale_cache").length,
      degradedCount: stocks.filter((stock) => stock.degraded).length,
      providerCounts,
    },
    stocks,
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (args.output) {
    await mkdir(path.dirname(path.resolve(String(args.output))), { recursive: true });
    await writeFile(path.resolve(String(args.output)), serialized);
  } else {
    process.stdout.write(serialized);
  }
  if (output.summary.failedCount && args.strict === true) process.exitCode = 3;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
