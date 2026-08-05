#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  applySinaQfq,
  barsHash,
  normalizeSecurity,
  parseEastmoneyPayload,
  parseSinaHistory,
  parseSinaQfqFactors,
  parseTencentPayload,
  resolveWithFallback,
  validateBars,
} from "./query-qfq-history.mjs";

const security = normalizeSecurity("300649");
assert.deepEqual(security, { code: "300649", symbol: "sz300649", exchange: "sz" });
assert.throws(() => normalizeSecurity("sh300649"), /prefix mismatch/);
assert.throws(() => normalizeSecurity("700001"), /Unsupported/);

const tencentRows = parseTencentPayload(JSON.stringify({
  data: {
    sz300649: {
      qfqday: [
        ["2026-07-17", "10", "9.5", "10.2", "9.4", "123"],
        ["2026-07-20", "9.4", "9.0", "9.6", "8.9", "200"],
      ],
    },
  },
}), security);
assert.equal(tencentRows.length, 2);
assert.equal(tencentRows[0].volume, 12300);
assert.equal(tencentRows[0].volumeUnit, "shares");
assert.equal(tencentRows[0].sourceVolumeUnit, "lots");
assert.equal(tencentRows[0].amountProxy, 120232.5);
assert.throws(() => parseTencentPayload(JSON.stringify({
  data: { sz300649: { day: [["2026-07-17", "10", "9.5", "10.2", "9.4", "123"]] } },
}), security), /拒绝冒充 qfqday/);
assert.throws(() => parseTencentPayload("<html>WAF 501</html>", security), /WAF/);

const eastmoneyRows = parseEastmoneyPayload(JSON.stringify({
  data: {
    klines: [
      "2026-07-17,10,9.5,10.2,9.4,123,123456,0,-5,0,2",
      "2026-07-20,9.4,9.0,9.6,8.9,200,180000,0,-5.26,0,3",
    ],
  },
}));
assert.equal(eastmoneyRows[1].amount, 180000);
assert.equal(eastmoneyRows[1].amountIsProxy, false);
assert.throws(() => parseEastmoneyPayload(""), /空响应/);

const sinaRaw = parseSinaHistory(`/*guard*/\nvar _kline_=([{"day":"2026-07-17","open":"10","high":"10.2","low":"9.4","close":"9.5","volume":"123"},{"day":"2026-07-20","open":"9.4","high":"9.6","low":"8.9","close":"9","volume":"200"}]);`);
const factors = parseSinaQfqFactors('var sz300649qfq={"total":2,"data":[{"d":"2026-07-20","f":"1"},{"d":"2026-01-01","f":"2"}]};');
const sinaQfq = applySinaQfq(sinaRaw, factors);
assert.equal(sinaQfq[0].close, 4.75);
assert.equal(sinaQfq[1].close, 9);
assert.equal(sinaQfq[0].volume, 123);

const request = {
  startDate: "2026-07-17",
  endDate: "2026-07-20",
  minBars: 2,
  requiredDates: ["2026-07-17", "2026-07-20"],
};
assert.equal(validateBars(tencentRows, request).valid, true);
assert.equal(validateBars(tencentRows.slice(0, 1), request).valid, false);

const fallback = await resolveWithFallback({
  security,
  providers: ["tencent", "eastmoney", "sina"],
  providerFetcher: async (provider) => {
    if (provider === "tencent") throw new Error("HTTP 501; WAF/HTML");
    if (provider === "eastmoney") throw new Error("empty response");
    return { rows: sinaQfq, urls: ["sina-history", "sina-qfq"], response: { httpStatus: 200, attempt: 1, durationMs: 5 } };
  },
  cachedRecord: null,
  request,
  cacheMaxAgeHours: 24,
  refresh: false,
  offline: false,
});
assert.equal(fallback.status, "success");
assert.equal(fallback.provider, "sina");
assert.equal(fallback.degraded, true);
assert.deepEqual(fallback.attempts.map((attempt) => attempt.status), ["failed", "failed", "success"]);

let networkCalled = false;
const freshCache = await resolveWithFallback({
  security,
  providers: ["tencent", "eastmoney", "sina"],
  providerFetcher: async () => { networkCalled = true; throw new Error("must not run"); },
  cachedRecord: {
    schemaVersion: "1.0", adjustment: "qfq", provider: "sina", providerLabel: "新浪",
    fetchedAt: new Date().toISOString(), request: { startDate: "2026-07-01", endDate: "2026-08-01" },
    barsSha256: barsHash(sinaQfq), bars: sinaQfq,
  },
  request,
  cacheMaxAgeHours: 24,
  refresh: false,
  offline: false,
});
assert.equal(networkCalled, false);
assert.equal(freshCache.retrievalMode, "fresh_cache");

const staleCache = await resolveWithFallback({
  security,
  providers: ["tencent"],
  providerFetcher: async () => { throw new Error("HTTP 501"); },
  cachedRecord: {
    schemaVersion: "1.0", adjustment: "qfq", provider: "sina", providerLabel: "新浪",
    fetchedAt: "2020-01-01T00:00:00.000Z", request: { startDate: "2026-07-01", endDate: "2026-08-01" },
    barsSha256: barsHash(sinaQfq), bars: sinaQfq,
  },
  request,
  cacheMaxAgeHours: 24,
  refresh: false,
  offline: false,
});
assert.equal(staleCache.retrievalMode, "stale_cache");
assert.equal(staleCache.degraded, true);
assert.match(staleCache.warnings[0], /不得表述为最新行情/);

const totalFailure = await resolveWithFallback({
  security,
  providers: ["tencent"],
  providerFetcher: async () => { throw new Error("HTTP 501"); },
  cachedRecord: null,
  request,
  cacheMaxAgeHours: 24,
  refresh: false,
  offline: false,
});
assert.equal(totalFailure.status, "failed");
assert.match(totalFailure.warnings[0], /不得解释为无行情或无候选/);

console.log("query-qfq-history tests passed");
