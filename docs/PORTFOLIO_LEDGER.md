# Yi Capital D1 事件賬本

## 目標狀態

D1 是 US、HK、A 三個組合的唯一賬務真相源。Excel 不再是網站輸入，也不再
負責計算；它只保留兩個用途：

1. 從 `CONFIRMED` 事件及後台派生結果生成與舊版相同的 11-sheet 可視工作簿。
2. 對人工允許的 `BUY`、`SELL`、`CAPITAL` 做三方差異預覽，再寫入 `PENDING`。

公開網站仍只讀 `navcache:{us|hk|a}`，`/api/nav/*`、`/api/benchmark` 和
`/api/entry-market` 的回應合同不變。後台確認事件後，由 D1 outbox 重建
`ledger:{us|hk|a}`；盘中一分钟 Cron 只用当下未复权 counter 覆盖当日点，收盘任务
再冻结 raw close 并刷新 KV 公開快照。因此数据库切换不要求修改
首页、组合页或基金页的 HTML/CSS。

## 事件与状态

支持的事件：

- `BUY`
- `SELL`
- `DIVIDEND`
- `CORPORATE_ACTION`
- `LIABILITY`
- `CAPITAL`
- `FUND_ACTION`
- `REVERSAL`

人工新增只允许 `BUY`、`SELL`、`CAPITAL`。`DIVIDEND`、`CORPORATE_ACTION`、
`LIABILITY`、`FUND_ACTION` 及其他非人工来源必须由 Broker、custodian 或后台任务
先写入不可变 source record，再以 `source=AUTOMATION` 进入 `ledger_pending`。
所有 Pending 都可在后台复核和修改；股息等现金事件可在 Confirm 前补充扣税资料。
确认后写入 append-only `ledger_events`，不可原地覆盖。已确认事件的修订会创建新的
`event_id`，保留相同 `lineage_id`，并通过 `supersedes_event_id` 指向旧事件。显式
作废使用新的 `REVERSAL` 事件。

每次确认使用两个乐观锁：

- `pending.version`
- `ledger_portfolios.ledger_revision`

锁条件在同一个 D1 `batch()` 中通过临时 guard 的 NOT NULL 约束检查；任一状态已
变化，整个 batch 回滚。事件、Pending 状态、审计和 outbox 同批提交。

## 旧 Python 兼容规则

确定性重放引擎位于 `worker/portfolio-ledger.js`，规则是：

- Amount 为实际现金金额，Price 仅作参考。
- Amount 同时是现金链和累计成本/收入的唯一真相；不得用 `Quantity × Price` 反算。
- Buy 现金为负；Sell、Dividend 为正。
- Liability 现金变化为 `Liability Change - Interest`。
- Capital 份额为 `(Subscription - Redemption) / Unit Price`。
- 同日顺序为 Capital → Liability → Corporate Action → Buy/Sell → Dividend → Fund Action。
- 公司行动在同日交易前执行。
- 公司行动只描述原持仓变成哪些新 ticker 及各自绝对数量；现金变化独立进入现金链。
- 公司行动不会按市价分摊、搬移或创造成本；买入成本、卖出收入、股息、税费永远留在产生该现金记录的 ticker。
- 负现金照实保留并参与 NAV，但不产生警告、确认要求或阻断。
- 净成本为累计买入成本减累计卖出收入。
- 总盈亏为当前市值 + 累计卖出 + 净股息 - 累计买入。
- 名义收益率严格沿用旧 Python：`(Latest Price - Net Cost / Quantity) / abs(Net Cost / Quantity)`。
- 敞口收益率严格沿用旧 Python：`Total P&L / Total Buy Cost`。
- NAV 为现金 + 市值 - 负债，单位 NAV 再除以总份额。

