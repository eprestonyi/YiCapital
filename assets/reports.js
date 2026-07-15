/* ═══════════════════════════════════════════════════════════════
   ★ Research Forum 研報庫 —— 一份研報 = 一條記錄 ★
   新增研報：1) PDF 放 assets/pdf/  2) 複製 posts/_template.html 做報告頁
            3) 在 REPORTS 最上面加一條
   genre 可多選：company 公司研究 / macro 宏觀研究 / quant 量化研究 /
                portfolio 組合研究 / filings 組合文件 / other 其他
═══════════════════════════════════════════════════════════════ */

const REPORT_GENRES = ["company","macro","quant","portfolio","filings","other"];

const REPORTS = [
  {
    url: "posts/tencent-0700-ch12.html",
    ticker: "0700.HK",
    genre: ["company"],
    title: "騰訊控股：流量帝國的價值重估時刻——深度研究報告（第一、二章）",
    tags: "騰訊 tencent 港股 互聯網 遊戲 微信 首次覆蓋 買入",
    date: "2026-07-08",
    meta: "買入 · TP HK$770"
  },
  {
    url: "posts/yicapital-risk-report.html",
    ticker: "PORTFOLIO",
    genre: ["quant","portfolio"],
    title: "Yi Capital 高階矩深度分析：厚尾、偏度與三情景極端壓力測試",
    tags: "風險 量化 VaR CVaR 壓力測試 skewed-t 厚尾",
    date: "2026-07-08",
    meta: "方法論"
  }
];

/* ── 渲染＋搜索＋類型篩選 ── */
const _T = (k, fb) => (window.YCI ? YCI.t(k) : fb);
let _activeGenres = new Set();   // 空 = 全部

function renderReports(listId, keyword, prefix) {
  const el = document.getElementById(listId);
  if (!el) return;
  const kw = (keyword || "").trim().toLowerCase();
  const hits = REPORTS.filter(r =>
    (!kw || (r.ticker + " " + r.title + " " + r.tags).toLowerCase().includes(kw)) &&
    (!_activeGenres.size || (r.genre || []).some(g => _activeGenres.has(g)))
  );
  if (!hits.length) {
    el.innerHTML = '<div class="no-result">' + _T('forum.noresult','沒有找到相關研報，換個關鍵詞或類型試試。') + '</div>';
    return;
  }
  el.innerHTML = '<ul class="forum">' + hits.map((r, i) => `
    <li><a href="${(prefix||"") + r.url}">
      <span class="f-num">${String(i+1).padStart(2,"0")}</span>
      <span class="f-num" style="color:#8b98ac">${r.ticker}</span>
      <span>${r.title}${(r.genre||[]).map(g=>'<span class="g-tag">'+_T('g.'+g,g)+'</span>').join('')}</span>
      <span class="f-dots"></span>
      <span class="f-meta">${r.meta} · ${r.date}</span>
    </a></li>`).join("") + '</ul>';
}
function bindSearch(inputId, listId, prefix) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  inp.addEventListener("input", () => renderReports(listId, inp.value, prefix));
}
/* 高級搜索：類型篩選 chips */
function renderGenreChips(chipId, inputId, listId, prefix) {
  const box = document.getElementById(chipId);
  if (!box) return;
  const draw = () => {
    box.innerHTML = '<span class="g-chip'+(!_activeGenres.size?' on':'')+'" data-g="__all">'+_T('g.all','全部')+'</span>'
      + REPORT_GENRES.map(g=>'<span class="g-chip'+(_activeGenres.has(g)?' on':'')+'" data-g="'+g+'">'+_T('g.'+g,g)+'</span>').join('');
  };
  box.addEventListener('click', e => {
    const g = e.target.dataset && e.target.dataset.g;
    if (!g) return;
    if (g === '__all') _activeGenres.clear();
    else _activeGenres.has(g) ? _activeGenres.delete(g) : _activeGenres.add(g);
    draw();
    const inp = document.getElementById(inputId);
    renderReports(listId, inp ? inp.value : '', prefix);
  });
  draw();
}
