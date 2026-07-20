/* Research Forum 研報庫：一份研報 = 一條記錄；title/meta 三語，genre 可多選 */
const REPORT_GENRES = ["company","macro","quant","portfolio","filings","other"];
const REPORTS = [
  {
    "id": "great-company-2026-07",
    "url": "posts/great-company-great-investment",
    "pdf": "assets/pdf/great-company-great-investment-2026-07.pdf",
    "ticker": "ESSAY",
    "genre": ["other"],
    "title": {
      "tw": "買入一家偉大的公司，不一定是一筆偉大的投資——思科與昇陽的雙標本研究",
      "cn": "买入一家伟大的公司，不一定是一笔伟大的投资——思科与升阳的双标本研究",
      "en": "Buying a Great Company Is Not Necessarily a Great Investment - The Cisco & Sun Twin Specimens"
    },
    "tags": "思科 CSCO 昇陽 SUNW 定投 估值 勝率 賠率 投資隨筆 essay valuation",
    "date": "2026-07-16",
    "meta": {"tw": "投資隨筆 · 第003期", "cn": "投资随笔 · 第003期", "en": "Essay · No. 003"}
  },
  {
    id: "tencent-0700-ch12",
    url: "posts/tencent-0700-ch12", pdf: "assets/pdf/tencent-0700-ch12.pdf", ticker: "0700.HK", genre: ["company"], date: "2026-07-08",
    tags: "騰訊 腾讯 tencent 港股 互聯網 互联网 遊戲 游戏 微信 wechat internet gaming initiation buy",
    title: { tw:"騰訊控股：流量帝國的價值重估時刻——深度研究報告（第一、二章）", cn:"腾讯控股：流量帝国的价值重估时刻——深度研究报告（第一、二章）", en:"Tencent Holdings: The Revaluation Moment of a Traffic Empire — Deep-Dive Report (Ch. 1–2)" },
    meta: { tw:"買入 · TP HK$770", cn:"买入 · TP HK$770", en:"BUY · TP HK$770" }
  },
  {
    id: "yicapital-risk-report",
    url: "posts/yicapital-risk-report", pdf: "", ticker: "PORTFOLIO", genre: ["quant","portfolio"], date: "2026-07-08",
    tags: "風險 风险 量化 VaR CVaR 壓力測試 压力测试 skewed-t 厚尾 fat tail stress risk quant",
    title: { tw:"Yi Capital 高階矩深度分析：厚尾、偏度與三情景極端壓力測試", cn:"Yi Capital 高阶矩深度分析：厚尾、偏度与三情景极端压力测试", en:"Yi Capital Higher-Moment Analysis: Fat Tails, Skewness & Three-Scenario Extreme Stress Tests" },
    meta: { tw:"方法論", cn:"方法论", en:"Methodology" }
  }
];
const _LANG = () => (window.YCI && YCI.lang) || window.YC_LANG || 'tw';
const _T = (k, fb) => (window.YCI ? YCI.t(k) : fb);
const _F = (o) => (typeof o === 'string') ? o : (o[_LANG()] || o.tw);
let _activeGenres = new Set();
function renderReports(listId, keyword, prefix) {
  const el = document.getElementById(listId); if (!el) return;
  const kw = (keyword || "").trim().toLowerCase();
  const hits = REPORTS.filter(r =>
    (!kw || (r.ticker + " " + _F(r.title) + " " + r.title.tw + " " + r.tags).toLowerCase().includes(kw)) &&
    (!_activeGenres.size || (r.genre || []).some(g => _activeGenres.has(g))));
  if (!hits.length) { el.innerHTML = '<div class="no-result">' + _T('forum.noresult','沒有找到相關研報。') + '</div>'; return; }
  el.innerHTML = '<ul class="forum">' + hits.map((r, i) => `
    <li><a href="${ (r.url||"").indexOf("assets/")===0 ? "/"+r.url : (prefix||"")+r.url }">
      <span class="f-num">${String(i+1).padStart(2,"0")}</span>
      <span class="f-num" style="color:#8b98ac">${r.ticker}</span>
      <span>${_F(r.title)}${(r.genre||[]).map(g=>'<span class="g-tag">'+_T('g.'+g,g)+'</span>').join('')}</span>
      <span class="f-dots"></span>
      <span class="f-meta">${_F(r.meta)} · ${r.date}</span>
    </a></li>`).join("") + '</ul>';
}
function bindSearch(inputId, listId, prefix) {
  const inp = document.getElementById(inputId); if (!inp) return;
  inp.addEventListener("input", () => renderReports(listId, inp.value, prefix));
}
function renderGenreChips(chipId, inputId, listId, prefix) {
  const box = document.getElementById(chipId); if (!box) return;
  const draw = () => {
    box.innerHTML = '<span class="g-chip'+(!_activeGenres.size?' on':'')+'" data-g="__all">'+_T('g.all','全部')+'</span>'
      + REPORT_GENRES.map(g=>'<span class="g-chip'+(_activeGenres.has(g)?' on':'')+'" data-g="'+g+'">'+_T('g.'+g,g)+'</span>').join('');
  };
  box.addEventListener('click', e => {
    const g = e.target.dataset && e.target.dataset.g; if (!g) return;
    if (g === '__all') _activeGenres.clear();
    else _activeGenres.has(g) ? _activeGenres.delete(g) : _activeGenres.add(g);
    draw(); const inp = document.getElementById(inputId);
    renderReports(listId, inp ? inp.value : '', prefix);
  });
  draw();
}

/* ── 動態層：後端 KV 若已託管內容，覆蓋內置種子並重繪（後台可增改停刪，無需改代碼）── */
(function ycLoadContent(){
  const api=(window.YC_API||'').replace(/\/+$/,''); if(!api) return;
  fetch(api+'/api/content',{cache:'no-store'}).then(r=>r.json()).then(j=>{
    if(!j.ok||!j.managed) return;
    if(Array.isArray(j.reports)){
      REPORTS.length=0; j.reports.forEach(x=>REPORTS.push(x));
      REPORTS.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
      document.dispatchEvent(new CustomEvent('yc-content-reports'));
    }
    if(Array.isArray(j.posts)&&window.POSTS){
      POSTS.length=0; j.posts.forEach(x=>POSTS.push(x));
      POSTS.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
      document.dispatchEvent(new CustomEvent('yc-content-posts'));
    }
  }).catch(()=>{});
})();
