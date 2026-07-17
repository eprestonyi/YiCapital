/* ═══════════════════════════════════════════════════════════
   Yi Capital i18n — 繁體 / 简体 / English 全站平行三語
   規則：導航右上 繁｜简｜EN 切換，選擇存本機；
        data-i18n / data-i18n-ph 標記自動翻譯；
        JS 用 YCI.t(key) / YCI.lbl(key) / YCI.f(key,vars)；
        專有名詞（YiCapital、基金名、代號）不翻譯；
        研報正文暫繁體，简/EN 顯示敬請期待。
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const D = {

    /* ── 頂欄 / 導航 / 頁腳 ── */
    'ut.live':['實時組合','实时组合','LIVE PORTFOLIO'],
    'ut.forum':['研報庫','研报库','RESEARCH FORUM'],
    'ut.insights':['最新觀點','最新观点','LATEST INSIGHTS'],
    'ut.contact':['聯繫我們','联系我们','CONTACT'],
    'ut.login':['登入','登入','LOGIN'],
    'nav.insights':['研究觀點','研究观点','Our Insights'],
    'nav.forum':['研究論壇','研究论坛','Research Forum'],
    'nav.portfolios':['組合實錄','组合实录','Our Portfolios'],
    'nav.about':['關於我們','关于我们','About Us'],
    'footer.disc':['免責聲明：本網站所載之研究報告、組合數據與論壇內容，均基於公開資料與個人判斷撰寫，僅供研究與學習參考，不構成任何證券之買賣要約、招攬或投資建議。','免责声明：本网站所载之研究报告、组合数据与论坛内容，均基于公开资料与个人判断撰写，仅供研究与学习参考，不构成任何证券之买卖要约、招揽或投资建议。','Disclaimer: All research, portfolio data and forum content on this site are prepared from public information and personal judgment, for research and educational reference only, and do not constitute an offer, solicitation or investment advice with respect to any security.'],
    /* ── 頁籤 ── */
    'tab.perf':['業績表現','业绩表现','Performance'],
    'tab.hold':['持倉','持仓','Holdings'],
    'tab.risk':['風險','风险','Risks'],
    'tab.meth':['方法論','方法论','Methodology'],
    'tab.filings':['申報文件 ↗','申报文件 ↗','Filings ↗'],
    /* ── 首頁 ── */
    'hero.s1k':['研究 ｜ 首次覆蓋','研究 ｜ 首次覆盖','Research | Initiation'],
    'hero.s1t':['騰訊控股（0700.HK）：流量帝國的價值重估時刻','腾讯控股（0700.HK）：流量帝国的价值重估时刻','Tencent (0700.HK): The Revaluation Moment of a Traffic Empire'],
    'hero.s2k':['組合 ｜ Yi Capital HK','组合 ｜ Yi Capital HK','Portfolio | Yi Capital HK'],
    'hero.s2t':['港股週期均值回歸策略','港股周期均值回归策略','HK Cyclical Mean-Reversion Strategy'],
    'hero.s3k':['論壇 ｜ 研報庫','论坛 ｜ 研报库','Forum | Research Library'],
    'hero.s3t':['搜索全部深度研報與方法論文件','搜索全部深度研报与方法论文件','Search all deep-dive research & methodology files'],
    'home.portfolios.h':['組合實錄','组合实录','Our Portfolios'],
    'home.portfolios.p':['三個獨立運作的個人組合，方法論、持倉與申報文件全部公開。','三个独立运作的个人组合，方法论、持仓与申报文件全部公开。','Three independently run portfolios — methodology, holdings and filings fully disclosed.'],
    'home.viewall':['查看全部組合 →','查看全部组合 →','View all portfolios →'],
    'home.hk.k':['精選 ｜ 港股','精选 ｜ 港股','Featured | Hong Kong'],
    'home.hk.p':['做港股的週期均值回歸：在情緒與估值的極端處建倉，等待價格向長期均值收斂。標的集中於現金流可驗證、股東回報明確的週期資產。','做港股的周期均值回归：在情绪与估值的极端处建仓，等待价格向长期均值收敛。标的集中于现金流可验证、股东回报明确的周期资产。','Mean-reversion in HK cyclicals: positions built at sentiment and valuation extremes, concentrated in cash-flow-verifiable assets with clear shareholder returns.'],
    'home.hk.go':['查看淨值曲線、持倉與風險檔案 →','查看净值曲线、持仓与风险档案 →','View NAV curve, holdings & risk profile →'],
    'home.us.k':['USD ｜ 多資產','USD ｜ 多资产','USD | Multi-Asset'],
    'home.us.p':['多資產配置的美金組合：股票、久期（duration）、黃金與短債的風險平衡，以厚尾（fat-tail）與壓力測試框架管理回撤。','多资产配置的美金组合：股票、久期（duration）、黄金与短债的风险平衡，以厚尾（fat-tail）与压力测试框架管理回撤。','A multi-asset USD portfolio: risk balanced across equities, duration, gold and short-term bonds, with fat-tail and stress-testing frameworks governing drawdowns.'],
    'home.a.k':['CNY ｜ A股','CNY ｜ A股','CNY | A-Shares'],
    'home.a.p':['A股優質資產的長期持有：聚焦競爭格局清晰、自由現金流充沛的龍頭，換手極低、以年為單位計倉。','A股优质资产的长期持有：聚焦竞争格局清晰、自由现金流充沛的龙头，换手极低、以年为单位计仓。','Long-term ownership of quality A-shares: leaders with clear competitive structure and abundant free cash flow; minimal turnover, positions measured in years.'],
    'home.enter':['進入組合頁 →','进入组合页 →','Enter portfolio →'],
    'home.forum.h':['研報庫・最新','研报库・最新','Research Library · Latest'],
    'home.forum.p':['一份研報一個檔案，可全文搜索。','一份研报一个档案，可全文搜索。','One file per report, full-text searchable.'],
    'home.forum.a':['進入論壇搜索全部研報 →','进入论坛搜索全部研报 →','Search the full library →'],
    'home.insights.h':['研究觀點','研究观点','Insights'],
    'home.st.cum17':['累計回報（17 個月）','累计回报（17 个月）','Cumulative Return (17 mo.)'],
    /* ── 研報庫 ── */
    'forum.h1':['研報庫','研报库','Research Library'],
    'forum.p':['一份研報一個檔案：點進去是研報簡介，頁面底部附完整 PDF 原文。可按代號、公司名或主題搜索，或按類型篩選。','一份研报一个档案：点进去是研报简介，页面底部附完整 PDF 原文。可按代号、公司名或主题搜索，或按类型筛选。','One file per report: each entry opens a summary page with the full PDF attached. Search by ticker, name or topic, or filter by genre.'],
    'forum.ph':['搜索研報：0700、騰訊、VaR、均值回歸⋯','搜索研报：0700、腾讯、VaR、均值回归⋯','Search: 0700, Tencent, VaR, mean-reversion…'],
    'forum.noresult':['沒有找到相關研報，換個關鍵詞或類型試試（代號、公司名、主題均可搜索）。','没有找到相关研报，换个关键词或类型试试（代号、公司名、主题均可搜索）。','No matching reports — try another keyword or genre (ticker, name and topic are all searchable).'],
    'g.all':['全部','全部','All'],
    'g.company':['公司研究','公司研究','Company Research'],
    'g.macro':['宏觀研究','宏观研究','Macro Research'],
    'g.quant':['量化研究','量化研究','Quantitative Research'],
    'g.portfolio':['組合研究','组合研究','Portfolio Research'],
    'g.filings':['組合文件','组合文件','Portfolio Filings'],
    'g.other':['其他','其他','Other'],
    'ins.more':['探索更多研究觀點 →','探索更多研究观点 →','Explore more insights →'],
    'ins.arch.h1':['研究觀點・全部','研究观点・全部','Insights · Archive'],
    'ins.arch.small':['觀點檔案','观点档案','Insights Archive'],
    'ins.arch.p':['按時間倒序排列的全部研究觀點與投資隨筆——最新三篇同時展示於研究觀點首頁。','按时间倒序排列的全部研究观点与投资随笔——最新三篇同时展示于研究观点首页。','All insights and investment essays in reverse chronological order - the latest three also appear on the Insights page.'],
    'ins.arch.crumb':['<a href="./">首頁</a> / 研究觀點 / 全部','<a href="./">首页</a> / 研究观点 / 全部','<a href="./">HOME</a> / OUR INSIGHTS / ARCHIVE'],
    /* ── Insights / Filings / About 頁 ── */
    'ins.h1':['研究觀點','研究观点','Insights'],
    'ins.p':['深度個股研報按章節連載：封面先給結論，正文交證據。每篇均含十年維度的收入毛利拆解、可證偽的核心假設，與完整的估值推導。','深度个股研报按章节连载：封面先给结论，正文交证据。每篇均含十年维度的收入毛利拆解、可证伪的核心假设，与完整的估值推导。','Deep-dive equity research, serialized by chapter: conclusions up front, evidence in the body. Each piece includes a decade-scale revenue and margin breakdown, falsifiable core assumptions, and a full valuation derivation.'],
    'fil.h1':['致股東信','致股东信','Shareholder Letters'],
    'fil.p':['三個組合（Yi Capital HK / US / A Share）共用本頁：致股東信、階段性思考與其他 insights 文件，一份文件對應一個 PDF，按時間倒序排列。','三个组合（Yi Capital HK / US / A Share）共用本页：致股东信、阶段性思考与其他 insights 文件，一份文件对应一个 PDF，按时间倒序排列。','Shared by all three portfolios (Yi Capital HK / US / A Share): shareholder letters, interim reflections and other filings — one PDF per document, newest first.'],
    'ab.h1':['關於我們','关于我们','About Us'],
    'coming.title':['','简体中文研报即将上线','English research coming soon'],
    'coming.body':['','目前全部研报以繁体中文提供，简体版本正在整理中，敬请期待。下方列表为繁体原文，欢迎先行阅读。','All research is currently published in Traditional Chinese. English editions are in preparation — stay tuned. The list below is available in the original language.'],
    /* ── 統計標籤 ── */
    'st.cum':['累計回報','累计回报','Cumulative Return'],'st.cum.en':'Cumulative Return',
    'st.ann':['年化收益率','年化收益率','Annualized Return'],'st.ann.en':'Annualized Return',
    'st.vol':['年化波動率','年化波动率','Annualized Volatility'],'st.vol.en':'Annualized Volatility',
    'st.mdd':['最大回撤','最大回撤','Max Drawdown'],'st.mdd.en':'Max Drawdown',
    'st.var':['VaR 95%（日，經驗）','VaR 95%（日，经验）','VaR 95% (daily, empirical)'],'st.var.en':'VaR 95% (daily, empirical)',
    'st.win':['日勝率','日胜率','Daily Win Rate'],'st.win.en':'Daily Win Rate',
    'st.alpha':['年化 Alpha','年化 Alpha','Annualized Alpha'],'st.alpha.en':'Annualized Alpha',
    'st.beta':['Beta','Beta','Beta'],'st.beta.en':'vs Benchmark',
    'st.sharpe':['夏普比率','夏普比率','Sharpe Ratio'],'st.sharpe.en':'Sharpe Ratio',
    'st.sortino':['索提諾比率','索提诺比率','Sortino Ratio'],'st.sortino.en':'Sortino Ratio',
    'st.calmar':['卡瑪比率','卡玛比率','Calmar Ratio'],'st.calmar.en':'Calmar Ratio',
    'st.pl':['盈虧比','盈亏比','Payoff Ratio'],'st.pl.en':'Payoff Ratio',
    'st.cvar':['CVaR 95%（日）','CVaR 95%（日）','CVaR 95% (daily)'],'st.cvar.en':'Expected Shortfall',
    'st.skew':['偏度','偏度','Skewness'],'st.skew.en':'Skewness',
    'st.kurt':['超額峰度','超额峰度','Excess Kurtosis'],'st.kurt.en':'Excess Kurtosis',
    'st.ir':['信息比率','信息比率','Information Ratio'],'st.ir.en':'Information Ratio',
    /* ── 面板標題 ── */
    'pn.equity':['淨值曲線（模擬 $10,000 投入）','净值曲线（模拟 $10,000 投入）','NAV Curve (hypothetical $10,000)'],'pn.equity.en':'NAV Curve',
    'pn.equity.hk':['淨值曲線（模擬 10,000 投入）','净值曲线（模拟 10,000 投入）','NAV Curve (hypothetical 10,000)'],
    'pn.underwater':['水下圖（回撤路徑 Underwater）','水下图（回撤路径 Underwater）','Underwater Chart (drawdown path)'],'pn.underwater.en':'Underwater / Drawdown',
    'pn.heatmap':['月度收益率熱力圖','月度收益率热力图','Monthly Returns Heatmap'],'pn.heatmap.en':'Monthly Returns Heatmap',
    'pn.monthly':['月度收益柱狀圖','月度收益柱状图','Monthly Returns'],'pn.monthly.en':'Monthly Returns',
    'pn.rollvol':['滾動年化波動率（20日窗口）','滚动年化波动率（20日窗口）','Rolling Annualized Volatility (20d)'],'pn.rollvol.en':'Rolling Volatility (20d)',
    'pn.rollsharpe':['滾動夏普比率（20日窗口）','滚动夏普比率（20日窗口）','Rolling Sharpe Ratio (20d)'],'pn.rollsharpe.en':'Rolling Sharpe (20d)',
    'pn.dist':['日收益率分佈 vs 正態擬合','日收益率分布 vs 正态拟合','Daily Return Distribution vs Normal Fit'],'pn.dist.en':'Distribution vs Normal',
    'pn.metrics':['完整指標表','完整指标表','Full Metrics Table'],'pn.metrics.en':'Full Metrics',
    'pn.donut':['持倉市值分佈（環形圖）','持仓市值分布（环形图）','Holdings by Market Value'],'pn.donut.en':'Holdings by Market Value',
    'pn.holdings':['持倉明細','持仓明细','Holdings Detail'],'pn.holdings.en':'Holdings Detail',
    'pn.stacked':['資產構成（現金 vs 持倉市值）','资产构成（现金 vs 持仓市值）','Asset Composition (Cash vs Positions)'],'pn.stacked.en':'Cash vs Positions',
    'pn.unitnav':['每股淨資產走勢（Unit NAV）','每股净资产走势（Unit NAV）','Unit NAV History'],'pn.unitnav.en':'Unit NAV',
    'pn.var':['VaR（日，95/98/99）','VaR（日，95/98/99）','VaR (daily, 95/98/99)'],'pn.var.en':'Normal / Cornish-Fisher / Empirical',
    'pn.var.full':['VaR 多模型對比（日，95/98/99）','VaR 多模型对比（日，95/98/99）','VaR Model Comparison (daily, 95/98/99)'],
    'pn.stress':['蒙特卡洛極端壓力測試（10,000 次歷史 bootstrap）','蒙特卡洛极端压力测试（10,000 次历史 bootstrap）','Monte Carlo Stress Tests (10,000 bootstrap paths)'],'pn.stress.en':'Monte Carlo Stress Tests',
    'pn.skewt':['Skewed-t 極端壓力測試','Skewed-t 极端压力测试','Skewed-t Extreme Stress Tests'],
    /* ── 組合實錄 ── */
    'pf.crumbtitle':['組合實錄','组合实录','Our Portfolios'],
    'pf.intro':['三個獨立運作的個人組合，往下滑動依次為','三个独立运作的个人组合，往下滑动依次为','Three independently run portfolios; scroll for'],
    'pf.intro2':['。每個組合含淨值曲線、Performance / Holdings / Risks / Methodology 檔案分頁；致股東信見 Filings。綠漲紅跌。','。每个组合含净值曲线、Performance / Holdings / Risks / Methodology 档案分页；致股东信见 Filings。绿涨红跌。','. Each portfolio includes its NAV curve and Performance / Holdings / Risks / Methodology tabs; shareholder letters live under Filings. Green = up, red = down.'],
    'pf.fullpage':['完整檔案頁 ↗','完整档案页 ↗','Full Profile ↗'],
    'fund.loading':['正在從淨值表計算','正在从净值表计算','Computing from NAV workbook'],
    'hk.idx':['01 ｜ HKD ｜ 週期均值回歸','01 ｜ HKD ｜ 周期均值回归','01 | HKD | Cyclical Mean-Reversion'],
    'hk.desc':['做港股的週期均值回歸：在情緒與估值的極端處建倉，等待價格向長期均值收斂。高貝塔（beta）、高集中度，以無槓桿與安全邊際換取持有極端波動的資格。回測區間 2025-02-06 → 2026-07-10（357 交易日）。','做港股的周期均值回归：在情绪与估值的极端处建仓，等待价格向长期均值收敛。高贝塔（beta）、高集中度，以无杠杆与安全边际换取持有极端波动的资格。回测区间 2025-02-06 → 2026-07-10（357 交易日）。','Mean-reversion in HK cyclicals: positions built at sentiment and valuation extremes, held until price converges to long-run value. High beta, high concentration — no leverage and a margin of safety buy the right to sit through extreme volatility. Backtest window 2025-02-06 → 2026-07-10 (357 trading days).'],
    'hk.st.cum':['累計回報（HK$10,000 → 約15,100）','累计回报（HK$10,000 → 约15,100）','Cumulative Return (HK$10,000 → ≈15,100)'],
    'hk.st.win':['日勝率（185/357）','日胜率（185/357）','Daily Win Rate (185/357)'],
    'hk.hold.note':['總市值 HK$413,365。盈虧含已實現＋未實現＋股息。0700.HK 為核心週期倉位，詳見〈研究論壇〉深度研報。','总市值 HK$413,365。盈亏含已实现＋未实现＋股息。0700.HK 为核心周期仓位，详见〈研究论坛〉深度研报。','Total market value HK$413,365. P&L includes realized, unrealized and dividends. 0700.HK is the core cyclical position — see the deep-dive report in the Research Forum.'],
    'hk.risknote1':['CVaR（Expected Shortfall）95% = <b>−3.88%</b>。偏度 −0.91（大虧概率顯著高於大盈）、超額峰度 9.04、Student-t 自由度 3.9——<b>極厚尾</b>，4σ 事件概率為正態假設的 272 倍。正態模型低估真實風險約 9%，風控一律採用 Cornish-Fisher / Skewed-t 口徑，並以 GARCH(1,1) 建模條件波動率。','CVaR（Expected Shortfall）95% = <b>−3.88%</b>。偏度 −0.91（大亏概率显著高于大盈）、超额峰度 9.04、Student-t 自由度 3.9——<b>极厚尾</b>，4σ 事件概率为正态假设的 272 倍。正态模型低估真实风险约 9%，风控一律采用 Cornish-Fisher / Skewed-t 口径，并以 GARCH(1,1) 建模条件波动率。','CVaR (Expected Shortfall) 95% = <b>−3.88%</b>. Skewness −0.91 (large losses far likelier than large gains), excess kurtosis 9.04, Student-t df 3.9 — <b>extremely fat-tailed</b>: a 4σ event is 272× more likely than the normal assumption implies. The normal model understates true risk by ~9%; risk controls use Cornish-Fisher / skewed-t throughout, with GARCH(1,1) conditional volatility.'],
    'hk.risknote2':['高貝塔＋高集中度（0700 佔 44.5%）使本組合為三者中尾部風險最高：陰跌半年情景下腰斬概率 100%。無槓桿、無 margin call 是壓測下仍可存活的前提；該倉位結構要求極強的心理承受力。','高贝塔＋高集中度（0700 占 44.5%）使本组合为三者中尾部风险最高：阴跌半年情景下腰斩概率 100%。无杠杆、无 margin call 是压测下仍可存活的前提；该仓位结构要求极强的心理承受力。','High beta plus high concentration (0700 at 44.5%) makes this the highest tail-risk of the three portfolios: in the six-month grind-down scenario the probability of losing half is 100%. No leverage and no margin calls are the precondition for surviving the stress tests; this position structure demands exceptional psychological endurance.'],
    'hk.meth':['週期均值回歸的三個紀律：其一，只在估值與情緒的統計極端處建倉（歷史分位、隱含回報、資金面擁擠度三重確認）；其二，標的必須現金流可驗證、股東回報明確——回歸的錨是內在價值而非價格慣性；其三，無槓桿持倉，用倉位而非止損管理風險，接受深回撤以換取完整的回歸路徑。當前核心倉位 0700.HK 的完整論證見研究論壇的深度研報。','周期均值回归的三个纪律：其一，只在估值与情绪的统计极端处建仓（历史分位、隐含回报、资金面拥挤度三重确认）；其二，标的必须现金流可验证、股东回报明确——回归的锚是内在价值而非价格惯性；其三，无杠杆持仓，用仓位而非止损管理风险，接受深回撤以换取完整的回归路径。当前核心仓位 0700.HK 的完整论证见研究论坛的深度研报。','Three disciplines of cyclical mean-reversion: first, build positions only at statistical extremes of valuation and sentiment (triple-confirmed by historical percentile, implied return and crowding); second, holdings must have verifiable cash flow and clear shareholder returns — the anchor of reversion is intrinsic value, not price momentum; third, hold unlevered, manage risk with position size rather than stop-losses, and accept deep drawdowns in exchange for the full reversion path. The full thesis on the core 0700.HK position is in the Research Forum.'],
    'a.idx':['03 ｜ CNY ｜ 長期持有','03 ｜ CNY ｜ 长期持有','03 | CNY | Long-Term Ownership'],
    'a.desc':['A股優質資產的長期持有：聚焦競爭格局清晰、自由現金流充沛的龍頭，換手極低、以年為單位計倉，用時間換取複利。回測區間 2025-01-07 → 2026-07-10（377 交易日）。','A股优质资产的长期持有：聚焦竞争格局清晰、自由现金流充沛的龙头，换手极低、以年为单位计仓，用时间换取复利。回测区间 2025-01-07 → 2026-07-10（377 交易日）。','Long-term ownership of quality A-shares: leaders with clear competitive structure and abundant free cash flow; minimal turnover, positions measured in years, compounding bought with time. Backtest window 2025-01-07 → 2026-07-10 (377 trading days).'],
    'a.st.cum':['累計回報（¥10,000 → 約12,200）','累计回报（¥10,000 → 约12,200）','Cumulative Return (¥10,000 → ≈12,200)'],
    'a.st.win':['日勝率（177/377）','日胜率（177/377）','Daily Win Rate (177/377)'],
    'a.hold.note':['總市值 ¥644,048。盈虧含已實現＋未實現＋股息。','总市值 ¥644,048。盈亏含已实现＋未实现＋股息。','Total market value ¥644,048. P&L includes realized, unrealized and dividends.'],
    'a.risknote1':['CVaR 95% = <b>−1.98%</b>。偏度 −0.32（近似對稱、輕微左尾）、超額峰度 2.87、Student-t 自由度 6.4——溫和厚尾。VaR 回測：317 個滾動樣本實際突破 19 次 vs 預期 16 次（1.2 倍），模型基本可用。','CVaR 95% = <b>−1.98%</b>。偏度 −0.32（近似对称、轻微左尾）、超额峰度 2.87、Student-t 自由度 6.4——温和厚尾。VaR 回测：317 个滚动样本实际突破 19 次 vs 预期 16 次（1.2 倍），模型基本可用。','CVaR 95% = <b>−1.98%</b>. Skewness −0.32 (roughly symmetric, mild left tail), excess kurtosis 2.87, Student-t df 6.4 — moderately fat-tailed. VaR backtest: 19 actual breaches vs 16 expected across 317 rolling samples (1.2×) — the model is serviceable.'],
    'a.risknote2':['低換手、龍頭分散（9 只、單一行業不超三成）令極端情景下回撤顯著低於 HK 組合；最大單次回撤期 184 天（2026 上半年，尚未修復），長期持有策略以時間而非止損消化波動。','低换手、龙头分散（9 只、单一行业不超三成）令极端情景下回撤显著低于 HK 组合；最大单次回撤期 184 天（2026 上半年，尚未修复），长期持有策略以时间而非止损消化波动。','Low turnover and diversified leaders (9 names, no single sector above 30%) keep extreme-scenario drawdowns well below the HK book; the longest drawdown spell is 184 days (H1 2026, not yet recovered). The long-hold strategy digests volatility with time, not stop-losses.'],
    'a.meth':['選股三問：生意是否足夠好（ROE 持續性與自由現金流）、格局是否足夠清（份額集中且對手理性）、價格是否足夠低（以十年持有期倒算的隱含回報）。買入後以年報為單位跟蹤，賣出只有三個理由——邏輯被證偽、估值透支十年、出現顯著更優的機會。銀行股息倉（招行、成銀、江銀）提供組合的現金流底座，消費與製造龍頭提供成長期權。','选股三问：生意是否足够好（ROE 持续性与自由现金流）、格局是否足够清（份额集中且对手理性）、价格是否足够低（以十年持有期倒算的隐含回报）。买入后以年报为单位跟踪，卖出只有三个理由——逻辑被证伪、估值透支十年、出现显著更优的机会。银行股息仓（招行、成银、江银）提供组合的现金流底座，消费与制造龙头提供成长期权。','Three questions before buying: is the business good enough (ROE durability and free cash flow), is the structure clear enough (concentrated share, rational competitors), is the price low enough (implied return over a ten-year holding period)? Positions are tracked by annual report; there are only three reasons to sell — the thesis is falsified, valuation borrows a decade of growth, or a clearly better opportunity appears. Bank dividend positions (CMB, Chengdu Bank, Jiangsu Bank) form the cash-flow base; consumer and manufacturing leaders provide the growth option.'],
    'us.idx':['02 ｜ USD ｜ 多資產配置','02 ｜ USD ｜ 多资产配置','02 | USD | Multi-Asset Allocation'],
    'us.desc':['多資產配置的美金組合：股票、久期（duration）、黃金與短債的風險平衡，以厚尾（fat-tail）與壓力測試框架管理回撤，追求全天候的風險調整後回報。本板塊全部數字與圖表由淨值表（Excel）即時計算——','多资产配置的美金组合：股票、久期（duration）、黄金与短债的风险平衡，以厚尾（fat-tail）与压力测试框架管理回撤，追求全天候的风险调整后回报。本板块全部数字与图表由净值表（Excel）实时计算——','A multi-asset USD portfolio: risk balanced across equities, duration, gold and short-term bonds, with fat-tail and stress-testing frameworks governing drawdowns, pursuing all-weather risk-adjusted returns. Every number and chart in this section is computed live from the NAV workbook — '],
    'us.desc.a':['進入完整檔案頁','进入完整档案页','open the full profile'],
    'us.desc.b':['看全部 14 張圖。','看全部 14 张图。','for all 14 charts.'],
    /* ── 動態注釋模板 ── */
    'n.period':['數據截至 {end}（{days} 交易日，自動更新）。','数据截至 {end}（{days} 交易日，自动更新）。','Data through {end} ({days} trading days, auto-updated).'],
    'n.holdnote':['總市值 ${v}。盈虧含已實現＋未實現＋股息（全歷史口徑）。','总市值 ${v}。盈亏含已实现＋未实现＋股息（全历史口径）。','Total market value ${v}. P&L includes realized, unrealized and dividends (full history).'],
    'n.varnote':['偏度 {s}、超額峰度 {k}；99% 置信下 Cornish-Fisher 口徑 {cf} vs 正態 {n}。','偏度 {s}、超额峰度 {k}；99% 置信下 Cornish-Fisher 口径 {cf} vs 正态 {n}。','Skewness {s}, excess kurtosis {k}; at 99% confidence, Cornish-Fisher {cf} vs normal {n}.'],
    /* ── 圖表內部 ── */
    'ch.ticker':['代號','代号','Ticker'],'ch.weight':['權重','权重','Weight'],'ch.mv':['市值','市值','Mkt Value'],
    'ch.pnl':['總盈虧','总盈亏','Total P&L'],'ch.expret':['敞口收益率','敞口收益率','Exposure Return'],
    'ch.cl':['置信水平','置信水平','Confidence'],'ch.varn':['VaR 正態','VaR 正态','VaR Normal'],
    'ch.varcf':['VaR Cornish-Fisher','VaR Cornish-Fisher','VaR Cornish-Fisher'],'ch.vare':['VaR 經驗','VaR 经验','VaR Empirical'],
    'ch.cvar':['CVaR（ES）','CVaR（ES）','CVaR (ES)'],
    'ch.scen':['壓力場景','压力场景','Scenario'],'ch.dur':['持續','持续','Horizon'],
    'ch.p50':['P50 終值','P50 终值','P50 Terminal'],'ch.p5':['P5 終值','P5 终值','P5 Terminal'],'ch.p1':['P1 終值','P1 终值','P1 Terminal'],
    'ch.half':['腰斬概率','腰斩概率','P(−50%)'],'ch.day':['天','天','d'],
    'ch.total':['總市值','总市值','Total MV'],
    'ch.cash':['現金餘額（負值＝結算/融資）','现金余额（负值＝结算/融资）','Cash (negative = settlement/financing)'],
    'ch.pos':['持倉市值（頂線＝總資產）','持仓市值（顶线＝总资产）','Positions (top line = total assets)'],
    'ch.normfit':['正態擬合','正态拟合','Normal fit'],'ch.posday':['正收益日','正收益日','Up days'],'ch.negday':['負收益日','负收益日','Down days'],
    'ch.updown':['綠漲紅跌；色深對應幅度。','绿涨红跌；色深对应幅度。','Green = gains, red = losses; intensity scales with magnitude.'],
    'ch.updown2':['綠漲紅跌；色深對應幅度。由淨值表逐日複利計算。','绿涨红跌；色深对应幅度。由净值表逐日复利计算。','Green = gains, red = losses; intensity scales with magnitude. Compounded daily from the NAV workbook.'],
    'ch.nodata':['無數據','无数据','No data'],
    'ch.dd':['回撤','回撤','Drawdown'],
    'sc.crash':['Black Swan Crash（10天，1%分位）','Black Swan Crash（10天，1%分位）','Black Swan Crash (10d, 1st pct.)'],
    'sc.bear':['Prolonged Bear（21天，5%分位）','Prolonged Bear（21天，5%分位）','Prolonged Bear (21d, 5th pct.)'],
    'sc.grind':['Slow Grind Down（126天，負收益均值）','Slow Grind Down（126天，负收益均值）','Slow Grind Down (126d, negative drift)'],
    'mon':['{n}月','{n}月','M{n}'],
  };

  const LANGS = ['tw', 'cn', 'en'];
  // 物理平行站點：語言僅由頁面注入的 YC_LANG 或 URL 目錄決定
  let lang = window.YC_LANG
    || (/\/cn\//.test(location.pathname) ? 'cn' : /\/en\//.test(location.pathname) ? 'en' : 'tw');
  if (LANGS.indexOf(lang) < 0) lang = 'tw';
  const idx = { tw: 0, cn: 1, en: 2 }[lang];

  function t(key) {
    const v = D[key];
    if (v == null) return key;
    if (typeof v === 'string') return v;
    return v[idx] || v[0];
  }
  function f(key, vars) {
    let s = t(key);
    Object.keys(vars || {}).forEach(k => { s = s.split('{' + k + '}').join(vars[k]); });
    return s;
  }
  function lbl(key) {
    if (lang === 'en') return t(key);
    const en = D[key + '.en'] || (D[key] && D[key][2]) || '';
    return t(key) + (en && en !== t(key) ? '<span class="lbl-en">' + en + '</span>' : '');
  }
  // 目錄制平行站點：/ = 繁體, /cn/ = 简体, /en/ = English
  function pageTarget(l) {
    const parts = location.pathname.split('/').filter(Boolean);
    let file = (parts[parts.length - 1] || '').replace(/\.html$/, '');
    const TRIPLED = ['index','portfolios','fund-us','insights','insights-archive','forum','filings','about','login','terms'];
    const TRIPLED_POSTS = ['tencent-0700-ch12','yicapital-risk-report','great-company-great-investment'];
    const root = (l === 'tw' ? '/' : '/' + l + '/');
    if (parts.indexOf('posts') >= 0) {
      return TRIPLED_POSTS.indexOf(file) >= 0 ? root + 'posts/' + file + location.hash : root;
    }
    if (!file || file === 'index' || TRIPLED.indexOf(file) < 0) return root + location.hash;
    return root + file + location.hash;
  }
  window.YCI = { lang, t, f, lbl, set: l => { localStorage.setItem('yc-lang', l); location.href = pageTarget(l); } };

  const css = document.createElement('style');
  css.textContent = '.lbl-en{display:block;font-size:.82em;opacity:.55;letter-spacing:.4px;font-family:"IBM Plex Mono",monospace;margin-top:2px}'
    + '.yc-lang{display:inline-flex;gap:2px;margin-left:16px;font-family:"IBM Plex Mono",monospace;font-size:11.5px;vertical-align:middle}'
    + '.yc-lang a{color:#5f6f85;text-decoration:none;padding:3px 7px;border-radius:5px;cursor:pointer}'
    + '.yc-lang a:hover{color:#22d3ee}.yc-lang a.on{color:#22d3ee;background:rgba(34,211,238,.1)}'
    + '.yc-coming{border:1px solid #1a2436;border-left:3px solid #22d3ee;border-radius:8px;padding:18px 22px;margin:0 0 26px;background:rgba(34,211,238,.04)}'
    + '.yc-coming b{color:#e8edf5;display:block;margin-bottom:6px;font-size:15.5px}'
    + '.yc-coming p{color:#8b98ab;font-size:13.5px;line-height:1.9;margin:0}';
  document.head.appendChild(css);

  function mount() {
    const nav = document.querySelector('header .nav');
    if (nav && !document.querySelector('.yc-lang')) {
      const box = document.createElement('div');
      box.className = 'yc-lang';
      box.innerHTML = [['tw', '繁'], ['cn', '简'], ['en', 'EN']].map(x =>
        '<a data-l="' + x[0] + '" class="' + (x[0] === lang ? 'on' : '') + '">' + x[1] + '</a>').join('');
      box.addEventListener('click', e => { const l = e.target.dataset && e.target.dataset.l; if (l) YCI.set(l); });
      nav.appendChild(box);
    }
    // 文本已按語言烘焙進各目錄頁面，運行時不再改寫 DOM
    document.dispatchEvent(new CustomEvent('yci-ready'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
