/* Portal 後端地址 —— 部署 Cloudflare Worker 後把地址填到這裡（一行）
   例如: window.YC_API = 'https://yicapital-portal.你的子域.workers.dev';        */
window.YC_API = 'https://yicapital-portal.eprestonyi.workers.dev';
window.YC_RELEASE = 'v8.9-entry';
window.YC_FEATURES = Object.assign({ feedback: true }, window.YC_FEATURES || {});

/* Google 登入（可選）：在 console.cloud.google.com 創建 OAuth Client ID 後填入。
   留空 = 登入頁不顯示 Google 按鈕。 */
window.YC_GOOGLE_CLIENT_ID = '433596135840-hl13scv6o7g6v5oh0a1g4i6qfvv96hcd.apps.googleusercontent.com';
