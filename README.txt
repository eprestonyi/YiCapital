Yi Capital 網站使用說明（v2）
══════════════════════════════

■ 頁面結構
  index.html            首頁：hero＋三個板塊的最新內容；頂部小導航滑到對應區塊
  insights.html         Our Insights：精選文章（自動讀 assets/posts.js）
  forum.html            Research Forum：研報庫＋中央搜索（自動讀 assets/reports.js）
  portfolios.html       組合實錄：HK → US → A Share 三基金縱向滑動
    → 每個基金：淨值曲線＋關鍵指標＋分頁
      Performance / Holdings / Risks / Methodology（已填入回測真實數據）
      Filings 分頁點擊跳到共用的 filings.html
    → 更新數據：直接改 portfolios.html 對應區塊的數字即可
  filings.html          致股東信與階段性文件：三組合共用（目前留空待發布）
  about.html            關於我們
  posts/                文章／研報頁（騰訊那篇底部已內嵌完整 PDF）
  assets/pdf/           所有 PDF 放這裡（研報原文、申報文件）

■ 發一篇新研報（Research Forum）
  1. PDF 放進 assets/pdf/（英文檔名）
  2. 複製 posts/_template.html 做報告頁：上半部寫簡介，
     底部取消 PDF 註釋、填上檔名（頁面會內嵌 PDF 預覽＋下載按鈕）
  3. assets/reports.js 的 REPORTS 最上面加一條（ticker/title/tags 都可被搜索）
  4. 若想同時上 Our Insights 精選 → assets/posts.js 也加一條
  5. 整個資料夾重新拖上 Netlify

■ 發布致股東信（Filings）
  PDF 放 assets/pdf/ → filings.html 照格式加一行 <li>，
  徽章 class 由「ext soon」改成「ext」並填上連結

■ Our Insights 精選
  卡片本身就是內容（引文式）＋底部「更多資訊」連結，
  在 assets/posts.js 的 POSTS 加一條即可，不需要做新頁面

■ 色彩慣例
  現為綠漲紅跌（美股慣例）。想改回紅漲綠跌：
  assets/style.css 第一段 :root 裡對調 --up 與 --down 的色值即可

■ 如何上線
  方法A：https://app.netlify.com/drop 拖整個資料夾，立即得到網址
  方法B：GitHub Pages（建 repo → 上傳 → Settings → Pages）
  自訂域名：Namecheap / Cloudflare 購買後在託管平台綁定

■ 待辦
  - about.html 郵箱換成真實郵箱
  - 三個組合頁五個分頁的內容（你說回頭給文件，貼進 tab-panel 即可）
  - Forum 若要開放留言：https://giscus.app 生成代碼貼入報告頁
