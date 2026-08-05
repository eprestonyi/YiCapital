Cloudflare Worker v9.4 部署步驟（D1 登入會話 + D1 事件賬本 + Password-only Admin + Wrangler ES Module + Terminal Atlas + 用戶意見 D1）
════════════════════════════════════════════════════════

① 創建 KV（用戶數據庫）
   Cloudflare 儀表盤 → Storage & Databases → KV → Create namespace
   名稱填 YC_KV → Create

② 創建或升級 Worker
   本 Worker 由 worker.js、tushare.js、warehouse.js 等多個 ES module 組成，必須在
   倉庫根目錄依照 wrangler.toml 綁定後由 Wrangler 打包，不能只在 Dashboard 貼上
   worker.js。部署前先執行：
     npm test
     npx wrangler@latest deploy --dry-run --keep-vars
   確認無誤後執行：
     npx wrangler@latest deploy --keep-vars
   wrangler.toml 不覆蓋帳戶的 CPU 上限。首次把 PBKDF2 寫入成本由 100k 升至 600k
   前，必須按下方「v9.4 密碼相容橋」順序發布，並用臨時帳戶實測註冊、登入、
   /api/me、登出與刪除；任一步超時或失敗即停在相容橋，不得發布靜態前端。
   新環境需先建立下列 KV/D1 並把 wrangler.toml 內的 id 改成該環境資源；現有環境
   則直接使用已核對的綁定。

③ 綁定 KV
   該 Worker → Settings → Bindings → Add → KV namespace
   Variable name 填 YC_KV，Namespace 選剛建的 → Save

③-B 創建及初始化 D1（登入會話 + 用戶意見 + 投資組合事件賬本）
   Cloudflare 儀表盤 → Storage & Databases → D1 → Create database
   名稱填 yicapital-feedback。
   Worker → Settings → Bindings → Add → D1 database
   Variable name 填 FEEDBACK_DB，Database 選 yicapital-feedback。
   使用倉庫的 wrangler.toml 部署時，執行：
     npx wrangler d1 migrations apply FEEDBACK_DB --remote
   這會依次套用 migrations/0001_user_feedback.sql、
   migrations/0002_portfolio_ledger.sql、migrations/0003_frozen_price_tapes.sql 與
   migrations/0004_auth_sessions.sql、migrations/0005_public_portfolio_snapshots.sql、
   migrations/0006_dividend_candidate_inbox.sql。
   0003 為每個 ledger revision 建立 immutable、未復權 raw-close price tape，
   是 NAV 發布門禁；0004 必須先於 v9.4 Worker 部署完成；0005 把賬本物化投影、
   最後完整公開快照及最新刷新狀態放入 D1，以單行 guarded UPSERT 取代分鐘級
   KV 多鍵發布。0006 建立派息核實 Inbox：行情只寫 Amount=NULL 的候選，管理員輸入
   券商實際到賬 Amount 後只轉成 Pending，仍須另行 Confirm。0005/0006 都是 additive
   migration，必須先套用再部署讀取它們的 Worker。
   不要把登入 token、
   用戶意見、投資組合事件或稅務資料存入公開 GitHub 文件。

   v9.4 以 D1 作為登入會話真源：普通帳戶為 30 天閒置滑動續期、180 天絕對上限；
   管理員為 12 小時閒置、7 天絕對上限，並以不可逆指紋綁定目前管理員憑證，輪換
   ADMIN_USERNAME、ADMIN_PASSWORD 或限流 salt 後，舊管理員會話會自動失效。新 D1
   會話不再把明文 bearer token 複製到 KV；既有 sess:{token} 只供懶遷移，成功
   遷入 D1 後即刪除。
   v9.4 密碼相容橋：第一次發布使用同一套強化後的 D1／管理員會話程式碼，但暫時
   以 100k 寫入 PBKDF2、關閉懶升級，同時保留按 passwordIterations 驗證 100k／600k
   雜湊的能力。相容橋健康及登入回歸全部通過、且 deployment id 已記錄後，才可發布
   寫入 600k 的完整 v9.4。不得在兩版本間做流量混跑。完整 v9.4 的回退目標只能是這個
   相容橋；v9.3 固定按 100k 驗證，亦會延長管理員會話及重建 KV 明文 bearer 副本，
   因此絕不是安全回退版本。

   v9 過渡期可讓事件賬本與 user log 共用 FEEDBACK_DB。若另建專用 D1，綁定名
   必須是 LEDGER_DB；Worker 會優先使用 LEDGER_DB，未配置時才回退 FEEDBACK_DB。

