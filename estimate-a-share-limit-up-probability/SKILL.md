---
name: estimate-a-share-limit-up-probability
description: 分页获取完整A股股票池，筛选创业板和科创板小市值股票，识别连续下跌期放量、随后缩量和价格修复形态，并分别运行前一晚预测、收盘确认及强者越强排序。用于用户要求预测次日大涨或涨停候选、筛选双创市值低于指定阈值股票、复刻红框量价模式、比较未过热强势股、回测次日/3日/5日结果，或排查行情接口截断和数据源失效时。
---

# 双创次日大涨候选研究

## 边界

- 输出“候选名单”“形态匹配分”或“相对潜力排序”；未完成时间外校准时，不称为真实概率。
- 不给出个性化买卖指令。写明数据日期、来源、复权方式、股票池和缺失情况。
- 始终分页并校验完整性。禁止把接口实际返回的涨幅前100名冒充完整股票池。
- 公司事件、基本面和题材只加独立标签，不改变纯形态是否入选；除非用户明确要求风险过滤。
- 使用公司全称和证券代码消歧。

## 标准流程

1. 读取 [references/data-sources.md](references/data-sources.md)，确定主数据源和降级链路。
2. 使用 `scripts/fetch_dual_board_data.mjs` 获取创业板、科创板快照与日线。默认总市值上限100亿元、观察140日。
3. 核验报告中的 `reportedTotal`、`snapshotRows`、`snapshotUnique`、涨跌幅最小值和最大值。若总数不一致，解释停牌、无报价或来源口径差异，不能静默丢弃。
4. 使用 `scripts/rank_dual_board_candidates.mjs` 同时生成：
   - `priorNightRanking`：剔除当日涨幅和当日换手；
   - `closeConfirmationRanking`：加入当日涨幅和换手；
   - `redBoxRanking`：连续下跌至少2日、下跌期平均成交额高于此前6日、随后缩量；
   - `strongUnder5Ranking`：在红框样本中按强者越强排序，且当日涨幅小于5%。
5. 读取 [references/factors.md](references/factors.md)，解释评分和阶段，不把“第三日”写成机械买点。
6. 需要评价有效性时读取 [references/backtest.md](references/backtest.md)，滚动报告次日、未来3日、未来5日触板与收盘涨停。
7. 单独核验公告、题材和龙虎榜，仅作为标签层。

## 命令

```bash
node scripts/fetch_dual_board_data.mjs \
  --output /tmp/dual-board-data.json \
  --max-market-cap-yi 100

node scripts/rank_dual_board_candidates.mjs \
  --input /tmp/dual-board-data.json \
  --output /tmp/dual-board-ranking.json \
  --max-current-change-pct 5 \
  --top 30
```

先用 `--limit 10` 验证数据源和字段，再运行完整股票池。脚本失败时不得沿用旧缓存冒充最新数据。

## 输出

至少报告：

- 数据截止日、完整股票池、有效报价数、市值过滤后数量、日线成功/失败数量；
- 前一晚模型与收盘确认模型分表，说明两者不可混用；
- 红框形态的下跌日期、累计跌幅、放量比、缩量比、第三日和修复幅度；
- 强者越强且当日涨幅小于5%的名单；
- 已涨停组单列；
- 至少一个失败反例和所有数据近似；
- 次日竞价、成交活跃度、板块联动和形态失效条件。

## 资产

- `assets/reference-two-day-selloff.png`：两日放量下跌、随后缩量参考图。
- `assets/reference-repeated-selloff.png`：重复放量下跌参考图。

图片只用于解释形态，不证明证券身份、指标公式或策略有效性。
