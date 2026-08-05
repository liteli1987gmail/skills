# 数据源与核验

## 1. 腾讯筹码分布

优先使用腾讯自选股数据工具的固定版本：

```bash
npx -y westock-data-clawhub@1.0.4 chip sz300227,sz301313
```

没有`npx`时：

```bash
pnpm dlx westock-data-clawhub@1.0.4 chip sz300227,sz301313
```

本技能的包装脚本会自动选择可用运行器并把批量Markdown输出规范化为JSON。

固定版本校验信息：

```text
package: westock-data-clawhub@1.0.4
shasum: b434e6ca4b434455201f1d8af56da435f518b678
sha512: Cr4IS69wJ6aFdaDv7Sh/Zwf1FEj+8BHxegIltjWg4bswjV2SfbG9VmM0YN4SwfaLJlP1INzM0Ed3LXP+3WpjSA==
```

字段：

- `date`：筹码快照日期；
- `closePrice`：快照收盘价；
- `chipProfitRate`：获利盘百分比；
- `chipAvgCost`：平均成本；
- `chipConcentration90`、`chipConcentration70`：成本集中度，越低越集中。

不得把筹码推算值描述成登记结算公司的真实账户持仓。批量失败时逐股重试并报告失败代码。

## 2. 业绩预告

### 初筛

使用东方财富结构化业绩预告数据：

```text
https://datacenter-web.eastmoney.com/api/data/v1/get
reportName=RPT_PUBLIC_OP_NEWPREDICT
filter=(SECURITY_CODE="300227")
```

主口径固定为：

```text
PREDICT_FINANCE_CODE = 004
PREDICT_FINANCE = 归属于上市公司股东的净利润
```

`PREDICT_AMT_LOWER`和`PREDICT_AMT_UPPER`均小于0才标记`loss`；区间跨越0标记`mixed`。

### 官方核验

对`loss`、`mixed`和预告修正，必须使用巨潮资讯或交易所公告核验：

- 公告标题和公告日期；
- 报告期；
- 归母净利润上下限；
- 扣非净利润上下限；
- 首亏、续亏、增亏或减亏；
- 亏损原因；
- 官方PDF链接。

财报预约披露日只表示预定发布时间。腾讯工具的`reserve`命令不是业绩盈亏预告，禁止据此判断预亏。

## 3. 价格与成交额

需要事件分析时优先使用腾讯前复权日线。成交额优先级：

1. 行情源真实历史成交额；
2. `OHLC4 × 成交量`；
3. `收盘价 × 成交量`。

同一股票的整个窗口使用同一口径。沪深接口的成交量单位可能不同，先用单股公开成交额校验量纲。

## 4. 代码转换

- `000`、`001`、`002`、`003`、`300`、`301`：`sz`；
- `600`、`601`、`603`、`605`、`688`：`sh`；
- `4`、`8`、`9`开头的北交所代码：`bj`。

保留原始六位代码用于公告查询。

## 5. 完整性和降级

- 报告输入总数、唯一代码数、筹码成功数、预告查询成功数和失败数。
- 网络失败、验证码或限流时重试，不把空响应解释成“无预告”。
- 只有请求成功且结果为空时才能标记`no_forecast`。
- 官方公告与聚合数据冲突时以官方公告为准，并记录修正。
- 所有当前数据写明截止日；缓存必须写明生成时间。