④ 配置密鑰與變量（Settings → Variables and Secrets）
   【Secret 類型（加密）】
     ADMIN_USERNAME   你的管理員用戶名
     ADMIN_PASSWORD   你的管理員密碼（設強一點）
     GH_TOKEN         GitHub Fine-grained token（僅 YiCapital 倉庫、僅 Contents 讀寫）
     FEEDBACK_RATE_SALT  隨機 32-byte 字串，用於匿名意見及登入限流摘要
     TUSHARE_TOKEN    Tushare Pro token；只存 Worker Secret，禁止寫入前端或 Git
   【Text 類型（明文變量）】
     GH_OWNER         eprestonyi
     GH_REPO          YiCapital
     GH_BRANCH        main
     GH_PATH          assets/data/Yi_Capital_US.xlsx
     GH_PATH_HK       assets/data/Yi_Capital_HK.xlsx（可省略，這是默認值）
     GH_PATH_A        assets/data/Yi_Capital_A.xlsx（可省略，這是默認值）
     ALLOWED_ORIGIN   https://www.yicapital.co（canonical host，不帶末尾斜杠）
     ALLOWED_ORIGINS  可選逗號分隔 allowlist；過渡期可填
                      https://www.yicapital.co,https://yicapital.co
     TERMINAL_RATE_LIMIT_PER_MINUTE  可選；每 IP 每分鐘上限，預設 120
   → Save and deploy

④-B 發布 Terminal Atlas 只讀快照
   Terminal 的即時/發布驅動行情由 Tushare 提供；供應鏈與歷史證據快照走
   YC_KV 的 terminal:warehouse:atlas-seed 鍵，兩者不混寫。部署前把
   assets/data/atlas-seed.json 以 JSON 寫入該鍵。快照 status=partial 時，
   API 與前端必須保留 partial / missing 標記，不得以 0 代替缺失值。

   Terminal 公開路由：
     GET /api/terminal/status
     GET /api/terminal/bootstrap
     GET /api/terminal/search
     GET /api/terminal/market
     GET /api/terminal/news
     GET /api/terminal/quote
     GET /api/terminal/history
     GET /api/terminal/stock-detail

   Tushare 只允許 worker/tushare.js 中的資料集與參數白名單。上游權限不足、
   token 無效、超時、空資料或 schema 異常均 fail closed，前端不得生成替代數字。

⑤ 連接前端
   Worker 概覽頁複製地址（形如 https://yicapital-portal.xxx.workers.dev）
   → 打開網站倉庫的 assets/portal-config.js，把地址填進 YC_API → Commit
   （之後 GitHub Pages 自動重新部署）

⑥ 驗收
   你的域名/login.html → Admin Login 用 ④ 設的帳密登入 → 進入後台
   → 進入「事件賬本」，依次選 US / HK / A：人工新增只測 BUY / SELL / CAPITAL；
     自動檢測到派息時先進核實 Inbox（候選 Amount 永遠為空），人工輸入券商實際
     到賬 Amount 後才轉入 Pending，再修改/Confirm；Amount 已包含所有稅費，不存在
     另一套扣稅/費用工作流。公司行動、負債與基金行動同樣須由自動來源進 Pending。
     Excel 可新建的仍只限 BUY / SELL / CAPITAL；已由後台簽名
     導出的其他既有事件可在整本反向同步中 UPDATE 或移除。外部工作簿只在無會話、
     無 DOM、斷網且有 ZIP/公式/大小白名單的一次性 Worker 中解析，原始 xlsx 不上傳
   → Confirm 後應自動完成最早受影響日起的全歷史 Cash / Position / Liability /
     Units / NAV 重算，然後重建 D1 物化投影、公開快照與 Excel；outbox 最終應回到 0
   → /api/health 的 ledger_storage_ready 應為 true，三市場 projectionRevision 應等於
     ledgerRevision；新 revision 尚在重算時可暫時保留上一份完整 publicRevision
   → 首頁、組合頁和完整 US/HK/A 檔案頁讀取同一份 D1 公開快照；舊 KV 只作遷移/災備回退
   → Guest Sign up 註冊一個測試號 → 後台「帳號管理」應能看到並可停用/重置/刪除
   → 任一公開頁右下角提交一條測試意見 → admin-feedback 應顯示該條記錄，
     可更新狀態、優先級、處理備註及關聯 Issue / PR / 修復版本