现金以最小货币单位整数重放。Quantity、Price 和 NAV 以规范化 decimal 字段保留，
避免把 JavaScript/SQLite 二进制浮点当作账务事实。现金可以为负；系统照实用于后续
现金、总资产和 NAV 运算，不产生 warning、确认项或 blocker，也不得自动补融资事件。

## 股息和扣税

新股息事件分开保存：

- `gross_amount_minor`
- `tax_amount_minor`
- `fee_amount_minor`
- `net_cash_minor`
- `tax_rate`
- `tax_type`
- `tax_jurisdiction`
- `tax_reclaimable`
- `tax_evidence_id`

确认页支持 None、Rate、Fixed。确认后的 Amount 是净现金和 cost/income 真相；
gross、tax、fee 只作审计拆分，不能在 Amount 之外再次扣减。旧 Excel Dividend
Amount 继续显示净到账，因此可视格式不增加列。旧账没有可验证税项，迁移时必须
使用 `tax_status=UNKNOWN_LEGACY`，gross/tax 保持 null，不得把未知税额伪装成 0。

## Excel 双向同步

工作簿保留七张事件表，以便完整展示数据库事件：

- ETF Stock Buy Record
- ETF Stock Sell Record
- ETF Stock Dividend Record
- Corporate Action Record
- Liability Record
- Capital Record
- Fund Action Record

只有 Buy、Sell、Capital 允许由 Excel 反向导入全新的 CREATE。Dividend、Corporate
Action、Liability、Fund Action 的原始事实必须来自自动 source record，Excel 不能凭空
新建；但由后台签名导出的现有事件可带稳定 lineage/version/hash 在 Excel 修改，并以
UPDATE 重新进入 Pending，之后仍须在后台复核、扣税及 Confirm。

四张只读派生表：

- Asset Position Record
- Liability Statement
- Cash Flow Statement
- NAV Statement

导出使用仓库现有工作簿作为模板，浏览器端固定使用支持样式的 writer，保持 sheet
顺序、列宽、月份栏、颜色、边框、数字格式和零公式合同。同步元数据放在 veryHidden
`_YiSync` sheet；七张事件表的稳定 ID、版本和 base hash 放在隐藏列，不改变可见外观。

反向导入只能经过：

`上传 → SHA-256/模板检查 → Preview → CREATE/UPDATE/NOOP/CONFLICT → 写入 Pending → 单笔 Confirm`

服务端使用导出快照做三方比较：Excel、导出 base、当前 D1。Excel 删除行只显示
`MISSING_IN_EXCEL`，不会自动删除数据库事件。非人工事件若缺少有效的既有
lineage/version/hash 会被拒绝；有效 UPDATE 只进入 Pending，不会直接改写 confirmed
event 或原始 source record。四张派生表的改动显示 `IGNORED_DERIVED`，永不反写事实。

## 自动化输入

后台连接器发现的股息、公司行动、负债和基金行动原文先不可变写入
`ledger_source_records`，再以 `source=AUTOMATION` 创建 Pending。自动 source 不得创建
BUY、SELL 或 CAPITAL；这三类只能由后台人工或签名 Excel 进入 Pending。唯一键是：

`(portfolio, source_system, source_account, source_event_id)`

重复 webhook/job 不会重复入账。自动化只负责发现和规范化，不自动 Confirm。

## 数据库与 KV 的一致性

D1 和 KV 不能组成跨存储事务。确认 batch 会在 D1 同时写入 `ledger_outbox`：

- `RECALC_NAV`
- `REBUILD_KV`
- `REBUILD_EXCEL`

Confirm 后请求路径会立即触发 outbox：先从最早受影响日期冻结当前 revision 的未复权
raw-close 价格带并重放现金、持仓、负债、份额及 NAV，完成后才 materialize KV 和
Excel。不能在价格带之前先发布 KV。Cron 和后台 outbox 按指数退避重试。D1
事件已经提交但重算或 KV 暂时失败时，公开页继续返回上一份成功快照，不返回半成品。

