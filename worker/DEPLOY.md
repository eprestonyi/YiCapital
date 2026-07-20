Cloudflare Worker v8.2 部署步驟（約 10 分鐘，全程網頁操作，免費）
════════════════════════════════════════════════════════

① 創建 KV（用戶數據庫）
   Cloudflare 儀表盤 → Storage & Databases → KV → Create namespace
   名稱填 YC_KV → Create

② 創建 Worker
   Workers & Pages → Create → Create Worker → 隨便命名（如 yicapital-portal）
   → Deploy → 點 Edit code → 刪掉默認代碼，把 worker.js 全文粘貼進去 → Deploy
   ⚠ 升級現有網站時也必須先完成這一步，再上傳前端文件；v6 不認得 HK/A
     的獨立 GitHub 路徑。

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
     GH_PATH_HK       assets/data/Yi_Capital_HK.xlsx（可省略，這是默認值）
     GH_PATH_A        assets/data/Yi_Capital_A.xlsx（可省略，這是默認值）
     ALLOWED_ORIGIN   https://你的網站域名（如 https://yicapital.com，不帶末尾斜杠）
   → Save and deploy

⑤ 連接前端
   Worker 概覽頁複製地址（形如 https://yicapital-portal.xxx.workers.dev）
   → 打開網站倉庫的 assets/portal-config.js，把地址填進 YC_API → Commit
   （之後 GitHub Pages 自動重新部署）

⑥ 驗收
   你的域名/login.html → Admin Login 用 ④ 設的帳密登入 → 進入後台
   → 在「基金組合」選 US / HK / A → 拖入對應工作簿 → 發布
   → 約 1 分鐘後首頁、組合頁和完整 US 檔案頁更新
   → Guest Sign up 註冊一個測試號 → 後台「帳號管理」應能看到並可停用/重置/刪除

修改管理員密碼：回到 ④ 改 ADMIN_PASSWORD 這個 Secret 即可，即刻生效。

附：v8.2 自動淨值與基準行情（無需額外 API Key）
  · POST /api/ledger 保存三個組合的持倉、現金、負債與總份額。
  · 首次發布亦把 NAV 歷史寫入 KV，後台生成完整分析快照；公開 GET 只讀 KV，
    不在訪客請求時抓行情、讀 Excel 或即時計算。
  · 每日 Cron 以實際收盤行情計算市場價值、總資產、淨值與每份 NAV；
    Excel 的 NAV Statement 只保留歷史曲線，不再要求每日手工上傳。
  · GET /api/benchmark?set=us：S&P 500 / NASDAQ / DOW
  · GET /api/benchmark?set=hk：國企 ETF 2828 / 恒生 ETF 2800 / 恒科 ETF 3032
  · GET /api/benchmark?set=a：滬深 300
  · 行情、基準、Sharpe、回撤、VaR、壓測及持倉資料全部寫入 KV；
    首頁、portfolios 與 fund-us 直接展示同一份快照。

⑦ 配置每日任務（Worker → Settings → Triggers → Cron Triggers）
     30 21 * * *   US 收盤後更新 US + US 三大指數
     0 9 * * *     北京 17:00 更新 HK/A + 三隻港股 ETF/滬深300

⑧ 首次啟用
   部署 v8.2 後，在 admin-publish 依次發布 US、HK、A 三份工作簿各一次，
   再點「立即刷新後台緩存」預熱三市場行情與基準。
   以後只有交易、出入金、股息、公司行動或負債改變時才需重新發布。

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

════════ 郵件中心與收件箱（v4 新增）════════

■ 群發（admin 後台「③ 郵件中心」）
  · insight@yicapital.co    → 只發給勾選了訂閱的用戶（未訂閱者自動跳過）
  · information@yicapital.co → 可發給任何用戶（條款 04 授權的服務通知）
  · 範圍可選「全部」或「指定用戶」（勾選列表）
  · 無需額外配置，複用 RESEND_API_KEY；可選加一條 Text 變量
    MAIL_DOMAIN = yicapital.co（不加則默認 yicapital.co）

■ 收件箱（別人回信 → admin 後台「④ 收件箱」）
  需開啟 Cloudflare Email Routing（免費，5 分鐘）：
  1. dash.cloudflare.com → 選 yicapital.co → 左側 Email → Email Routing
     → Get started / Enable（它會自動往根域加 MX 和 TXT 記錄，
       與 Resend 在 send 子域的記錄互不衝突，放心開）
  2. Email Routing → Routing rules / Custom addresses → Create address：
     地址填 insight    → Action 選 Send to a Worker → 選 yicapital-portal → Save
     再建一條 information → 同樣 Send to a Worker → yicapital-portal
  3. 完成。任何人發/回信到這兩個地址，郵件自動出現在後台收件箱
     （解析 text/plain 正文，中文/引用/HTML 郵件做盡力提取）。
  注意：v4 的 worker.js 才帶收信處理器——記得把最新代碼貼進 Cloudflare。

════════ 歡迎信與研報簡報（v4.1 新增）════════

■ 歡迎信（自動）
  新用戶完成註冊（郵箱驗證通過 / Google 建號）即自動收到歡迎信：
  由 information@yicapital.co 發出，落款 Preston, YiCapital，
  無需任何配置（複用 RESEND_API_KEY），發送失敗不影響註冊。

■ 研報簡報群發（Bloomberg 風格）
  發送方法（後台「③ 郵件中心」）：
  1. 點「📄 載入騰訊研報示例模板」→ 正文框自動填入 HTML、
     格式自動切到「研報簡報(HTML)」、主題自動帶上
  2. 直接改文字：標題、評級/目標價數據條、KEY TAKEAWAYS 三點、
     數據表、引用句、按鈕鏈接——只改文字，不要動 style="…"
  3. 先發自己：範圍選「指定用戶」勾自己 → 發送 → 去郵箱看排版
  4. 滿意後範圍改「全部」、身份選 insight@ → 發送（自動跳過未訂閱者）
  模板文件在 email-templates/tencent-brief.html，可複製多份做不同研報；
  合規頁腳（退訂說明＋免責）發送時自動附加，模板裡不用寫。