修改管理員密碼：回到 ④ 改 ADMIN_PASSWORD 這個 Secret 即可，即刻生效。

附：v9 D1 事件賬本、自動淨值與基準行情
  · D1 的 ledger_events 是唯一真源；公开 GET 只读 D1 原子公开快照，不在访客请求时
    读 Excel。迁移期仅在 D1 缺表、读故障或尚未 backfill 时读取经过完整合同校验的旧 KV。
  · POST /api/ledger 与 POST /api/publish 永久返回 410；不存在可重新开启的
    Excel/KV 快照回退开关。
  · 人工只可新增 BUY、SELL、CAPITAL；股息、公司行动、负债及基金行动必须由
    Broker/custodian/后台任务自动写 source record 后进入 Pending。所有 Pending 均可
    修改；现金事件的 Amount 已是券商最终结算数，不另拆或重复扣税费，Confirm 后才写
    immutable event。自动派息信号先进入 Amount=NULL 的核实 Inbox，不会自动 Confirm。
  · Amount 是现金链与买入成本/卖出收入的唯一真相；Price 只作参考，gross/tax/fee
    是审计拆分，不得在 Amount 之外再次扣减。负现金照实进入 NAV，不警告、不阻断 Confirm。
  · 公司行动只记录原股变成哪些新 ticker 及绝对数量；不按价格分配、搬移或创造
    成本。所有成本/收入/税费只来自各自的 Cash Amount；公司行动 Cash 独立进入现金链。
  · Confirm 立即由 outbox 先冻结当前 revision 的未复权 raw-close price tape，再全历史
    重算现金、持仓、负债、份额与 NAV，完成后才重建 D1 物化投影 / 公开快照 / Excel；每日 Cron 再以
    实际收盘行情更新。盘中一分钟 Cron 只在各市场正常交易时段用已核验 counter
    覆盖当日点；已冻结历史不可改写。Excel 四张 derived statements 只展示后台计算结果，不是
    operational seed，也不要求每日手工上传。
  · GET /api/benchmark?set=us：S&P 500 / NASDAQ / DOW
  · GET /api/benchmark?set=hk：恒生指數 HSI / 恒生科技指數 HKTECH
  · GET /api/benchmark?set=a：滬深 300（只使用 Tushare；失敗時讀取上一份
    持久化成功快照，token 永不下發瀏覽器）
  · GET /api/entry-market：登入入口專用的三市場全歷史精簡快照，只含對齊後
    的組合/基準指數點與資料質量狀態，不包含持倉
  · NAV、Sharpe、回撤、VaR、壓測及持倉以一個 D1 public snapshot 原子發布；
    benchmark 仍是低頻 KV 快照。盤中 Tushare minute/intraday 報價不寫共享 KV，
    避免耗盡賬戶每日寫入配額；首頁、portfolios 與 fund-us 直接展示同一份快照。

⑦ 配置每日任務（Worker → Settings → Triggers → Cron Triggers）
     * * * * *     各市场正常交易时段每分钟更新当日未复权 counter NAV（D1 原子发布，无分钟级组合 KV 写）；同时续跑 outbox
     30 21 * * *   US 收盤後更新 US + US 三大指數
     0 9 * * *     北京 17:00 更新 HK/A 即時收盤快照
     30 10 * * *   北京 18:30 以官方 EOD 對賬 HK/A + 三隻港股 ETF/滬深300

