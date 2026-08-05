---
name: rank-a-share-dual-perspective-candidates
description: 对用户提供的A股股票名单批量查询腾讯自选股筹码分布，核对业绩预告是否预亏，结合价格相对平均成本、获利盘、筹码集中度、事件后修复、量价承接和业绩状态，分别运行常规正向因子与完全倒置的逆向因子评分并输出两份候选名单。用于用户要求比较正常分析师与逆向分析师、筛选套牢盘或利空消化候选、分析筹码和预亏组合、生成正反两套研究观察名单时。
---

# A股正逆向双视角候选

## 边界

- 输出“正向候选名单”和“逆向候选名单”，不得把模型排序写成确定收益或个性化买卖指令。
- 筹码分布是基于行情与换手推算的成本分布，不是股东账户逐笔持仓。
- “未发布业绩预告”只表示未检索到预告，不得推断公司一定盈利。
- 任何解释目标日期的因子都必须在该日期当时可知；后续筹码快照只能用于事后状态判断。
- 展示全部输入股票的数据成功、缺失和失败情况，不得只展示入选者。

## 标准流程

1. 记录股票代码、名称、分析截止日、可选事件日期、名单数量和用户指定的排除条件。
2. 读取 [references/data-sources.md](references/data-sources.md)，统一证券代码并查询腾讯筹码分布。
3. 运行 `scripts/query-tencent-chip.mjs`，取得收盘价、获利盘、平均成本、90%和70%筹码集中度。记录快照日期及成功率。
4. 运行 `scripts/query-earnings-forecasts.mjs` 初筛业绩预告。对所有预亏结果到巨潮资讯逐条核对公告日期、报告期、归母净利润区间和公告链接。
5. 若用户给出事件日期，补充事件日前后的前复权日线，计算事件跌幅、成交额、事件后收益和行业/指数超额收益。成交额口径必须同股同窗一致。
6. 读取 [references/factor-model.md](references/factor-model.md)，为每只股票组装评分输入。不能取得的因子保持缺失，不得编造或以零代替。
7. 运行 `scripts/score-dual-perspectives.mjs`。正向和逆向必须使用同一批可用因子；逆向分数固定为 `100 - 正向分数`。
8. 对两份排名运行相同的不可倒置风险门槛：停牌或不可交易、退市高风险、重大违法、持续经营或偿债危机不得因为逆向高分而升级为候选。
9. 对逆向名单额外检查止跌触发。没有止跌触发时列入“逆向观察池”，不得伪装成已确认反转。
10. 输出完整证据表、正向候选、逆向候选、两种逻辑冲突、风险标签和失效条件。

## 命令

查询腾讯筹码：

```bash
node scripts/query-tencent-chip.mjs \
  --codes 300227,301313,300518 \
  --output /tmp/tencent-chip.json
```

查询结构化业绩预告：

```bash
node scripts/query-earnings-forecasts.mjs \
  --codes 300227,301313,300518 \
  --as-of 2026-08-04 \
  --output /tmp/earnings-forecasts.json
```

双向评分：

```bash
node scripts/score-dual-perspectives.mjs \
  --input /tmp/dual-perspective-input.json \
  --output /tmp/dual-perspective-ranking.json \
  --top 10 \
  --min-score 60
```

评分输入的最小结构：

```json
{
  "asOfDate": "2026-08-04",
  "stocks": [
    {
      "code": "300227",
      "name": "光韵达",
      "closePrice": 9.86,
      "chipAvgCost": 9.65,
      "chipProfitRate": 52.85,
      "chipConcentration70": 16.94,
      "postEventReturnPct": 8.2,
      "volumeSupportScore": 70,
      "earningsStatus": "loss",
      "tradeable": true,
      "hardRisk": false,
      "reversalTrigger": true
    }
  ]
}
```

`earningsStatus`使用：`profit`、`turnaround`、`increase`、`positive_decrease`、`loss`、`mixed`、`no_forecast`或`unknown`。

`positiveRanking`和`reverseRanking`保留可比排名；默认仅分数不低于60的股票进入`positiveCandidates`或逆向候选。若无人达标，名单应为空，不得为凑数降低门槛。

评分脚本也接受`close`、`averageCost`、`profitRate`、`concentration70`和`concentration90`别名，并在`inputAliasesUsed`中披露转换；正式留档使用示例中的规范字段。

## 正向推理

优先寻找：

- 现价高于或接近平均成本；
- 获利盘较高；
- 70%筹码集中度较低；
- 事件后相对收益转强；
- 下跌后成交缩量、上涨日放量或出现承接；
- 最新相关报告期盈利、扭亏或改善。

重点识别“利空已知但价格走强”“低位筹码重新集中”和“事件后超额修复”。

## 逆向推理

完全倒置同一批因子，优先寻找：

- 现价显著低于平均成本；
- 获利盘极低；
- 筹码成本分散；
- 事件后仍弱、市场悲观充分；
- 业绩预亏或坏消息集中；
- 量价结构尚未修复。

逆向高分代表“最大痛苦/最大悲观”，不代表已经见底。另行检查：不再创新低、下跌缩量、上涨放量、重新站上短期均线或平均成本。只把已满足触发者列入“逆向触发名单”；止跌触发也只是研究条件，不等于买入确认。

不要倒置数据质量、可交易性、重大违法、退市与持续经营风险等硬门槛；这些约束对两种模型同样有效。

## 固定输出

至少包含：

- 数据截止日、筹码快照日、业绩预告检索区间和事件窗口；
- 输入总数、筹码成功/失败数、预告成功/失败数；
- 全量股票的现价、平均成本、成本偏离、获利盘、70%/90%集中度；
- 预告状态、公告日期、报告期、归母净利润区间和官方链接；
- 正向分数、逆向分数、因子覆盖率和每只股票的主要贡献因子；
- 正向候选名单及入选理由、失效条件；
- 逆向观察池、逆向触发名单及“接飞刀”风险；
- 同时被两种模型关注的股票以及两种解释为何冲突；
- 数据缺失、代理口径、公告修正和前视偏差说明。

## 质量检查

- 对任意股票验证 `正向分数 + 逆向分数 = 100`，允许四舍五入误差0.02。
- 没有任何可计算分数时，`parityCheckPassed`应为`null`并返回验证告警，不得以空集合声称校验通过。
- 因子覆盖率低于60%的股票不进入正式排名。
- 至少两个筹码核心字段有效，才允许进入排名。
- `tradeable=false`或`hardRisk=true`的股票不得进入任一正式排名；风险原因写入`riskFlags`。
- 业绩预告预约披露日不是业绩预告，不得把 `reserve` 数据当成预亏公告。
- 预亏公告必须以归属于上市公司股东的净利润为主口径，扣非净利润单列。
- 公告修正以分析截止日前最新版本为准。
- 需要解释历史事件时，排除公告日或筹码日晚于事件日的数据。
