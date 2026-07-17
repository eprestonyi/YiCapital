/* Our Insights 精選：三語數據 */
const POSTS = window.POSTS = [
  {
    "id": "great-company-2026-07",
    "tag": {"tw": "投資隨筆 ・ 2026-07-16", "cn": "投资随笔 ・ 2026-07-16", "en": "Essay · 2026-07-16"},
    "date": "2026-07-16",
    "title": {
      "tw": "買入一家偉大的公司，不一定是一筆偉大的投資",
      "cn": "买入一家伟大的公司，不一定是一笔伟大的投资",
      "en": "Buying a Great Company Is Not Necessarily a Great Investment"
    },
    "excerpt": {
      "tw": "互聯網是真革命，思科至今是龍頭——而2000年3月買入的人等了25年8個月才解套。回報只有三個來源，你只能控制一個：估值變化，屬於你按下買入鍵的那一刻。",
      "cn": "互联网是真革命，思科至今是龙头——而2000年3月买入的人等了25年8个月才解套。回报只有三个来源，你只能控制一个：估值变化，属于你按下买入键的那一刻。",
      "en": "The internet was a real revolution and Cisco still leads it - yet a March-2000 buyer waited 25 years and 8 months to break even. Returns have three sources and you control exactly one: the valuation you pay."
    },
    "pill": {"tw": "投資隨筆", "cn": "投资随笔", "en": "Essay"},
    "pillStyle": "",
    "more": "posts/great-company-great-investment",
    "moreLabel": {"tw": "閱讀全文＋PDF →", "cn": "阅读全文＋PDF →", "en": "Read + PDF →"}
  },
  {
    "date": "2026-07-08",
    "pillStyle": "",
    "more": "posts/tencent-0700-ch12",
    "tag": {
      "tw": "精選判斷｜遊戲",
      "cn": "精选判断｜游戏",
      "en": "Featured View | Gaming"
    },
    "title": {
      "tw": "「長青款數 × 單款年金」：騰訊遊戲收入模型的重構",
      "cn": "「长青款數 × 单款年金」：腾讯游戏收入模型的重构",
      "en": "'Evergreen Count × Per-Title Annuity': Rebuilding Tencent's Gaming Revenue Model"
    },
    "excerpt": {
      "tw": "市場仍在用「逐款猜新遊流水」的舊框架，預測一家增長主體已變成「長青池擴容」的公司。長青遊戲 2024 年達 14 款且逐年淨增，《王者榮耀》上線十年仍創流水新高、《三角洲行動》上線五個季度即入列——把收入改寫為「長青款數 × 單款年金」後，兩個因子都可以低風險外推。",
      "cn": "市场仍在用「逐款猜新游流水」的旧框架，预测一家增长主体已变成「长青池扩容」的公司。长青游戏 2024 年达 14 款且逐年净增，《王者荣耀》上线十年仍创流水新高、《三角洲行动》上线五个季度即入列——把收入改写为「长青款數 × 单款年金」后，两个因子都可以低风险外推。",
      "en": "The market still forecasts this company by guessing each new title's grossing — while its growth engine has become an expanding evergreen pool. Evergreen titles reached 14 in 2024 and keep adding; Honor of Kings set new grossing records in its tenth year, Delta Force qualified within five quarters. Rewrite revenue as 'evergreen count × per-title annuity' and both factors extrapolate at low risk."
    },
    "pill": {
      "tw": "買入",
      "cn": "买入",
      "en": "BUY"
    },
    "moreLabel": {
      "tw": "更多資訊：閱讀完整研報 →",
      "cn": "更多资讯：阅读完整研报 →",
      "en": "More: read the full report →"
    }
  },
  {
    "date": "2026-07-08",
    "pillStyle": "",
    "more": "posts/tencent-0700-ch12",
    "tag": {
      "tw": "精選判斷｜支付",
      "cn": "精选判断｜支付",
      "en": "Featured View | Payments"
    },
    "title": {
      "tw": "「跌無可跌」的費率：微信支付的監管免疫力",
      "cn": "「跌无可跌」的费率：微信支付的监管免疫力",
      "en": "A Take Rate With Nowhere Left to Fall: WeChat Pay's Regulatory Immunity"
    },
    "excerpt": {
      "tw": "商戶費率約 0.6%、淨費率僅萬分之幾，降費讓利與斷直連整改早已完成——監管在價格維度已無可再壓，「壓無可壓」本身就是政策風險出清的狀態。以五十至六十萬億元商業支付交易額計，淨費率每上行萬分之一即帶來約 50–60 億元近乎純毛利的收入：市場按監管受害者定價，事實上它是監管出清後的倖存壟斷者。",
      "cn": "商户费率约 0.6%、净费率仅万分之几，降费让利与断直連整改早已完成——监管在价格维度已无可再压，「压无可压」本身就是政策风险出清的状态。以五十至六十万亿元商业支付交易额计，净费率每上行万分之一即带来约 50–60 亿元近乎纯毛利的收入：市场按监管受害者定价，事实上它是监管出清后的幸存垄断者。",
      "en": "Merchant fees sit near 0.6% and the net take rate is only a few basis points; fee concessions and the de-intermediation overhaul finished long ago — on price, regulators have nothing left to squeeze, and that exhaustion itself marks policy risk as cleared. On RMB 50–60 trillion of commercial payment volume, each basis point of net-rate upside adds roughly RMB 5–6 billion of near-pure-margin revenue: priced as a regulatory victim, it is in fact the surviving monopolist after the clean-up."
    },
    "pill": {
      "tw": "隱藏價值",
      "cn": "隐藏价值",
      "en": "Hidden Value"
    },
    "moreLabel": {
      "tw": "更多資訊：閱讀完整研報 →",
      "cn": "更多资讯：阅读完整研报 →",
      "en": "More: read the full report →"
    }
  },
  {
    "date": "2026-07-10",
    "pillStyle": "gray",
    "more": "posts/yicapital-risk-report",
    "tag": {
      "tw": "精選方法論｜風險",
      "cn": "精选方法论｜风险",
      "en": "Featured Methodology | Risk"
    },
    "title": {
      "tw": "厚尾世界裡，Sharpe 會說謊",
      "cn": "厚尾世界里，Sharpe 会说谎",
      "en": "In a Fat-Tailed World, Sharpe Lies"
    },
    "excerpt": {
      "tw": "Yi Capital HK 的日收益率 Student-t 自由度僅 3.9：4σ 事件的真實概率是正態假設的 272 倍，正態 VaR 低估真實風險約 9%。結論適用於所有集中持倉組合——風險度量應以 Sortino 與 CVaR 替代 Sharpe 與正態 VaR，組合優化應以 Mean-CVaR 替代 Mean-Variance。",
      "cn": "Yi Capital HK 的日收益率 Student-t 自由度仅 3.9：4σ 事件的真实概率是正态假设的 272 倍，正态 VaR 低估真实风险约 9%。结论适用于所有集中持仓组合——风险度量应以 Sortino 与 CVaR 替代 Sharpe 与正态 VaR，组合优化应以 Mean-CVaR 替代 Mean-Variance。",
      "en": "Yi Capital HK's daily returns fit a Student-t with only 3.9 degrees of freedom: a 4-sigma event is 272 times more likely than the normal assumption implies, and normal VaR understates true risk by about 9%. The conclusion generalizes to every concentrated portfolio — measure risk with Sortino and CVaR instead of Sharpe and normal VaR, and optimize Mean-CVaR instead of Mean-Variance."
    },
    "pill": {
      "tw": "方法論",
      "cn": "方法论",
      "en": "Methodology"
    },
    "moreLabel": {
      "tw": "更多資訊：風險量化全文 →",
      "cn": "更多资讯：风险量化全文 →",
      "en": "More: full risk study →"
    }
  }
];
const _T=(k,fb)=>(window.YCI?YCI.t(k):fb);
const _PLANG=()=> (window.YCI&&YCI.lang)||window.YC_LANG||'tw';
const _PF=o=> (typeof o==='string')?o:(o[_PLANG()]||o.tw);
function renderPosts(elId, opts) {
  const el = document.getElementById(elId);
  if (!el) return;
  const limit = (opts && opts.limit) || POSTS.length;
  const prefix = (opts && opts.prefix) || "";
  el.innerHTML = POSTS.slice(0, limit).map(p => `
    <article class="card${p.soon ? " soon" : ""}">
      <div class="c-meta"><b>${_PF(p.tag)}</b><span>${p.date}</span></div>
      <h3>${_PF(p.title)}</h3>
      <blockquote>${_PF(p.excerpt)}</blockquote>
      <div class="c-foot">
        <span class="pill ${p.pillStyle || ""}">${_PF(p.pill)}</span>
        ${p.more ? `<a class="more" href="${prefix}${p.more}">${_PF(p.moreLabel) || _T('post.more','更多資訊 →')}</a>` : `<span>${p.foot || ""}</span>`}
      </div>
    </article>`).join("");
}
