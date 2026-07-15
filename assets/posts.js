/* ═══════════════════════════════════════════════════════════════
   ★ Our Insights 精選 —— 一條精選 = 一個獨立觀點 ★
   卡片本身就是內容（引文式），底部附「更多資訊」連結。
   新增精選：在 POSTS 最上面照格式加一條。
   欄位：
   tag / date / title  → 顯示
   excerpt             → 精選正文（獨立成立的觀點，100–160 字）
   pill / pillStyle    → 徽章（"" 綠色款；"gray" 灰框款）
   more / moreLabel    → 底部連結（可指向研報頁、組合頁或外部）
═══════════════════════════════════════════════════════════════ */

const POSTS = [
  {
    tag: "精選判斷｜遊戲",
    date: "2026-07-08",
    title: "「長青款數 × 單款年金」：騰訊遊戲收入模型的重構",
    excerpt: "市場仍在用「逐款猜新遊流水」的舊框架，預測一家增長主體已變成「長青池擴容」的公司。長青遊戲 2024 年達 14 款且逐年淨增，《王者榮耀》上線十年仍創流水新高、《三角洲行動》上線五個季度即入列——把收入改寫為「長青款數 × 單款年金」後，兩個因子都可以低風險外推。",
    pill: "買入",
    pillStyle: "",
    more: "posts/tencent-0700-ch12.html",
    moreLabel: "更多資訊：閱讀完整研報 →"
  },
  {
    tag: "精選判斷｜支付",
    date: "2026-07-08",
    title: "「跌無可跌」的費率：微信支付的監管免疫力",
    excerpt: "商戶費率約 0.6%、淨費率僅萬分之幾，降費讓利與斷直連整改早已完成——監管在價格維度已無可再壓，「壓無可壓」本身就是政策風險出清的狀態。以五十至六十萬億元商業支付交易額計，淨費率每上行萬分之一即帶來約 50–60 億元近乎純毛利的收入：市場按監管受害者定價，事實上它是監管出清後的倖存壟斷者。",
    pill: "隱藏價值",
    pillStyle: "",
    more: "posts/tencent-0700-ch12.html",
    moreLabel: "更多資訊：閱讀完整研報 →"
  },
  {
    tag: "精選方法論｜風險",
    date: "2026-07-10",
    title: "厚尾世界裡，Sharpe 會說謊",
    excerpt: "Yi Capital HK 的日收益率 Student-t 自由度僅 3.9：4σ 事件的真實概率是正態假設的 272 倍，正態 VaR 低估真實風險約 9%。結論適用於所有集中持倉組合——風險度量應以 Sortino 與 CVaR 替代 Sharpe 與正態 VaR，組合優化應以 Mean-CVaR 替代 Mean-Variance。",
    pill: "方法論",
    pillStyle: "gray",
    more: "posts/yicapital-risk-report.html",
    moreLabel: "更多資訊：風險量化全文 →"
  }
];

/* ── 渲染程式，不用動 ── */
function renderPosts(elId, opts) {
  const el = document.getElementById(elId);
  if (!el) return;
  const limit = (opts && opts.limit) || POSTS.length;
  const prefix = (opts && opts.prefix) || "";
  el.innerHTML = POSTS.slice(0, limit).map(p => `
    <article class="card${p.soon ? " soon" : ""}">
      <div class="c-meta"><b>${p.tag}</b><span>${p.date}</span></div>
      <h3>${p.title}</h3>
      <blockquote>${p.excerpt}</blockquote>
      <div class="c-foot">
        <span class="pill ${p.pillStyle || ""}">${p.pill}</span>
        ${p.more ? `<a class="more" href="${prefix}${p.more}">${p.moreLabel || "更多資訊 →"}</a>` : `<span>${p.foot || ""}</span>`}
      </div>
    </article>`).join("");
}
