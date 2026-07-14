Cloudflare Worker 部署步驟（約 10 分鐘，全程網頁操作，免費）
════════════════════════════════════════════════════════

① 創建 KV（用戶數據庫）
   Cloudflare 儀表盤 → Storage & Databases → KV → Create namespace
   名稱填 YC_KV → Create

② 創建 Worker
   Workers & Pages → Create → Create Worker → 隨便命名（如 yicapital-portal）
   → Deploy → 點 Edit code → 刪掉默認代碼，把 worker.js 全文粘貼進去 → Deploy

③ 綁定 KV
   該 Worker → Settings → Bindings → Add → KV namespace
   Variable name 填 YC_KV，Namespace 選剛建的 → Save

④ 配置密鑰與變量（Settings → Variables and Secrets）
   【Secret 類型（加密）】
     ADMIN_USERNAME   你的管理員用戶名
     ADMIN_PASSWORD   你的管理員密碼（設強一點）
     GH_TOKEN         GitHub Fine-grained token（僅 YiCapital 倉庫、僅 Contents 讀寫）
   【Text 類型（明文變量）】
     GH_OWNER         eprestonyi
     GH_REPO          YiCapital
     GH_BRANCH        main
     GH_PATH          assets/data/Yi_Capital_US.xlsx
     ALLOWED_ORIGIN   https://你的網站域名（如 https://yicapital.com，不帶末尾斜杠）
   → Save and deploy

⑤ 連接前端
   Worker 概覽頁複製地址（形如 https://yicapital-portal.xxx.workers.dev）
   → 打開網站倉庫的 assets/portal-config.js，把地址填進 YC_API → Commit
   （之後 GitHub Pages 自動重新部署）

⑥ 驗收
   你的域名/login.html → Admin Login 用 ④ 設的帳密登入 → 進入後台
   → 拖入淨值表 → 發布 → 約 1 分鐘後 fund-us.html 更新
   → Guest Sign up 註冊一個測試號 → 後台「帳號管理」應能看到並可停用/重置/刪除

修改管理員密碼：回到 ④ 改 ADMIN_PASSWORD 這個 Secret 即可，即刻生效。

附：/api/benchmark 基準行情接口（無需額外配置）
  Worker 部署後自帶 GET /api/benchmark?symbols=spy.us,qqq.us
  服務端從 Stooq 拉取日線收盤價，KV 緩存 12 小時。
  前端（portfolios.html 與 fund-us.html）檢測到 portal-config.js
  裡填了 YC_API 後，會自動調用它：淨值曲線疊加 SPY/QQQ，
  指標卡自動多出「年化 Alpha」「Beta」。
  （Worker 部署前，也可在 Excel 加 Benchmark 分頁實現同樣效果。）
