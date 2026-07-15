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

════════ 可選登入方式（v6 新增）════════

■ Google 登入（免費，約 10 分鐘）
  1. 打開 console.cloud.google.com → 頂部項目下拉 → New Project，名字隨意（如 yicapital）
  2. 左側菜單 → APIs & Services → OAuth consent screen：
     User Type 選 External → 填 App name（Yi Capital）、你的郵箱 → 一路保存默認
  3. APIs & Services → Credentials → Create Credentials → OAuth client ID：
     Application type 選 Web application
     Authorized JavaScript origins 加兩條：
       http://www.yicapital.co
       http://yicapital.co
     → Create → 複製那串 xxxx.apps.googleusercontent.com
  4. 填兩處：
     a. Cloudflare Worker → Settings → Variables 加一條 Text：
        GOOGLE_CLIENT_ID = 那串 client id
     b. GitHub 上編輯 assets/portal-config.js：
        window.YC_GOOGLE_CLIENT_ID = '那串 client id';
  5. 完成。login.html 會自動出現「使用 Google 繼續」按鈕。

■ 帳號模型（v3）
  · 註冊 = 用戶名 + 密碼 + 郵箱（配置了 Resend 則需輸入 6 位驗證碼）
  · Google 註冊 = Google 驗證身份 → 自己設置用戶名+密碼 → 建號
  · 登入 = 用戶名或郵箱 + 密碼；Google 用戶也可直接點 Google 按鈕

■ 郵箱驗證碼註冊（免費，約 10 分鐘，用 Resend）
  1. resend.com 註冊（免費 100 封/天）→ API Keys → Create → 複製 re_ 開頭的 Key
  2. Resend → Domains → Add Domain 填 yicapital.co →
     它給出的幾條 DNS 記錄，去 Cloudflare 你的域名 → DNS → 逐條添加 → 回 Resend 點 Verify
  3. Cloudflare Worker → Settings → Variables 加兩條：
     Secret: RESEND_API_KEY = re_xxxx
     Text:   MAIL_FROM = Yi Capital <login@yicapital.co>
  4. 完成。之後訪客用「郵箱」註冊時自動發 6 位驗證碼（15 分鐘有效、限錯 5 次），
     驗證通過才建號；用普通用戶名註冊則不需要驗證。
     不配 RESEND_API_KEY = 郵箱註冊退化為直接註冊，功能不受影響。

■ Apple 登入
  需要 Apple Developer Program（99 美元/年）+ 域名驗證，暫不接入。
  以後要加：模式與 Google 相同（前端拿 identityToken → Worker 驗簽建會話）。
