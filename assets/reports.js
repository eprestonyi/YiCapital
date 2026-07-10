/* ═══════════════════════════════════════════════════════════════
   ★ Research Forum 研報庫 —— 一份研報 = 一條記錄 ★
   新增研報步驟：
   1. 把 PDF 放進 assets/pdf/（檔名用英文，如 alibaba-9988.pdf）
   2. 複製 posts/_template.html 做一個報告頁（簡介＋底部自動嵌入 PDF）
   3. 在下面 REPORTS 最上面加一條記錄
   欄位：
   url    → 報告頁路徑
   ticker → 代號（會被搜索）
   title  → 標題（會被搜索）
   tags   → 關鍵詞，空格分隔（會被搜索）
   date / meta → 顯示用
═══════════════════════════════════════════════════════════════ */

const REPORTS = [
  {
    url: "posts/tencent-0700-ch12.html",
    ticker: "0700.HK",
    title: "騰訊控股：流量帝國的價值重估時刻——深度研究報告（第一、二章）",
    tags: "騰訊 tencent 港股 互聯網 遊戲 微信 首次覆蓋 買入",
    date: "2026-07-08",
    meta: "公司研究 · 買入 · TP HK$770"
  },
  {
    url: "posts/yicapital-risk-report.html",
    ticker: "PORTFOLIO",
    title: "Yi Capital 高階矩深度分析：厚尾、偏度與三情景極端壓力測試",
    tags: "風險 量化 VaR CVaR 壓力測試 skewed-t 厚尾",
    date: "2026-07-08",
    meta: "組合研究 · 方法論"
  }
];

/* ── 渲染＋搜索，不用動 ── */
function renderReports(listId, keyword, prefix) {
  const el = document.getElementById(listId);
  if (!el) return;
  const kw = (keyword || "").trim().toLowerCase();
  const hits = REPORTS.filter(r =>
    !kw || (r.ticker + " " + r.title + " " + r.tags).toLowerCase().includes(kw)
  );
  if (!hits.length) {
    el.innerHTML = '<div class="no-result">沒有找到相關研報，換個關鍵詞試試（代號、公司名、主題均可搜索）。</div>';
    return;
  }
  el.innerHTML = '<ul class="forum">' + hits.map((r, i) => `
    <li><a href="${(prefix||"") + r.url}">
      <span class="f-num">${String(i+1).padStart(2,"0")}</span>
      <span class="f-num" style="color:#8b98ac">${r.ticker}</span>
      <span>${r.title}</span>
      <span class="f-dots"></span>
      <span class="f-meta">${r.meta} · ${r.date}</span>
    </a></li>`).join("") + '</ul>';
}
function bindSearch(inputId, listId, prefix) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  inp.addEventListener("input", () => renderReports(listId, inp.value, prefix));
}
