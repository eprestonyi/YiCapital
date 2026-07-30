(function () {
  'use strict';

  const body = document.body;
  if (!body || !body.classList.contains('terminal-page')) return;

  const lang = body.dataset.terminalLang || 'tw';
  const locale = lang === 'en' ? 'en-US' : lang === 'cn' ? 'zh-CN' : 'zh-HK';
  const C = {
    tw: {
      markets: '市場快照',
      marketsIntro: '三個市場均讀取 YiCapital 已持久化的基準快照。每張卡都顯示來源日期、抓取時間與異常狀態；讀取失敗時不以示例數字替代。',
      marketSource: 'YICAPITAL MARKET SNAPSHOT',
      last: '最新',
      day: '單日',
      ytd: '年初至今',
      fetched: '抓取',
      snapshotFetched: '快照抓取',
      partialFetched: '部分抓取',
      lastAttempt: '最近嘗試',
      unavailable: '市場快照目前不可用；本頁已停止顯示該市場數字。',
      stale: '過期',
      current: '可用',
      supply: 'AI 算力供應鏈',
      supplyIntro: '同一份帶版本的快照提供左到右產業鏈、全局星雲與單公司 X-ray。實線是披露關係，虛線是分類關係，點線是模型化的類別連接；它們都不代表已知金額。',
      chain: '產業鏈',
      nebula: '星雲',
      xray: '公司 X-ray',
      disclosed: '披露關係',
      taxonomy: '分類關係',
      modelled: '模型類別關係',
      openXray: '打開公司 X-ray',
      zoom: '縮放',
      entities: '節點清單',
      relationships: '關係清單',
      upstream: '上游／設施',
      focal: '焦點公司',
      tob: 'ToB 下游',
      toc: 'ToC／終端市場',
      noRelations: '本快照沒有已發布的對應關係。缺失不代表不存在。',
      company: '公司',
      category: '類別節點',
      layer: '產業層',
      canonicalYear: '標準年度',
      ticker: '代號',
      notChecked: '尚未完成時點市值門檻檢查',
      source: '查看原始來源 ↗',
      financialSource: '財務報表來源 ↗',
      relationSource: '關係證據 ↗',
      taxonomyContext: '分類／成員關係',
      flow: '會計 Flow',
      flowIntro: 'Revenue − Cost of revenue − Opex = Operating income。Cost of revenue 並不等於支付給已命名供應商的現金。',
      revenue: '營收',
      cogs: '營業成本',
      opex: '營運費用',
      opIncome: '營業利潤',
      flowMissing: '本公司尚未有可發布的標準化會計 flow；不以估計值補空。',
      unallocated: '供應商金額、ToB／ToC 收入拆分與未分配殘差尚未披露。',
      financials: 'Financial Analysis',
      financialsIntro: 'Bloomberg FA 式的第一個讀取面：標準年度與公司實際財年同時顯示。首版只發布 NVIDIA 兩個年度的選定 GAAP 事實，並保留四張表、來源與方法狀態。',
      income: '利潤表',
      balance: '資產負債表',
      cashflow: '現金流量表',
      equity: '股東權益變動表',
      reportedFY: '實際財年',
      actualPeriod: '實際期間',
      coverage: '覆蓋狀態',
      currency: '幣種／單位',
      metric: '科目',
      method: '狀態',
      reported: 'R · 直接披露',
      derived: 'D · 推導',
      estimated: 'E · 估計',
      missing: '— · 缺失',
      faMissing: '此公司尚未有已發布的標準化財務事實。公司節點仍可存在，但缺失值不會被當成零。',
      status: '資料狀態',
      statusIntro: '這是資料產品的控制面，不是裝飾性的 confidence 分數。它公開快照、口徑版本、覆蓋分母、來源和仍然缺失的門檻條件。',
      prototype: '原型快照，尚非全市場完成版',
      prototypeBody: 'Atlas 僅發布帶來源的示範資料；{entities} 家候選公司仍由 Agent 隊列逐層處理。未通過 Evidence → Core → Graph → Audit 的資料不會成為正式圖譜。',
      snapshot: 'Snapshot ID',
      cutoff: '知識截止',
      taxonomyVersion: '分類版本',
      annualPolicy: '年度口徑',
      threshold: '市值門檻',
      thresholdDate: '門檻時點',
      graphEntities: '圖節點',
      graphRelations: '圖關係',
      actualYears: '已發布公司年度',
      queuedTasks: '初始化任務',
      pipelineMode: '發布模式',
      sources: '來源',
      marketStatus: '市場資料狀態',
      pending: '未設定；候選 Universe 不可視為通過',
      selectCompany: '選擇公司',
      searchEmpty: '找不到相符公司。',
      selected: '已選擇',
      loadingError: 'Terminal 核心快照讀取失敗。所有資料模組已停止渲染。',
      sourceStatus: 'PRIMARY',
      candidateOnly: 'candidate-only',
      partial: 'partial-selected-facts',
      notAmount: 'RELATIONSHIP ONLY',
      stageEvidence: 'Evidence',
      stageCore: 'Core',
      stageGraph: 'Graph',
      stageAudit: 'Audit'
    },
    cn: {
      markets: '市场快照',
      marketsIntro: '三个市场均读取 YiCapital 已持久化的基准快照。每张卡都显示来源日期、抓取时间与异常状态；读取失败时不以示例数字替代。',
      marketSource: 'YICAPITAL MARKET SNAPSHOT',
      last: '最新',
      day: '单日',
      ytd: '年初至今',
      fetched: '抓取',
      snapshotFetched: '快照抓取',
      partialFetched: '部分抓取',
      lastAttempt: '最近尝试',
      unavailable: '市场快照目前不可用；本页已停止显示该市场数字。',
      stale: '过期',
      current: '可用',
      supply: 'AI 算力供应链',
      supplyIntro: '同一份带版本的快照提供左到右产业链、全局星云与单公司 X-ray。实线是披露关系，虚线是分类关系，点线是模型化的类别连接；它们都不代表已知金额。',
      chain: '产业链',
      nebula: '星云',
      xray: '公司 X-ray',
      disclosed: '披露关系',
      taxonomy: '分类关系',
      modelled: '模型类别关系',
      openXray: '打开公司 X-ray',
      zoom: '缩放',
      entities: '节点清单',
      relationships: '关系列表',
      upstream: '上游／设施',
      focal: '焦点公司',
      tob: 'ToB 下游',
      toc: 'ToC／终端市场',
      noRelations: '本快照没有已发布的对应关系。缺失不代表不存在。',
      company: '公司',
      category: '类别节点',
      layer: '产业层',
      canonicalYear: '标准年度',
      ticker: '代码',
      notChecked: '尚未完成时点市值门槛检查',
      source: '查看原始来源 ↗',
      financialSource: '财务报表来源 ↗',
      relationSource: '关系证据 ↗',
      taxonomyContext: '分类／成员关系',
      flow: '会计 Flow',
      flowIntro: 'Revenue − Cost of revenue − Opex = Operating income。Cost of revenue 并不等于支付给已命名供应商的现金。',
      revenue: '营收',
      cogs: '营业成本',
      opex: '运营费用',
      opIncome: '营业利润',
      flowMissing: '本公司尚未有可发布的标准化会计 flow；不以估计值补空。',
      unallocated: '供应商金额、ToB／ToC 收入拆分与未分配残差尚未披露。',
      financials: 'Financial Analysis',
      financialsIntro: 'Bloomberg FA 式的第一个读取面：标准年度与公司实际财年同时显示。首版只发布 NVIDIA 两个年度的选定 GAAP 事实，并保留四张表、来源与方法状态。',
      income: '利润表',
      balance: '资产负债表',
      cashflow: '现金流量表',
      equity: '股东权益变动表',
      reportedFY: '实际财年',
      actualPeriod: '实际期间',
      coverage: '覆盖状态',
      currency: '币种／单位',
      metric: '科目',
      method: '状态',
      reported: 'R · 直接披露',
      derived: 'D · 推导',
      estimated: 'E · 估计',
      missing: '— · 缺失',
      faMissing: '此公司尚未有已发布的标准化财务事实。公司节点仍可存在，但缺失值不会被当成零。',
      status: '数据状态',
      statusIntro: '这是数据产品的控制面，不是装饰性的 confidence 分数。它公开快照、口径版本、覆盖分母、来源和仍然缺失的门槛条件。',
      prototype: '原型快照，尚非全市场完成版',
      prototypeBody: 'Atlas 仅发布带来源的示范数据；{entities} 家候选公司仍由 Agent 队列逐层处理。未通过 Evidence → Core → Graph → Audit 的数据不会成为正式图谱。',
      snapshot: 'Snapshot ID',
      cutoff: '知识截止',
      taxonomyVersion: '分类版本',
      annualPolicy: '年度口径',
      threshold: '市值门槛',
      thresholdDate: '门槛时点',
      graphEntities: '图节点',
      graphRelations: '图关系',
      actualYears: '已发布公司年度',
      queuedTasks: '初始化任务',
      pipelineMode: '发布模式',
      sources: '来源',
      marketStatus: '市场数据状态',
      pending: '未设置；候选 Universe 不可视为通过',
      selectCompany: '选择公司',
      searchEmpty: '找不到相符公司。',
      selected: '已选择',
      loadingError: 'Terminal 核心快照读取失败。所有数据模块已停止渲染。',
      sourceStatus: 'PRIMARY',
      candidateOnly: 'candidate-only',
      partial: 'partial-selected-facts',
      notAmount: 'RELATIONSHIP ONLY',
      stageEvidence: 'Evidence',
      stageCore: 'Core',
      stageGraph: 'Graph',
      stageAudit: 'Audit'
    },
    en: {
      markets: 'Market snapshots',
      marketsIntro: 'All three markets read YiCapital persisted benchmark snapshots. Every card exposes source date, fetch time and exceptions; a failed request never falls back to sample numbers.',
      marketSource: 'YICAPITAL MARKET SNAPSHOT',
      last: 'Last',
      day: 'Day',
      ytd: 'YTD',
      fetched: 'Fetched',
      snapshotFetched: 'Snapshot fetched',
      partialFetched: 'Partial fetched',
      lastAttempt: 'Last attempt',
      unavailable: 'This market snapshot is unavailable. Numeric rendering for this market has stopped.',
      stale: 'Stale',
      current: 'Available',
      supply: 'AI compute supply chain',
      supplyIntro: 'One versioned snapshot powers a left-to-right chain, a global nebula and company X-ray. Solid edges are disclosed relationships, dashed edges are taxonomy, and dotted edges are modelled category links; none implies a known amount.',
      chain: 'Industry Chain',
      nebula: 'Nebula',
      xray: 'Company X-ray',
      disclosed: 'Disclosed relationship',
      taxonomy: 'Taxonomy relationship',
      modelled: 'Modelled category link',
      openXray: 'Open company X-ray',
      zoom: 'Zoom',
      entities: 'Entity list',
      relationships: 'Relationship list',
      upstream: 'Suppliers / Facilities',
      focal: 'Focal company',
      tob: 'ToB downstream',
      toc: 'ToC / end market',
      noRelations: 'No corresponding relationship has been published in this snapshot. Missing does not mean absent.',
      company: 'Company',
      category: 'Category node',
      layer: 'Industry layer',
      canonicalYear: 'Canonical year',
      ticker: 'Ticker',
      notChecked: 'Point-in-time market-cap threshold not yet verified',
      source: 'Open primary source ↗',
      financialSource: 'Financial statement source ↗',
      relationSource: 'Relationship evidence ↗',
      taxonomyContext: 'Taxonomy / membership',
      flow: 'Accounting flow',
      flowIntro: 'Revenue − cost of revenue − opex = operating income. Cost of revenue is not cash paid to the named suppliers.',
      revenue: 'Revenue',
      cogs: 'Cost of revenue',
      opex: 'Operating expenses',
      opIncome: 'Operating income',
      flowMissing: 'No publishable standardized accounting flow exists for this company yet; estimates do not fill the gap.',
      unallocated: 'Supplier amounts, ToB / ToC revenue split and the unallocated residual remain undisclosed.',
      financials: 'Financial Analysis',
      financialsIntro: 'The first Bloomberg FA-style read surface shows canonical year beside the company’s actual fiscal year. V1 publishes only selected GAAP facts for two NVIDIA years, with four statements, source and method status preserved.',
      income: 'Income Statement',
      balance: 'Balance Sheet',
      cashflow: 'Cash Flow',
      equity: 'Changes in Equity',
      reportedFY: 'Reported fiscal year',
      actualPeriod: 'Actual period',
      coverage: 'Coverage',
      currency: 'Currency / scale',
      metric: 'Metric',
      method: 'Status',
      reported: 'R · Reported',
      derived: 'D · Derived',
      estimated: 'E · Estimated',
      missing: '— · Missing',
      faMissing: 'No published standardized financial facts exist for this company. The graph node may still exist, but missing values are never treated as zero.',
      status: 'Data status',
      statusIntro: 'This is the data product control plane, not a decorative confidence score. It exposes the snapshot, policy versions, coverage denominator, sources and unresolved threshold conditions.',
      prototype: 'Prototype snapshot, not full-market coverage',
      prototypeBody: 'Atlas publishes only sourced pilot data. The Agent queue is still processing {entities} candidate companies through Evidence → Core → Graph → Audit; records that fail those layers cannot become the official graph.',
      snapshot: 'Snapshot ID',
      cutoff: 'Knowledge cutoff',
      taxonomyVersion: 'Taxonomy version',
      annualPolicy: 'Annual policy',
      threshold: 'Market-cap threshold',
      thresholdDate: 'Threshold as of',
      graphEntities: 'Graph entities',
      graphRelations: 'Graph relationships',
      actualYears: 'Published company-years',
      queuedTasks: 'Initialized tasks',
      pipelineMode: 'Publication mode',
      sources: 'Sources',
      marketStatus: 'Market data status',
      pending: 'Unset; the candidate universe has not passed',
      selectCompany: 'Select company',
      searchEmpty: 'No matching company.',
      selected: 'Selected',
      loadingError: 'The Terminal core snapshot failed to load. Every data module has stopped rendering.',
      sourceStatus: 'PRIMARY',
      candidateOnly: 'candidate-only',
      partial: 'partial-selected-facts',
      notAmount: 'RELATIONSHIP ONLY',
      stageEvidence: 'Evidence',
      stageCore: 'Core',
      stageGraph: 'Graph',
      stageAudit: 'Audit'
    }
  }[lang] || null;

  if (!C) return;

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));
  const text = (value) => document.createTextNode(value == null ? '' : String(value));
  const el = (tag, className, children) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    (Array.isArray(children) ? children : children == null ? [] : [children]).forEach((child) => {
      node.appendChild(child instanceof Node ? child : text(child));
    });
    return node;
  };
  const svgEl = (tag, attrs) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  };
  const button = (label, className, onClick) => {
    const node = el('button', className, label);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  };
  const loc = (value) => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    return value[lang] || value.tw || value.cn || value.en || '';
  };
  const safeUrl = (value) => {
    try {
      const parsed = new URL(value, window.location.origin);
      return parsed.protocol === 'https:' || parsed.origin === window.location.origin ? parsed.href : null;
    } catch (_) {
      return null;
    }
  };
  const fmtNumber = (value, digits) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits == null ? 2 : digits }).format(value);
  const fmtPct = (value) => `${value >= 0 ? '+' : ''}${fmtNumber(value, 2)}%`;
  const fmtMoney = (value, record) => {
    if (!Number.isFinite(value)) return '—';
    const currency = record?.currency || 'USD';
    const scale = record?.scale || 'millions';
    const prefixes = {
      USD: '$',
      HKD: 'HK$',
      CNY: 'CN¥',
      TWD: 'NT$',
      JPY: 'JP¥',
      KRW: '₩',
      EUR: '€',
      GBP: '£'
    };
    const prefix = prefixes[currency] || `${currency} `;
    const sign = value < 0 ? '−' : '';
    const absolute = Math.abs(value);
    if (scale === 'billions') return `${sign}${prefix}${fmtNumber(absolute, 1)}B`;
    if (scale === 'millions') {
      return absolute >= 1000
        ? `${sign}${prefix}${fmtNumber(absolute / 1000, 1)}B`
        : `${sign}${prefix}${fmtNumber(absolute, 0)}M`;
    }
    if (scale === 'thousands') {
      if (absolute >= 1000000) return `${sign}${prefix}${fmtNumber(absolute / 1000000, 1)}B`;
      if (absolute >= 1000) return `${sign}${prefix}${fmtNumber(absolute / 1000, 1)}M`;
      return `${sign}${prefix}${fmtNumber(absolute, 0)}K`;
    }
    if (scale === 'units') {
      if (absolute >= 1000000000) return `${sign}${prefix}${fmtNumber(absolute / 1000000000, 1)}B`;
      if (absolute >= 1000000) return `${sign}${prefix}${fmtNumber(absolute / 1000000, 1)}M`;
      if (absolute >= 1000) return `${sign}${prefix}${fmtNumber(absolute / 1000, 1)}K`;
      return `${sign}${prefix}${fmtNumber(absolute, 0)}`;
    }
    return `${sign}${prefix}${fmtNumber(absolute, 2)} ${scale}`;
  };
  const fmtDate = (value) => {
    if (!value) return '—';
    const date = new Date(`${value}`.length === 10 ? `${value}T00:00:00Z` : value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  };

  const state = {
    seed: null,
    entities: new Map(),
    sources: new Map(),
    module: 'markets',
    supplyView: 'chain',
    entityId: 'nvda',
    year: '2025',
    faStatement: 'income',
    zoom: 1,
    markets: new Map(),
    chainObserver: null
  };

  function sourceById(id) {
    return state.sources.get(id) || null;
  }

  function relationshipSourceId(relationship) {
    const yearBound = relationship?.evidenceByCanonicalYear?.[String(state.year)];
    if (yearBound) return yearBound;
    if (/disclosed/i.test(relationship?.evidenceStatus || '')) {
      return null;
    }
    return relationship?.sourceId || relationship?.sourceIds?.[0] || null;
  }

  function relationshipApplies(relationship) {
    const years = relationship.validCanonicalYears;
    return Array.isArray(years) && years.includes(Number(state.year));
  }

  function validateSeed(seed) {
    if (!seed || !['partial', 'validated', 'published'].includes(seed.status)) {
      throw new Error('Unsupported snapshot status');
    }
    if (!Array.isArray(seed.layers) || !Array.isArray(seed.entities) ||
        !Array.isArray(seed.relationships) || !Array.isArray(seed.sources)) {
      throw new Error('Snapshot collections are incomplete');
    }
    if (!seed.coverage || !seed.scope || !seed.financials || typeof seed.financials !== 'object') {
      throw new Error('Snapshot control metadata is incomplete');
    }

    const uniqueMap = (rows, label) => {
      const map = new Map();
      rows.forEach((row) => {
        if (!row || typeof row.id !== 'string' || !row.id || map.has(row.id)) {
          throw new Error(`Invalid or duplicate ${label} id`);
        }
        map.set(row.id, row);
      });
      return map;
    };
    const layerIds = new Set(seed.layers.map((layer) => layer?.id));
    if (layerIds.has(undefined) || layerIds.size !== seed.layers.length) {
      throw new Error('Invalid or duplicate layer id');
    }
    const entities = uniqueMap(seed.entities, 'entity');
    const sources = uniqueMap(seed.sources, 'source');
    uniqueMap(seed.relationships, 'relationship');

    seed.entities.forEach((entity) => {
      if (!layerIds.has(entity.layer) || !Number.isFinite(entity.x) || !Number.isFinite(entity.y)) {
        throw new Error(`Invalid entity geometry: ${entity.id}`);
      }
    });
    seed.sources.forEach((source) => {
      if (!safeUrl(source.url)) throw new Error(`Invalid source URL: ${source.id}`);
    });
    seed.relationships.forEach((relationship) => {
      if (!entities.has(relationship.from) || !entities.has(relationship.to)) {
        throw new Error(`Relationship endpoint missing: ${relationship.id}`);
      }
      const sourceIds = [
        relationship.sourceId,
        ...(relationship.sourceIds || []),
        ...Object.values(relationship.evidenceByCanonicalYear || {})
      ].filter(Boolean);
      if (/disclosed/i.test(relationship.evidenceStatus || '') && !sourceIds.length) {
        throw new Error(`Disclosed relationship lacks evidence: ${relationship.id}`);
      }
      if (/disclosed/i.test(relationship.evidenceStatus || '')) {
        const years = relationship.validCanonicalYears;
        const byYear = relationship.evidenceByCanonicalYear;
        if (!Array.isArray(years) || !byYear ||
            years.some((year) => !sources.has(byYear[String(year)]))) {
          throw new Error(`Disclosed relationship lacks year-bound evidence: ${relationship.id}`);
        }
      }
      sourceIds.forEach((sourceId) => {
        if (!sources.has(sourceId)) throw new Error(`Relationship source missing: ${relationship.id}`);
      });
      if (relationship.validCanonicalYears &&
          (!Array.isArray(relationship.validCanonicalYears) ||
           relationship.validCanonicalYears.some((year) => !Number.isInteger(year)))) {
        throw new Error(`Invalid relationship years: ${relationship.id}`);
      }
    });

    const finiteFactArray = (rows, context) => {
      if (!Array.isArray(rows)) throw new Error(`Missing statement: ${context}`);
      rows.forEach((fact) => {
        if (!fact || typeof fact.metric !== 'string' || !Number.isFinite(fact.value) ||
            !/^(disclosed|derived|estimated)/.test(fact.method || '')) {
          throw new Error(`Invalid fact: ${context}`);
        }
      });
    };
    Object.entries(seed.financials).forEach(([entityId, years]) => {
      if (!entities.has(entityId) || !years || typeof years !== 'object') {
        throw new Error(`Invalid financial company: ${entityId}`);
      }
      Object.entries(years).forEach(([year, record]) => {
        if (!record || String(record.canonicalYear) !== year ||
            typeof record.currency !== 'string' || typeof record.scale !== 'string' ||
            !sources.has(record.sourceId)) {
          throw new Error(`Invalid financial record: ${entityId}.${year}`);
        }
        ['income', 'balance', 'cashflow', 'equity'].forEach((statement) =>
          finiteFactArray(record[statement], `${entityId}.${year}.${statement}`)
        );
        const flow = record.flow;
        const flowValues = flow && [
          flow.revenue,
          flow.costOfRevenue,
          flow.operatingExpenses,
          flow.operatingIncome
        ];
        if (!flowValues || flowValues.some((value) => !Number.isFinite(value)) ||
            Math.abs(flow.revenue - flow.costOfRevenue - flow.operatingExpenses - flow.operatingIncome) > 0.001) {
          throw new Error(`Invalid accounting flow: ${entityId}.${year}`);
        }
      });
    });

    const disclosedCount = seed.relationships.filter((relationship) =>
      /disclosed/i.test(relationship.evidenceStatus || '')
    ).length;
    if (seed.coverage.graph.entityCount !== seed.entities.length ||
        seed.coverage.graph.relationshipCount !== seed.relationships.length ||
        seed.coverage.graph.directDisclosedRelationshipCount !== disclosedCount) {
      throw new Error('Snapshot coverage counts do not reconcile');
    }
    return true;
  }

  function updateHeroStatus() {
    const coverage = state.seed.coverage;
    const publication = $('#terminal-publication-chip');
    const coverageChip = $('#terminal-coverage-chip');
    const pipeline = $('#terminal-pipeline-chip');
    if (publication) {
      publication.className = `terminal-status-chip ${
        state.seed.status === 'published' ? 'is-current' :
          state.seed.status === 'validated' ? 'is-partial' : 'is-prototype'
      }`;
      publication.textContent = coverage.publicationStatus || state.seed.status;
    }
    if (coverageChip) {
      coverageChip.className = 'terminal-status-chip is-partial';
      coverageChip.textContent = `${coverage.financialActuals.companyCount} ${
        lang === 'en' ? 'company' : '家公司'
      } · ${coverage.financialActuals.canonicalYearCount} ${
        lang === 'en' ? 'company-years' : '公司年度'
      }`;
    }
    if (pipeline) {
      pipeline.className = 'terminal-status-chip is-candidate';
      pipeline.textContent = coverage.pipeline.publicationMode || C.candidateOnly;
    }
  }

  function statusClass(relationship) {
    const value = relationship.evidenceStatus || '';
    if (value.indexOf('taxonomy') >= 0) return 'is-taxonomy';
    if (value.indexOf('modelled') >= 0) return 'is-modelled';
    return '';
  }

  const relationshipTypeLabels = {
    supplier: { tw: '供應商', cn: '供应商', en: 'Supplier' },
    'assembly-test-packaging': { tw: '組裝／測試／封裝', cn: '组装／测试／封装', en: 'Assembly / test / packaging' },
    'customer-class': { tw: '客戶類別', cn: '客户类别', en: 'Customer class' },
    'end-market-exposure': { tw: '間接終端需求', cn: '间接终端需求', en: 'Indirect end-market exposure' },
    'value-chain': { tw: '價值鏈連接', cn: '价值链连接', en: 'Value-chain link' },
    'taxonomy-membership': { tw: '分類成員', cn: '分类成员', en: 'Taxonomy membership' }
  };
  const relationshipTypeLabel = (relationship) =>
    loc(relationshipTypeLabels[relationship.type]) || relationship.type;
  const evidenceStatusLabel = (relationship) => {
    const status = relationship.evidenceStatus || '';
    if (status.includes('taxonomy')) return C.taxonomy;
    if (status.includes('modelled')) return C.modelled;
    if (status.includes('disclosed')) return C.disclosed;
    return C.missing;
  };

  function panelHead(kicker, title, intro, actions) {
    const copy = el('div', 'terminal-panel-head-copy', [
      el('div', 'terminal-section-kicker', kicker),
      el('h2', '', title),
      el('p', '', intro)
    ]);
    return el('div', 'terminal-panel-head', [
      copy,
      actions ? el('div', 'terminal-panel-actions', actions) : null
    ].filter(Boolean));
  }

  function updateUrl() {
    const params = new URLSearchParams(window.location.search);
    params.set('module', state.module);
    params.set('entity', state.entityId);
    params.set('year', state.year);
    if (state.module === 'supply') params.set('view', state.supplyView);
    else params.delete('view');
    const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState(null, '', next);
    updateLanguageLinks();
  }

  function updateLanguageLinks() {
    const suffix = `${window.location.search}${window.location.hash}`;
    const paths = lang === 'tw'
      ? ['terminal', 'cn/terminal', 'en/terminal']
      : ['../terminal', '../cn/terminal', '../en/terminal'];
    $$('[data-language-link]').forEach((link, index) => {
      link.href = `${paths[index]}${suffix}`;
    });
  }

  function setModule(module, focusPanel) {
    if (!['markets', 'supply', 'financials', 'status'].includes(module)) return;
    state.module = module;
    $$('[data-terminal-module]').forEach((tab) => {
      const selected = tab.dataset.terminalModule === module;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    });
    $$('[data-terminal-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.terminalPanel !== module;
    });
    updateUrl();
    if (module === 'supply') renderSupply();
    if (module === 'financials') renderFinancials();
    if (module === 'status') renderStatus();
    if (focusPanel) $(`[data-terminal-panel="${module}"]`)?.focus({ preventScroll: true });
  }

  function selectEntity(id, module, view) {
    if (!state.entities.has(id)) return;
    state.entityId = id;
    if (module) state.module = module;
    if (view) state.supplyView = view;
    const input = $('#terminal-company-search');
    if (input) {
      const entity = state.entities.get(id);
      input.value = entity.ticker ? `${entity.name} · ${entity.ticker}` : entity.name;
    }
    renderSupply();
    renderFinancials();
    updateUrl();
    const live = $('#terminal-live');
    if (live) live.textContent = `${C.selected}: ${state.entities.get(id).name}`;
  }

  function loadQueryState() {
    const params = new URLSearchParams(window.location.search);
    const module = params.get('module');
    const view = params.get('view');
    const entity = params.get('entity');
    const year = params.get('year');
    if (['markets', 'supply', 'financials', 'status'].includes(module)) state.module = module;
    if (['chain', 'nebula', 'xray'].includes(view)) state.supplyView = view;
    if (entity && state.entities.has(entity)) state.entityId = entity;
    if (year && /^\d{4}$/.test(year)) state.year = year;
  }

  function initYears() {
    const years = new Set();
    Object.values(state.seed.financials || {}).forEach((records) => {
      Object.keys(records || {}).forEach((year) => years.add(year));
    });
    state.seed.relationships.forEach((relationship) => {
      (relationship.validCanonicalYears || []).forEach((year) => years.add(String(year)));
    });
    const select = $('#terminal-year');
    select.replaceChildren();
    [...years].sort((a, b) => Number(b) - Number(a)).forEach((year) => {
      const option = el('option', '', year);
      option.value = year;
      select.appendChild(option);
    });
    if (!years.has(state.year)) state.year = [...years].sort((a, b) => Number(b) - Number(a))[0] || '2025';
    select.value = state.year;
    select.addEventListener('change', () => {
      state.year = select.value;
      renderSupply();
      renderFinancials();
      updateUrl();
    });
  }

  function initSearch() {
    const input = $('#terminal-company-search');
    const results = $('#terminal-search-results');
    const searchable = [...state.entities.values()].filter((entity) => entity.kind === 'company');
    let activeIndex = -1;
    const options = () => $$('[role="option"]', results);
    const setActive = (index) => {
      const items = options();
      if (!items.length) return;
      activeIndex = (index + items.length) % items.length;
      items.forEach((item, itemIndex) => {
        const active = itemIndex === activeIndex;
        item.setAttribute('aria-selected', active ? 'true' : 'false');
        if (active) input.setAttribute('aria-activedescendant', item.id);
      });
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    };
    const close = () => {
      activeIndex = -1;
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };
    const render = () => {
      const query = input.value.trim().toLowerCase();
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      results.replaceChildren();
      if (!query) {
        close();
        return;
      }
      const matches = searchable.filter((entity) =>
        `${entity.name} ${entity.ticker || ''}`.toLowerCase().includes(query)
      ).slice(0, 8);
      if (!matches.length) {
        results.appendChild(el('div', 'terminal-search-empty', C.searchEmpty));
      } else {
        matches.forEach((entity, index) => {
          const item = button('', 'terminal-search-option', () => {
            selectEntity(entity.id, 'supply', 'xray');
            setModule('supply');
            close();
          });
          item.id = `terminal-search-option-${index}`;
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', 'false');
          item.tabIndex = -1;
          item.addEventListener('mouseenter', () => setActive(index));
          item.append(
            el('strong', '', entity.name),
            el('small', '', `${entity.ticker || C.category} · ${loc(entity.role)}`)
          );
          results.appendChild(item);
        });
      }
      results.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    input.addEventListener('input', render);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = options();
        if (!items.length) return;
        event.preventDefault();
        setActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
      }
      if (event.key === 'Enter') {
        const items = options();
        const selected = items[activeIndex >= 0 ? activeIndex : 0];
        if (selected) {
          event.preventDefault();
          selected.click();
        }
      }
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.terminal-search-wrap')) close();
    });
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.focus();
        input.select();
      }
    });
    selectEntity(state.entityId);
  }

  function marketMetrics(series) {
    const rows = Array.isArray(series)
      ? series
        .filter((row) =>
          row &&
          row.close !== null &&
          row.close !== '' &&
          Number.isFinite(Number(row.close)) &&
          /^\d{4}-\d{2}-\d{2}$/.test(String(row.date || ''))
        )
        .slice()
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      : [];
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    const previous = rows.length > 1 ? rows[rows.length - 2] : null;
    const latestYear = String(last.date || '').slice(0, 4);
    const firstLatestYearIndex = rows.findIndex((row) => String(row.date || '').startsWith(latestYear));
    const ytdBase = firstLatestYearIndex > 0 ? rows[firstLatestYearIndex - 1] : null;
    const day = previous ? (Number(last.close) / Number(previous.close) - 1) * 100 : null;
    const ytd = ytdBase && Number(ytdBase.close) ? (Number(last.close) / Number(ytdBase.close) - 1) * 100 : null;
    return { last, day, ytd };
  }

  function renderMarkets() {
    const panel = $('#terminal-panel-markets');
    const refresh = button(lang === 'en' ? 'Refresh' : lang === 'cn' ? '刷新' : '重新整理', 'terminal-action', fetchMarkets);
    const root = document.createDocumentFragment();
    root.appendChild(panelHead('MARKETS', C.markets, C.marketsIntro, [refresh]));
    const grid = el('div', 'terminal-market-grid');
    [
      { id: 'us', title: lang === 'en' ? 'United States' : lang === 'cn' ? '美国市场' : '美國市場' },
      { id: 'hk', title: lang === 'en' ? 'Hong Kong' : lang === 'cn' ? '香港市场' : '香港市場' },
      { id: 'a', title: lang === 'en' ? 'Mainland China' : lang === 'cn' ? 'A 股市场' : 'A 股市場' }
    ].forEach((market) => {
      const card = el('article', 'terminal-market-card');
      const result = state.markets.get(market.id);
      const payload = result?.payload;
      const stale = payload && (
        payload.stale === true ||
        payload.unavailable === true ||
        (Array.isArray(payload.missing) && payload.missing.length > 0)
      );
      const unavailable = !result || result.error || !payload;
      const chipLabel = result?.loading
        ? `${C.fetched}…`
        : unavailable
          ? C.unavailable
          : stale
            ? C.stale
            : C.current;
      const chipClass = result?.loading
        ? 'is-neutral'
        : unavailable
          ? 'is-error'
          : stale
            ? 'is-candidate'
            : 'is-current';
      card.appendChild(el('div', 'terminal-market-card-head', [
        el('div', '', [el('h3', '', market.title), el('p', '', C.marketSource)]),
        el('span', `terminal-status-chip ${chipClass}`, chipLabel)
      ]));
      if (!result || result.error || !result.payload) {
        card.appendChild(el('div', 'terminal-market-unavailable', result?.loading ? `${C.fetched}…` : C.unavailable));
      } else {
        const cardStatus = $('.terminal-status-chip', card);
        cardStatus.textContent = stale ? C.stale : C.current;
        const marketBody = el('div', 'terminal-market-body');
        let renderedSeries = 0;
        Object.entries(payload.data || {}).forEach(([name, series]) => {
          const metrics = marketMetrics(series);
          if (!metrics) return;
          renderedSeries += 1;
          const row = el('div', 'terminal-benchmark-row');
          row.appendChild(el('div', 'terminal-benchmark-name', [
            name,
            el('small', '', fmtDate(metrics.last.date))
          ]));
          const last = el('div', 'terminal-market-value', [
            el('small', '', C.last),
            fmtNumber(Number(metrics.last.close), 2)
          ]);
          const day = el('div', `terminal-market-value ${metrics.day == null ? '' : metrics.day >= 0 ? 'is-up' : 'is-down'}`, [
            el('small', '', C.day),
            metrics.day == null ? '—' : fmtPct(metrics.day)
          ]);
          const ytd = el('div', `terminal-market-value ${metrics.ytd == null ? '' : metrics.ytd >= 0 ? 'is-up' : 'is-down'}`, [
            el('small', '', C.ytd),
            metrics.ytd == null ? '—' : fmtPct(metrics.ytd)
          ]);
          row.append(last, day, ytd);
          marketBody.appendChild(row);
        });
        if (!renderedSeries) {
          cardStatus.textContent = C.unavailable;
          cardStatus.classList.remove('is-current', 'is-candidate');
          cardStatus.classList.add('is-error');
          card.appendChild(el('div', 'terminal-market-unavailable', C.unavailable));
        } else {
          card.appendChild(marketBody);
          const freshness = [
            payload.fetched ? el('span', '', `${C.snapshotFetched}: ${fmtDate(payload.fetched)}`) : null,
            payload.partialFetched ? el('span', '', `${C.partialFetched}: ${fmtDate(payload.partialFetched)}`) : null,
            payload.lastAttempt ? el('span', '', `${C.lastAttempt}: ${fmtDate(payload.lastAttempt)}`) : null,
            el('span', '', stale ? `${C.stale}${payload.missing?.length ? ` · ${payload.missing.join(', ')}` : ''}` : C.current)
          ].filter(Boolean);
          card.appendChild(el('div', 'terminal-market-meta', freshness));
        }
      }
      grid.appendChild(card);
    });
    root.appendChild(grid);
    root.appendChild(el('div', 'terminal-note terminal-market-legend', [
      el('strong', '', lang === 'en' ? 'Definition: ' : lang === 'cn' ? '口径：' : '口徑：'),
      lang === 'en'
        ? 'Day uses the immediately prior available observation; YTD uses the last available close of the prior calendar year. If that base is absent, YTD stays missing. Market snapshots can be delayed.'
        : lang === 'cn'
          ? '单日使用紧邻的上一条可用观测；YTD 使用上一自然年的最后一条可用收盘。缺少基准时保持缺失。市场快照可能延迟。'
          : '單日使用緊鄰的上一條可用觀測；YTD 使用上一自然年的最後一條可用收盤。缺少基準時保持缺失。市場快照可能延遲。'
    ]));
    panel.replaceChildren(root);
  }

  async function fetchMarkets() {
    ['us', 'hk', 'a'].forEach((id) => state.markets.set(id, { loading: true }));
    renderMarkets();
    const base = String(window.YC_API || window.location.origin).replace(/\/+$/, '');
    await Promise.all(['us', 'hk', 'a'].map(async (id) => {
      try {
        const response = await fetch(`${base}/api/benchmark?set=${encodeURIComponent(id)}`, {
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!payload || payload.ok !== true || !payload.data) throw new Error('Invalid payload');
        state.markets.set(id, { payload });
      } catch (error) {
        state.markets.set(id, { error: String(error) });
      }
    }));
    renderMarkets();
    if (state.module === 'status') renderStatus();
  }

  function graphNode(entity) {
    const node = button('', `terminal-graph-node layer-${entity.layer}${entity.id === state.entityId ? ' is-selected' : ''}`, () => {
      selectEntity(entity.id, 'supply', state.supplyView);
      if (state.supplyView === 'xray') renderSupply();
    });
    node.dataset.entity = entity.id;
    node.append(
      el('strong', '', entity.name),
      el('code', '', entity.ticker || C.category),
      el('small', '', loc(entity.role))
    );
    return node;
  }

  function edgeLegend() {
    return el('div', 'terminal-edge-legend', [
      el('span', '', [el('i', 'terminal-edge-sample'), C.disclosed]),
      el('span', '', [el('i', 'terminal-edge-sample is-taxonomy'), C.taxonomy]),
      el('span', '', [el('i', 'terminal-edge-sample is-modelled'), C.modelled])
    ]);
  }

  function accessibleGraph() {
    const details = el('details', 'terminal-accessible-alt');
    details.appendChild(el('summary', '', lang === 'en' ? 'Accessible entity and relationship lists' : lang === 'cn' ? '无障碍节点与关系列表' : '無障礙節點與關係清單'));
    const entityList = el('div', 'terminal-accessible-list');
    state.seed.entities.forEach((entity) => {
      entityList.appendChild(button(`${entity.name}${entity.ticker ? ` · ${entity.ticker}` : ''}`, '', () => {
        selectEntity(entity.id, 'supply', 'xray');
        renderSupply();
      }));
    });
    const relationList = el('ul', 'terminal-relationship-list');
    state.seed.relationships.filter(relationshipApplies).forEach((relationship) => {
      const from = state.entities.get(relationship.from);
      const to = state.entities.get(relationship.to);
      relationList.appendChild(el('li', '', [
        el('strong', '', `${from?.name || relationship.from} → ${to?.name || relationship.to}`),
        ` · ${relationshipTypeLabel(relationship)} · ${evidenceStatusLabel(relationship)} · ${C.notAmount}`
      ]));
    });
    details.appendChild(el('div', 'terminal-accessible-grid', [
      el('section', '', [el('h3', '', C.entities), entityList]),
      el('section', '', [el('h3', '', C.relationships), relationList])
    ]));
    return details;
  }

  function renderChain(container) {
    const frame = el('div', 'terminal-graph-frame');
    const canvas = el('div', 'terminal-chain-canvas');
    const svg = svgEl('svg', { class: 'terminal-chain-edges', 'aria-hidden': 'true' });
    const columns = el('div', 'terminal-chain-columns');
    [...state.seed.layers].sort((a, b) => a.order - b.order).forEach((layer, index) => {
      const layerNode = el('section', 'terminal-chain-layer');
      layerNode.appendChild(el('header', 'terminal-chain-layer-head', [
        el('span', 'terminal-chain-layer-index', `0${index + 1}`),
        el('h3', '', loc(layer.label)),
        el('p', '', loc(layer.description))
      ]));
      const nodes = el('div', 'terminal-chain-nodes');
      state.seed.entities.filter((entity) => entity.layer === layer.id).forEach((entity) => nodes.appendChild(graphNode(entity)));
      layerNode.appendChild(nodes);
      columns.appendChild(layerNode);
    });
    canvas.append(svg, columns);
    frame.appendChild(canvas);
    container.append(frame, accessibleGraph());

    const draw = () => {
      svg.replaceChildren();
      const canvasRect = canvas.getBoundingClientRect();
      const width = Math.max(canvas.clientWidth, canvas.scrollWidth);
      const height = Math.max(canvas.clientHeight, canvas.scrollHeight);
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.style.width = `${width}px`;
      svg.style.height = `${height}px`;
      state.seed.relationships.filter(relationshipApplies).forEach((relationship) => {
        const fromNode = $(`[data-entity="${CSS.escape(relationship.from)}"]`, columns);
        const toNode = $(`[data-entity="${CSS.escape(relationship.to)}"]`, columns);
        if (!fromNode || !toNode) return;
        const from = fromNode.getBoundingClientRect();
        const to = toNode.getBoundingClientRect();
        const x1 = from.right - canvasRect.left + canvas.scrollLeft;
        const y1 = from.top + from.height / 2 - canvasRect.top + canvas.scrollTop;
        const x2 = to.left - canvasRect.left + canvas.scrollLeft;
        const y2 = to.top + to.height / 2 - canvasRect.top + canvas.scrollTop;
        const bend = Math.max(28, Math.abs(x2 - x1) * 0.42);
        const path = svgEl('path', {
          d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
          class: `terminal-chain-edge ${statusClass(relationship)}${relationship.from === state.entityId || relationship.to === state.entityId ? ' is-selected' : ''}`
        });
        svg.appendChild(path);
      });
    };
    requestAnimationFrame(draw);
    window.setTimeout(draw, 120);
    if ('ResizeObserver' in window) {
      state.chainObserver = new ResizeObserver(draw);
      state.chainObserver.observe(canvas);
      state.chainObserver.observe(columns);
    }
  }

  function renderNebula(container) {
    const frame = el('div', 'terminal-graph-frame');
    const zoomReadout = el('span', 'terminal-zoom-readout', `${C.zoom}: ${Math.round(state.zoom * 100)}%`);
    const zoom = (delta) => {
      state.zoom = Math.min(1.8, Math.max(0.5, state.zoom + delta));
      renderSupply();
    };
    const zoomOut = button('−', '', () => zoom(-0.15));
    const zoomIn = button('+', '', () => zoom(0.15));
    const zoomReset = button('1:1', '', () => { state.zoom = 1; renderSupply(); });
    zoomOut.setAttribute('aria-label', lang === 'en' ? 'Zoom out' : lang === 'cn' ? '缩小图谱' : '縮小圖譜');
    zoomIn.setAttribute('aria-label', lang === 'en' ? 'Zoom in' : lang === 'cn' ? '放大图谱' : '放大圖譜');
    zoomReset.setAttribute('aria-label', lang === 'en' ? 'Reset zoom' : lang === 'cn' ? '重置缩放' : '重設縮放');
    frame.appendChild(el('div', 'terminal-nebula-toolbar', [
      edgeLegend(),
      el('div', 'terminal-zoom-controls', [
        zoomOut,
        zoomIn,
        zoomReset,
        zoomReadout
      ])
    ]));
    const viewport = el('div', 'terminal-nebula-viewport');
    const stage = el('div', 'terminal-nebula-stage');
    stage.style.width = `${Math.round(100 * state.zoom)}%`;
    stage.style.height = `${Math.round(100 * state.zoom)}%`;
    stage.style.minWidth = `${Math.round(760 * state.zoom)}px`;
    stage.style.minHeight = `${Math.round(450 * state.zoom)}px`;
    const svg = svgEl('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    state.seed.relationships.filter(relationshipApplies).forEach((relationship) => {
      const from = state.entities.get(relationship.from);
      const to = state.entities.get(relationship.to);
      if (!from || !to) return;
      svg.appendChild(svgEl('line', {
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        class: `terminal-nebula-edge ${statusClass(relationship)}${relationship.from === state.entityId || relationship.to === state.entityId ? ' is-selected' : ''}`
      }));
    });
    stage.appendChild(svg);
    state.seed.entities.forEach((entity) => {
      const node = button(entity.name, `terminal-nebula-node kind-${entity.kind} layer-${entity.layer}${entity.id === state.entityId ? ' is-selected' : ''}`, () => {
        selectEntity(entity.id, 'supply', 'nebula');
        renderSupply();
      });
      node.style.left = `${entity.x}%`;
      node.style.top = `${entity.y}%`;
      node.title = `${entity.name}${entity.ticker ? ` · ${entity.ticker}` : ''} · ${loc(entity.role)}`;
      stage.appendChild(node);
    });
    viewport.appendChild(stage);
    const selected = state.entities.get(state.entityId);
    const inspector = el('div', 'terminal-nebula-inspector', [
      el('div', '', [
        el('h3', '', selected?.name || C.selectCompany),
        el('p', '', selected ? `${selected.ticker || C.category} · ${loc(selected.role)}` : '')
      ]),
      button(C.openXray, 'terminal-action primary', () => {
        state.supplyView = 'xray';
        renderSupply();
        updateUrl();
      })
    ]);
    frame.append(viewport, inspector);
    container.append(frame, accessibleGraph());
  }

  function relationButton(entity, relationship) {
    const wrap = el('div', 'terminal-xray-relation-wrap');
    const node = button('', 'terminal-xray-relation', () => {
      selectEntity(entity.id, 'supply', 'xray');
      renderSupply();
    });
    node.append(
      el('strong', '', entity.name),
      el(
        'small',
        '',
        `${entity.ticker || C.category} · ${relationshipTypeLabel(relationship)} · ${evidenceStatusLabel(relationship)} · ${C.notAmount}`
      )
    );
    wrap.appendChild(node);
    const source = sourceById(relationshipSourceId(relationship));
    const href = safeUrl(source?.url);
    if (href) {
      const link = el('a', 'terminal-relation-source', `${C.relationSource} · ${source.title}`);
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      wrap.appendChild(link);
    }
    return wrap;
  }

  function relationColumn(label, title, pairs) {
    const column = el('section', 'terminal-xray-column');
    column.appendChild(el('header', 'terminal-xray-column-head', [
      el('span', '', label),
      el('h3', '', title)
    ]));
    const list = el('div', 'terminal-xray-list');
    if (!pairs.length) list.appendChild(el('p', 'terminal-xray-empty', C.noRelations));
    pairs.forEach(({ entity, relationship }) => list.appendChild(relationButton(entity, relationship)));
    column.appendChild(list);
    return column;
  }

  function financialRecord(entityId, year) {
    return state.seed.financials?.[entityId]?.[String(year)] || null;
  }

  function flowView(record) {
    const box = el('section', 'terminal-accounting-flow');
    box.append(el('h3', '', C.flow), el('p', '', C.flowIntro));
    const flowValues = record?.flow && [
      record.flow.revenue,
      record.flow.costOfRevenue,
      record.flow.operatingExpenses,
      record.flow.operatingIncome
    ];
    if (!flowValues || flowValues.some((value) => !Number.isFinite(value))) {
      box.appendChild(el('div', 'terminal-note', C.flowMissing));
      return box;
    }
    const flow = record.flow;
    box.appendChild(el('div', 'terminal-flow-total', [
      el('span', '', `${C.revenue} ${fmtMoney(flow.revenue, record)}`),
      el('span', '', `${record.reportedFiscalYear} · ${record.currency} ${record.scale}`)
    ]));
    const bar = el('div', 'terminal-flow-bar');
    [
      { value: flow.costOfRevenue, label: C.cogs, className: 'is-cogs' },
      { value: flow.operatingExpenses, label: C.opex, className: 'is-opex' },
      { value: flow.operatingIncome, label: C.opIncome, className: 'is-profit' }
    ].forEach((item) => {
      const segment = el('div', `terminal-flow-segment ${item.className}`, `${item.label} ${fmtMoney(item.value, record)}`);
      segment.style.width = `${Math.max(2, item.value / flow.revenue * 100)}%`;
      bar.appendChild(segment);
    });
    box.appendChild(bar);
    const legend = el('div', 'terminal-flow-legend');
    [
      ['is-cogs', C.cogs, flow.costOfRevenue],
      ['is-opex', C.opex, flow.operatingExpenses],
      ['is-profit', C.opIncome, flow.operatingIncome]
    ].forEach(([className, label, value]) => {
      legend.appendChild(el('span', '', [el('i', className), `${label} · ${fmtMoney(value, record)}`]));
    });
    box.append(legend, el('div', 'terminal-note', C.unallocated));
    return box;
  }

  function renderXray(container) {
    const selected = state.entities.get(state.entityId);
    const allIncoming = state.seed.relationships
      .filter(relationshipApplies)
      .filter((relationship) => relationship.to === state.entityId)
      .map((relationship) => ({ relationship, entity: state.entities.get(relationship.from) }))
      .filter((pair) => pair.entity);
    const allOutgoing = state.seed.relationships
      .filter(relationshipApplies)
      .filter((relationship) => relationship.from === state.entityId)
      .map((relationship) => ({ relationship, entity: state.entities.get(relationship.to) }))
      .filter((pair) => pair.entity);
    const taxonomyPairs = allIncoming.concat(allOutgoing)
      .filter((pair) => pair.relationship.type === 'taxonomy-membership');
    const incoming = allIncoming.filter((pair) => pair.relationship.type !== 'taxonomy-membership');
    const outgoing = allOutgoing.filter((pair) => pair.relationship.type !== 'taxonomy-membership');
    const toc = outgoing.filter((pair) =>
      pair.entity.id === 'consumer-internet-class' || pair.entity.cluster === 'consumer-demand' || pair.entity.cluster === 'models-consumer'
    );
    const tob = outgoing.filter((pair) => !toc.includes(pair));
    const record = financialRecord(state.entityId, state.year);

    const focus = el('section', 'terminal-xray-column terminal-xray-focus');
    focus.appendChild(el('header', 'terminal-xray-column-head', [
      el('span', '', C.focal),
      el('h3', '', selected?.name || C.selectCompany)
    ]));
    const card = el('div', 'terminal-company-card');
    if (selected) {
      card.append(
        el('span', 'terminal-company-kind', selected.kind === 'company' ? C.company : C.category),
        el('h3', '', selected.name),
        el('code', '', selected.ticker || C.notAmount),
        el('p', '', loc(selected.role)),
        el('div', 'terminal-company-meta', [
          el('div', '', [el('span', '', C.layer), el('strong', '', loc(state.seed.layers.find((layer) => layer.id === selected.layer)?.label))]),
          el('div', '', [el('span', '', C.canonicalYear), el('strong', '', state.year)]),
          el('div', '', [el('span', '', C.coverage), el('strong', '', record ? C.partial : '—')]),
          el('div', '', [el('span', '', 'UNIVERSE'), el('strong', '', C.notChecked)])
        ])
      );
      const source = sourceById(record?.sourceId);
      const url = safeUrl(source?.url);
      if (url) {
        const link = el('a', 'terminal-source-link', C.financialSource);
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        card.appendChild(link);
      }
    }
    focus.appendChild(card);
    const xray = el('div', 'terminal-xray', [
      relationColumn('01', C.upstream, incoming),
      focus,
      relationColumn('03', C.tob, tob),
      relationColumn('04', C.toc, toc)
    ]);
    container.appendChild(xray);
    if (taxonomyPairs.length) {
      const taxonomy = relationColumn('05', C.taxonomyContext, taxonomyPairs);
      taxonomy.classList.add('terminal-xray-context');
      container.appendChild(taxonomy);
    }
    container.append(flowView(record), accessibleGraph());
  }

  function renderSupply() {
    if (!state.seed) return;
    const panel = $('#terminal-panel-supply');
    if (state.chainObserver) {
      state.chainObserver.disconnect();
      state.chainObserver = null;
    }
    const fragment = document.createDocumentFragment();
    fragment.appendChild(panelHead('ATLAS', C.supply, C.supplyIntro));
    const tabs = el('div', 'terminal-subtabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', C.supply);
    const views = [
      ['chain', C.chain],
      ['nebula', C.nebula],
      ['xray', C.xray]
    ];
    views.forEach(([id, label], index) => {
      const activate = (restoreFocus) => {
        state.supplyView = id;
        renderSupply();
        updateUrl();
        if (restoreFocus) requestAnimationFrame(() => $(`#terminal-supply-tab-${id}`)?.focus());
      };
      const tab = button(label, '', () => activate(false));
      tab.id = `terminal-supply-tab-${id}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'terminal-supply-view');
      tab.setAttribute('aria-selected', state.supplyView === id ? 'true' : 'false');
      tab.tabIndex = state.supplyView === id ? 0 : -1;
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let target = index;
        if (event.key === 'ArrowLeft') target = (index - 1 + views.length) % views.length;
        if (event.key === 'ArrowRight') target = (index + 1) % views.length;
        if (event.key === 'Home') target = 0;
        if (event.key === 'End') target = views.length - 1;
        state.supplyView = views[target][0];
        renderSupply();
        updateUrl();
        requestAnimationFrame(() => $(`#terminal-supply-tab-${views[target][0]}`)?.focus());
      });
      tabs.appendChild(tab);
    });
    fragment.appendChild(el('div', 'terminal-supply-controls', [tabs, edgeLegend()]));
    const content = el('div', '');
    content.id = 'terminal-supply-view';
    content.setAttribute('role', 'tabpanel');
    content.setAttribute('aria-labelledby', `terminal-supply-tab-${state.supplyView}`);
    if (state.supplyView === 'nebula') renderNebula(content);
    else if (state.supplyView === 'xray') renderXray(content);
    else renderChain(content);
    fragment.appendChild(content);
    panel.replaceChildren(fragment);
  }

  const metricLabels = {
    revenue: [C.revenue, C.revenue, C.revenue],
    costOfRevenue: [C.cogs, C.cogs, C.cogs],
    grossProfit: [lang === 'en' ? 'Gross profit' : lang === 'cn' ? '毛利润' : '毛利', '', ''],
    operatingExpenses: [C.opex, C.opex, C.opex],
    operatingIncome: [C.opIncome, C.opIncome, C.opIncome],
    netIncome: [lang === 'en' ? 'Net income' : lang === 'cn' ? '净利润' : '淨利潤', '', ''],
    assets: [lang === 'en' ? 'Total assets' : lang === 'cn' ? '总资产' : '總資產', '', ''],
    liabilities: [lang === 'en' ? 'Total liabilities' : lang === 'cn' ? '总负债' : '總負債', '', ''],
    stockholdersEquity: [lang === 'en' ? "Stockholders' equity" : lang === 'cn' ? '股东权益' : '股東權益', '', ''],
    retainedEarnings: [lang === 'en' ? 'Retained earnings' : lang === 'cn' ? '留存收益' : '留存收益', '', ''],
    operatingCashFlow: [lang === 'en' ? 'Operating cash flow' : lang === 'cn' ? '经营活动现金流' : '營運現金流', '', ''],
    shareRepurchases: [lang === 'en' ? 'Share repurchases' : lang === 'cn' ? '股份回购' : '股份回購', '', ''],
    dividendsPaid: [lang === 'en' ? 'Dividends paid' : lang === 'cn' ? '已付股息' : '已付股息', '', ''],
    openingEquity: [lang === 'en' ? 'Opening equity' : lang === 'cn' ? '期初权益' : '期初權益', '', ''],
    otherEquityMovements: [lang === 'en' ? 'Other equity movements' : lang === 'cn' ? '其他权益变动' : '其他權益變動', '', ''],
    closingEquity: [lang === 'en' ? 'Closing equity' : lang === 'cn' ? '期末权益' : '期末權益', '', '']
  };
  const metricLabel = (metric) => metricLabels[metric]?.[0] || metric;

  function methodInfo(method) {
    if ((method || '').startsWith('derived')) return { code: 'D', className: 'is-derived', label: C.derived };
    if ((method || '').startsWith('estimated')) return { code: 'E', className: 'is-estimated', label: C.estimated };
    if ((method || '').startsWith('disclosed')) return { code: 'R', className: '', label: C.reported };
    return { code: '—', className: 'is-missing', label: C.missing };
  }

  function renderFinancials() {
    if (!state.seed) return;
    const panel = $('#terminal-panel-financials');
    const selected = state.entities.get(state.entityId);
    const records = state.seed.financials?.[state.entityId];
    const fragment = document.createDocumentFragment();
    fragment.appendChild(panelHead('FA', C.financials, C.financialsIntro));
    if (!records) {
      fragment.appendChild(el('div', 'terminal-empty-state', el('div', '', [
        el('strong', '', selected?.name || C.selectCompany),
        el('p', '', C.faMissing)
      ])));
      panel.replaceChildren(fragment);
      return;
    }
    const years = Object.keys(records).sort((a, b) => Number(b) - Number(a));
    const focus = records[state.year];
    if (!focus) {
      fragment.appendChild(el('div', 'terminal-empty-state', el('div', '', [
        el('strong', '', `${selected?.name || C.selectCompany} · ${state.year}`),
        el('p', '', C.faMissing)
      ])));
      panel.replaceChildren(fragment);
      return;
    }
    fragment.appendChild(el('div', 'terminal-fa-summary', [
      el('div', 'terminal-fa-company', [el('span', '', C.company), el('strong', '', `${selected.name}${selected.ticker ? ` · ${selected.ticker}` : ''}`)]),
      el('div', '', [el('span', '', C.canonicalYear), el('strong', '', focus.canonicalYear)]),
      el('div', '', [el('span', '', C.reportedFY), el('strong', '', focus.reportedFiscalYear)]),
      el('div', '', [el('span', '', C.actualPeriod), el('strong', '', `${fmtDate(focus.periodStart)} – ${fmtDate(focus.periodEnd)}`)]),
      el('div', '', [el('span', '', C.currency), el('strong', '', `${focus.currency} · ${focus.scale}`)])
    ]));
    const tabs = el('div', 'terminal-fa-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', C.financials);
    const statements = [
      ['income', C.income],
      ['balance', C.balance],
      ['cashflow', C.cashflow],
      ['equity', C.equity]
    ];
    statements.forEach(([id, label], index) => {
      const activate = (restoreFocus) => {
        state.faStatement = id;
        renderFinancials();
        if (restoreFocus) requestAnimationFrame(() => $(`#terminal-fa-tab-${id}`)?.focus());
      };
      const tab = button(label, '', () => activate(false));
      tab.id = `terminal-fa-tab-${id}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'terminal-fa-view');
      tab.setAttribute('aria-selected', state.faStatement === id ? 'true' : 'false');
      tab.tabIndex = state.faStatement === id ? 0 : -1;
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let target = index;
        if (event.key === 'ArrowLeft') target = (index - 1 + statements.length) % statements.length;
        if (event.key === 'ArrowRight') target = (index + 1) % statements.length;
        if (event.key === 'Home') target = 0;
        if (event.key === 'End') target = statements.length - 1;
        state.faStatement = statements[target][0];
        renderFinancials();
        requestAnimationFrame(() => $(`#terminal-fa-tab-${statements[target][0]}`)?.focus());
      });
      tabs.appendChild(tab);
    });
    fragment.appendChild(tabs);

    const orderedMetrics = [];
    years.forEach((year) => {
      (records[year][state.faStatement] || []).forEach((row) => {
        if (!orderedMetrics.includes(row.metric)) orderedMetrics.push(row.metric);
      });
    });
    const table = el('table', 'terminal-fa-table');
    const head = el('thead', '', el('tr', '', [
      el('th', '', C.metric),
      ...years.map((year) => {
        const record = records[year];
        return el('th', '', `${year} · ${record.reportedFiscalYear}`);
      })
    ]));
    const tbody = el('tbody');
    orderedMetrics.forEach((metric) => {
      const row = el('tr');
      row.appendChild(el('td', '', metricLabel(metric)));
      years.forEach((year) => {
        const fact = (records[year][state.faStatement] || []).find((item) => item.metric === metric);
        const cell = el('td');
        if (!fact || !Number.isFinite(fact.value)) {
          const missingBadge = el('span', 'terminal-fact-status is-missing', '—');
          missingBadge.setAttribute('aria-label', C.missing);
          cell.append(el('span', 'terminal-fa-value', '—'), missingBadge);
        } else {
          const info = methodInfo(fact.method);
          const badge = el('span', `terminal-fact-status ${info.className}`, info.code);
          badge.title = info.label;
          badge.setAttribute('aria-label', info.label);
          cell.append(el('span', 'terminal-fa-value', fmtMoney(fact.value, records[year])), text(' '), badge);
        }
        row.appendChild(cell);
      });
      tbody.appendChild(row);
    });
    table.append(head, tbody);
    const tablePanel = el('div', 'terminal-fa-table-wrap', table);
    tablePanel.id = 'terminal-fa-view';
    tablePanel.setAttribute('role', 'tabpanel');
    tablePanel.setAttribute('aria-labelledby', `terminal-fa-tab-${state.faStatement}`);
    fragment.appendChild(tablePanel);
    fragment.appendChild(el('div', 'terminal-fa-legend', [
      el('span', '', [el('i', 'terminal-fact-status', 'R'), C.reported]),
      el('span', '', [el('i', 'terminal-fact-status is-derived', 'D'), C.derived]),
      el('span', '', [el('i', 'terminal-fact-status is-estimated', 'E'), C.estimated]),
      el('span', '', [el('i', 'terminal-fact-status is-missing', '—'), C.missing])
    ]));
    const sourceLinks = years.map((year) => {
      const source = sourceById(records[year].sourceId);
      const href = safeUrl(source?.url);
      if (!href) return null;
      const link = el('a', 'terminal-source-link', `${year} · ${source.title} ↗`);
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    }).filter(Boolean);
    if (sourceLinks.length) fragment.appendChild(el('div', 'terminal-panel-actions', sourceLinks));
    panel.replaceChildren(fragment);
  }

  function definitionList(rows) {
    const list = el('dl', 'terminal-definition-list');
    rows.forEach(([term, value]) => list.append(el('dt', '', term), el('dd', '', value)));
    return list;
  }

  function renderStatus() {
    if (!state.seed) return;
    const panel = $('#terminal-panel-status');
    const coverage = state.seed.coverage;
    const statusHeadline = state.seed.status === 'published'
      ? (lang === 'en' ? 'Published snapshot' : lang === 'cn' ? '已发布快照' : '已發布快照')
      : state.seed.status === 'validated'
        ? (lang === 'en' ? 'Validated snapshot' : lang === 'cn' ? '已验证快照' : '已驗證快照')
        : C.prototype;
    const fragment = document.createDocumentFragment();
    fragment.appendChild(panelHead('CONTROL PLANE', C.status, C.statusIntro));
    fragment.appendChild(el('div', 'terminal-status-banner', [
      el(
        'span',
        `terminal-status-chip ${state.seed.status === 'published' ? 'is-current' : 'is-candidate'}`,
        state.seed.status.toUpperCase()
      ),
      el('div', '', [
        el('strong', '', statusHeadline),
        el('p', '', C.prototypeBody.replace('{entities}', coverage.pipeline.candidateEntities))
      ])
    ]));
    fragment.appendChild(el('div', 'terminal-status-grid', [
      el('article', 'terminal-status-card', [el('span', '', C.graphEntities), el('strong', '', coverage.graph.entityCount), el('p', '', `${coverage.graph.directDisclosedRelationshipCount} ${C.disclosed}`)]),
      el('article', 'terminal-status-card', [el('span', '', C.graphRelations), el('strong', '', coverage.graph.relationshipCount), el('p', '', C.notAmount)]),
      el('article', 'terminal-status-card', [el('span', '', C.actualYears), el('strong', '', coverage.financialActuals.canonicalYearCount), el('p', '', `${coverage.financialActuals.companyCount} ${C.company}`)]),
      el('article', 'terminal-status-card', [
        el('span', '', C.queuedTasks),
        el('strong', '', coverage.pipeline.queuedTasksAtInitialization),
        el('p', '', `${coverage.pipeline.candidateEntities} ${C.company} · ${coverage.pipeline.companyYearUnits} ${
          lang === 'en' ? 'company-years' : '公司年度'
        }`)
      ])
    ]));
    const sourceList = el('ul', 'terminal-source-list');
    state.seed.sources.forEach((source) => {
      const link = el('a', '', source.title);
      const href = safeUrl(source.url);
      if (href) {
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      sourceList.appendChild(el('li', '', [
        el('div', '', [link, el('small', '', `${source.publisher} · ${fmtDate(source.filedAt)}`)]),
        el('span', 'terminal-status-chip', C.sourceStatus)
      ]));
    });
    const marketList = el('ul', 'terminal-market-status-list');
    ['us', 'hk', 'a'].forEach((id) => {
      const item = state.markets.get(id);
      const payload = item?.payload;
      const label = id === 'us' ? 'US' : id === 'hk' ? 'HK' : 'A-SHARE';
      const unavailable = !payload || payload.unavailable === true;
      const stale = payload && !unavailable && (
        payload.stale === true || (Array.isArray(payload.missing) && payload.missing.length > 0)
      );
      const status = item?.loading
        ? `${C.fetched}…`
        : unavailable
          ? C.unavailable
          : stale
            ? C.stale
            : C.current;
      const statusClassName = item?.loading
        ? 'is-neutral'
        : unavailable
          ? 'is-error'
          : stale
            ? 'is-candidate'
            : 'is-current';
      marketList.appendChild(el('li', '', [
        el('div', '', [
          label,
          el(
            'small',
            '',
            payload
              ? `${C.snapshotFetched}: ${fmtDate(payload.fetched)} · ${C.lastAttempt}: ${fmtDate(payload.lastAttempt)}`
              : '—'
          )
        ]),
        el('span', `terminal-status-chip ${statusClassName}`, status)
      ]));
    });
    fragment.appendChild(el('div', 'terminal-status-detail-grid', [
      el('section', 'terminal-status-block', [
        el('h3', '', lang === 'en' ? 'Snapshot contract' : lang === 'cn' ? '快照合同' : '快照合約'),
        definitionList([
          [C.snapshot, state.seed.snapshotId],
          [C.cutoff, state.seed.knowledgeCutoff],
          [C.taxonomyVersion, state.seed.taxonomyVersion],
          [C.annualPolicy, state.seed.annualPolicyVersion],
          [C.threshold, `$${fmtNumber(state.seed.scope.marketCapThresholdUsd / 1000000000, 0)}B`],
          [C.thresholdDate, state.seed.scope.marketCapThresholdAsOf || C.pending],
          [C.pipelineMode, coverage.pipeline.publicationMode || C.candidateOnly]
        ])
      ]),
      el('section', 'terminal-status-block', [el('h3', '', C.sources), sourceList]),
      el('section', 'terminal-status-block', [
        el('h3', '', lang === 'en' ? 'Agent pipeline' : lang === 'cn' ? 'Agent 流水线' : 'Agent 流水線'),
        definitionList([
          [C.stageEvidence, lang === 'en' ? 'source documents + raw facts' : lang === 'cn' ? '来源文档 + 原始事实' : '來源文件 + 原始事實'],
          [C.stageCore, lang === 'en' ? 'normalized annual facts' : lang === 'cn' ? '标准化年度事实' : '標準化年度事實'],
          [C.stageGraph, lang === 'en' ? 'versioned relationships' : lang === 'cn' ? '版本化关系' : '版本化關係'],
          [C.stageAudit, lang === 'en' ? 'independent release gate' : lang === 'cn' ? '独立发布门禁' : '獨立發布門禁']
        ])
      ]),
      el('section', 'terminal-status-block', [el('h3', '', C.marketStatus), marketList])
    ]));
    panel.replaceChildren(fragment);
  }

  function initTabs() {
    const tabs = $$('[data-terminal-module]');
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => setModule(tab.dataset.terminalModule));
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let target = index;
        if (event.key === 'ArrowLeft') target = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
        if (event.key === 'Home') target = 0;
        if (event.key === 'End') target = tabs.length - 1;
        tabs[target].focus();
        tabs[target].click();
      });
    });
  }

  function initMenu() {
    const toggle = $('.terminal-menu-button');
    const menu = $('#terminal-site-menu');
    const nav = menu?.closest('.terminal-site-nav');
    if (!toggle || !menu || !nav) return;
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      menu.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  async function init() {
    initTabs();
    initMenu();
    try {
      const response = await fetch('/assets/data/atlas-seed.json', { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const seed = await response.json();
      validateSeed(seed);
      state.seed = seed;
      state.entities = new Map(seed.entities.map((entity) => [entity.id, entity]));
      state.sources = new Map(seed.sources.map((source) => [source.id, source]));
      updateHeroStatus();
      loadQueryState();
      initYears();
      initSearch();
      renderMarkets();
      renderSupply();
      renderFinancials();
      renderStatus();
      setModule(state.module);
      updateLanguageLinks();
      fetchMarkets();
    } catch (error) {
      const alert = $('#terminal-alert');
      alert.hidden = false;
      alert.textContent = C.loadingError;
      $$('[data-terminal-panel]').forEach((panel) => {
        panel.replaceChildren(el('div', 'terminal-empty-state', el('div', '', [
          el('strong', '', C.loadingError),
          el('p', '', String(error))
        ])));
      });
    }
  }

  init();
})();
