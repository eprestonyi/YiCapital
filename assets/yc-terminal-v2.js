(function () {
  'use strict';

  const body = document.body;
  const searchInput = document.querySelector('#terminal-search');
  const searchResults = document.querySelector('#terminal-search-results');
  const workspaceTabs = document.querySelector('#terminal-workspace-tabs');
  const functionTabs = document.querySelector('#terminal-function-tabs');
  const contextBar = document.querySelector('#terminal-context');
  const canvas = document.querySelector('#terminal-canvas');
  const statusbar = document.querySelector('#terminal-statusbar');
  const alertBox = document.querySelector('#terminal-alert');
  const yearSelect = document.querySelector('#terminal-year');

  if (!body || !searchInput || !searchResults || !workspaceTabs || !functionTabs ||
      !contextBar || !canvas || !statusbar || !alertBox) return;

  const language = ['tw', 'cn', 'en'].includes(body.dataset.terminalLang)
    ? body.dataset.terminalLang
    : 'tw';
  const locale = language === 'en' ? 'en-US' : language === 'cn' ? 'zh-CN' : 'zh-HK';
  const apiBase = String(window.YC_API || window.location.origin).replace(/\/+$/, '');

  const ENDPOINTS = Object.freeze({
    bootstrap: '/api/terminal/bootstrap',
    search: '/api/terminal/search',
    market: '/api/terminal/market',
    news: '/api/terminal/news',
    quote: '/api/terminal/quote',
    history: '/api/terminal/history',
    stockDetail: '/api/terminal/stock-detail',
    status: '/api/terminal/status'
  });

  const t3 = (tw, cn, en) => ({ tw, cn, en });
  const localize = (value) => {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    return String(value[language] || value.en || value.cn || value.tw || '');
  };

  const COPY = {
    loading: t3('正在讀取資料…', '正在读取数据…', 'Loading data…'),
    unavailableTitle: t3('資料不可用', '数据不可用', 'Data unavailable'),
    unavailableBody: t3(
      '此功能已停止渲染；不會以樣本、舊值或零替代失敗資料。',
      '此功能已停止渲染；不会以样本、旧值或零替代失败数据。',
      'Rendering stopped for this function. Failed data is never replaced with samples, old values or zero.'
    ),
    searchUnavailable: t3('搜尋服務不可用', '搜索服务不可用', 'Search service unavailable'),
    searchEmpty: t3('找不到相符的市場、證券或功能。', '找不到匹配的市场、证券或功能。', 'No matching market, security or function.'),
    searchHint: t3('搜尋公司、代號或功能', '搜索公司、代码或功能', 'Search a company, ticker or function'),
    selectSecurity: t3(
      '先用上方命令列搜尋並選擇一項證券。',
      '请先使用上方命令栏搜索并选择一项证券。',
      'Search for and select a security from the command bar first.'
    ),
    source: t3('來源', '来源', 'Source'),
    freshness: t3('新鮮度', '新鲜度', 'Freshness'),
    permission: t3('權限', '权限', 'Permission'),
    endpoint: t3('端點', '端点', 'Endpoint'),
    asOf: t3('截至', '截至', 'As of'),
    noRows: t3('端點沒有返回可發布的記錄。', '端点没有返回可发布的记录。', 'The endpoint returned no publishable records.'),
    notPublished: t3(
      '功能入口已建立，但專用資料集或計算尚未通過發布門禁；不會以其他資料表代替。',
      '功能入口已建立，但专用数据集或计算尚未通过发布门禁；不会以其他数据表代替。',
      'The function is registered, but its dedicated dataset or calculation has not passed the publication gate. No unrelated dataset is substituted.'
    ),
    partial: t3('WAREHOUSE PARTIAL', 'WAREHOUSE PARTIAL', 'WAREHOUSE PARTIAL'),
    partialBody: t3(
      'Warehouse Atlas 目前只發布已核驗的 Supply／FA 範圍，不代表全市場覆蓋；缺失資料不會以樣本或零補齊。',
      'Warehouse Atlas 目前只发布已核验的 Supply／FA 范围，不代表全市场覆盖；缺失数据不会以样本或零补齐。',
      'Warehouse Atlas currently publishes only verified Supply / FA coverage. It is not full-market coverage, and missing data is never filled with samples or zero.'
    ),
    functionDirectory: t3('功能目錄', '功能目录', 'Function directory'),
    overview: t3('總覽', '总览', 'Overview'),
    status: t3('資料狀態', '数据状态', 'Data status'),
    refresh: t3('重新整理', '刷新', 'Refresh'),
    latest: t3('最新', '最新', 'Latest'),
    value: t3('數值', '数值', 'Value'),
    date: t3('日期', '日期', 'Date'),
    company: t3('公司', '公司', 'Company'),
    category: t3('類別', '类别', 'Category'),
    role: t3('角色', '角色', 'Role'),
    upstream: t3('上游／供應商', '上游／供应商', 'Upstream / suppliers'),
    focal: t3('焦點公司', '焦点公司', 'Focal company'),
    tob: t3('ToB 下游', 'ToB 下游', 'ToB downstream'),
    toc: t3('ToC／終端需求', 'ToC／终端需求', 'ToC / end demand'),
    noRelations: t3('此年度沒有已發布關係。', '该年度没有已发布关系。', 'No relationships are published for this year.'),
    evidence: t3('證據', '证据', 'Evidence'),
    amountUnknown: t3('關係存在不代表已知金額', '关系存在不代表已知金额', 'A relationship does not imply a known amount'),
    canonicalYear: t3('標準年度', '标准年度', 'Canonical year'),
    reportedYear: t3('實際財年', '实际财年', 'Reported fiscal year'),
    period: t3('實際期間', '实际期间', 'Actual period'),
    metric: t3('科目', '科目', 'Metric'),
    method: t3('方法', '方法', 'Method'),
    networkKeyboard: t3('可用 Tab 聚焦節點，Enter 打開 X-Ray。', '可用 Tab 聚焦节点，Enter 打开 X-Ray。', 'Tab to a node and press Enter to open X-Ray.'),
    news: t3('市場新聞', '市场新闻', 'Market News'),
    all: t3('全部', '全部', 'All'),
    storyUnavailable: t3('選擇一則新聞查看內容。', '选择一则新闻查看内容。', 'Select a story to inspect it.'),
    bootstrapFailed: t3(
      'Terminal 控制面無法完成初始化；各資料端點仍會獨立 fail closed。',
      'Terminal 控制面无法完成初始化；各数据端点仍会独立 fail closed。',
      'The Terminal control plane could not initialize. Each data endpoint will still fail closed independently.'
    ),
    terminalHome: t3('易終端首頁', '易终端首页', 'Terminal Home'),
    dailyDesk: t3('每日市場綜合屏', '每日市场综合屏', 'Daily Market Desk'),
    dailyDeskBody: t3(
      '新聞與市場資料按來源時間更新；沒有可核驗資料的面板會明確停止顯示。',
      '新闻与市场数据按来源时间更新；没有可核验数据的面板会明确停止显示。',
      'News and market panels update to their source timestamps. Panels without verified data stop explicitly.'
    ),
    sevenDesks: t3('七大綜合工作台', '七大综合工作台', 'Seven integrated desks'),
    openDesk: t3('打開綜合屏', '打开综合屏', 'Open dashboard'),
    securitySearch: t3('搜尋 A／H／美股後進入公司工作台', '搜索 A／H／美股后进入公司工作台', 'Search A/H/US equities to open a company workspace'),
    records: t3('筆可發布記錄', '条可发布记录', 'publishable records'),
    dashboard: t3('綜合屏', '综合屏', 'Dashboard'),
    chartSource: t3('圖表只使用目前端點返回的可核驗記錄', '图表只使用当前端点返回的可核验记录', 'Charts use only verifiable rows returned by the active endpoint'),
    atlasMode: t3('星雲網絡', '星云网络', 'Nebula network'),
    highwayMode: t3('產業高速公路', '产业高速公路', 'Supply highway')
  };

  const workspace = (id, code, name, description, functions) => ({
    id, code, name, description, functions
  });
  const fn = (id, code, name, description, loader, options) => ({
    id, code, name, description, loader, ...(options || {})
  });

  const WORKSPACES = [
    workspace('market', 'MKT', t3('市場', '市场', 'Market'), t3(
      '全球市場、新聞、指數、輪動與日曆',
      '全球市场、新闻、指数、轮动与日历',
      'Global markets, news, indices, rotation and calendars'
    ), [
      fn('overview', 'NEWS', t3('市場新聞', '市场新闻', 'Market News'), t3('市場快照與最新新聞流', '市场快照与最新新闻流', 'Market tape and latest news flow'), 'market-news'),
      fn('indices', 'WEI', t3('全球指數', '全球指数', 'World Indices'), t3('主要股票與跨資產指數', '主要股票与跨资产指数', 'Major equity and cross-asset indices'), 'market'),
      fn('movers', 'MOST', t3('市場異動', '市场异动', 'Market Movers'), t3('領漲、領跌與成交異動', '领涨、领跌与成交异动', 'Leaders, laggards and volume anomalies'), 'unavailable'),
      fn('sectors', 'SECF', t3('板塊表現', '板块表现', 'Sector Performance'), t3('產業輪動與相對強弱', '行业轮动与相对强弱', 'Industry rotation and relative strength'), 'unavailable'),
      fn('breadth', 'MBRD', t3('市場寬度', '市场宽度', 'Market Breadth'), t3('漲跌家數與市場內部結構', '涨跌家数与市场内部结构', 'Advancers, decliners and market internals'), 'unavailable'),
      fn('cross-asset', 'MA', t3('跨資產監察', '跨资产监测', 'Cross-Asset Monitor'), t3('股票、利率、外匯與商品', '股票、利率、外汇与商品', 'Equities, rates, currencies and commodities'), 'unavailable'),
      fn('calendar', 'ECO', t3('經濟日曆', '经济日历', 'Economic Calendar'), t3('宏觀發布與市場事件', '宏观发布与市场事件', 'Macro releases and market events'), 'unavailable'),
      fn('status', 'DATA', COPY.status, t3('端點、權限與新鮮度', '端点、权限与新鲜度', 'Endpoints, entitlements and freshness'), 'status')
    ]),
    workspace('stocks', 'EQT', t3('股票', '股票', 'Stocks'), t3(
      '公司描述、行情、FA、估值與持有人',
      '公司描述、行情、FA、估值与持有人',
      'Company description, pricing, FA, valuation and ownership'
    ), [
      fn('overview', 'DES', t3('公司描述', '公司描述', 'Security Description'), t3('公司、上市與分類資料', '公司、上市与分类数据', 'Company, listing and classification data'), 'detail', { requiresSecurity: true }),
      fn('news', 'CN', t3('公司新聞', '公司新闻', 'Company News'), t3('公司新聞、公告與催化', '公司新闻、公告与催化', 'Company news, filings and catalysts'), 'news', { requiresSecurity: true }),
      fn('research', 'RES', t3('研究庫', '研究库', 'Research'), t3('研報、觀點、催化與反證', '研报、观点、催化与反证', 'Research, catalysts and disconfirming evidence'), 'warehouse-module', { requiresSecurity: true, warehouseKey: 'research' }),
      fn('financials', 'FA', t3('財務分析', '财务分析', 'Financial Analysis'), t3('標準年度四表與方法狀態', '标准年度四表与方法状态', 'Four statements by canonical year with method status'), 'fa', { requiresSecurity: true }),
      fn('model', 'MODL', t3('財務模型', '财务模型', 'Financial Model'), t3('假設、驅動因子、三表與情景', '假设、驱动因素、三表与情景', 'Assumptions, drivers, statements and scenarios'), 'warehouse-module', { requiresSecurity: true, warehouseKey: 'model' }),
      fn('supply-chain', 'SPLC', t3('供應鏈', '供应链', 'Supply Chain'), t3('供應商、ToB 與終端需求', '供应商、ToB 与终端需求', 'Suppliers, ToB and end-market demand'), 'warehouse-module', { requiresSecurity: true, warehouseKey: 'supply' }),
      fn('quote', 'Q', t3('即時報價', '实时报价', 'Quote Monitor'), t3('最新價、漲跌與成交', '最新价、涨跌与成交', 'Latest price, change and trading activity'), 'quote', { requiresSecurity: true }),
      fn('chart', 'GP', t3('價格圖表', '价格图表', 'Price & Volume'), t3('可追溯歷史價格與成交量', '可追溯历史价格与成交量', 'Traceable price and volume history'), 'history', { requiresSecurity: true }),
      fn('price-history', 'HP', t3('歷史價格', '历史价格', 'Historical Price'), t3('按標準年度查看日線歷史', '按标准年度查看日线历史', 'Daily history by canonical year'), 'history', { requiresSecurity: true }),
      fn('valuation', 'VAL', t3('估值', '估值', 'Valuation'), t3('市場倍數、歷史區間與口徑', '市场倍数、历史区间与口径', 'Market multiples, history and methodology'), 'valuation', { requiresSecurity: true }),
      fn('estimates', 'EE', t3('盈利預測', '盈利预测', 'Earnings Estimates'), t3('一致預期、修正與差異', '一致预期、修正与差异', 'Consensus, revisions and dispersion'), 'warehouse-module', { requiresSecurity: true, warehouseKey: 'estimates' }),
      fn('ownership', 'OWN', t3('持有人', '持有人', 'Ownership'), t3('股東、機構與內部人', '股东、机构与内部人', 'Shareholders, institutions and insiders'), 'warehouse-module', { requiresSecurity: true, warehouseKey: 'ownership' }),
      fn('events', 'EVT', t3('公司事件', '公司事件', 'Corporate Events'), t3('財報、股息與行動日曆', '财报、股息与行动日历', 'Earnings, dividends and action calendar'), 'warehouse-module', { requiresSecurity: true, warehouseKey: 'events' }),
      fn('vwap', 'VWAP', t3('成交均價', '成交均价', 'VWAP'), t3('分鐘價量與成交均價', '分钟价量与成交均价', 'Intraday price-volume and volume-weighted price'), 'unavailable', { requiresSecurity: true }),
      fn('avat', 'AVAT', t3('成交量分析', '成交量分析', 'Average Volume at Time'), t3('按時間與歷史成交量檢視', '按时间与历史成交量查看', 'Time-of-day and historical volume analysis'), 'unavailable', { requiresSecurity: true })
    ]),
    workspace('debt', 'FI', t3('債券', '债券', 'Debt'), t3(
      '主權債、信用、曲線、利差與可轉債',
      '主权债、信用、曲线、利差与可转债',
      'Sovereign, credit, curves, spreads and convertibles'
    ), [
      fn('overview', 'FIW', t3('債券總覽', '债券总览', 'Debt Monitor'), t3('收益率、利差與發行概況', '收益率、利差与发行概况', 'Yields, spreads and issuance overview'), 'market'),
      fn('sovereign', 'WB', t3('主權債券', '主权债券', 'Government Bonds'), t3('主要國家利率與期限', '主要国家利率与期限', 'Major sovereign rates and maturities'), 'market'),
      fn('curves', 'YCRV', t3('收益率曲線', '收益率曲线', 'Yield Curves'), t3('即期、到期與曲線形態', '即期、到期与曲线形态', 'Spot, maturity and curve shape'), 'market'),
      fn('credit', 'CRVF', t3('信用市場', '信用市场', 'Credit Monitor'), t3('評級、行業與信用利差', '评级、行业与信用利差', 'Ratings, sectors and credit spreads'), 'unavailable'),
      fn('spreads', 'SPRD', t3('利差矩陣', '利差矩阵', 'Spread Matrix'), t3('期限與信用風險溢價', '期限与信用风险溢价', 'Term and credit risk premia'), 'unavailable'),
      fn('convertibles', 'CB', t3('可轉債', '可转债', 'Convertibles'), t3('價格、轉股價與溢價率', '价格、转股价与溢价率', 'Price, conversion terms and premium'), 'market'),
      fn('issuance', 'NIM', t3('新債發行', '新债发行', 'New Issues'), t3('發行、到期與贖回安排', '发行、到期与赎回安排', 'Issuance, maturities and redemptions'), 'market'),
      fn('calendar', 'DTC', t3('債券日曆', '债券日历', 'Debt Calendar'), t3('付息、到期與評級事件', '付息、到期与评级事件', 'Coupon, maturity and rating events'), 'market'),
      fn('status', 'DATA', COPY.status, t3('資料權限與更新口徑', '数据权限与更新口径', 'Entitlements and update policy'), 'status')
    ]),
    workspace('supply', 'SPLC', t3('供應鏈', '供应链', 'Supply Chain'), t3(
      'AI 算力產業鏈、星雲與公司 X-Ray',
      'AI 算力产业链、星云与公司 X-Ray',
      'AI compute value chain, network and company X-Ray'
    ), [
      fn('overview', 'MAP', t3('產業地圖', '产业地图', 'Industry Map'), t3('由物理底座到 AI 需求', '从物理底座到 AI 需求', 'From physical base to AI demand'), 'atlas'),
      fn('chain', 'CHAIN', t3('左右產業鏈', '左右产业链', 'Left-to-Right Chain'), t3('按產業層展示公司與類別', '按产业层展示公司与类别', 'Companies and categories arranged by layer'), 'atlas'),
      fn('network', 'NET', t3('全局星雲', '全局星云', 'Global Network'), t3('跨產業群集與關係網', '跨产业群集与关系网', 'Cross-industry clusters and relationships'), 'atlas'),
      fn('xray', 'XRAY', t3('公司 X-Ray', '公司 X-Ray', 'Company X-Ray'), t3('上游、ToB、ToC 與證據', '上游、ToB、ToC 与证据', 'Upstream, ToB, ToC and evidence'), 'atlas'),
      fn('flows', 'FLOW', t3('會計 Flow', '会计 Flow', 'Accounting Flow'), t3('營收、成本、費用與營業利潤', '营收、成本、费用与营业利润', 'Revenue, cost, opex and operating income'), 'atlas'),
      fn('evidence', 'EVD', t3('關係證據', '关系证据', 'Evidence Ledger'), t3('年度化來源與關係狀態', '年度化来源与关系状态', 'Year-scoped sources and relationship status'), 'atlas'),
      fn('coverage', 'COV', t3('覆蓋與隊列', '覆盖与队列', 'Coverage & Queue'), t3('分母、缺口與 Agent 隊列', '分母、缺口与 Agent 队列', 'Denominators, gaps and Agent queue'), 'atlas'),
      fn('status', 'DATA', COPY.status, t3('發布門禁與資料血緣', '发布门禁与数据血缘', 'Release gates and lineage'), 'atlas')
    ]),
    workspace('etf', 'ETF', t3('ETF', 'ETF', 'ETF'), t3(
      'ETF 行情、持倉、流量與折溢價',
      'ETF 行情、持仓、流量与折溢价',
      'ETF pricing, holdings, flows and premium/discount'
    ), [
      fn('overview', 'ETF', t3('ETF 總覽', 'ETF 总览', 'ETF Dashboard'), t3('市場規模、成交與分類', '市场规模、成交与分类', 'Market size, trading and classifications'), 'market'),
      fn('screener', 'SRCH', t3('ETF 篩選器', 'ETF 筛选器', 'ETF Screener'), t3('按資產、費率與流動性篩選', '按资产、费率与流动性筛选', 'Screen by asset, fee and liquidity'), 'market'),
      fn('quote', 'Q', t3('ETF 報價', 'ETF 报价', 'ETF Quote'), t3('最新價、IOPV 與成交', '最新价、IOPV 与成交', 'Latest price, IOPV and trading'), 'quote', { requiresSecurity: true }),
      fn('chart', 'GP', t3('價格圖表', '价格图表', 'Price & Volume'), t3('歷史價格、成交與淨值', '历史价格、成交与净值', 'Historical price, volume and NAV'), 'history', { requiresSecurity: true }),
      fn('holdings', 'HOLD', t3('持倉', '持仓', 'Holdings'), t3('成分、權重與集中度', '成分、权重与集中度', 'Constituents, weights and concentration'), 'unavailable', { requiresSecurity: true }),
      fn('flows', 'FL', t3('份額與資金流', '份额与资金流', 'Shares & Flows'), t3('份額、規模與估算流量', '份额、规模与估算流量', 'Shares, assets and estimated flows'), 'market'),
      fn('premium', 'PREM', t3('折溢價', '折溢价', 'Premium / Discount'), t3('價格相對 IOPV／NAV', '价格相对 IOPV／NAV', 'Price versus IOPV / NAV'), 'unavailable'),
      fn('composition', 'COMP', t3('籃子組合', '篮子组合', 'Creation Basket'), t3('申贖籃子與現金替代', '申赎篮子与现金替代', 'Creation basket and cash substitution'), 'unavailable', { requiresSecurity: true }),
      fn('status', 'DATA', COPY.status, t3('實時與日頻權限', '实时与日频权限', 'Real-time and EOD entitlements'), 'status')
    ]),
    workspace('derivatives', 'DERI', t3('衍生品', '衍生品', 'Derivatives'), t3(
      '期貨、期權、波動率與持倉',
      '期货、期权、波动率与持仓',
      'Futures, options, volatility and positioning'
    ), [
      fn('overview', 'DERI', t3('衍生品總覽', '衍生品总览', 'Derivatives Monitor'), t3('主要合約、波動率與風險', '主要合约、波动率与风险', 'Key contracts, volatility and risk'), 'market'),
      fn('futures', 'CT', t3('期貨合約', '期货合约', 'Futures Contracts'), t3('主力、連續與到期合約', '主力、连续与到期合约', 'Active, continuous and expiring contracts'), 'market'),
      fn('options', 'OMON', t3('期權監察', '期权监测', 'Option Monitor'), t3('履約價、期限、價格與成交', '行权价、期限、价格与成交', 'Strikes, maturities, prices and volume'), 'market'),
      fn('volatility', 'OV', t3('波動率', '波动率', 'Volatility'), t3('歷史與隱含波動率', '历史与隐含波动率', 'Historical and implied volatility'), 'unavailable'),
      fn('term-structure', 'TS', t3('期限結構', '期限结构', 'Term Structure'), t3('升水、貼水與期限價差', '升水、贴水与期限价差', 'Contango, backwardation and calendar spreads'), 'unavailable'),
      fn('open-interest', 'OI', t3('未平倉量', '未平仓量', 'Open Interest'), t3('持倉變化與集中度', '持仓变化与集中度', 'Position changes and concentration'), 'market'),
      fn('positioning', 'COT', t3('市場持倉', '市场持仓', 'Positioning'), t3('會員排名與多空結構', '会员排名与多空结构', 'Member rankings and long/short structure'), 'market'),
      fn('quote', 'Q', t3('合約報價', '合约报价', 'Contract Quote'), t3('指定合約最新報價', '指定合约最新报价', 'Latest quote for a selected contract'), 'quote', { requiresSecurity: true }),
      fn('chart', 'GP', t3('合約圖表', '合约图表', 'Contract Chart'), t3('指定合約歷史行情', '指定合约历史行情', 'History for a selected contract'), 'history', { requiresSecurity: true }),
      fn('status', 'DATA', COPY.status, t3('分鐘與實時權限', '分钟与实时权限', 'Minute and real-time entitlements'), 'status')
    ]),
    workspace('money', 'FX', t3('貨幣與外匯', '货币与外汇', 'Money & Currency'), t3(
      '外匯、利率、央行、流動性與貨幣供應',
      '外汇、利率、央行、流动性与货币供应',
      'FX, rates, central banks, liquidity and money supply'
    ), [
      fn('overview', 'FXC', t3('貨幣總覽', '货币总览', 'Money & Currency'), t3('主要匯率、利率與流動性', '主要汇率、利率与流动性', 'Key currencies, rates and liquidity'), 'unavailable'),
      fn('fx', 'WCRS', t3('全球匯率', '全球汇率', 'World Currencies'), t3('即期、變動與交叉匯率', '即期、变动与交叉汇率', 'Spot, change and cross rates'), 'market'),
      fn('rates', 'IRSM', t3('貨幣市場利率', '货币市场利率', 'Money-Market Rates'), t3('Shibor、LPR、Libor 與 Hibor', 'Shibor、LPR、Libor 与 Hibor', 'Shibor, LPR, Libor and Hibor'), 'market'),
      fn('curves', 'FWCV', t3('利率曲線', '利率曲线', 'Forward Curves'), t3('期限利率與遠期結構', '期限利率与远期结构', 'Term rates and forward structure'), 'market'),
      fn('central-banks', 'CBQ', t3('央行政策', '央行政策', 'Central Banks'), t3('政策利率、會議與聲明', '政策利率、会议与声明', 'Policy rates, meetings and statements'), 'unavailable'),
      fn('liquidity', 'LIQ', t3('流動性', '流动性', 'Liquidity'), t3('公開市場操作與資金面', '公开市场操作与资金面', 'Open-market operations and funding conditions'), 'unavailable'),
      fn('macro', 'ECO', t3('宏觀發布', '宏观发布', 'Macro Releases'), t3('通脹、增長與社融日曆', '通胀、增长与社融日历', 'Inflation, growth and financing calendar'), 'unavailable'),
      fn('money-supply', 'M2', t3('貨幣供應', '货币供应', 'Money Supply'), t3('M0、M1、M2 與社會融資', 'M0、M1、M2 与社会融资', 'M0, M1, M2 and social financing'), 'market'),
      fn('status', 'DATA', COPY.status, t3('發布頻率與權限', '发布频率与权限', 'Release frequency and entitlements'), 'status')
    ])
  ];

  const workspaceMap = new Map(WORKSPACES.map((item) => [item.id, item]));
  const YEAR_FUNCTIONS = new Set([
    'financials', 'model', 'supply-chain', 'price-history',
    'valuation', 'estimates', 'ownership'
  ]);
  const MARKET_SHORTCUTS = Object.freeze([
    { symbol: 'SPX', name: 'S&P 500', asset: 'global-index' },
    { symbol: 'IXIC', name: 'NASDAQ Composite', asset: 'global-index' },
    { symbol: 'DJI', name: 'Dow Jones Industrial Average', asset: 'global-index' },
    { symbol: 'HSI', name: 'Hang Seng Index', asset: 'global-index' },
    { symbol: 'HKTECH', name: 'Hang Seng TECH Index', asset: 'global-index' },
    { symbol: 'N225', name: 'Nikkei 225', asset: 'global-index' },
    { symbol: '000300.SH', name: 'CSI 300', asset: 'index' },
    { symbol: '000001.SH', name: 'SSE Composite', asset: 'index' },
    { symbol: '399001.SZ', name: 'Shenzhen Component', asset: 'index' },
    { symbol: '399006.SZ', name: 'ChiNext', asset: 'index' }
  ]);
  const defaultYear = String(Math.max(2010, Math.min(2026, new Date().getUTCFullYear() - 1)));
  const state = {
    workspace: null,
    functionId: 'overview',
    year: defaultYear,
    symbol: '',
    asset: '',
    securityName: '',
    entityId: '',
    atlas: null,
    atlasVisual: null,
    atlasPromise: null,
    atlasMeta: null,
    entityMap: new Map(),
    sourceMap: new Map(),
    bootstrap: null,
    serviceStatus: null,
    lastMeta: null,
    loadSequence: 0,
    loadController: null,
    searchSequence: 0,
    searchController: null,
    searchTimer: 0,
    composing: false,
    searchItems: [],
    activeSearchIndex: -1,
    newsFilter: '',
    newsSelection: 0
  };

  function terminalMode() {
    if (!state.workspace) return 'home';
    if (state.workspace === 'supply') return 'supply';
    if (state.symbol) return 'security';
    if (state.workspace === 'stocks') return 'equity-dashboard';
    return 'dashboard';
  }

  function create(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined && value !== null) element.textContent = String(value);
    return element;
  }

  function createSvg(tag, attributes, value) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes || {}).forEach(([key, attributeValue]) => {
      element.setAttribute(key, String(attributeValue));
    });
    if (value !== undefined && value !== null) element.textContent = String(value);
    return element;
  }

  function append(parent, children) {
    (Array.isArray(children) ? children : [children]).filter(Boolean).forEach((child) => {
      parent.appendChild(child);
    });
    return parent;
  }

  function makeButton(label, className, handler) {
    const element = create('button', className, label);
    element.type = 'button';
    if (handler) element.addEventListener('click', handler);
    return element;
  }

  function currentWorkspace() {
    return workspaceMap.get(state.workspace) || WORKSPACES[0];
  }

  function currentFunction() {
    const area = currentWorkspace();
    return area.functions.find((item) => item.id === state.functionId) || area.functions[0];
  }

  function finiteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !value.trim()) return null;
    const normalized = value.replace(/,/g, '').trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatNumber(value, maximumFractionDigits) {
    const numeric = finiteNumber(value);
    if (numeric == null) return value == null || value === '' ? '—' : String(value);
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: maximumFractionDigits == null ? 2 : maximumFractionDigits
    }).format(numeric);
  }

  function formatTimestamp(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Hong_Kong'
    }).format(date);
  }

  function safeUrl(value) {
    try {
      const parsed = new URL(String(value), window.location.origin);
      if (parsed.protocol === 'https:' || parsed.origin === window.location.origin) return parsed.href;
    } catch (_) {
      return null;
    }
    return null;
  }

  function showAlert(message) {
    alertBox.textContent = String(message || '');
    alertBox.hidden = !message;
  }

  function setBusy(isBusy) {
    canvas.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  }

  function endpointUrl(path, parameters) {
    const url = new URL(`${apiBase}${path}`);
    Object.entries(parameters || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
    return url.href;
  }

  function extractMeta(envelope, endpoint) {
    const meta = envelope && typeof envelope.meta === 'object' ? envelope.meta : {};
    const sourceEndpoints = (Array.isArray(envelope?.source_endpoint)
      ? envelope.source_endpoint
      : [envelope?.source_endpoint || meta.endpoint])
      .filter(Boolean)
      .map(String);
    const hasWarehouse = envelope?.domain === 'Supply' ||
      sourceEndpoints.some((value) => value.startsWith('warehouse.'));
    const hasTushare = sourceEndpoints.some((value) => !value.startsWith('warehouse.'));
    const inferredSource = hasWarehouse && hasTushare
      ? 'TUSHARE + YICAPITAL WAREHOUSE'
      : hasWarehouse ? 'YICAPITAL WAREHOUSE'
        : hasTushare ? 'TUSHARE' : 'UNVERIFIED';
    const freshness = envelope?.freshness ?? envelope?.freshness_class ?? meta.freshness ??
      meta.freshness_class ?? envelope?.updateFrequency ?? 'UNKNOWN';
    const permission = envelope?.permission ?? envelope?.permission_status ??
      envelope?.entitlement_status ?? meta.permission ?? meta.permission_status ??
      envelope?.entitlement ?? 'UNVERIFIED';
    return {
      endpoint: String(envelope?.endpoint || envelope?.source_endpoint || meta.endpoint || endpoint || 'UNKNOWN'),
      source: String(envelope?.source || envelope?.provider || meta.source || meta.provider || inferredSource),
      freshness: typeof freshness === 'object' ? JSON.stringify(freshness) : String(freshness),
      permission: typeof permission === 'object' ? JSON.stringify(permission) : String(permission),
      asOf: envelope?.as_of || envelope?.asOf || envelope?.retrieved_at || envelope?.updated_at ||
        meta.as_of || meta.asOf || meta.retrieved_at || meta.updated_at || '',
      partial: envelope?.partial === true || envelope?.is_complete === false || meta.partial === true ||
        /partial/i.test(String(envelope?.warehouse_status || meta.warehouse_status || ''))
    };
  }

  function unwrapEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(envelope, 'data')) return envelope.data;
    if (Object.prototype.hasOwnProperty.call(envelope, 'result')) return envelope.result;
    if (Object.prototype.hasOwnProperty.call(envelope, 'payload')) return envelope.payload;
    return envelope;
  }

  async function apiRequest(path, parameters, signal) {
    const url = endpointUrl(path, parameters);
    let response;
    try {
      response = await fetch(url, {
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal
      });
    } catch (cause) {
      const error = new Error('NETWORK_UNAVAILABLE');
      error.endpoint = path;
      error.status = 0;
      error.cause = cause;
      throw error;
    }

    let envelope = null;
    try {
      envelope = await response.json();
    } catch (_) {
      envelope = null;
    }
    const meta = extractMeta(envelope || {}, path);
    if (!response.ok || !envelope || envelope.ok === false || envelope.success === false) {
      const error = new Error(response.status === 403 ? 'PERMISSION_DENIED' : 'ENDPOINT_UNAVAILABLE');
      error.endpoint = path;
      error.status = response.status;
      error.meta = meta;
      throw error;
    }
    return { envelope, data: unwrapEnvelope(envelope), meta };
  }

  function primitiveValue(value) {
    return value == null || ['string', 'number', 'boolean'].includes(typeof value);
  }

  function arrayFrom(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    for (const key of ['items', 'rows', 'results', 'news', 'quotes', 'series', 'history', 'records', 'securities']) {
      if (Array.isArray(value[key])) return value[key];
    }
    return [];
  }

  function latestSeriesRows(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const rows = [];
    Object.entries(value).forEach(([name, candidate]) => {
      if (Array.isArray(candidate) && candidate.length) {
        const valid = candidate.filter((row) => row && typeof row === 'object');
        if (valid.length) rows.push({ name, ...valid[valid.length - 1] });
      } else if (candidate && typeof candidate === 'object' &&
                 Object.values(candidate).some(primitiveValue)) {
        rows.push({ name, ...candidate });
      }
    });
    return rows;
  }

  function normalizedRows(value) {
    const direct = arrayFrom(value);
    if (direct.length) return direct.filter((row) => row && typeof row === 'object');
    const fromSeries = latestSeriesRows(value);
    if (fromSeries.length) return fromSeries;
    if (value && typeof value === 'object' && value.data && typeof value.data === 'object') {
      return normalizedRows(value.data);
    }
    return [];
  }

  function freshnessClass(value) {
    const normalized = String(value || '').toLowerCase();
    if (/real|live|minute|intraday/.test(normalized)) return 'is-live';
    if (/partial|stale|unknown|unverified/.test(normalized)) return 'is-partial';
    if (/daily|eod|close|release|disclosure/.test(normalized)) return 'is-eod';
    return '';
  }

  function metaBadges(meta) {
    const fragment = document.createDocumentFragment();
    const source = create('span', 'terminal-source-badge', `${localize(COPY.source)} · ${meta?.source || 'UNKNOWN'}`);
    const freshness = create(
      'span',
      `terminal-freshness ${freshnessClass(meta?.freshness)}`,
      `${localize(COPY.freshness)} · ${meta?.freshness || 'UNKNOWN'}`
    );
    const permission = create(
      'span',
      `terminal-source-badge ${/denied|missing|unavailable|unverified/i.test(meta?.permission || '') ? 'is-partial' : ''}`,
      `${localize(COPY.permission)} · ${meta?.permission || 'UNVERIFIED'}`
    );
    fragment.append(source, freshness, permission);
    if (meta?.asOf) fragment.appendChild(create('span', 'terminal-tag', `${localize(COPY.asOf)} · ${formatTimestamp(meta.asOf)}`));
    if (meta?.partial) fragment.appendChild(create('span', 'terminal-source-badge is-partial', 'PARTIAL COVERAGE'));
    return fragment;
  }

  function screenHeader(title, subtitle, meta, actions) {
    const header = create('header', 'terminal-screen-header');
    const titleWrap = create('div', 'terminal-screen-title');
    titleWrap.append(create('h1', '', title), create('p', '', subtitle));
    const actionWrap = create('div', 'terminal-screen-actions');
    if (meta) actionWrap.appendChild(metaBadges(meta));
    (actions || []).forEach((action) => actionWrap.appendChild(action));
    header.append(titleWrap, actionWrap);
    return header;
  }

  function panel(title, bodyNode, span, small) {
    const root = create('section', `terminal-panel terminal-span-${span || 12}`);
    const head = create('header', 'terminal-panel-head');
    head.append(create('h2', '', title), create('small', '', small || ''));
    root.append(head, bodyNode);
    return root;
  }

  function unavailableNode(endpoint, meta, extra) {
    const root = create('div', 'terminal-unavailable');
    const content = create('div');
    content.append(
      create('strong', '', localize(COPY.unavailableTitle)),
      create('p', '', extra || localize(COPY.unavailableBody)),
      create('code', '', `${localize(COPY.endpoint)}: ${endpoint || 'UNKNOWN'}`),
      create('code', '', `${localize(COPY.freshness)}: ${meta?.freshness || 'UNKNOWN'}`),
      create('code', '', `${localize(COPY.permission)}: ${meta?.permission || 'UNVERIFIED'}`)
    );
    root.appendChild(content);
    return root;
  }

  function renderLoading() {
    if (state.atlasVisual?.destroy) state.atlasVisual.destroy();
    state.atlasVisual = null;
    setBusy(true);
    canvas.replaceChildren(create('div', 'terminal-loading', localize(COPY.loading)));
  }

  function currentRouteParameters() {
    const mode = terminalMode();
    return {
      workspace: state.workspace || null,
      function: mode === 'home' || mode === 'dashboard' || mode === 'equity-dashboard'
        ? null
        : state.functionId,
      year: mode === 'supply' || (mode === 'security' && YEAR_FUNCTIONS.has(state.functionId))
        ? state.year
        : null,
      symbol: state.symbol || null,
      asset: state.asset || null,
      entity: state.entityId || null
    };
  }

  function writeRoute(mode) {
    const url = new URL(window.location.href);
    const route = currentRouteParameters();
    Object.entries(route).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    });
    const next = `${url.pathname}${url.search}${url.hash}`;
    const method = mode === 'replace' ? 'replaceState' : 'pushState';
    window.history[method]({ terminal: true, ...route }, '', next);
    updateLanguageLinks();
  }

  function readRoute() {
    const params = new URLSearchParams(window.location.search);
    const requestedWorkspace = params.get('workspace');
    state.workspace = requestedWorkspace && workspaceMap.has(requestedWorkspace)
      ? requestedWorkspace
      : null;
    const area = currentWorkspace();
    const requestedFunction = params.get('function');
    state.functionId = area.functions.some((item) => item.id === requestedFunction)
      ? requestedFunction
      : area.functions[0].id;
    const requestedYear = params.get('year');
    if (requestedYear && /^(201\d|202[0-6])$/.test(requestedYear)) state.year = requestedYear;
    state.symbol = String(params.get('symbol') || '').trim().slice(0, 40);
    state.asset = String(params.get('asset') || '').trim().slice(0, 24);
    state.entityId = String(params.get('entity') || '').trim().slice(0, 80);
  }

  function compactDate(date) {
    return date.toISOString().slice(0, 10).replaceAll('-', '');
  }

  function selectedYearRange() {
    const year = Number(state.year);
    const start = `${year}0101`;
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const end = year >= currentYear ? compactDate(now) : `${year}1231`;
    return { start, end };
  }

  function recentRange(days) {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 86400000);
    return { start: compactDate(startDate), end: compactDate(endDate) };
  }

  function assetForSelection() {
    if (state.asset) return state.asset;
    if (state.workspace === 'etf') return 'etf';
    if (state.workspace === 'debt') return 'debt';
    if (state.workspace === 'derivatives') return 'future';
    if (state.workspace === 'money') return 'fx';
    if (state.workspace === 'market') {
      return state.symbol && !state.symbol.includes('.') ? 'global-index' : 'index';
    }
    if (state.symbol.endsWith('.HK')) return 'hk-stock';
    if (state.symbol && !state.symbol.includes('.')) return 'us-stock';
    return 'stock';
  }

  function marketParameters(area, activeFunction) {
    const range = recentRange(45);
    if (area.id === 'market') {
      if (activeFunction.id === 'calendar') {
        return {
          domain: 'Market',
          dataset: 'trade_cal',
          exchange: 'SSE',
          start_date: range.start,
          end_date: range.end,
          limit: 200
        };
      }
      const globalIndex = state.asset === 'global-index' ||
        (state.symbol && !state.symbol.includes('.'));
      return {
        domain: 'Market',
        dataset: globalIndex || !state.symbol ? 'index_global' : 'index_daily',
        ts_code: state.symbol || undefined,
        start: range.start,
        end: range.end,
        limit: 400
      };
    }
    if (area.id === 'stocks') {
      return {
        domain: 'Stocks',
        dataset: assetForSelection() === 'us-stock'
          ? 'us_daily'
          : assetForSelection() === 'hk-stock' ? 'hk_daily' : 'daily',
        ts_code: state.symbol || undefined,
        start: range.start,
        end: range.end,
        limit: 400
      };
    }
    if (area.id === 'debt') {
      const dataset = ['sovereign', 'curves', 'spreads'].includes(activeFunction.id)
        ? 'yc_cb'
        : activeFunction.id === 'issuance' ? 'cb_issue'
          : activeFunction.id === 'calendar' ? 'cb_redeem' : 'cb_daily';
      return {
        domain: 'Debt',
        dataset,
        start: range.start,
        end: range.end,
        limit: 400
      };
    }
    if (area.id === 'etf') {
      const dataset = activeFunction.id === 'screener' ? 'etf_basic'
        : activeFunction.id === 'flows' ? 'etf_share_size' : 'fund_daily';
      return {
        domain: 'ETF',
        dataset,
        start: dataset === 'etf_basic' ? undefined : range.start,
        end: dataset === 'etf_basic' ? undefined : range.end,
        limit: 400
      };
    }
    if (area.id === 'derivatives') {
      const dataset = activeFunction.id === 'options' ? 'opt_daily'
        : ['open-interest', 'positioning'].includes(activeFunction.id)
          ? 'fut_holding' : 'fut_daily';
      return {
        domain: 'Derivatives',
        dataset,
        start: range.start,
        end: range.end,
        limit: 400
      };
    }
    const dataset = activeFunction.id === 'fx' ? 'fx_daily'
      : activeFunction.id === 'money-supply' ? 'cn_m' : 'shibor';
    return {
      domain: 'Money & Currency',
      dataset,
      start: dataset === 'cn_m' ? undefined : range.start,
      end: dataset === 'cn_m' ? undefined : range.end,
      start_m: dataset === 'cn_m' ? `${state.year}01` : undefined,
      end_m: dataset === 'cn_m' ? `${state.year}12` : undefined,
      limit: 400
    };
  }

  function updateLanguageLinks() {
    document.querySelectorAll('[data-language-link]').forEach((link) => {
      if (!(link instanceof HTMLAnchorElement)) return;
      const target = new URL(link.href, window.location.href);
      target.search = window.location.search;
      target.hash = window.location.hash;
      link.href = target.href;
    });
  }

  function updateContext() {
    if (terminalMode() === 'home') {
      contextBar.replaceChildren(
        create('span', 'terminal-context-code', 'HOME'),
        create('strong', '', 'Yi Terminal'),
        create('span', '', localize(COPY.dailyDesk))
      );
      return;
    }
    const area = currentWorkspace();
    const activeFunction = currentFunction();
    const mode = terminalMode();
    const code = create(
      'span',
      'terminal-context-code',
      mode === 'security' ? `${area.code}:${activeFunction.code}` : area.code
    );
    const title = create(
      'strong',
      '',
      mode === 'security' ? localize(activeFunction.name) : `${localize(area.name)} · ${localize(COPY.dashboard)}`
    );
    const suffixParts = [];
    if (state.symbol) suffixParts.push(state.securityName || state.symbol);
    if (mode === 'security' && YEAR_FUNCTIONS.has(state.functionId)) {
      suffixParts.push(`${localize(COPY.canonicalYear)} ${state.year}`);
    }
    contextBar.replaceChildren(code, title, create('span', '', suffixParts.join(' · ')));
  }

  function rovingKeydown(event, buttons, selectedIndex) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let target = selectedIndex;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = (selectedIndex - 1 + buttons.length) % buttons.length;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = (selectedIndex + 1) % buttons.length;
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = buttons.length - 1;
    buttons[target]?.focus();
    buttons[target]?.click();
  }

  function renderWorkspaceTabs() {
    workspaceTabs.replaceChildren();
    WORKSPACES.forEach((area, index) => {
      const selected = area.id === state.workspace;
      const button = makeButton('', '', () => selectWorkspace(area.id));
      button.id = `terminal-workspace-${area.id}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.setAttribute('aria-controls', 'terminal-canvas');
      button.title = `${index + 1} ${area.code} · ${localize(area.name)}`;
      button.tabIndex = selected ? 0 : -1;
      button.append(create('code', '', `${index + 1} ${area.code}`), create('span', '', localize(area.name)));
      button.addEventListener('keydown', (event) => {
        rovingKeydown(event, Array.from(workspaceTabs.querySelectorAll('[role="tab"]')), index);
      });
      workspaceTabs.appendChild(button);
    });
  }

  function renderFunctionTabs() {
    functionTabs.replaceChildren();
    const area = currentWorkspace();
    area.functions.forEach((activeFunction, index) => {
      const selected = activeFunction.id === state.functionId;
      const button = makeButton(`${activeFunction.code}  ${localize(activeFunction.name)}`, '', () => {
        selectFunction(activeFunction.id);
      });
      button.id = `terminal-function-${area.id}-${activeFunction.id}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.setAttribute('aria-controls', 'terminal-canvas');
      button.tabIndex = selected ? 0 : -1;
      button.addEventListener('keydown', (event) => {
        rovingKeydown(event, Array.from(functionTabs.querySelectorAll('[role="tab"]')), index);
      });
      functionTabs.appendChild(button);
    });
  }

  function updateChromeVisibility() {
    const mode = terminalMode();
    body.classList.remove(
      'terminal-mode-home',
      'terminal-mode-dashboard',
      'terminal-mode-equity-dashboard',
      'terminal-mode-security',
      'terminal-mode-supply'
    );
    body.classList.add(`terminal-mode-${mode}`);
    workspaceTabs.hidden = mode === 'home';
    functionTabs.hidden = mode !== 'security';
    const yearControl = document.querySelector('.terminal-year-control');
    if (yearControl) {
      yearControl.hidden = !(mode === 'security' && YEAR_FUNCTIONS.has(state.functionId));
    }
  }

  function syncShell() {
    renderWorkspaceTabs();
    renderFunctionTabs();
    updateChromeVisibility();
    updateContext();
    if (yearSelect) yearSelect.value = state.year;
  }

  function selectWorkspace(id, mode) {
    if (!workspaceMap.has(id)) return;
    if (state.workspace !== id) {
      state.symbol = '';
      state.asset = '';
      state.securityName = '';
      state.entityId = '';
    }
    state.workspace = id;
    state.functionId = workspaceMap.get(id).functions[0].id;
    syncShell();
    writeRoute(mode === 'replace' ? 'replace' : 'push');
    loadCurrentFunction();
  }

  function selectFunction(id, mode) {
    const area = currentWorkspace();
    if (!area.functions.some((item) => item.id === id)) return;
    state.functionId = id;
    syncShell();
    writeRoute(mode === 'replace' ? 'replace' : 'push');
    loadCurrentFunction();
  }

  function initializeYearSelect() {
    if (!yearSelect) return;
    yearSelect.replaceChildren();
    for (let year = 2026; year >= 2010; year -= 1) {
      const option = create('option', '', String(year));
      option.value = String(year);
      yearSelect.appendChild(option);
    }
    yearSelect.value = state.year;
    yearSelect.addEventListener('change', () => {
      if (!/^(201\d|202[0-6])$/.test(yearSelect.value)) return;
      state.year = yearSelect.value;
      updateContext();
      writeRoute('push');
      loadCurrentFunction();
    });
  }

  function functionDirectory(area) {
    const wrapper = create('section', 'terminal-panel terminal-span-12');
    const head = create('header', 'terminal-panel-head');
    head.append(create('h2', '', localize(COPY.functionDirectory)), create('small', '', area.code));
    const grid = create('div', 'terminal-function-grid terminal-panel-body');
    area.functions.forEach((item) => {
      const card = makeButton('', 'terminal-function-card', () => selectFunction(item.id));
      card.append(
        create('code', '', item.code),
        create('strong', '', localize(item.name)),
        create('p', '', localize(item.description))
      );
      grid.appendChild(card);
    });
    wrapper.append(head, grid);
    return wrapper;
  }

  function rowDate(row) {
    return String(
      row?.trade_date ?? row?.date ?? row?.cal_date ?? row?.ann_date ??
      row?.pub_time ?? row?.datetime ?? row?.time ?? ''
    );
  }

  function rowInstrument(row) {
    return String(
      row?.ts_code ?? row?.symbol ?? row?.code ?? row?.name ??
      row?.index_name ?? row?.curve_type ?? row?.exchange ?? 'SERIES'
    );
  }

  function rowMarketValue(row) {
    const candidates = [
      row?.close, row?.last, row?.price, row?.settle, row?.nav,
      row?.value, row?.rate, row?.yield
    ];
    for (const candidate of candidates) {
      const numeric = finiteNumber(candidate);
      if (numeric != null) return numeric;
    }
    return null;
  }

  function latestRowsByInstrument(rows) {
    const latest = new Map();
    rows.forEach((row) => {
      const key = rowInstrument(row);
      const previous = latest.get(key);
      if (!previous || rowDate(row) >= rowDate(previous)) latest.set(key, row);
    });
    return [...latest.values()];
  }

  function normalizedPerformanceChart(rows, label) {
    const root = create('div', 'terminal-performance-chart');
    const groups = new Map();
    rows.forEach((row) => {
      const value = rowMarketValue(row);
      const date = rowDate(row);
      if (value == null || !date) return;
      const key = rowInstrument(row);
      if (!groups.has(key)) groups.set(key, new Map());
      groups.get(key).set(date, value);
    });
    const series = [...groups.entries()]
      .map(([name, values]) => ({
        name,
        points: [...values.entries()].sort(([left], [right]) => left.localeCompare(right))
      }))
      .filter((item) => item.points.length >= 8)
      .sort((left, right) => right.points.length - left.points.length)
      .slice(0, 5);
    if (!series.length) return unavailableNode('DASHBOARD:SERIES', state.lastMeta, localize(COPY.noRows));

    const width = 820;
    const height = 270;
    const padding = { top: 22, right: 18, bottom: 28, left: 36 };
    const normalized = series.map((item) => {
      const base = item.points[0][1] || 1;
      return {
        ...item,
        points: item.points.map(([date, value]) => [date, (value / base) * 100])
      };
    });
    const allValues = normalized.flatMap((item) => item.points.map((point) => point[1]));
    const minimum = Math.min(...allValues);
    const maximum = Math.max(...allValues);
    const spread = maximum - minimum || 1;
    const colors = ['#22d3ee', '#6e9af4', '#b54bfa', '#f3c969', '#36d39a'];
    const svg = createSvg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': label,
      preserveAspectRatio: 'none'
    });
    for (let line = 0; line <= 4; line += 1) {
      const y = padding.top + ((height - padding.top - padding.bottom) * line) / 4;
      svg.appendChild(createSvg('line', {
        x1: padding.left,
        y1: y,
        x2: width - padding.right,
        y2: y,
        stroke: '#18263a',
        'stroke-width': 1
      }));
    }
    normalized.forEach((item, seriesIndex) => {
      const path = item.points.map((point, index) => {
        const x = padding.left +
          ((width - padding.left - padding.right) * index) / Math.max(1, item.points.length - 1);
        const y = height - padding.bottom -
          ((point[1] - minimum) / spread) * (height - padding.top - padding.bottom);
        return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
      }).join(' ');
      svg.appendChild(createSvg('path', {
        d: path,
        fill: 'none',
        stroke: colors[seriesIndex],
        'stroke-width': seriesIndex === 0 ? 2.4 : 1.5,
        opacity: seriesIndex === 0 ? 1 : .82,
        'vector-effect': 'non-scaling-stroke'
      }));
    });
    const legend = create('div', 'terminal-chart-legend');
    normalized.forEach((item, index) => {
      const key = create('span');
      key.append(
        append(create('i'), []),
        document.createTextNode(item.name)
      );
      key.querySelector('i').style.background = colors[index];
      legend.appendChild(key);
    });
    root.append(svg, legend, create('p', 'terminal-chart-caption', `${localize(COPY.chartSource)} · BASE 100`));
    return root;
  }

  function rankBars(rows) {
    const candidates = latestRowsByInstrument(rows).map((row) => {
      const change = finiteNumber(row.pct_chg ?? row.change_pct ?? row.change);
      const fallback = finiteNumber(row.amount ?? row.vol ?? row.volume ?? row.open_interest ?? row.oi);
      return {
        name: rowInstrument(row),
        value: change == null ? fallback : change,
        measure: change == null ? 'ACTIVITY' : 'CHANGE %',
        signed: change != null
      };
    }).filter((item) => item.value != null);
    candidates.sort((left, right) => Math.abs(right.value) - Math.abs(left.value));
    const visible = candidates.slice(0, 10);
    if (!visible.length) return unavailableNode('DASHBOARD:RANKING', state.lastMeta, localize(COPY.noRows));
    const maximum = Math.max(...visible.map((item) => Math.abs(item.value)), 1);
    const root = create('div', 'terminal-rank-bars');
    visible.forEach((item) => {
      const row = create('div', 'terminal-rank-row');
      const label = create('span', 'terminal-rank-label', item.name);
      const track = create('span', 'terminal-rank-track');
      const bar = create('i', item.signed && item.value < 0 ? 'is-negative' : '');
      bar.style.width = `${Math.max(3, Math.abs(item.value) / maximum * 100)}%`;
      track.appendChild(bar);
      row.append(
        label,
        track,
        create('strong', item.signed && item.value < 0 ? 'is-down' : item.signed ? 'is-up' : '', formatNumber(item.value))
      );
      root.appendChild(row);
    });
    root.appendChild(create('p', 'terminal-chart-caption', visible[0].measure));
    return root;
  }

  function categoricalBars(rows, keys) {
    const field = (keys || []).find((key) => rows.some((row) => row?.[key] != null));
    if (!field) return rankBars(rows);
    const counts = new Map();
    rows.forEach((row) => {
      const value = String(row?.[field] || 'UNKNOWN');
      counts.set(value, (counts.get(value) || 0) + 1);
    });
    const visible = [...counts.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((left, right) => right.value - left.value)
      .slice(0, 10);
    const maximum = Math.max(...visible.map((item) => item.value), 1);
    const root = create('div', 'terminal-rank-bars');
    visible.forEach((item) => {
      const row = create('div', 'terminal-rank-row');
      const track = create('span', 'terminal-rank-track');
      const bar = create('i');
      bar.style.width = `${Math.max(3, item.value / maximum * 100)}%`;
      track.appendChild(bar);
      row.append(
        create('span', 'terminal-rank-label', item.name),
        track,
        create('strong', '', formatNumber(item.value, 0))
      );
      root.appendChild(row);
    });
    root.appendChild(create('p', 'terminal-chart-caption', `${field.toUpperCase()} · COUNT`));
    return root;
  }

  function moneyCurve(rows) {
    const latest = [...rows].sort((left, right) => rowDate(left).localeCompare(rowDate(right))).at(-1);
    if (!latest) return unavailableNode('DASHBOARD:CURVE', state.lastMeta, localize(COPY.noRows));
    const tenors = ['on', '1w', '2w', '1m', '3m', '6m', '9m', '1y']
      .map((key) => ({ key, value: finiteNumber(latest[key]) }))
      .filter((item) => item.value != null);
    if (tenors.length < 3) return rankBars(rows);
    const width = 720;
    const height = 245;
    const padding = 34;
    const values = tenors.map((item) => item.value);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const spread = maximum - minimum || 1;
    const svg = createSvg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': `${rowDate(latest)} SHIBOR curve`,
      preserveAspectRatio: 'none'
    });
    let path = '';
    tenors.forEach((item, index) => {
      const x = padding + (width - padding * 2) * index / Math.max(1, tenors.length - 1);
      const y = height - padding - (item.value - minimum) / spread * (height - padding * 2);
      path += `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
      svg.append(
        createSvg('circle', { cx: x, cy: y, r: 4, fill: '#22d3ee' }),
        createSvg('text', {
          x,
          y: height - 10,
          fill: '#74849a',
          'font-size': 11,
          'text-anchor': 'middle',
          'font-family': 'IBM Plex Mono, monospace'
        }, item.key.toUpperCase())
      );
    });
    svg.prepend(createSvg('path', {
      d: path.trim(),
      fill: 'none',
      stroke: '#22d3ee',
      'stroke-width': 2.2,
      'vector-effect': 'non-scaling-stroke'
    }));
    const root = create('div', 'terminal-performance-chart');
    root.append(svg, create('p', 'terminal-chart-caption', `${rowDate(latest)} · SHIBOR`));
    return root;
  }

  function dashboardKpis(rows, meta) {
    const instruments = new Set(rows.map(rowInstrument).filter(Boolean));
    const latestDate = rows.map(rowDate).filter(Boolean).sort().at(-1) || '—';
    return kpiStrip([
      { label: localize(COPY.records), value: rows.length },
      { label: localize(COPY.asOf), value: latestDate },
      { label: localize(COPY.category), value: instruments.size },
      { label: localize(COPY.source), value: meta?.source || 'UNKNOWN' }
    ]);
  }

  function dashboardVisual(area, rows) {
    if (area.id === 'money') return moneyCurve(rows);
    const chart = normalizedPerformanceChart(rows, `${area.code} ${localize(COPY.dashboard)}`);
    if (!chart.classList?.contains('terminal-unavailable')) return chart;
    return rankBars(rows);
  }

  function renderDomainDashboard(result, secondaryResult) {
    const area = currentWorkspace();
    const rows = normalizedRows(result.data);
    const secondaryRows = secondaryResult ? normalizedRows(secondaryResult.data) : [];
    const screen = create('div', 'terminal-screen terminal-domain-screen');
    screen.appendChild(screenHeader(
      `${area.code} · ${localize(area.name)}`,
      localize(area.description),
      result.meta
    ));
    if (area.id === 'stocks') {
      const prompt = create('section', 'terminal-dashboard-search');
      prompt.append(
        create('code', '', 'EQT'),
        create('strong', '', localize(COPY.securitySearch)),
        create('span', '', 'DES · CN · RES · FA · MODL · SPLC · Q · GP · HP · VAL · EE · OWN · EVT · VWAP · AVAT')
      );
      prompt.addEventListener('click', () => searchInput.focus());
      screen.appendChild(prompt);
    }
    const grid = create('div', 'terminal-grid');
    if (rows.length || secondaryRows.length) {
      const visualBody = create('div', 'terminal-panel-body');
      visualBody.appendChild(
        rows.length
          ? dashboardVisual(area, rows)
          : unavailableNode(ENDPOINTS.market, result.meta, localize(COPY.noRows))
      );
      grid.appendChild(panel(
        area.id === 'money' ? t3('利率曲線', '利率曲线', 'Rate curve')[language] : localize(COPY.dashboard),
        visualBody,
        8,
        `${rows.length}`
      ));
      const rankingBody = create('div', 'terminal-panel-body');
      rankingBody.appendChild(
        area.id === 'etf' && secondaryRows.length
          ? categoricalBars(secondaryRows, ['exchange', 'etf_type', 'mgr_name'])
          : rankBars(rows)
      );
      grid.appendChild(panel(
        area.id === 'etf'
          ? t3('ETF 市場結構', 'ETF 市场结构', 'ETF universe')[language]
          : t3('市場截面', '市场截面', 'Market cross-section')[language],
        rankingBody,
        4,
        area.id === 'etf' ? `${secondaryRows.length}` : rowDate(rows.at(-1))
      ));
      const kpiBody = create('div', 'terminal-panel-body');
      kpiBody.appendChild(dashboardKpis(rows.length ? rows : secondaryRows, result.meta));
      grid.appendChild(panel(t3('資料覆蓋', '数据覆盖', 'Data coverage')[language], kpiBody, 12));
      const tableBody = create('div', 'terminal-panel-body');
      const tableRows = secondaryRows.length ? secondaryRows : rows;
      tableBody.appendChild(tableNode(tableRows.slice(-24).reverse()));
      grid.appendChild(panel(t3('最新可發布記錄', '最新可发布记录', 'Latest publishable records')[language], tableBody, 12, `${tableRows.length}`));
    } else {
      grid.appendChild(panel(localize(COPY.dashboard), unavailableNode(ENDPOINTS.market, result.meta, localize(COPY.noRows)), 12));
    }
    screen.appendChild(grid);
    canvas.replaceChildren(screen);
    state.lastMeta = result.meta;
    setBusy(false);
    updateStatusbar();
  }

  function workspaceAvailability(area) {
    const service = state.serviceStatus || {};
    if (area.id === 'supply') {
      return service.warehouse_ready === true
        ? service.warehouse_complete === true ? 'PUBLISHED' : 'PARTIAL'
        : 'CHECKING';
    }
    return service.ready === true || service.token_configured === true ? 'TUSHARE READY' : 'SOURCE CHECK';
  }

  function workspaceCards() {
    const wrapper = create('section', 'terminal-home-workspaces');
    wrapper.appendChild(create('h2', '', localize(COPY.sevenDesks)));
    const grid = create('div', 'terminal-workspace-card-grid');
    WORKSPACES.forEach((area, index) => {
      const card = makeButton('', `terminal-workspace-card terminal-workspace-card-${area.id}`, () => {
        selectWorkspace(area.id);
      });
      card.append(
        append(create('span', 'terminal-workspace-card-code'), [
          create('b', '', String(index + 1).padStart(2, '0')),
          create('code', '', area.code)
        ]),
        create('strong', '', localize(area.name)),
        create('p', '', localize(area.description)),
        append(create('span', 'terminal-workspace-card-foot'), [
          create('small', '', workspaceAvailability(area)),
          create('i', '', '→')
        ])
      );
      grid.appendChild(card);
    });
    wrapper.appendChild(grid);
    return wrapper;
  }

  function homeNewsPanel(newsResult) {
    const rows = newsResult
      ? newsRows(newsResult.data, newsResult.meta?.source || 'TUSHARE')
      : [];
    if (!rows.length) return unavailableNode(ENDPOINTS.news, newsResult?.meta, localize(COPY.noRows));
    const stream = create('div', 'terminal-home-news');
    rows.slice(0, 16).forEach((row) => {
      const item = create('article', 'terminal-home-news-item');
      item.append(
        create('time', '', formatTimestamp(row.time)),
        append(create('div'), [
          create('strong', '', row.title),
          create('small', '', `${row.source || 'UNKNOWN'}${row.category ? ` · ${row.category}` : ''}`)
        ])
      );
      stream.appendChild(item);
    });
    return stream;
  }

  function renderHome(marketResult, newsResult) {
    const marketRows = marketResult ? normalizedRows(marketResult.data) : [];
    const meta = newsResult?.meta || marketResult?.meta || {
      source: 'UNKNOWN',
      freshness: 'UNKNOWN',
      permission: 'UNVERIFIED'
    };
    const isTerminalHome = terminalMode() === 'home';
    const screen = create('div', `terminal-screen ${isTerminalHome ? 'terminal-home-screen' : 'terminal-domain-screen'}`);
    screen.appendChild(screenHeader(
      isTerminalHome ? localize(COPY.dailyDesk) : `MKT · ${localize(COPY.dashboard)}`,
      localize(COPY.dailyDeskBody),
      meta
    ));
    const hero = create('div', 'terminal-home-hero');
    const newsBody = create('div', 'terminal-panel-body');
    newsBody.appendChild(homeNewsPanel(newsResult));
    hero.appendChild(panel(localize(COPY.news), newsBody, 12, newsResult?.meta?.asOf ? formatTimestamp(newsResult.meta.asOf) : ''));
    const chartBody = create('div', 'terminal-panel-body');
    chartBody.appendChild(
      marketRows.length
        ? normalizedPerformanceChart(marketRows, localize(COPY.dailyDesk))
        : unavailableNode(ENDPOINTS.market, marketResult?.meta, localize(COPY.noRows))
    );
    hero.appendChild(panel(t3('全球市場走勢', '全球市场走势', 'Global market performance')[language], chartBody, 12, 'BASE 100'));
    screen.appendChild(hero);
    if (isTerminalHome) screen.appendChild(workspaceCards());
    canvas.replaceChildren(screen);
    state.lastMeta = meta;
    setBusy(false);
    updateStatusbar();
  }

  function primitiveColumns(rows) {
    const seen = [];
    rows.slice(0, 25).forEach((row) => {
      Object.entries(row || {}).forEach(([key, value]) => {
        if (primitiveValue(value) && !seen.includes(key) && seen.length < 10) seen.push(key);
      });
    });
    return seen;
  }

  function tableNode(rows) {
    const wrap = create('div', 'terminal-table-wrap');
    const table = create('table', 'terminal-table');
    const columns = primitiveColumns(rows);
    if (!columns.length) return unavailableNode('PAYLOAD', null, localize(COPY.noRows));
    const thead = create('thead');
    const headRow = create('tr');
    columns.forEach((column) => headRow.appendChild(create('th', '', column.replace(/_/g, ' '))));
    thead.appendChild(headRow);
    const tbody = create('tbody');
    rows.slice(0, 250).forEach((row) => {
      const tr = create('tr');
      columns.forEach((column) => {
        const value = row[column];
        const cell = create('td', '', typeof value === 'number' ? formatNumber(value) : value == null ? '—' : String(value));
        tr.appendChild(cell);
      });
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function kpisFrom(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const source = value.kpis && typeof value.kpis === 'object' ? value.kpis : value;
    return Object.entries(source)
      .filter(([, item]) => primitiveValue(item))
      .slice(0, 8)
      .map(([key, item]) => ({ label: key.replace(/_/g, ' '), value: item }));
  }

  function kpiStrip(items) {
    const strip = create('div', 'terminal-kpi-strip');
    items.forEach((item) => {
      const card = create('div', 'terminal-kpi');
      card.append(
        create('span', '', item.label),
        create('strong', '', typeof item.value === 'number' ? formatNumber(item.value) : item.value == null ? '—' : String(item.value)),
        item.detail ? create('small', '', item.detail) : null
      );
      strip.appendChild(card);
    });
    return strip;
  }

  function renderGeneric(result, endpoint) {
    const area = currentWorkspace();
    const activeFunction = currentFunction();
    const screen = create('div', 'terminal-screen');
    const refresh = makeButton(localize(COPY.refresh), 'terminal-button', loadCurrentFunction);
    screen.appendChild(screenHeader(
      localize(activeFunction.name),
      localize(activeFunction.description),
      result.meta,
      [refresh]
    ));
    const grid = create('div', 'terminal-grid');
    const kpis = kpisFrom(result.data);
    if (kpis.length) {
      const bodyNode = create('div', 'terminal-panel-body');
      bodyNode.appendChild(kpiStrip(kpis));
      grid.appendChild(panel(localize(COPY.overview), bodyNode, 12, result.meta?.asOf ? formatTimestamp(result.meta.asOf) : ''));
    }
    const rows = normalizedRows(result.data);
    if (rows.length) {
      const bodyNode = create('div', 'terminal-panel-body');
      bodyNode.appendChild(tableNode(rows));
      grid.appendChild(panel(localize(activeFunction.name), bodyNode, 12, `${rows.length}`));
    }
    if (!kpis.length && !rows.length) {
      const primitive = result.data && typeof result.data === 'object'
        ? Object.entries(result.data).filter(([, value]) => primitiveValue(value))
        : [];
      if (primitive.length) {
        const bodyNode = create('div', 'terminal-panel-body');
        bodyNode.appendChild(kpiStrip(primitive.map(([label, value]) => ({ label, value }))));
        grid.appendChild(panel(localize(activeFunction.name), bodyNode, 12));
      } else {
        grid.appendChild(panel(localize(activeFunction.name), unavailableNode(endpoint, result.meta, localize(COPY.noRows)), 12));
      }
    }
    screen.appendChild(grid);
    canvas.replaceChildren(screen);
    setBusy(false);
  }

  function quoteKpis(value) {
    const quote = value?.quote || value?.security || value;
    if (!quote || typeof quote !== 'object') return [];
    const definitions = [
      ['last', ['last', 'price', 'close', 'latest_price']],
      ['change', ['change', 'chg']],
      ['change %', ['pct_chg', 'change_pct', 'percent_change']],
      ['open', ['open']],
      ['high', ['high']],
      ['low', ['low']],
      ['volume', ['volume', 'vol']],
      ['amount', ['amount', 'turnover']]
    ];
    return definitions.map(([label, keys]) => {
      const key = keys.find((candidate) => quote[candidate] !== undefined && quote[candidate] !== null);
      return key ? { label, value: quote[key] } : null;
    }).filter(Boolean);
  }

  function renderQuote(result) {
    const activeFunction = currentFunction();
    const value = result.data?.quote || result.data?.security || result.data || {};
    const symbol = String(value.symbol || value.ts_code || value.ticker || state.symbol || '—');
    const name = String(value.name || value.security_name || state.securityName || symbol);
    const screen = create('div', 'terminal-screen');
    screen.appendChild(screenHeader(localize(activeFunction.name), localize(activeFunction.description), result.meta));
    const securityHead = create('section', 'terminal-security-head');
    const identity = create('div', 'terminal-security-id');
    identity.append(create('code', '', symbol), create('h1', '', name));
    securityHead.appendChild(identity);
    quoteKpis(value).slice(0, 3).forEach((item) => {
      const stat = create('div', 'terminal-security-stat');
      stat.append(create('span', '', item.label), create('strong', '', formatNumber(item.value)));
      securityHead.appendChild(stat);
    });
    screen.appendChild(securityHead);
    const metrics = quoteKpis(value);
    if (metrics.length) screen.appendChild(kpiStrip(metrics));
    else screen.appendChild(unavailableNode(ENDPOINTS.quote, result.meta, localize(COPY.noRows)));
    canvas.replaceChildren(screen);
    setBusy(false);
  }

  function historyRows(value) {
    const rows = normalizedRows(value);
    return rows.map((row) => {
      const numeric = finiteNumber(row.close ?? row.price ?? row.value ?? row.last);
      const time = row.trade_date ?? row.date ?? row.time ?? row.datetime ?? row.timestamp;
      return numeric == null || !time ? null : { ...row, _numeric: numeric, _time: String(time) };
    }).filter(Boolean);
  }

  function drawHistory(canvasNode, rows) {
    const context = canvasNode.getContext && canvasNode.getContext('2d');
    if (!context || rows.length < 2) return;
    const rect = canvasNode.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width || 900));
    const height = 230;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvasNode.width = Math.floor(width * ratio);
    canvasNode.height = Math.floor(height * ratio);
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    const values = rows.map((row) => row._numeric);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const range = maximum - minimum || 1;
    const padding = 18;
    context.strokeStyle = '#18263a';
    context.lineWidth = 1;
    for (let line = 0; line <= 4; line += 1) {
      const y = padding + ((height - padding * 2) * line) / 4;
      context.beginPath();
      context.moveTo(padding, y);
      context.lineTo(width - padding, y);
      context.stroke();
    }
    context.strokeStyle = '#22d3ee';
    context.lineWidth = 1.7;
    context.beginPath();
    rows.forEach((row, index) => {
      const x = padding + ((width - padding * 2) * index) / (rows.length - 1);
      const y = height - padding - ((row._numeric - minimum) / range) * (height - padding * 2);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }

  function renderHistory(result) {
    const activeFunction = currentFunction();
    const rows = historyRows(result.data);
    const screen = create('div', 'terminal-screen');
    screen.appendChild(screenHeader(localize(activeFunction.name), localize(activeFunction.description), result.meta));
    if (!rows.length) {
      screen.appendChild(unavailableNode(ENDPOINTS.history, result.meta, localize(COPY.noRows)));
      canvas.replaceChildren(screen);
      setBusy(false);
      return;
    }
    const grid = create('div', 'terminal-grid');
    const chartBody = create('div', 'terminal-chart-wrap');
    const chart = create('canvas');
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', `${state.symbol} ${localize(activeFunction.name)}`);
    chartBody.append(chart, create('p', 'terminal-chart-caption', `${rows[0]._time} — ${rows[rows.length - 1]._time}`));
    grid.appendChild(panel(localize(activeFunction.name), chartBody, 8, state.symbol));
    const tableBody = create('div', 'terminal-panel-body');
    tableBody.appendChild(tableNode(rows.slice(-20).reverse()));
    grid.appendChild(panel(localize(COPY.latest), tableBody, 4, `${rows.length}`));
    screen.appendChild(grid);
    canvas.replaceChildren(screen);
    setBusy(false);
    window.requestAnimationFrame(() => drawHistory(chart, rows));
  }

  function newsRows(value, defaultSource = '') {
    return normalizedRows(value).map((row, index) => {
      const disclosedTitle = row.title || row.headline || row.name || row.subject || '';
      const disclosedBody = row.summary || row.description || row.content || row.body || '';
      return {
        original: row,
        title: String(disclosedTitle || disclosedBody || `#${index + 1}`),
        summary: disclosedTitle ? String(disclosedBody) : '',
        time: String(row.pub_time || row.datetime || row.published_at || row.time || row.date || ''),
        source: String(row.source || row.src || row.publisher || row.source_name || defaultSource),
        category: String(row.category || row.channel || row.channels || row.topic || '')
      };
    });
  }

  function renderNewsResult(marketResult, newsResult) {
    const screen = create('div', 'terminal-screen');
    const combinedMeta = newsResult?.meta || marketResult?.meta || {
      source: 'UNKNOWN', freshness: 'UNKNOWN', permission: 'UNVERIFIED'
    };
    screen.appendChild(screenHeader(localize(COPY.news), localize(currentFunction().description), combinedMeta));

    if (marketResult) {
      const bySymbol = new Map();
      normalizedRows(marketResult.data).forEach((row) => {
        const key = String(row.ts_code || row.symbol || row.code || row.name || '');
        if (!key) return;
        const previous = bySymbol.get(key);
        const rowDate = String(row.trade_date || row.date || '');
        const previousDate = String(previous?.trade_date || previous?.date || '');
        if (!previous || rowDate >= previousDate) bySymbol.set(key, row);
      });
      const rows = [...bySymbol.values()];
      const ticks = create('div', 'terminal-market-tape');
      rows.slice(0, 12).forEach((row) => {
        const name = row.name || row.symbol || row.ts_code || row.code || row.index_name || '—';
        const value = row.last ?? row.price ?? row.close ?? row.value;
        const change = row.pct_chg ?? row.change_pct ?? row.change;
        const tick = create('div', 'terminal-market-tick');
        tick.append(create('span', '', name), create('strong', '', formatNumber(value)));
        if (change !== undefined && change !== null) {
          const numeric = finiteNumber(change);
          tick.appendChild(create('em', numeric == null ? '' : numeric >= 0 ? 'is-up' : 'is-down', formatNumber(change)));
        }
        ticks.appendChild(tick);
      });
      if (ticks.childElementCount) screen.appendChild(ticks);
      else screen.appendChild(unavailableNode(ENDPOINTS.market, marketResult.meta, localize(COPY.noRows)));
    } else {
      screen.appendChild(unavailableNode(ENDPOINTS.market, null));
    }

    const rows = newsResult
      ? newsRows(newsResult.data, newsResult.meta?.source || 'TUSHARE')
      : [];
    if (!rows.length) {
      screen.appendChild(unavailableNode(ENDPOINTS.news, newsResult?.meta, localize(COPY.noRows)));
      canvas.replaceChildren(screen);
      setBusy(false);
      return;
    }

    const categories = [...new Set(rows.map((row) => row.category).filter(Boolean))].slice(0, 12);
    if (state.newsFilter && !categories.includes(state.newsFilter)) state.newsFilter = '';
    const visibleRows = state.newsFilter ? rows.filter((row) => row.category === state.newsFilter) : rows;
    if (state.newsSelection >= visibleRows.length) state.newsSelection = 0;
    const layout = create('div', 'terminal-news-layout');
    const filters = create('section', 'terminal-panel terminal-news-filters');
    const filterValues = ['', ...categories];
    filterValues.forEach((category) => {
      const button = makeButton(category || localize(COPY.all), 'terminal-filter-button', () => {
        state.newsFilter = category;
        state.newsSelection = 0;
        renderNewsResult(marketResult, newsResult);
      });
      button.setAttribute('aria-pressed', state.newsFilter === category ? 'true' : 'false');
      filters.appendChild(button);
    });

    const streamPanel = create('section', 'terminal-panel terminal-news-stream');
    visibleRows.slice(0, 100).forEach((row, index) => {
      const button = makeButton('', `terminal-news-item${index === state.newsSelection ? ' is-active' : ''}`, () => {
        state.newsSelection = index;
        renderNewsResult(marketResult, newsResult);
      });
      button.append(
        create('span', 'terminal-news-time', formatTimestamp(row.time)),
        append(create('span', 'terminal-news-copy'), [
          create('strong', '', row.title),
          create('p', '', row.summary.slice(0, 220))
        ]),
        create('span', 'terminal-news-source', row.source)
      );
      streamPanel.appendChild(button);
    });

    const selected = visibleRows[state.newsSelection];
    const storyPanel = create('section', 'terminal-panel terminal-story');
    if (selected) {
      const storyMeta = create('div', 'terminal-story-meta');
      storyMeta.append(
        create('span', 'terminal-source-badge', selected.source || 'UNKNOWN'),
        create('span', 'terminal-freshness', formatTimestamp(selected.time)),
        selected.category ? create('span', 'terminal-tag', selected.category) : null
      );
      storyPanel.append(create('h2', '', selected.title), storyMeta);
      if (selected.summary) storyPanel.appendChild(create('p', '', selected.summary));
    } else {
      storyPanel.appendChild(create('p', '', localize(COPY.storyUnavailable)));
    }
    layout.append(filters, streamPanel, storyPanel);
    screen.appendChild(layout);
    canvas.replaceChildren(screen);
    setBusy(false);
  }

  function validateAtlas(seed) {
    if (!seed || !['partial', 'validated', 'published'].includes(seed.status)) throw new Error('ATLAS_STATUS');
    if (!Array.isArray(seed.layers) || !Array.isArray(seed.entities) ||
        !Array.isArray(seed.relationships) || !Array.isArray(seed.sources) ||
        !seed.financials || typeof seed.financials !== 'object') throw new Error('ATLAS_SCHEMA');
    const ids = new Set();
    seed.entities.forEach((entity) => {
      if (!entity || typeof entity.id !== 'string' || ids.has(entity.id)) throw new Error('ATLAS_ENTITY');
      ids.add(entity.id);
    });
    seed.relationships.forEach((relation) => {
      if (!ids.has(relation.from) || !ids.has(relation.to) ||
          !Array.isArray(relation.validCanonicalYears)) throw new Error('ATLAS_RELATION');
    });
    return seed;
  }

  async function getAtlas() {
    if (state.atlas) return state.atlas;
    if (state.atlasPromise) return state.atlasPromise;
    state.atlasPromise = apiRequest(ENDPOINTS.market, {
      domain: 'Supply',
      limit: 1000
    }).then((result) => {
      const seed = result.data;
      validateAtlas(seed);
      state.atlas = seed;
      state.atlasMeta = result.meta;
      state.entityMap = new Map(seed.entities.map((entity) => [entity.id, entity]));
      state.sourceMap = new Map(seed.sources.map((source) => [source.id, source]));
      return seed;
    }).finally(() => {
      state.atlasPromise = null;
    });
    return state.atlasPromise;
  }

  function atlasMeta() {
    return {
      endpoint: state.atlasMeta?.endpoint || ENDPOINTS.market,
      source: state.atlasMeta?.source || 'YICAPITAL WAREHOUSE',
      freshness: state.atlasMeta?.freshness || 'DISCLOSURE · VERSIONED',
      permission: state.atlasMeta?.permission || 'AVAILABLE',
      asOf: state.atlasMeta?.asOf || state.atlas?.knowledgeCutoff || '',
      partial: state.atlasMeta?.partial === true || state.atlas?.status !== 'published'
    };
  }

  function partialNotice() {
    if (!atlasMeta().partial) return document.createDocumentFragment();
    const note = create('div', 'terminal-note');
    note.append(create('strong', 'is-warn', localize(COPY.partial)), create('span', '', ` · ${localize(COPY.partialBody)}`));
    return note;
  }

  function atlasEntityForSelection() {
    const needle = state.symbol.trim().toLowerCase();
    if (needle) {
      const match = state.atlas.entities.find((entity) => {
        if (entity.kind !== 'company') return false;
        const tickers = String(entity.ticker || '')
          .toLowerCase()
          .split(/[\s/|,]+/)
          .filter(Boolean);
        return entity.id.toLowerCase() === needle ||
          entity.name.toLowerCase() === needle ||
          tickers.includes(needle);
      });
      return match || null;
    }
    if (state.entityMap.has(state.entityId)) return state.entityMap.get(state.entityId);
    return null;
  }

  function relationshipApplies(relation) {
    return relation.validCanonicalYears.map(String).includes(String(state.year));
  }

  function supplyStageGrid() {
    const grid = create('div', 'terminal-supply-stage-grid');
    [...state.atlas.layers].sort((a, b) => a.order - b.order).forEach((layer) => {
      const stage = create('section', 'terminal-supply-stage');
      stage.appendChild(create('header', '', localize(layer.label)));
      state.atlas.entities.filter((entity) => entity.layer === layer.id).forEach((entity) => {
        const node = makeButton('', 'terminal-supply-node', () => {
          state.entityId = entity.id;
          if (entity.ticker) state.symbol = String(entity.ticker).split(/[ /]/)[0];
          state.functionId = 'xray';
          syncShell();
          writeRoute('push');
          renderAtlas();
        });
        node.append(
          create('strong', '', entity.name),
          create('small', '', `${entity.ticker || localize(COPY.category)} · ${localize(entity.role)}`)
        );
        stage.appendChild(node);
      });
      grid.appendChild(stage);
    });
    return grid;
  }

  function relationLabel(relation) {
    const from = state.entityMap.get(relation.from);
    const to = state.entityMap.get(relation.to);
    return `${from?.name || relation.from} → ${to?.name || relation.to}`;
  }

  function supplyNetwork() {
    const wrapper = create('div', 'terminal-chart-wrap');
    const svg = createSvg('svg', {
      viewBox: '0 0 1000 560',
      role: 'img',
      'aria-label': localize(currentFunction().name),
      width: '100%',
      height: '520'
    });
    const applicable = state.atlas.relationships.filter(relationshipApplies);
    applicable.forEach((relation) => {
      const from = state.entityMap.get(relation.from);
      const to = state.entityMap.get(relation.to);
      if (!from || !to) return;
      const disclosed = String(relation.evidenceStatus || '').startsWith('disclosed');
      svg.appendChild(createSvg('line', {
        x1: 55 + Number(from.x) * 8.8,
        y1: 35 + Number(from.y) * 4.8,
        x2: 55 + Number(to.x) * 8.8,
        y2: 35 + Number(to.y) * 4.8,
        stroke: disclosed ? '#6e9af4' : '#29415f',
        'stroke-width': disclosed ? 1.8 : 1,
        'stroke-dasharray': disclosed ? '0' : '5 5',
        opacity: disclosed ? '.78' : '.56'
      }));
    });
    state.atlas.entities.forEach((entity) => {
      const group = createSvg('g', {
        transform: `translate(${55 + Number(entity.x) * 8.8} ${35 + Number(entity.y) * 4.8})`,
        tabindex: '0',
        role: 'button',
        'aria-label': `${entity.name} ${localize(entity.role)}`
      });
      group.append(
        createSvg('circle', {
          r: entity.id === state.entityId ? 8 : entity.kind === 'company' ? 6 : 5,
          fill: entity.id === state.entityId ? '#22d3ee' : entity.kind === 'company' ? '#6e9af4' : '#29415f',
          stroke: '#dbe5f1',
          'stroke-width': entity.id === state.entityId ? 1.4 : .5
        }),
        createSvg('text', {
          x: 10,
          y: 3,
          fill: '#dbe5f1',
          'font-size': '9',
          'font-family': 'IBM Plex Mono, monospace'
        }, entity.name)
      );
      const open = () => {
        state.entityId = entity.id;
        if (entity.ticker) state.symbol = String(entity.ticker).split(/[ /]/)[0];
        state.functionId = 'xray';
        syncShell();
        writeRoute('push');
        renderAtlas();
      };
      group.addEventListener('click', open);
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
      svg.appendChild(group);
    });
    wrapper.append(svg, create('p', 'terminal-chart-caption', localize(COPY.networkKeyboard)));
    return wrapper;
  }

  function relationCard(relation, counterpartId) {
    const counterpart = state.entityMap.get(counterpartId);
    const card = create('div', 'terminal-relation');
    card.append(
      create('strong', '', counterpart?.name || counterpartId),
      create('small', '', `${relation.type || 'relationship'} · ${relation.evidenceStatus || 'unknown'} · ${localize(COPY.amountUnknown)}`)
    );
    return card;
  }

  function xrayColumn(title, nodes) {
    const column = create('section', 'terminal-xray-column');
    column.appendChild(create('h3', '', title));
    if (nodes.length) nodes.forEach((node) => column.appendChild(node));
    else column.appendChild(create('div', 'terminal-relation', localize(COPY.noRelations)));
    return column;
  }

  function supplyXray() {
    const entity = atlasEntityForSelection();
    if (!entity) return unavailableNode('ATLAS:XRAY', atlasMeta(), localize(COPY.noRows));
    state.entityId = entity.id;
    const relations = state.atlas.relationships.filter(relationshipApplies);
    const upstream = relations.filter((relation) => relation.to === entity.id);
    const downstream = relations.filter((relation) => relation.from === entity.id);
    const toB = downstream.filter((relation) => !/end-market|consumer/i.test(`${relation.type} ${state.entityMap.get(relation.to)?.role?.en || ''}`));
    const toC = downstream.filter((relation) => !toB.includes(relation));
    const focal = create('div', 'terminal-relation');
    focal.append(
      create('strong', '', entity.name),
      create('small', '', `${entity.ticker || localize(COPY.category)} · ${localize(entity.role)}`)
    );
    const grid = create('div', 'terminal-xray-grid');
    grid.append(
      xrayColumn(localize(COPY.upstream), upstream.map((relation) => relationCard(relation, relation.from))),
      xrayColumn(localize(COPY.focal), [focal]),
      xrayColumn(localize(COPY.tob), toB.map((relation) => relationCard(relation, relation.to))),
      xrayColumn(localize(COPY.toc), toC.map((relation) => relationCard(relation, relation.to)))
    );
    return grid;
  }

  function financialRecord(entityId) {
    const records = state.atlas.financials?.[entityId];
    if (!records) return null;
    return records[state.year] || null;
  }

  function accountingFlow() {
    const entity = atlasEntityForSelection();
    const record = entity ? financialRecord(entity.id) : null;
    if (!record || !record.flow) return unavailableNode('ATLAS:FA', atlasMeta(), localize(COPY.noRows));
    const labels = {
      revenue: t3('營收', '营收', 'Revenue'),
      costOfRevenue: t3('營業成本', '营业成本', 'Cost of revenue'),
      operatingExpenses: t3('營運費用', '运营费用', 'Operating expenses'),
      operatingIncome: t3('營業利潤', '营业利润', 'Operating income')
    };
    return kpiStrip(Object.entries(record.flow).map(([key, value]) => ({
      label: localize(labels[key] || key),
      value: formatFinancial(value, record)
    })));
  }

  function formatFinancial(value, record) {
    const numeric = finiteNumber(value);
    if (numeric == null) return '—';
    const scale = record?.scale === 'millions' ? 'M' : record?.scale === 'billions' ? 'B' : record?.scale || '';
    return `${record?.currency || ''} ${formatNumber(numeric)}${scale ? ` ${scale}` : ''}`.trim();
  }

  function evidenceTable() {
    const rows = state.atlas.relationships.filter(relationshipApplies).map((relation) => {
      const sourceId = relation.evidenceByCanonicalYear?.[String(state.year)] ||
        relation.sourceId || relation.sourceIds?.[0] || '';
      const source = state.sourceMap.get(sourceId);
      return {
        relationship: relationLabel(relation),
        type: relation.type,
        evidence: relation.evidenceStatus,
        year: state.year,
        amount_status: relation.amountStatus,
        source: source?.title || sourceId || '—'
      };
    });
    return rows.length ? tableNode(rows) : unavailableNode('ATLAS:EVIDENCE', atlasMeta(), localize(COPY.noRelations));
  }

  function coverageView() {
    const coverage = state.atlas.coverage || {};
    const graph = coverage.graph || {};
    const financial = coverage.financialActuals || {};
    const pipeline = coverage.pipeline || {};
    return kpiStrip([
      { label: 'graph entities', value: graph.entityCount ?? '—' },
      { label: 'graph relationships', value: graph.relationshipCount ?? '—' },
      { label: 'disclosed relationships', value: graph.directDisclosedRelationshipCount ?? '—' },
      { label: 'FA companies', value: financial.companyCount ?? '—' },
      { label: 'company-years', value: financial.canonicalYearCount ?? '—' },
      { label: 'candidate entities', value: pipeline.candidateEntities ?? '—' },
      { label: 'queued tasks', value: pipeline.queuedTasksAtInitialization ?? '—' },
      { label: 'publication mode', value: pipeline.publicationMode ?? state.atlas.status }
    ]);
  }

  function supplyToolbar() {
    const toolbar = create('div', 'terminal-supply-toolbar');
    [
      { id: 'network', code: 'ATLAS', label: localize(COPY.atlasMode) },
      { id: 'chain', code: 'HIGHWAY', label: localize(COPY.highwayMode) },
      { id: 'xray', code: 'XRAY', label: localize(WORKSPACES[3].functions[3].name) },
      { id: 'flows', code: 'FLOW', label: localize(WORKSPACES[3].functions[4].name) },
      { id: 'evidence', code: 'EVD', label: localize(WORKSPACES[3].functions[5].name) },
      { id: 'coverage', code: 'COV', label: localize(WORKSPACES[3].functions[6].name) }
    ].forEach((item) => {
      const selected = (state.functionId === 'overview' && item.id === 'network') || state.functionId === item.id;
      const button = makeButton(`${item.code} · ${item.label}`, 'terminal-supply-mode', () => {
        selectFunction(item.id);
      });
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      toolbar.appendChild(button);
    });
    const yearWrap = create('label', 'terminal-supply-year');
    yearWrap.appendChild(create('span', '', 'YEAR'));
    const select = create('select');
    select.setAttribute('aria-label', localize(COPY.canonicalYear));
    for (let year = 2026; year >= 2010; year -= 1) {
      const option = create('option', '', String(year));
      option.value = String(year);
      select.appendChild(option);
    }
    select.value = state.year;
    select.addEventListener('change', () => {
      if (!/^(201\d|202[0-6])$/.test(select.value)) return;
      state.year = select.value;
      writeRoute('push');
      renderAtlas();
    });
    yearWrap.appendChild(select);
    toolbar.appendChild(yearWrap);
    return toolbar;
  }

  function supplyFocusSheet() {
    const root = create('div', 'terminal-focus-sheet');
    const entity = atlasEntityForSelection();
    if (!entity) {
      root.append(
        create('strong', '', t3('選擇一個節點', '选择一个节点', 'Select a node')[language]),
        create('p', '', t3(
          '點擊星點或道路節點，查看一跳供應商、ToB 客戶與證據狀態。',
          '点击星点或道路节点，查看一跳供应商、ToB 客户与证据状态。',
          'Select a star or highway node to inspect one-hop suppliers, ToB customers and evidence.'
        )[language])
      );
      return root;
    }
    const applies = state.atlas.relationships
      .filter(relationshipApplies)
      .filter((relation) => {
        return typeof window.YCAtlasVisuals?.hasEvidence === 'function'
          ? window.YCAtlasVisuals.hasEvidence(relation, state.year)
          : true;
      });
    const upstream = applies.filter((relation) => relation.to === entity.id);
    const downstream = applies.filter((relation) => relation.from === entity.id);
    root.append(
      create('code', '', entity.ticker || entity.id),
      create('h3', '', entity.name),
      create('p', '', localize(entity.role)),
      create('h4', '', `${localize(COPY.upstream)} · ${upstream.length}`)
    );
    upstream.slice(0, 8).forEach((relation) => root.appendChild(relationCard(relation, relation.from)));
    root.appendChild(create('h4', '', `${localize(COPY.tob)} / ${localize(COPY.toc)} · ${downstream.length}`));
    downstream.slice(0, 8).forEach((relation) => root.appendChild(relationCard(relation, relation.to)));
    if (!upstream.length && !downstream.length) {
      root.appendChild(create('p', '', localize(COPY.noRelations)));
    }
    return root;
  }

  async function renderAtlas(sequence = state.loadSequence, signal = state.loadController?.signal) {
    const activeFunction = currentFunction();
    try {
      await getAtlas();
    } catch (_) {
      if (signal?.aborted || sequence !== state.loadSequence) return;
      canvas.replaceChildren(unavailableNode(ENDPOINTS.market, {
        freshness: 'DISCLOSURE',
        permission: 'UNVERIFIED'
      }));
      setBusy(false);
      return;
    }
    if (signal?.aborted || sequence !== state.loadSequence) return;
    if (state.atlasVisual?.destroy) state.atlasVisual.destroy();
    state.atlasVisual = null;
    const screen = create('div', 'terminal-screen terminal-supply-screen');
    screen.append(
      screenHeader(
        activeFunction.id === 'chain'
          ? localize(COPY.highwayMode)
          : activeFunction.id === 'network' || activeFunction.id === 'overview'
            ? localize(COPY.atlasMode)
            : localize(activeFunction.name),
        localize(activeFunction.description),
        atlasMeta()
      ),
      supplyToolbar(),
      partialNotice()
    );
    const grid = create('div', 'terminal-grid');
    let bodyNode;
    const visualMode = activeFunction.id === 'network' || activeFunction.id === 'overview' || activeFunction.id === 'chain';
    const visualHost = visualMode ? create('div', 'terminal-atlas-visual-host') : null;
    if (visualMode) bodyNode = visualHost;
    else if (activeFunction.id === 'xray') bodyNode = supplyXray();
    else if (activeFunction.id === 'flows') bodyNode = accountingFlow();
    else if (activeFunction.id === 'evidence') bodyNode = evidenceTable();
    else if (activeFunction.id === 'coverage' || activeFunction.id === 'status') bodyNode = coverageView();
    else bodyNode = supplyStageGrid();
    const panelBody = create('div', 'terminal-panel-body');
    panelBody.appendChild(bodyNode);
    grid.appendChild(panel(
      visualMode
        ? activeFunction.id === 'chain' ? localize(COPY.highwayMode) : localize(COPY.atlasMode)
        : localize(activeFunction.name),
      panelBody,
      visualMode && state.entityId ? 9 : 12,
      `${localize(COPY.canonicalYear)} ${state.year}`
    ));
    if (visualMode && state.entityId) {
      const focusBody = create('div', 'terminal-panel-body');
      focusBody.appendChild(supplyFocusSheet());
      grid.appendChild(panel('X-RAY', focusBody, 3, state.entityId));
    }
    screen.appendChild(grid);
    canvas.replaceChildren(screen);
    state.lastMeta = atlasMeta();
    updateStatusbar();
    setBusy(false);
    if (visualMode && visualHost) {
      window.requestAnimationFrame(() => {
        if (signal?.aborted || sequence !== state.loadSequence || !visualHost.isConnected) return;
        const factory = activeFunction.id === 'chain'
          ? window.YCAtlasVisuals?.createHighway
          : window.YCAtlasVisuals?.createStarfield;
        if (typeof factory !== 'function') {
          visualHost.replaceChildren(unavailableNode('ATLAS:VISUAL', atlasMeta(), localize(COPY.unavailableBody)));
          return;
        }
        state.atlasVisual = factory(visualHost, state.atlas, {
          locale: language,
          year: state.year,
          focusId: state.entityId || null,
          onFocusChange: ({ entity }) => {
            if (!entity || entity.id === state.entityId) return;
            state.entityId = entity.id;
            state.securityName = entity.name || '';
            if (entity.ticker) state.symbol = String(entity.ticker).split(/[ /|,]+/)[0];
            writeRoute('replace');
            renderAtlas();
          }
        });
      });
    }
  }

  function statementTable(rows, record) {
    const normalized = Array.isArray(rows) ? rows.map((item) => ({
      [localize(COPY.metric)]: localize(item.label) || item.metric,
      [localize(COPY.value)]: formatFinancial(item.value, record),
      [localize(COPY.method)]: item.method || '—'
    })) : [];
    return normalized.length ? tableNode(normalized) : unavailableNode('ATLAS:FA', atlasMeta(), localize(COPY.noRows));
  }

  function renderAtlasFa() {
    const entity = atlasEntityForSelection();
    const record = entity ? financialRecord(entity.id) : null;
    if (!entity || !record) return false;
    state.entityId = entity.id;
    const screen = create('div', 'terminal-screen');
    screen.append(screenHeader(localize(currentFunction().name), entity.name, atlasMeta()), partialNotice());
    const securityHead = create('section', 'terminal-security-head');
    const identity = create('div', 'terminal-security-id');
    identity.append(create('code', '', entity.ticker || entity.id), create('h1', '', entity.name));
    securityHead.append(
      identity,
      append(create('div', 'terminal-security-stat'), [
        create('span', '', localize(COPY.canonicalYear)),
        create('strong', '', record.canonicalYear)
      ]),
      append(create('div', 'terminal-security-stat'), [
        create('span', '', localize(COPY.reportedYear)),
        create('strong', '', record.reportedFiscalYear || '—')
      ]),
      append(create('div', 'terminal-security-stat'), [
        create('span', '', localize(COPY.period)),
        create('strong', '', record.periodEnd || record.actualPeriod || '—')
      ])
    );
    screen.appendChild(securityHead);
    const grid = create('div', 'terminal-grid');
    const statementLabels = {
      income: t3('利潤表', '利润表', 'Income Statement'),
      balance: t3('資產負債表', '资产负债表', 'Balance Sheet'),
      cashflow: t3('現金流量表', '现金流量表', 'Cash Flow'),
      equity: t3('股東權益變動表', '股东权益变动表', 'Changes in Equity')
    };
    Object.entries(statementLabels).forEach(([key, label]) => {
      const bodyNode = create('div', 'terminal-panel-body');
      bodyNode.appendChild(statementTable(record[key], record));
      grid.appendChild(panel(localize(label), bodyNode, 6, `${record.currency || ''} · ${record.scale || ''}`));
    });
    screen.appendChild(grid);
    canvas.replaceChildren(screen);
    state.lastMeta = atlasMeta();
    updateStatusbar();
    setBusy(false);
    return true;
  }

  function renderWarehouseFa(result) {
    const record = result?.data?.financials;
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const profile = result.data.profile || {};
    const warehouseMeta = {
      ...result.meta,
      endpoint: 'warehouse.stockDetail',
      source: 'YICAPITAL WAREHOUSE'
    };
    const screen = create('div', 'terminal-screen');
    screen.appendChild(screenHeader(
      localize(currentFunction().name),
      String(profile.name || profile.enname || state.securityName || state.symbol),
      warehouseMeta
    ));
    const securityHead = create('section', 'terminal-security-head');
    const identity = create('div', 'terminal-security-id');
    identity.append(
      create('code', '', String(profile.ts_code || state.symbol || '—')),
      create('h1', '', String(profile.name || profile.enname || state.securityName || state.symbol || '—'))
    );
    securityHead.append(
      identity,
      append(create('div', 'terminal-security-stat'), [
        create('span', '', localize(COPY.canonicalYear)),
        create('strong', '', record.canonicalYear ?? state.year)
      ]),
      append(create('div', 'terminal-security-stat'), [
        create('span', '', localize(COPY.reportedYear)),
        create('strong', '', record.reportedFiscalYear || '—')
      ]),
      append(create('div', 'terminal-security-stat'), [
        create('span', '', localize(COPY.period)),
        create('strong', '', record.periodEnd || record.actualPeriod || '—')
      ])
    );
    screen.appendChild(securityHead);
    const grid = create('div', 'terminal-grid');
    const statementLabels = {
      income: t3('利潤表', '利润表', 'Income Statement'),
      balance: t3('資產負債表', '资产负债表', 'Balance Sheet'),
      cashflow: t3('現金流量表', '现金流量表', 'Cash Flow'),
      equity: t3('股東權益變動表', '股东权益变动表', 'Changes in Equity')
    };
    let rendered = 0;
    Object.entries(statementLabels).forEach(([key, label]) => {
      if (!Array.isArray(record[key]) || !record[key].length) return;
      const bodyNode = create('div', 'terminal-panel-body');
      bodyNode.appendChild(statementTable(record[key], record));
      grid.appendChild(panel(localize(label), bodyNode, 6, `${record.currency || ''} · ${record.scale || ''}`));
      rendered += 1;
    });
    if (!rendered) return false;
    screen.appendChild(grid);
    canvas.replaceChildren(screen);
    state.lastMeta = warehouseMeta;
    updateStatusbar();
    setBusy(false);
    return true;
  }

  function renderWarehouseModule(result, key) {
    const warehouse = result?.data?.supply;
    const warehouseMeta = {
      ...result?.meta,
      endpoint: 'warehouse.stockDetail',
      source: 'YICAPITAL WAREHOUSE'
    };
    let value = warehouse && typeof warehouse === 'object' ? warehouse[key] : null;
    if (key === 'supply' && warehouse && typeof warehouse === 'object') {
      const rows = [];
      (Array.isArray(warehouse.upstream) ? warehouse.upstream : []).forEach((item) => {
        rows.push({
          direction: 'upstream',
          company: item?.entity?.name || item?.edge?.from || '—',
          relationship: item?.edge?.type || '—',
          evidence: item?.edge?.evidenceStatus || '—',
          amount_status: item?.edge?.amountStatus || 'unknown'
        });
      });
      (Array.isArray(warehouse.downstream) ? warehouse.downstream : []).forEach((item) => {
        rows.push({
          direction: 'downstream',
          company: item?.entity?.name || item?.edge?.to || '—',
          relationship: item?.edge?.type || '—',
          evidence: item?.edge?.evidenceStatus || '—',
          amount_status: item?.edge?.amountStatus || 'unknown'
        });
      });
      value = rows.length ? rows : null;
    }
    if (value == null || (Array.isArray(value) && !value.length)) {
      const activeFunction = currentFunction();
      const screen = create('div', 'terminal-screen');
      screen.append(
        screenHeader(localize(activeFunction.name), localize(activeFunction.description), warehouseMeta),
        unavailableNode(ENDPOINTS.stockDetail, warehouseMeta, localize(COPY.noRows))
      );
      canvas.replaceChildren(screen);
      setBusy(false);
      return;
    }
    renderGeneric({ ...result, data: value, meta: warehouseMeta }, ENDPOINTS.stockDetail);
  }

  function renderValuation(result) {
    const market = result?.data?.market;
    if (!market || typeof market !== 'object') {
      renderWarehouseModule(result, 'valuation');
      return;
    }
    renderGeneric({ ...result, data: market }, ENDPOINTS.stockDetail);
  }

  function renderStatus(result) {
    const screen = create('div', 'terminal-screen');
    const meta = result?.meta || state.lastMeta || {
      source: 'CONTROL PLANE', freshness: 'UNKNOWN', permission: 'UNVERIFIED'
    };
    screen.appendChild(screenHeader(localize(COPY.status), localize(currentFunction().description), meta));
    if (result && (normalizedRows(result.data).length || kpisFrom(result.data).length)) {
      const grid = create('div', 'terminal-grid');
      const bodyNode = create('div', 'terminal-panel-body');
      const rows = normalizedRows(result.data);
      if (rows.length) bodyNode.appendChild(tableNode(rows));
      else bodyNode.appendChild(kpiStrip(kpisFrom(result.data)));
      grid.appendChild(panel(localize(COPY.status), bodyNode, 12));
      screen.appendChild(grid);
    } else {
      screen.appendChild(unavailableNode(ENDPOINTS.status, meta, localize(COPY.noRows)));
    }
    canvas.replaceChildren(screen);
    setBusy(false);
  }

  function renderRequiredSecurity() {
    const screen = create('div', 'terminal-screen');
    const activeFunction = currentFunction();
    screen.appendChild(screenHeader(localize(activeFunction.name), localize(activeFunction.description), {
      source: 'CONTROL PLANE',
      freshness: 'ON SELECTION',
      permission: 'NOT REQUESTED'
    }));
    const empty = create('div', 'terminal-empty');
    const content = create('div');
    content.append(create('strong', '', localize(COPY.searchHint)), create('p', '', localize(COPY.selectSecurity)));
    empty.appendChild(content);
    screen.appendChild(empty);
    canvas.replaceChildren(screen);
    setBusy(false);
  }

  async function loadMarketNews(signal, sequence) {
    const [marketResponse, newsResponse] = await Promise.allSettled([
      apiRequest(ENDPOINTS.market, {
        domain: 'Market',
        dataset: 'index_global',
        ...recentRange(14),
        limit: 400
      }, signal),
      apiRequest(ENDPOINTS.news, { dataset: 'news', src: 'sina', limit: 100 }, signal)
    ]);
    if (signal.aborted || sequence !== state.loadSequence) return;
    const marketResult = marketResponse.status === 'fulfilled' ? marketResponse.value : null;
    const newsResult = newsResponse.status === 'fulfilled' ? newsResponse.value : null;
    const failures = [marketResponse, newsResponse].filter((item) => item.status === 'rejected');
    if (failures.length) {
      const endpoints = failures.map((item) => item.reason?.endpoint || 'UNKNOWN').join(', ');
      showAlert(`${localize(COPY.unavailableTitle)} · ${endpoints} · ${localize(COPY.unavailableBody)}`);
    } else {
      showAlert('');
    }
    state.lastMeta = newsResult?.meta || marketResult?.meta || null;
    renderNewsResult(marketResult, newsResult);
  }

  async function loadHomeDashboard(signal, sequence) {
    const [marketResponse, newsResponse] = await Promise.allSettled([
      apiRequest(ENDPOINTS.market, {
        domain: 'Market',
        dataset: 'index_global',
        ...recentRange(45),
        limit: 800
      }, signal),
      apiRequest(ENDPOINTS.news, {
        dataset: 'news',
        src: 'sina',
        limit: 100
      }, signal)
    ]);
    if (signal.aborted || sequence !== state.loadSequence) return;
    const marketResult = marketResponse.status === 'fulfilled' ? marketResponse.value : null;
    const newsResult = newsResponse.status === 'fulfilled' ? newsResponse.value : null;
    const failures = [marketResponse, newsResponse].filter((item) => item.status === 'rejected');
    showAlert(failures.length
      ? `${localize(COPY.unavailableTitle)} · ${failures.map((item) => item.reason?.endpoint || 'UNKNOWN').join(', ')}`
      : '');
    renderHome(marketResult, newsResult);
  }

  async function loadDomainDashboard(signal, sequence) {
    const area = currentWorkspace();
    if (area.id === 'market') {
      await loadHomeDashboard(signal, sequence);
      return;
    }
    try {
      let result;
      let secondaryResult = null;
      if (area.id === 'etf') {
        const range = recentRange(45);
        const responses = await Promise.allSettled([
          apiRequest(ENDPOINTS.market, {
            domain: 'ETF',
            dataset: 'fund_daily',
            ts_code: '510300.SH',
            start: range.start,
            end: range.end,
            limit: 400
          }, signal),
          apiRequest(ENDPOINTS.market, {
            domain: 'ETF',
            dataset: 'etf_basic',
            limit: 400
          }, signal)
        ]);
        result = responses[0].status === 'fulfilled'
          ? responses[0].value
          : {
              data: [],
              meta: responses[0].reason?.meta || {
                source: 'TUSHARE',
                freshness: 'UNKNOWN',
                permission: responses[0].reason?.status === 403 ? 'DENIED' : 'UNVERIFIED'
              }
            };
        secondaryResult = responses[1].status === 'fulfilled' ? responses[1].value : null;
        if (!normalizedRows(result.data).length && !secondaryResult) throw responses[0].reason;
        if (secondaryResult) {
          result.meta = {
            ...result.meta,
            source: `${result.meta?.source || 'TUSHARE'} + ${secondaryResult.meta?.source || 'TUSHARE'}`,
            partial: result.meta?.partial === true || secondaryResult.meta?.partial === true
          };
        }
        if (responses.some((response) => response.status === 'rejected')) {
          showAlert(`${localize(COPY.unavailableTitle)} · ETF PARTIAL`);
        }
      } else {
        result = await apiRequest(
          ENDPOINTS.market,
          marketParameters(area, area.functions[0]),
          signal
        );
      }
      if (signal.aborted || sequence !== state.loadSequence) return;
      if (area.id !== 'etf') showAlert('');
      renderDomainDashboard(result, secondaryResult);
    } catch (error) {
      if (error.name === 'AbortError' || signal.aborted || sequence !== state.loadSequence) return;
      const meta = error.meta || {
        source: 'TUSHARE',
        freshness: 'UNKNOWN',
        permission: error.status === 403 ? 'DENIED' : 'UNVERIFIED'
      };
      state.lastMeta = meta;
      showAlert(`${localize(COPY.unavailableTitle)} · ${error.endpoint || ENDPOINTS.market}`);
      const areaName = `${area.code} · ${localize(area.name)}`;
      const screen = create('div', 'terminal-screen terminal-domain-screen');
      screen.append(
        screenHeader(areaName, localize(area.description), meta),
        unavailableNode(error.endpoint || ENDPOINTS.market, meta)
      );
      canvas.replaceChildren(screen);
      setBusy(false);
      updateStatusbar('error');
    }
  }

  async function loadCurrentFunction() {
    const sequence = ++state.loadSequence;
    if (state.loadController) state.loadController.abort();
    state.loadController = new AbortController();
    const signal = state.loadController.signal;
    const mode = terminalMode();
    const activeFunction = currentFunction();
    renderLoading();

    if (mode === 'home') {
      await loadHomeDashboard(signal, sequence);
      return;
    }
    if (mode === 'dashboard' || mode === 'equity-dashboard') {
      await loadDomainDashboard(signal, sequence);
      return;
    }

    if (activeFunction.requiresSecurity && !state.symbol) {
      renderRequiredSecurity();
      return;
    }
    if (activeFunction.loader === 'unavailable') {
      const screen = create('div', 'terminal-screen');
      const meta = {
        endpoint: `MODULE:${currentWorkspace().code}:${activeFunction.code}`,
        source: 'FUNCTION CONTRACT',
        freshness: 'NOT PUBLISHED',
        permission: 'NOT REQUESTED'
      };
      screen.append(
        screenHeader(localize(activeFunction.name), localize(activeFunction.description), meta),
        unavailableNode(meta.endpoint, meta, localize(COPY.notPublished))
      );
      canvas.replaceChildren(screen);
      state.lastMeta = meta;
      showAlert('');
      updateStatusbar();
      setBusy(false);
      return;
    }
    if (activeFunction.loader === 'atlas') {
      await renderAtlas(sequence, signal);
      return;
    }
    if (activeFunction.loader === 'fa') {
      try {
        const range = selectedYearRange();
        const result = await apiRequest(ENDPOINTS.stockDetail, {
          symbol: state.symbol,
          start: range.start,
          end: range.end
        }, signal);
        if (sequence !== state.loadSequence) return;
        if (renderWarehouseFa(result)) {
          showAlert('');
          return;
        }
      } catch (error) {
        if (error.name === 'AbortError' || signal.aborted) return;
        showAlert(`${localize(COPY.unavailableTitle)} · ${ENDPOINTS.stockDetail} · ${localize(COPY.partialBody)}`);
      }
      try {
        await getAtlas();
        if (sequence !== state.loadSequence) return;
        if (renderAtlasFa()) return;
      } catch (_) {
        // The explicit unavailable panel below remains the only output.
      }
      canvas.replaceChildren(unavailableNode(ENDPOINTS.stockDetail, {
        freshness: 'UNKNOWN',
        permission: 'UNVERIFIED'
      }));
      setBusy(false);
      return;
    }

    try {
      if (activeFunction.loader === 'market-news') {
        await loadMarketNews(signal, sequence);
        updateStatusbar();
        return;
      }
      let endpoint = ENDPOINTS.market;
      let parameters = marketParameters(currentWorkspace(), activeFunction);
      if (activeFunction.loader === 'quote') {
        endpoint = ENDPOINTS.quote;
        parameters = { symbol: state.symbol, asset: assetForSelection() };
      } else if (activeFunction.loader === 'history') {
        const range = selectedYearRange();
        endpoint = ENDPOINTS.history;
        parameters = {
          symbol: state.symbol,
          asset: assetForSelection(),
          start: range.start,
          end: range.end,
          limit: 6000
        };
      } else if (['detail', 'warehouse-module', 'valuation'].includes(activeFunction.loader)) {
        const range = selectedYearRange();
        endpoint = ENDPOINTS.stockDetail;
        parameters = { symbol: state.symbol, start: range.start, end: range.end };
      } else if (activeFunction.loader === 'news') {
        endpoint = ENDPOINTS.news;
        const range = selectedYearRange();
        parameters = state.symbol
          ? {
              dataset: 'anns_d',
              ts_code: state.symbol,
              start: range.start,
              end: range.end,
              limit: 100
            }
          : { dataset: 'news', src: 'sina', limit: 100 };
      } else if (activeFunction.loader === 'status') {
        endpoint = ENDPOINTS.status;
        parameters = {};
      }
      const result = await apiRequest(endpoint, parameters, signal);
      if (sequence !== state.loadSequence) return;
      state.lastMeta = result.meta;
      showAlert('');
      if (activeFunction.loader === 'quote') renderQuote(result);
      else if (activeFunction.loader === 'history') renderHistory(result);
      else if (activeFunction.loader === 'news') renderNewsResult(null, result);
      else if (activeFunction.loader === 'status') renderStatus(result);
      else if (activeFunction.loader === 'warehouse-module') {
        renderWarehouseModule(result, activeFunction.warehouseKey);
      } else if (activeFunction.loader === 'valuation') renderValuation(result);
      else renderGeneric(result, endpoint);
      updateStatusbar();
    } catch (error) {
      if (error.name === 'AbortError' || signal.aborted || sequence !== state.loadSequence) return;
      const meta = error.meta || {
        freshness: 'UNKNOWN',
        permission: error.status === 403 ? 'DENIED' : 'UNVERIFIED'
      };
      state.lastMeta = { ...meta, endpoint: error.endpoint || 'UNKNOWN' };
      showAlert(`${localize(COPY.unavailableTitle)} · ${error.endpoint || 'UNKNOWN'} · ${localize(COPY.unavailableBody)}`);
      const screen = create('div', 'terminal-screen');
      screen.append(
        screenHeader(localize(activeFunction.name), localize(activeFunction.description), state.lastMeta),
        unavailableNode(error.endpoint, meta)
      );
      canvas.replaceChildren(screen);
      setBusy(false);
      updateStatusbar('error');
    }
  }

  function normalizeSearchItem(item) {
    if (!item || typeof item !== 'object') return null;
    const symbol = String(item.symbol || item.ts_code || item.ticker || item.code || '').trim();
    const name = String(item.name || item.security_name || item.short_name || item.title || symbol).trim();
    if (!name && !symbol) return null;
    const type = String(item.type || item.kind || item.asset_class || item.assetClass || 'security').toLowerCase();
    let destination = String(item.workspace || item.domain || '').toLowerCase();
    if (!workspaceMap.has(destination)) {
      if (/fund|etf/.test(type)) destination = 'etf';
      else if (/bond|debt|convertible|fixed/.test(type)) destination = 'debt';
      else if (/future|option|derivative/.test(type)) destination = 'derivatives';
      else if (/fx|currency|money|rate/.test(type)) destination = 'money';
      else destination = 'stocks';
    }
    return {
      kind: 'security',
      code: symbol || destination.toUpperCase(),
      name: name || symbol,
      subtitle: String(item.exchange || item.market || item.description || type),
      type,
      workspace: destination,
      functionId: String(
        item.functionId || item.function_id ||
        (destination === 'stocks' ? 'overview' : destination === 'etf' ? 'quote' : 'overview')
      ),
      symbol,
      asset: String(item.asset || item.asset_class || ''),
      entityId: String(item.entity_id || item.entityId || '')
    };
  }

  function localMarketMatches(query) {
    const needle = query.toLocaleLowerCase();
    return MARKET_SHORTCUTS
      .filter((item) => `${item.symbol} ${item.name}`.toLocaleLowerCase().includes(needle))
      .slice(0, 8)
      .map((item) => ({
        kind: 'market',
        code: item.symbol,
        name: item.name,
        subtitle: 'Market · Tushare index',
        type: 'market',
        workspace: 'market',
        functionId: 'indices',
        symbol: item.symbol,
        asset: item.asset
      }));
  }

  function localFunctionMatches(query) {
    const needle = query.toLowerCase();
    const matches = [];
    WORKSPACES.forEach((area) => {
      area.functions.forEach((item) => {
        const haystack = `${area.code} ${localize(area.name)} ${item.code} ${localize(item.name)} ${localize(item.description)}`.toLowerCase();
        if (haystack.includes(needle)) {
          matches.push({
            kind: 'function',
            code: item.code,
            name: localize(item.name),
            subtitle: `${area.code} · ${localize(area.name)}`,
            type: 'function',
            workspace: area.id,
            functionId: item.id,
            symbol: ''
          });
        }
      });
    });
    return matches.slice(0, 8);
  }

  function localAtlasMatches(query) {
    if (!state.atlas) return [];
    const needle = query.toLowerCase();
    const matches = [];
    state.atlas.entities.filter((entity) => entity.kind === 'company').forEach((entity) => {
      if (!`${entity.name} ${entity.ticker || ''}`.toLowerCase().includes(needle)) return;
      const symbol = String(entity.ticker || '').split(/[ /]/)[0];
      matches.push({
        kind: 'atlas',
        code: symbol || 'SPLC',
        name: entity.name,
        subtitle: `Supply X-Ray · ${localize(COPY.partial)}`,
        type: 'atlas sample',
          workspace: 'supply',
          functionId: 'xray',
          symbol,
          asset: symbol && !symbol.includes('.') ? 'us-stock' : '',
          entityId: entity.id
      });
      if (state.atlas.financials?.[entity.id]) {
        matches.push({
          kind: 'atlas',
          code: symbol || 'FA',
          name: entity.name,
          subtitle: `FA · ${localize(COPY.partial)}`,
          type: 'atlas sample',
          workspace: 'stocks',
          functionId: 'financials',
          symbol,
          asset: symbol && !symbol.includes('.') ? 'us-stock' : '',
          entityId: entity.id
        });
      }
    });
    return matches.slice(0, 6);
  }

  function setActiveSearch(index) {
    const options = Array.from(searchResults.querySelectorAll('[role="option"]'));
    if (!options.length) return;
    state.activeSearchIndex = (index + options.length) % options.length;
    options.forEach((option, optionIndex) => {
      option.setAttribute('aria-selected', optionIndex === state.activeSearchIndex ? 'true' : 'false');
    });
    const active = options[state.activeSearchIndex];
    searchInput.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  }

  function closeSearch() {
    state.activeSearchIndex = -1;
    state.searchItems = [];
    searchResults.hidden = true;
    searchResults.replaceChildren();
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.removeAttribute('aria-activedescendant');
  }

  function chooseSearchItem(item) {
    if (!item || !workspaceMap.has(item.workspace)) return;
    state.workspace = item.workspace;
    const area = currentWorkspace();
    state.functionId = area.functions.some((candidate) => candidate.id === item.functionId)
      ? item.functionId
      : area.functions[0].id;
    state.symbol = item.symbol || '';
    state.asset = item.asset || '';
    state.securityName = item.name || item.symbol || '';
    state.entityId = item.entityId || '';
    searchInput.value = item.symbol ? `${item.name} · ${item.symbol}` : item.name;
    closeSearch();
    syncShell();
    writeRoute('push');
    loadCurrentFunction();
  }

  function renderSearchItems(items, failed) {
    searchResults.replaceChildren();
    state.searchItems = items;
    state.activeSearchIndex = -1;
    if (failed) {
      const failure = create('div', 'terminal-search-option');
      failure.setAttribute('role', 'status');
      failure.append(
        create('code', '', 'ERR'),
        append(create('span'), [
          create('strong', '', localize(COPY.searchUnavailable)),
          create('small', '', `${ENDPOINTS.search} · FRESHNESS UNKNOWN · PERMISSION UNVERIFIED`)
        ]),
        create('span', 'terminal-search-result-type', 'FAIL CLOSED')
      );
      searchResults.appendChild(failure);
    }
    if (!items.length && !failed) {
      const empty = create('div', 'terminal-search-option');
      empty.setAttribute('role', 'status');
      empty.append(
        create('code', '', '—'),
        append(create('span'), [
          create('strong', '', localize(COPY.searchEmpty)),
          create('small', '', localize(COPY.searchHint))
        ]),
        create('span', 'terminal-search-result-type', '')
      );
      searchResults.appendChild(empty);
    }
    items.forEach((item, index) => {
      const option = makeButton('', 'terminal-search-result', () => chooseSearchItem(item));
      option.id = `terminal-search-result-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.tabIndex = -1;
      option.append(
        create('code', 'terminal-search-result-code', item.code || '—'),
        append(create('span'), [
          create('strong', '', item.name),
          create('small', '', item.subtitle)
        ]),
        create('span', 'terminal-search-result-type', item.type)
      );
      option.addEventListener('pointerenter', () => setActiveSearch(index));
      searchResults.appendChild(option);
    });
    searchResults.hidden = false;
    searchInput.setAttribute('aria-expanded', 'true');
  }

  async function runSearch() {
    if (state.composing) return;
    const query = searchInput.value.trim();
    if (!query) {
      closeSearch();
      return;
    }
    const sequence = ++state.searchSequence;
    if (state.searchController) state.searchController.abort();
    state.searchController = new AbortController();
    const localItems = [
      ...localMarketMatches(query),
      ...localFunctionMatches(query),
      ...localAtlasMatches(query)
    ];
    try {
      const remoteResults = await Promise.allSettled([
        apiRequest(ENDPOINTS.search, {
          q: query,
          domain: 'Stocks',
          limit: 15
        }, state.searchController.signal),
        apiRequest(ENDPOINTS.search, {
          q: query,
          domain: 'Supply',
          limit: 8
        }, state.searchController.signal)
      ]);
      if (sequence !== state.searchSequence || state.composing) return;
      const fulfilled = remoteResults
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value);
      if (!fulfilled.length) throw remoteResults[0].reason;
      const serverItems = fulfilled
        .flatMap((result) => normalizedRows(result.data))
        .map(normalizeSearchItem)
        .filter(Boolean);
      const combined = [];
      const seen = new Set();
      [...serverItems, ...localItems].forEach((item) => {
        const key = `${item.workspace}:${item.functionId}:${item.symbol}:${item.entityId || ''}:${item.name}`;
        if (!seen.has(key) && combined.length < 20) {
          seen.add(key);
          combined.push(item);
        }
      });
      renderSearchItems(
        combined,
        remoteResults.some((result) => result.status === 'rejected')
      );
    } catch (error) {
      if (error.name === 'AbortError' || state.searchController.signal.aborted || sequence !== state.searchSequence) return;
      renderSearchItems(localItems, true);
    }
  }

  function scheduleSearch(delay) {
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(runSearch, delay == null ? 180 : delay);
  }

  function bindSearch() {
    searchInput.addEventListener('compositionstart', () => {
      state.composing = true;
      window.clearTimeout(state.searchTimer);
    });
    searchInput.addEventListener('compositionend', () => {
      state.composing = false;
      scheduleSearch(0);
    });
    searchInput.addEventListener('input', (event) => {
      if (state.composing || event.isComposing) return;
      scheduleSearch();
    });
    searchInput.addEventListener('keydown', (event) => {
      if (state.composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSearch();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const options = searchResults.querySelectorAll('[role="option"]');
        if (!options.length) return;
        event.preventDefault();
        setActiveSearch(state.activeSearchIndex + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.key === 'Enter') {
        const index = state.activeSearchIndex >= 0 ? state.activeSearchIndex : 0;
        const item = state.searchItems[index];
        if (item) {
          event.preventDefault();
          chooseSearchItem(item);
        }
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('.terminal-query')) closeSearch();
    });
  }

  function editableTarget(target) {
    if (!(target instanceof Element)) return false;
    return target.matches('input, textarea, select, [contenteditable="true"]') || Boolean(target.closest('[contenteditable="true"]'));
  }

  function bindGlobalKeys() {
    document.addEventListener('keydown', (event) => {
      if (state.composing || event.isComposing || event.keyCode === 229) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput.focus();
        searchInput.select();
        return;
      }
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !editableTarget(event.target)) {
        event.preventDefault();
        searchInput.focus();
        return;
      }
      if (event.altKey && !event.metaKey && !event.ctrlKey && /^[1-7]$/.test(event.key)) {
        event.preventDefault();
        const area = WORKSPACES[Number(event.key) - 1];
        if (area) selectWorkspace(area.id);
      }
    });
  }

  function statusPart(label, value, indicatorClass) {
    const item = create('span');
    item.append(create('i', indicatorClass || ''), document.createTextNode(`${label} ${value}`));
    return item;
  }

  function updateStatusbar(force) {
    const service = state.serviceStatus || {};
    const serviceText = String(
      service.ready === true ? 'READY'
        : service.token_configured === true ? 'TOKEN READY'
          : service.tushare?.status || service.tushare_status || service.status ||
            (force === 'error' ? 'UNAVAILABLE' : 'PENDING')
    ).toUpperCase();
    const serviceClass = /ok|ready|live|available|online/.test(serviceText.toLowerCase())
      ? 'is-live'
      : /fail|error|unavailable|offline/.test(serviceText.toLowerCase()) ? 'is-error' : 'is-pending';
    const meta = state.lastMeta || {};
    statusbar.replaceChildren(
      statusPart('TUSHARE', serviceText, serviceClass),
      statusPart(
        'WAREHOUSE 2010–2026',
        service.warehouse_ready === true
          ? service.warehouse_complete === true ? 'CONNECTED · COMPLETE' : 'CONNECTED · PARTIAL'
          : 'UNAVAILABLE',
        service.warehouse_ready === true
          ? service.warehouse_complete === true ? 'is-live' : 'is-pending'
          : 'is-error'
      ),
      statusPart('FRESHNESS', meta.freshness || 'UNKNOWN', freshnessClass(meta.freshness) === 'is-live' ? 'is-live' : 'is-pending'),
      statusPart('PERMISSION', meta.permission || 'UNVERIFIED', /denied|missing|unavailable/i.test(meta.permission || '') ? 'is-error' : 'is-pending'),
      create('span', '', 'NO MISSING-AS-ZERO')
    );
  }

  async function loadControlPlane() {
    const controller = new AbortController();
    const [bootstrapResponse, statusResponse] = await Promise.allSettled([
      apiRequest(ENDPOINTS.bootstrap, {}, controller.signal),
      apiRequest(ENDPOINTS.status, {}, controller.signal)
    ]);
    if (bootstrapResponse.status === 'fulfilled') {
      state.bootstrap = bootstrapResponse.value.data;
    } else {
      showAlert(localize(COPY.bootstrapFailed));
    }
    if (statusResponse.status === 'fulfilled') {
      state.serviceStatus = statusResponse.value.data || statusResponse.value.envelope;
      if (!state.lastMeta) state.lastMeta = statusResponse.value.meta;
    }
    updateStatusbar(statusResponse.status === 'rejected' ? 'error' : '');
  }

  function startClock() {
    const clock = document.querySelector('#terminal-clock');
    if (!clock) return;
    const tick = () => {
      const time = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Asia/Hong_Kong'
      }).format(new Date());
      clock.textContent = `HKT ${time}`;
    };
    tick();
    window.setInterval(tick, 1000);
  }

  function bindPopstate() {
    window.addEventListener('popstate', () => {
      readRoute();
      syncShell();
      loadCurrentFunction();
    });
  }

  function initialize() {
    initializeYearSelect();
    readRoute();
    syncShell();
    writeRoute('replace');
    bindSearch();
    bindGlobalKeys();
    bindPopstate();
    startClock();
    updateStatusbar();
    getAtlas().catch(() => {});
    loadControlPlane();
    loadCurrentFunction();
  }

  initialize();
})();
