# Yi Capital D1 事件賬本

## 目標狀態

D1 是 US、HK、A 三個組合的唯一賬務真相源。Excel 不再是網站輸入，也不再
負責計算；它只保留兩個用途：

1. 從 `CONFIRMED` 事件及後台派生結果生成與舊版相同的 11-sheet 可視工作簿。
2. 對後台簽名導出的凍結快照做全賬本差異預覽，再以一個原子 revision 覆蓋目前
   active ledger；舊 revision 和所有被取代事件永久保留，絕不原地刪除。

公開網站只讀 D1 的 `ledger_public_snapshots` 原子快照，`/api/nav/*` 和
`/api/entry-market` 的數據合同不變；`/api/benchmark` 仍讀低頻 KV benchmark。
舊 `navcache:{us|hk|a}` 只在 D1 缺表、讀故障或首次 backfill 前作經完整合同驗證的
災備回退。後台確認事件後，由 D1 outbox 重建
`ledger_materialized_projections`；盘中一分钟 Cron 只用当下未复权 counter 覆盖当日点，
收盘任务再冻结 raw close 并刷新 D1 公開快照。因此数据库切换不要求修改
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
所有 Pending 都可在后台复核和修改。现金事件只输入券商最终结算的 `Amount`；系统
没有独立税费录入、扣减、复核或阻断流程。
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

## Amount 边界与派息核实

`Amount` 是券商账单上的最终结算现金，已经包含任何税费影响。BUY、SELL、DIVIDEND
和其他现金事件都只按这个值入账；`CPS = Amount / Quantity` 由后台计算，不能作为
输入反推现金。BUY / SELL 的 `Price` 只是可选参考值，可以手填，也可以留空。

自动派息检测只写入 `ledger_dividend_candidates` 核实 Inbox。候选的 `Amount` 在数据库
中必须保持 NULL；管理员看到证券、除息日、支付日和来源证据后，手工输入券商实际
到账 Amount，系统才创建 `source=AUTOMATION` 的 Pending。这个动作不会自动 Confirm。
重复行情抓取按稳定的市场事实去重，抓取时间或查询窗口变化不会制造重复候选。

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
新建；后台签名导出的既有事件则可按稳定 lineage/version/hash 修改或移除。

四张只读派生表：

- Asset Position Record
- Liability Statement
- Cash Flow Statement
- NAV Statement

导出使用仓库现有工作簿作为模板，浏览器端固定使用支持样式的 writer，保持 sheet
顺序、列宽、月份栏、颜色、边框、数字格式和零公式合同。同步元数据放在 veryHidden
`_YiSync` sheet；七张事件表的稳定 ID、版本和 base hash 放在隐藏列，不改变可见外观。

反向导入只能经过：

`上传 → SHA-256/模板检查 → 全賬本 Preview → 明確確認整本覆蓋 → 一個原子 revision`

工作簿是這次覆蓋的 active ledger 真相。服务端列出 CREATE、UPDATE、NOOP、
`MISSING_IN_EXCEL` 和 blocker；确认时以 ledger revision CAS 防止 Preview 后发生并发
修改。Excel 中缺失的 active 事件以 append-only `REVERSAL` 墓碑停用，更新以新事件
supersede 旧事件；D1 历史永不删除。空白 BUY / SELL Price 保留数据库已有 Price，
新行则继续为空；Excel 中 CPS 和任何兼容税费字段一律忽略。四张派生表的改动显示
`IGNORED_DERIVED`，永不反写事实。即使当前 revision 正在重算，也可导出上一份完整
冻结快照并用其做全量 Preview；确认前仍须通过当前 revision CAS。

## 自动化输入

后台连接器发现的股息、公司行动、负债和基金行动原文先不可变写入
`ledger_source_records`，再以 `source=AUTOMATION` 创建 Pending。自动 source 不得创建
BUY、SELL 或 CAPITAL；这三类只能由后台人工或签名 Excel 进入 Pending。唯一键是：

`(portfolio, source_system, source_account, source_event_id)`

重复 webhook/job 不会重复入账。自动化只负责发现和规范化，不自动 Confirm。派息
检测还会回放扫描窗口内曾经持有过的证券，避免除息后卖出导致漏报；资格本身仍标记
为待人工核实，不由行情源自动判定。

## D1 派生投影与原子发布

确认 batch 会在 D1 同时写入 `ledger_outbox`：

- `RECALC_NAV`
- `REBUILD_KV`
- `REBUILD_EXCEL`

Confirm 后请求路径会立即触发 outbox：先从最早受影响日期冻结当前 revision 的未复权
raw-close 价格带并重放现金、持仓、负债、份额及 NAV，完成后才 materialize D1 read
projection、原子公開快照和 Excel。不能在价格带之前先发布公開快照。Cron 和后台
outbox 按指数退避重试。D1 事件已经提交但重算暂时失败时，公开页继续返回上一份
成功快照并明确标记 pending/fallback，不返回半成品。

`ledger_public_snapshots` 每个市场只有一行完整 last-known-good payload，发布使用
`ledger_revision` guarded UPSERT；`ledger_public_attempts` 单独记录最新失败/成功尝试，
不会为状态变化重写大 JSON；`ledger_materialized_projections` 取代旧 `ledger:*` KV。
三者均保存 SHA-256 并在读取时校验。KV 每日写入配额耗尽不得阻断 D1 outbox 或公开
发布，盘中 minute/intraday 行情也不写共享 KV。

历史日期事件或行情会从对应日期起自动重建全部 NAV；修改或撤销旧事件时从新旧日期
中较早者开始。非交易日可按 as-of 沿用上一个已冻结 raw close；任一实际交易日缺少
raw close 时必须 fail closed，不得用复权价、Book Value、参考价或成本代替。重建完成前普通
刷新不得发布新的 D1 public 或 Excel 快照；若 D1 revision
在重算或 guarded D1 写入期间变化，整批结果作废，outbox 按最新 revision 重新排队。
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
3. 历史股息只保留工作簿里的最终 Amount，不补造或拆分税费。
4. US 的 2026-07-01 SPGI → SPGI + MBGL 是多输出公司行动；迁移只保留原 ticker、
   输出 ticker 和绝对数量。行动本身不分配、搬移或创造成本，独立 Cash Amount 才改变现金。

迁移器只警告，不自动补融资、不去重、不推测税额。先在 D1 preview 环境导入三本，
对账事件数、现金、份额、持仓、负债和 NAV；全部通过后才允许切断旧 `/api/ledger`。
导入确认必须显式确认 exact duplicates。负现金不作 warning；derived
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
- `GET /api/admin/ledger/dividends?portfolio=us`
- `POST /api/admin/ledger/dividends/verify`
- `POST /api/admin/ledger/dividends/dismiss`
- `POST /api/admin/ledger/source`
- `POST /api/admin/ledger/migration/preview`
- `POST /api/admin/ledger/migration/confirm`
- `POST /api/admin/ledger/outbox`

所有路由均需 admin session；JSON 请求上限 2 MiB，Excel 原文件不进入 D1，请求只传
经过浏览器白名单解析后的事件行和 SHA-256。原始自动化证据另存 source record。
