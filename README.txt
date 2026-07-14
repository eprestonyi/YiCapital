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

■ 數據驅動組合頁（v3 新增）—— fund-us.html
  Yi Capital US 現有一個「完整檔案頁」fund-us.html：
  所有指標與圖表由淨值表 Excel 即時計算，與 Yi_Capital_Manager_V2.py 同一套口徑
  （日收益 =（每股淨資產＋每股派息）÷ 前日淨資產 − 1；指標已與 pandas 逐位核對一致）。

  ▸ 更新數據（唯一要做的事）：
    1. 用 Yi_Capital_Manager 正常記帳，得到基金工作簿（含 NAV Statement /
       Asset Position Record 兩個分頁）
    2. 把該 xlsx 改名為 Yi_Capital_US.xlsx，放進 assets/data/ 覆蓋
    3. 重新拖上 Netlify → 頁面所有數字、曲線、熱力圖、VaR、壓測自動更新
    （目前 assets/data/ 內是一份示例數據，替換即可）

  ▸ 可選：Alpha / Beta / 基準對比曲線
    在同一 xlsx 加一個分頁「Benchmark」：
    第一行表頭 Date | SPY | QQQ | ...（收盤價），逐日一行。
    頁面會自動疊加基準淨值曲線並計算 Alpha、Beta、信息比率、R²。
    （可在 Python 程序裡把 yfinance 下載的 bm_prices 直接 to_excel 到該分頁）

  ▸ 本地預覽：直接雙擊 fund-us.html（file:// 下 fetch 會失敗），
    把 xlsx 拖進頁面即可渲染，不需要本地服務器。

  ▸ 引擎文件：
    assets/yc-analytics.js  計算引擎（解析 Excel、指標、VaR、bootstrap 壓測）
    assets/yc-charts.js     SVG 圖表渲染（風格對齊全站）
    HK / A Share 想做同款：複製 fund-us.html，把 DATA_URL 換成對應
    xlsx 路徑、改標題與投資邏輯文案即可（引擎全部共用）。

■ 持續同步（v4 新增）—— 網頁自動跟隨本地淨值表更新
  fund-us.html 頂部有「🔗 綁定本地淨值表（持續同步）」按鈕（需 Chrome/Edge 桌面版）：
    1. 點擊 → 選中你的基金工作簿（如 Yi_Capital_Version_2.xlsx）
    2. 之後頁面每 4 秒檢查文件修改時間；Python 程序一保存，
       全部指標與圖表自動重算重畫（狀態欄顯示 ● LIVE）
    3. 綁定跨會話保留：下次打開頁面點一下「重新連接」即恢復同步
  注意：這只作用於「你自己這台電腦上的瀏覽器」。訪客看到的仍是
  站內 assets/data/Yi_Capital_US.xlsx（或遠程數據，見下）。

  ▸ 讓「訪客也自動看到最新數據」的兩種方式：
    a) 遠程託管：把 xlsx 放到任意可公開訪問的直鏈（GitHub raw /
       Cloudflare R2 等），訪問 fund-us.html?data=https://…/文件.xlsx
       或把頁面裡 DATA_URL 常量改成該鏈接。之後只更新遠端文件即可，
       網站本身不用重新部署。（GitHub raw 可在 Python 記帳程序末尾
       加一句 git commit + push 實現全自動。）
    b) 傳統方式：覆蓋 assets/data/Yi_Capital_US.xlsx 後重新拖上 Netlify。

  說明：瀏覽器安全模型不允許任何網站「主動」讀寫你的硬盤；
  綁定式授權（File System Access API）是唯一正規途徑，且只讀。
  記帳寫入仍由 Python 程序完成——網站負責讀與展示。