⑧ 首次啟用
   先按 docs/PORTFOLIO_LEDGER.md 的遷移門禁，把三份舊工作簿轉成 canonical JSON，
   在 preview 环境重放并对账后再导入 production D1。确认三本的事件数、现金、
   份额、持仓和 NAV 一致，再从「事件账本」确认 outbox 与三市场行情预热。
   在任何 production migration/import 前先记录 D1 Time Travel bookmark；导入确认
   必须显式确认 duplicates，并输入服务端真实确认短语：
   CONFIRM LEGACY US / CONFIRM LEGACY HK / CONFIRM LEGACY A。负现金照实计算且不作 warning；
   Asset Position、Liability Statement、Cash Flow Statement、NAV Statement 只用于
   parity 核验，不得作为 operational seed。SPGI → SPGI + MBGL 只转换数量，不分配
   成本，不要求 Form 8937，也不是 migration blocker。
   不要再通过 admin-publish 或 GitHub 工作簿更新投资组合；Excel 只从数据库导出，
   上传可为 BUY / SELL / CAPITAL 新建事实，也可修改或移除带签名元数据的既有事件；
   整本必须经过全量 Preview → 明确确认整本覆盖 → 一个原子 revision。被取代或移除
   的旧事件仍永久保留；空白 Price 保留已有值，CPS 与税费兼容列不反写，四张 derived
   statements 永不反写。浏览器主页面不直接解析工作簿；一次性隔离 Worker 在移除网络、
   存储和页面能力后才解析 allowlist sheet，并在一次响应或 15 秒后强制终止。
   0005 首次上线后保留旧 navcache/ledger KV 原值，不删除；由后台实时刷新或完整重算
   验证当前 ledger revision 后自动 backfill 三市场 D1 projection/public snapshot。确认
   /api/health 的 ledger_storage_ready=true、三个 public snapshot SHA 校验通过、公开接口
   均显示 storage_backend=d1 后，旧 KV 才只是只读灾备。

════════ 可選登入方式（v6 新增）════════

■ Google 登入（免費，約 10 分鐘）
  1. 打開 console.cloud.google.com → 頂部項目下拉 → New Project，名字隨意（如 yicapital）
  2. 左側菜單 → APIs & Services → OAuth consent screen：
     User Type 選 External → 填 App name（Yi Capital）、你的郵箱 → 一路保存默認
  3. APIs & Services → Credentials → Create Credentials → OAuth client ID：
     Application type 選 Web application
     Authorized JavaScript origins 加兩條：
       https://www.yicapital.co
       https://yicapital.co
     → Create → 複製那串 xxxx.apps.googleusercontent.com
  4. 填兩處：
     a. Cloudflare Worker → Settings → Variables 加一條 Secret：
        GOOGLE_CLIENT_ID = 那串 client id
     b. GitHub 上編輯 assets/portal-config.js：
        window.YC_GOOGLE_CLIENT_ID = '那串 client id';
  5. 管理員只允許使用 ADMIN_USERNAME + ADMIN_PASSWORD 登入；Google 僅用於普通用戶，
     不配置 ADMIN_GOOGLE_EMAILS，也不會把任何 Google 郵箱提升為管理員。
  6. 完成。普通用戶入口會出現 Google 官方按鈕；首次授權會直接建號並寄歡迎信，
     後續點擊直接登入，不需要再設用戶名或密碼。

■ 帳號模型（v9.4）
  · 註冊 = 用戶名 + 密碼 + 郵箱；郵箱必須先完成 6 位驗證碼確認
  · Google 註冊 = Google 驗證身份 → 一鍵建立無密碼帳號
  · 登入 = 用戶名或郵箱 + 密碼；Google 用戶也可直接點 Google 按鈕
  · Guest = 不建立帳號、不發 session token；公開研究內容保持可讀，但沒有會員帳戶
    資料、訂閱設定或管理員權限。前端明確顯示「訪客模式」，不偽裝成 YI 頭像

■ 郵箱驗證碼註冊（免費，約 10 分鐘，用 Resend）
  1. resend.com 註冊（免費 100 封/天）→ API Keys → Create → 複製 re_ 開頭的 Key
  2. Resend → Domains → Add Domain 填 yicapital.co →
     它給出的幾條 DNS 記錄，去 Cloudflare 你的域名 → DNS → 逐條添加 → 回 Resend 點 Verify
  3. Cloudflare Worker → Settings → Variables 加兩條：
     Secret: RESEND_API_KEY = re_xxxx
     Text:   MAIL_FROM = Yi Capital <login@yicapital.co>
  4. 完成。之後所有郵箱註冊都先發 6 位驗證碼（15 分鐘有效、限錯 5 次），驗證通過
     才建號。未配置 RESEND_API_KEY 時註冊端點返回 503 並保持 fail closed，絕不退化
     為未驗證的直接註冊。

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