历史日期事件或行情会从对应日期起自动重建全部 NAV；修改或撤销旧事件时从新旧日期
中较早者开始。非交易日可按 as-of 沿用上一个已冻结 raw close；任一实际交易日缺少
raw close 时必须 fail closed，不得用复权价、Book Value、参考价或成本代替。重建完成前普通
刷新不得发布新的 KV 或 Excel 快照；若 D1 revision
在重算或 KV 写入期间变化，整批结果作废，outbox 按最新 revision 重新排队。
每个 ledger revision 都有独立、带 hash 的 immutable raw-close price tape；新 revision
必须逐行继承上一 revision 的重叠历史，只能补更早的新事件区间或向未来追加 EOD。
当日 verified counter 可以每分钟覆盖当日 NAV，但不能改写 tape 内任何历史日期。
三市场只在各自正常交易时段运行实时刷新；美股 Yahoo counter 与带明确时间戳的
A/HK counter 超过 15 分钟即拒绝，绝不把同日陈旧成交当作“现在价格”。

## 迁移门禁

迁移工具 `scripts/migrate-legacy-ledgers.mjs` 只把七张事件表转换为 canonical 事件。
`Asset Position Record`、`Liability Statement`、`Cash Flow Statement`、`NAV
Statement` 只用于离线 parity 核验，不进入 operational migration payload，也不作为
价格、NAV 或任何账务 seed。生产 D1 的四张派生结果必须从 confirmed events、后台
行情和 Python 兼容重放重新计算。
正式导入前必须核验：

1. US、HK、A 的每笔 Cash Amount 必须按事件顺序连续重放，期末现金分别与原工作簿一致；
   过程中出现负现金时只保留数值并进入 NAV 运算，不作告警或确认门禁。
2. US 在 2026-05-29 有两笔字段完全相同的 ORCL 卖出（10 股、2,140 USD）。
3. 历史股息税项全部为 UNKNOWN_LEGACY。
4. US 的 2026-07-01 SPGI → SPGI + MBGL 是多输出公司行动；迁移只保留原 ticker、
   输出 ticker 和绝对数量。行动本身不分配、搬移或创造成本，独立 Cash Amount 才改变现金。

迁移器只警告，不自动补融资、不去重、不推测税额。先在 D1 preview 环境导入三本，
对账事件数、现金、份额、持仓、负债和 NAV；全部通过后才允许切断旧 `/api/ledger`。
导入确认必须显式确认 exact duplicates 与 unknown tax。负现金不作 warning；derived
NAV/price 不作为迁移 seed，因此没有 historical NAV/prices 的 operational sign-off。
确认短语必须使用服务端真实合同：US、HK、A 分别为 `CONFIRM LEGACY US`、
`CONFIRM LEGACY HK`、`CONFIRM LEGACY A`，不得由客户端按事件数自行拼接。

当前三本迁移包的事件数为 A 59、HK 81、US 110。SPGI/MBGL 不再是 blocker；三本都
必须在真实 Cash Flow、份额、持仓、负债和全历史 NAV parity 通过后才可进入生产。

## API

- `GET /api/admin/ledger?portfolio=us&status=all`
- `POST /api/admin/ledger/pending`
- `POST /api/admin/ledger/pending/update`
- `POST /api/admin/ledger/pending/reject`
- `POST /api/admin/ledger/pending/confirm`
- `GET /api/admin/ledger/export?portfolio=us`
- `POST /api/admin/ledger/import/preview`
- `POST /api/admin/ledger/import/confirm`
- `POST /api/admin/ledger/source`
- `POST /api/admin/ledger/migration/preview`
- `POST /api/admin/ledger/migration/confirm`
- `POST /api/admin/ledger/outbox`

所有路由均需 admin session；JSON 请求上限 2 MiB，Excel 原文件不进入 D1，请求只传
经过浏览器白名单解析后的事件行和 SHA-256。原始自动化证据另存 source record。
