/* ═══════════════════════════════════════════════════════════════
   Yi Capital Portal Backend v8.2 — Cloudflare Worker（單文件，粘貼即部署）
   ─────────────────────────────────────────────────────────────
   帳號模型：
     · 註冊 = 用戶名 + 密碼 + 郵箱（配置了 Resend 則發 6 位驗證碼）
     · Google 註冊 = Google 驗證身份 → 自己設置用戶名+密碼 → 建號
     · 登入 = 用戶名或郵箱 + 密碼；Google 用戶也可直接點 Google 登入
   接口：
     POST /api/signup           {username,password,email}
     POST /api/verify           {email,code}
     POST /api/login            {username(或郵箱),password}
     POST /api/google           {credential} → 老用戶直接登入 / 新用戶返回 needSetup
     POST /api/google/complete  {setupToken,username,password}
     GET  /api/me   POST /api/logout
     GET  /api/benchmark?set=us|hk|a               三市場基準行情（只讀 KV 快照）
     POST /api/refresh          [admin] 手動重算 NAV / 統計 / 基準並覆蓋 KV
     GET  /api/users            [admin]
     POST /api/users/update     [admin] disable/enable/delete/resetpw
     POST /api/publish          [admin] 淨值表 → GitHub
     POST /api/ledger           [admin] 上傳持倉賬本（發布時前端自動提取）
     GET  /api/content          公開：研報庫+研究觀點條目（僅啟用項）
     GET  /api/content/all      [admin] 全部條目（含停用）
     POST /api/content/save     [admin] 覆蓋保存 {kind:'reports'|'posts', items:[…]}
     POST /api/forgot           找回密碼第一步 {email} → 郵箱驗證碼
     POST /api/reset            找回密碼第二步 {email, code, password}
     POST /api/users/setpw      [admin] 重設任意用戶密碼
     GET  /api/nav/us|hk|a      公開：只讀每日持久化快照（不即時計算/抓行情）
     ⏰ Cron: "30 21 * * *" 美股收盤後更新 US ｜ "0 9 * * *" 北京 17:00 更新 HK/A
   KV 鍵：
     user:{用戶名} / email:{郵箱}→用戶名 / sess:{token} /
     pending:{郵箱}(驗證碼,15分鐘) / gsetup:{token}(Google待設置,15分鐘) /
     ledger:{us|hk|a} / live:{us|hk|a} / navcache:{us|hk|a} /
     navstatus:{us|hk|a} / bmset:{us|hk|a} / bmstatus:{us|hk|a}
   綁定與密鑰：KV=YC_KV；Secrets: ADMIN_USERNAME, ADMIN_PASSWORD, GH_TOKEN,
     （可選）RESEND_API_KEY；Text: GH_OWNER, GH_REPO, GH_BRANCH, GH_PATH,
     ALLOWED_ORIGIN,（可選）GOOGLE_CLIENT_ID, MAIL_FROM
   ═══════════════════════════════════════════════════════════════ */

const SESSION_TTL = 7 * 24 * 3600;
const enc = new TextEncoder();

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));

async function pbkdf2(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return hex(bits);
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const corsHeaders = env => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
});
const J = (env, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(env) } });

async function getSession(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (!m) return null;
  const raw = await env.YC_KV.get('sess:' + m[1]);
  return raw ? { token: m[1], ...JSON.parse(raw) } : null;
}
async function newSession(env, username, role) {
  const token = randomHex(32);
  await env.YC_KV.put('sess:' + token, JSON.stringify({ u: username, role }), { expirationTtl: SESSION_TTL });
  return token;
}

const isUsername = u => /^[a-zA-Z0-9_\-\u4e00-\u9fff]{2,24}$/.test(u || '');
const isEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e || '');
const brandWordmark = (size = '20px') =>
  '<span style="display:inline-block;background:#0B1E3F;padding:3px 8px;font-family:Arial,sans-serif;font-weight:800;font-size:' + size + ';letter-spacing:0;white-space:nowrap">'
  + '<span style="color:#FFFFFF">Yi</span>'
  + '<span style="color:#6E9AF4">C</span><span style="color:#7A8CF5">a</span><span style="color:#867EF6">p</span>'
  + '<span style="color:#9270F7">i</span><span style="color:#9E63F8">t</span><span style="color:#AA57F9">a</span><span style="color:#B54BFA">l</span>'
  + '</span>';

async function sendResetCode(env, email, code) {
  const html = '<div style="max-width:560px;margin:0 auto;font-family:Georgia,\'Noto Serif TC\',serif;color:#1a1a1a;background:#ffffff">'
    + '<div style="border-bottom:3px solid #0e7490;padding:20px 0 12px">' + brandWordmark('20px') + '<span style="float:right;font-family:Arial,sans-serif;font-size:11px;color:#888;letter-spacing:2px;padding-top:6px">PASSWORD RESET</span></div>'
    + '<div style="padding:26px 0 4px">'
    + '<p style="font-size:15px;line-height:1.9;margin:0 0 6px">您好，</p>'
    + '<p style="font-size:15px;line-height:1.9;margin:0 0 18px">我們收到了重設您 Yi Capital 帳號密碼的請求。請在頁面輸入以下驗證碼以繼續：</p>'
    + '<p style="font-size:13.5px;line-height:1.8;color:#555;margin:0 0 18px">We received a request to reset your Yi Capital password. Enter the code below to continue:</p>'
    + '<div style="background:#f4f7f9;border:1px solid #dbe3e8;border-radius:8px;text-align:center;padding:22px 0;margin:6px 0 20px"><span style="font-family:Arial,sans-serif;font-size:34px;font-weight:800;letter-spacing:10px;color:#0e7490">' + code + '</span></div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;font-size:12.5px;color:#666;line-height:1.9"><tr><td>'
    + '· 驗證碼於 <b>15 分鐘</b>內有效。若您並未發起此請求，請忽略本郵件，密碼不會被更改。<br>'
    + '· This code expires in <b>15 minutes</b>. If you did not request this, ignore this email — your password will not change.'
    + '</td></tr></table>'
    + '<p style="font-size:15px;line-height:1.9;margin:26px 0 0">Preston<br>' + brandWordmark('15px') + '</p>'
    + '</div>'
    + '<hr style="border:none;border-top:1px solid #ddd;margin:26px 0 12px">'
    + '<p style="color:#999;font-size:11.5px;font-family:Arial,sans-serif;line-height:1.8">此為系統郵件（服務條款 04）。Yi Capital · <a href="https://www.yicapital.co" style="color:#0e7490">yicapital.co</a></p></div>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || 'Yi Capital <onboarding@resend.dev>', to: [email], subject: 'Yi Capital 密碼重設驗證碼 Password Reset Code: ' + code, html }),
  });
  return r.ok;
}

async function sendCode(env, email, code) {
  const html = '<div style="max-width:560px;margin:0 auto;font-family:Georgia,\'Noto Serif TC\',serif;color:#1a1a1a;background:#ffffff">'
    + '<div style="border-bottom:3px solid #0e7490;padding:20px 0 12px">' + brandWordmark('20px') + '<span style="float:right;font-family:Arial,sans-serif;font-size:11px;color:#888;letter-spacing:2px;padding-top:6px">ACCOUNT VERIFICATION</span></div>'
    + '<div style="padding:26px 0 4px">'
    + '<p style="font-size:15px;line-height:1.9;margin:0 0 6px">您好，</p>'
    + '<p style="font-size:15px;line-height:1.9;margin:0 0 18px">感謝您註冊 Yi Capital。請在註冊頁面輸入以下驗證碼以完成郵箱驗證：</p>'
    + '<p style="font-size:13.5px;line-height:1.8;color:#555;margin:0 0 18px">Thank you for signing up with Yi Capital. Please enter the verification code below to complete your email verification:</p>'
    + '<div style="background:#f4f7f9;border:1px solid #dbe3e8;border-radius:8px;text-align:center;padding:22px 0;margin:6px 0 20px"><span style="font-family:Arial,sans-serif;font-size:34px;font-weight:800;letter-spacing:10px;color:#0e7490">' + code + '</span></div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;font-size:12.5px;color:#666;line-height:1.9"><tr><td>'
    + '· 驗證碼於 <b>15 分鐘</b>內有效，且僅可使用一次。<br>'
    + '· This code expires in <b>15 minutes</b> and can only be used once.<br>'
    + '· 若您並未發起此次註冊，請忽略本郵件，您的郵箱不會被註冊。<br>'
    + '· If you did not request this, please disregard this email — no account will be created.'
    + '</td></tr></table>'
    + '<p style="font-size:15px;line-height:1.9;margin:26px 0 0">Preston<br>' + brandWordmark('15px') + '</p>'
    + '</div>'
    + '<hr style="border:none;border-top:1px solid #ddd;margin:26px 0 12px">'
    + '<p style="color:#999;font-size:11.5px;font-family:Arial,sans-serif;line-height:1.8">此為系統郵件，由 Yi Capital 帳號服務發出（服務條款 04）。This is an automated message from Yi Capital account services.<br>Yi Capital · <a href="https://www.yicapital.co" style="color:#0e7490">yicapital.co</a> · Key to Extraordinary Research and Opensource Portfolio</p></div>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Yi Capital <onboarding@resend.dev>',
      to: [email],
      subject: 'Yi Capital 郵箱驗證碼 Verification Code: ' + code,
      html,
    }),
  });
  return r.ok;
}
async function sendWelcome(env, email, username) {
  if (!env.RESEND_API_KEY) return;
  const domain = env.MAIL_DOMAIN || 'yicapital.co';
  const html = '<div style="font-family:Georgia,\'Noto Serif TC\',serif;max-width:560px;margin:0 auto;color:#1a1a1a;line-height:1.9;font-size:15.5px">'
    + '<div style="border-bottom:3px solid #0e7490;padding:18px 0 10px">' + brandWordmark('20px') + '</div>'
    + '<p style="margin-top:26px">' + username + '，你好：</p>'
    + '<p>歡迎加入 Yi Capital——Key to Extraordinary Research and Opensource Portfolio。</p>'
    + '<p>這裡是一個開源的個人投資組合：全部淨值、持倉與風險數據由淨值表即時計算，全部研究公開可讀，<b>歡迎抄作業</b>（註明出處即可），更歡迎來信交流——回覆本郵件就能找到我。</p>'
    + '<p>先從這三處開始：<br>· 組合實錄：<a href="https://www.yicapital.co/portfolios.html" style="color:#0e7490">yicapital.co/portfolios.html</a><br>· 研究觀點：<a href="https://www.yicapital.co/insights.html" style="color:#0e7490">yicapital.co/insights.html</a><br>· 致股東的信：<a href="https://www.yicapital.co/filings.html" style="color:#0e7490">yicapital.co/filings.html</a></p>'
    + '<p style="margin-top:30px">坐在牌桌上，是一切正期望值交易兌現的前提。</p>'
    + '<p style="margin-top:26px">Preston<br>' + brandWordmark('15px') + '</p>'
    + '<hr style="border:none;border-top:1px solid #ddd;margin:28px 0 12px"><p style="color:#999;font-size:12px;font-family:Arial,sans-serif">此為帳號服務通知（服務條款 04）。Yi Capital · yicapital.co</p></div>';
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Yi Capital <information@' + domain + '>', to: [email], reply_to: 'information@' + domain, subject: '歡迎加入 Yi Capital，' + username, html }),
    });
  } catch (e) { /* 歡迎信失敗不影響註冊 */ }
}

async function createUser(env, rec) {
  await env.YC_KV.put('user:' + rec.u, JSON.stringify(rec));
  if (rec.email) await env.YC_KV.put('email:' + rec.email, rec.u);
}

/* ── 收件：極簡 MIME 文本提取（best-effort，覆蓋常見 text/plain、QP、base64、multipart）── */
/* ── 三市場報價鏈：Stooq 優先，Yahoo Chart API 備援 ── */
function symbolMap(ticker, market) {
  const t = String(ticker || '').trim();
  if (market === 'hk') return { stooq: t.replace(/\.HK$/i, '').padStart(4, '0') + '.hk', yahoo: t.toUpperCase() };
  if (market === 'a') return { stooq: null, yahoo: t.toUpperCase() };
  return { stooq: t.toLowerCase().replace(/\./g, '-') + '.us', yahoo: t.toUpperCase() };
}
async function stooqQuoteRaw(symbol) {
  if (!symbol) return null;
  const r = await fetch('https://stooq.com/q/l/?s=' + encodeURIComponent(symbol) + '&f=sd2t2ohlcv&h&e=csv', { headers: { 'User-Agent': 'yicapital-portal' } });
  if (!r.ok) return null;
  const lines = (await r.text()).trim().split('\n');
  if (lines.length < 2) return null;
  const c = lines[1].split(','), close = parseFloat(c[6]), date = String(c[1] || '').slice(0, 10);
  return isFinite(close) && close > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date, close } : null;
}
async function yahooChart(symbol, range) {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=' + (range || '5d') + '&interval=1d&events=history&includeAdjustedClose=true', { headers: { 'User-Agent': 'Mozilla/5.0 yicapital-portal' } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && j.chart && j.chart.result && j.chart.result[0] || null;
}
async function yahooQuote(symbol) {
  const res = await yahooChart(symbol, '10d');
  if (!res || !res.timestamp || !res.indicators || !res.indicators.quote) return null;
  const close = res.indicators.quote[0].close || [];
  for (let i = res.timestamp.length - 1; i >= 0; i--) {
    if (isFinite(close[i]) && close[i] > 0) return { date: new Date(res.timestamp[i] * 1000).toISOString().slice(0, 10), close: close[i] };
  }
  return null;
}
async function quote(ticker, market) {
  const m = symbolMap(ticker, market);
  try { const q = await yahooQuote(m.yahoo); if (q) return q; } catch (e) {}
  if (m.stooq) { try { return await stooqQuoteRaw(m.stooq); } catch (e) {} }
  return null;
}
async function stooqSeries(symbol) {
  if (!symbol) return null;
  const r = await fetch('https://stooq.com/q/d/l/?s=' + encodeURIComponent(symbol) + '&i=d', { headers: { 'User-Agent': 'yicapital-portal' } });
  if (!r.ok) return null;
  const rows = (await r.text()).trim().split('\n').slice(1).map(l => l.split(','));
  const series = rows.filter(c => c.length >= 5 && c[4] && c[4] !== 'N/D').slice(-1300).map(c => ({ date: c[0], close: parseFloat(c[4]) })).filter(p => isFinite(p.close));
  return series.length > 20 ? series : null;
}
async function yahooSeries(symbol) {
  const res = await yahooChart(symbol, '5y');
  if (!res || !res.timestamp || !res.indicators || !res.indicators.quote) return null;
  const close = res.indicators.quote[0].close || [], out = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    if (isFinite(close[i]) && close[i] > 0) out.push({ date: new Date(res.timestamp[i] * 1000).toISOString().slice(0, 10), close: close[i] });
  }
  return out.length > 20 ? out.slice(-1300) : null;
}
async function hangSengSeries(code) {
  const r = await fetch('https://www.hsi.com.hk/data/eng/indexes/' + encodeURIComponent(code) + '/chart.json', { headers: { 'User-Agent': 'Mozilla/5.0 yicapital-portal' } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const levels = j && (j['indexLevels-5y'] || j['indexLevels-3y'] || j['indexLevels-1y']);
  if (!Array.isArray(levels)) return null;
  const out = levels.map(p => ({ date: new Date(Number(p[0])).toISOString().slice(0, 10), close: Number(p[1]) })).filter(p => isFinite(p.close) && p.close > 0);
  return out.length > 20 ? out : null;
}
const BM_SETS = {
  us: [{ label: 'S&P 500', stooq: '^spx', yahoo: '^GSPC' }, { label: 'NASDAQ', stooq: '^ndq', yahoo: '^IXIC' }, { label: 'DOW', stooq: '^dji', yahoo: '^DJI' }],
  hk: [
    { label: 'HSCEI ETF', stooq: '2828.hk', yahoo: '2828.HK' },
    { label: 'HSI ETF', stooq: '2800.hk', yahoo: '2800.HK' },
    { label: 'HSTECH ETF', stooq: '3032.hk', yahoo: '3032.HK' },
  ],
  a: [{ label: 'HS300', stooq: '000300.cn', yahoo: '000300.SS' }],
};
async function fetchBenchmarkSet(set) {
  const cfg = BM_SETS[set]; if (!cfg) return null;
  const data = {};
  await Promise.all(cfg.map(async b => {
    let series = null;
    if (b.official) { try { series = await hangSengSeries(b.official); } catch (e) {} }
    if (series && b.yahoo) {
      try {
        const latest = await yahooQuote(b.yahoo);
        if (latest && (!series.length || latest.date > series[series.length - 1].date)) series.push(latest);
      } catch (e) {}
    }
    if (!series) { try { series = await yahooSeries(b.yahoo); } catch (e) {} }
    if (!series && b.stooq) { try { series = await stooqSeries(b.stooq); } catch (e) {} }
    if (series) data[b.label] = series;
  }));
  return Object.keys(data).length ? data : null;
}
async function prewarmBenchmark(env, sets) {
  return Promise.all((sets || ['us', 'hk', 'a']).map(async set => {
    const ranAt = new Date().toISOString(), cacheKey = 'bmset:' + set, statusKey = 'bmstatus:' + set;
    let fresh = null, error = null;
    try { fresh = await fetchBenchmarkSet(set); } catch (e) { error = e.message || String(e); }
    const oldRaw = await env.YC_KV.get(cacheKey);
    const old = oldRaw ? JSON.parse(oldRaw) : null;
    const expected = BM_SETS[set].map(x => x.label);
    const data = {};
    expected.forEach(label => {
      if (fresh && fresh[label]) data[label] = fresh[label];
      else if (old && old.data && old.data[label]) data[label] = old.data[label];
    });
    const refreshed = expected.filter(label => fresh && fresh[label]);
    const missing = expected.filter(label => !(fresh && fresh[label]));
    const unavailable = expected.filter(label => !data[label]);
    const status = {
      ok: unavailable.length === 0, set, ranAt, refreshed, missing, unavailable,
      stale: missing.length > 0, error,
    };
    if (Object.keys(data).length) {
      const payload = {
        ok: true, set, data,
        fetched: missing.length ? (old && old.fetched) || ranAt : ranAt,
        partialFetched: refreshed.length ? ranAt : null,
        lastAttempt: ranAt, missing, unavailable, stale: missing.length > 0,
      };
      // 行情快照不設 TTL：即使上游短暫失敗，公開 GET 仍讀到上一個成功版本。
      await env.YC_KV.put(cacheKey, JSON.stringify(payload));
    }
    await env.YC_KV.put(statusKey, JSON.stringify(status));
    return status;
  }));
}
const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;
const pxRecord = v => typeof v === 'number' ? { close: v, date: null } : v;

const TRADING_DAYS = 252;
const RISK_FREE = 0.04;
const METRIC_FIELDS = [
  'totalRet', 'annRet', 'vol', 'sharpe', 'sortino', 'calmar', 'treynor', 'maxDD',
  'winRate', 'plRatio', 'var95', 'cvar95', 'alpha', 'beta', 'r2', 'infoRatio',
  'trackingErr', 'skew', 'kurt', 'days', 'wins',
];
const sum = a => a.reduce((s, x) => s + x, 0);
const mean = a => a.length ? sum(a) / a.length : 0;
function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1));
}
function quantile(a, q) {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return null;
  const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (p - lo);
}
function skewness(a) {
  const n = a.length, m = mean(a), s = std(a);
  if (n < 3 || !s) return 0;
  return (n / ((n - 1) * (n - 2))) * sum(a.map(x => ((x - m) / s) ** 3));
}
function excessKurtosis(a) {
  const n = a.length, m = mean(a);
  if (n < 4) return 0;
  const s2 = sum(a.map(x => (x - m) ** 2)) / (n - 1);
  if (!s2) return 0;
  const m4 = sum(a.map(x => (x - m) ** 4));
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * (m4 / (s2 * s2))
    - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}
function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
function rollingMetric(rows, window, fn) {
  const out = [];
  for (let i = window; i <= rows.length; i++) {
    out.push({ date: rows[i - 1].date, v: fn(rows.slice(i - window, i).map(x => x.ret)) });
  }
  return out;
}
function histogram(rp, bins = 30) {
  if (!rp.length) return null;
  const lo = Math.min(...rp), hi = Math.max(...rp), width = (hi - lo) / bins || 1e-9;
  const counts = new Array(bins).fill(0);
  rp.forEach(r => counts[Math.min(bins - 1, Math.floor((r - lo) / width))]++);
  const m = mean(rp), s = std(rp);
  const normal = counts.map((_, i) => {
    if (!s) return 0;
    const x = lo + (i + 0.5) * width, z = (x - m) / s;
    return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI) / s * width * rp.length;
  });
  return { lo, hi, width, counts, normal };
}
function buildVarTable(rp, levels = [0.95, 0.98, 0.99]) {
  if (!rp.length) return [];
  const m = mean(rp), s = std(rp), skew = skewness(rp), kurt = excessKurtosis(rp);
  return levels.map(level => {
    const z = normInv(1 - level);
    const zcf = z + (z * z - 1) * skew / 6 + (z ** 3 - 3 * z) * kurt / 24
      - (2 * z ** 3 - 5 * z) * skew * skew / 36;
    const empirical = quantile(rp, 1 - level);
    const tail = rp.filter(r => r <= empirical);
    return {
      level, normal: m + z * s, cf: m + zcf * s, empirical,
      cvar: tail.length ? mean(tail) : empirical,
    };
  });
}
/* Noncentral-t 壓力測試：與 Manager 的 _fit_skewed_t / 圖17-19 同口徑。 */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function logGamma(z) {
  const c = [
    0.9999999999998099, 676.5203681218851, -1259.1392167224028,
    771.3234287776531, -176.6150291621406, 12.507343278686905,
    -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < c.length; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function nctShapeMoments(df, nc) {
  if (!(df > 4)) return null;
  const rawNormal = [1, nc, 1 + nc * nc, nc ** 3 + 3 * nc, nc ** 4 + 6 * nc * nc + 3];
  const raw = [1];
  for (let k = 1; k <= 4; k++) {
    const inverseChiMoment = Math.exp(
      0.5 * k * Math.log(df / 2) + logGamma((df - k) / 2) - logGamma(df / 2)
    );
    raw[k] = rawNormal[k] * inverseChiMoment;
  }
  const mu = raw[1], variance = raw[2] - mu * mu;
  if (!(variance > 0) || !isFinite(variance)) return null;
  const central3 = raw[3] - 3 * mu * raw[2] + 2 * mu ** 3;
  const central4 = raw[4] - 4 * mu * raw[3] + 6 * mu * mu * raw[2] - 3 * mu ** 4;
  return {
    mean: mu, variance,
    skew: central3 / variance ** 1.5,
    kurt: central4 / (variance * variance) - 3,
  };
}
function populationMoments(values) {
  const m = mean(values);
  const variance = mean(values.map(v => (v - m) ** 2));
  if (!(variance > 0)) return { mean: m, std: 0, skew: 0, kurt: 0 };
  return {
    mean: m,
    std: Math.sqrt(variance),
    skew: mean(values.map(v => (v - m) ** 3)) / variance ** 1.5,
    kurt: mean(values.map(v => (v - m) ** 4)) / (variance * variance) - 3,
  };
}
function fitNctMoments(values) {
  const sample = populationMoments(values);
  if (!sample.std || values.length < 5) {
    return {
      df: 200, nc: 0, loc: sample.mean, scale: Math.max(sample.std, 1e-9),
      sampleMean: sample.mean, sampleStd: sample.std,
      targetSkew: sample.skew, targetKurt: sample.kurt,
      fittedSkew: 0, fittedKurt: 6 / 196, objective: 0,
    };
  }
  const objective = shape => {
    const skewScale = 0.25 + Math.abs(sample.skew);
    const kurtScale = 1 + Math.abs(sample.kurt);
    return ((shape.skew - sample.skew) / skewScale) ** 2
      + ((shape.kurt - sample.kurt) / kurtScale) ** 2;
  };
  let best = null;
  for (let di = 0; di <= 64; di++) {
    const df = 4.05 * (200 / 4.05) ** (di / 64);
    for (let ni = -48; ni <= 48; ni++) {
      const nc = ni * 0.25, shape = nctShapeMoments(df, nc);
      if (!shape) continue;
      const score = objective(shape);
      if (!best || score < best.score) best = { df, nc, shape, score };
    }
  }
  let dfStep = Math.max(0.25, (best.df - 4) * 0.18), ncStep = 0.2;
  for (let pass = 0; pass < 7; pass++) {
    const centre = best;
    for (let di = -3; di <= 3; di++) {
      const df = Math.max(4.01, Math.min(300, centre.df + di * dfStep));
      for (let ni = -3; ni <= 3; ni++) {
        const nc = Math.max(-20, Math.min(20, centre.nc + ni * ncStep));
        const shape = nctShapeMoments(df, nc);
        if (!shape) continue;
        const score = objective(shape);
        if (score < best.score) best = { df, nc, shape, score };
      }
    }
    dfStep *= 0.42; ncStep *= 0.42;
  }
  const scale = sample.std / Math.sqrt(best.shape.variance);
  return {
    df: best.df, nc: best.nc,
    loc: sample.mean - scale * best.shape.mean, scale,
    sampleMean: sample.mean, sampleStd: sample.std,
    targetSkew: sample.skew, targetKurt: sample.kurt,
    fittedSkew: best.shape.skew, fittedKurt: best.shape.kurt,
    objective: best.score,
  };
}
function standardNormal(random) {
  let u = 0, v = 0;
  while (u <= Number.EPSILON) u = random();
  while (v <= Number.EPSILON) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gammaRandom(shape, random) {
  if (shape < 1) {
    let u = 0;
    while (u <= Number.EPSILON) u = random();
    return gammaRandom(shape + 1, random) * u ** (1 / shape);
  }
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = standardNormal(random), base = 1 + c * x;
    if (base <= 0) continue;
    const v = base ** 3, u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}
function nctRandom(fit, random) {
  const z = standardNormal(random);
  const chiSquare = 2 * gammaRandom(fit.df / 2, random);
  return fit.loc + fit.scale * (z + fit.nc) / Math.sqrt(chiSquare / fit.df);
}
function fittedNctPool(fit, size, seed) {
  const random = mulberry32(seed), pool = new Array(size);
  for (let i = 0; i < size; i++) pool[i] = nctRandom(fit, random);
  return pool;
}
function sortedValue(sorted, p) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p, lo = Math.floor(index), hi = Math.ceil(index);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}
function maxValue(values) {
  let out = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > out) out = values[i];
  return values.length ? out : null;
}
function stressTest(pool, nDays, opts = {}) {
  const { nSims = 10000, pathSims = 1000, seed = 42, detDaily = null } = opts;
  if (!pool.length) return null;
  const random = mulberry32(seed), finals = new Array(nSims), sampledPaths = [];
  for (let sim = 0; sim < nSims; sim++) {
    let value = 1, path = sim < pathSims ? new Float64Array(nDays) : null;
    for (let day = 0; day < nDays; day++) {
      value *= 1 + pool[Math.floor(random() * pool.length)];
      if (path) path[day] = value;
    }
    finals[sim] = value;
    if (path) sampledPaths.push(path);
  }
  const sorted = finals.slice().sort((a, b) => a - b);
  const pathP5 = [], pathP50 = [], pathP95 = [];
  for (let day = 0; day < nDays; day++) {
    const col = sampledPaths.map(path => path[day]).sort((a, b) => a - b);
    pathP5.push(sortedValue(col, 0.05));
    pathP50.push(sortedValue(col, 0.50));
    pathP95.push(sortedValue(col, 0.95));
  }
  const deterministicDaily = detDaily == null ? mean(pool) : detDaily;
  const detNav = (1 + deterministicDaily) ** nDays;
  return {
    nDays, p1: sortedValue(sorted, 0.01), p5: sortedValue(sorted, 0.05),
    p50: sortedValue(sorted, 0.50), p95: sortedValue(sorted, 0.95),
    mean: mean(finals), probLoss: finals.filter(v => v < 1).length / nSims,
    probHalf: finals.filter(v => v < 0.5).length / nSims,
    pathP5, pathP50, pathP95,
    detDaily: deterministicDaily, detNav, detDrawdown: detNav - 1,
    conditionMean: mean(pool), poolSize: pool.length, pathSims,
  };
}
function stressScenarios(rp) {
  if (rp.length < 5) return null;
  const fit = fitNctMoments(rp);
  const fittedPool = fittedNctPool(fit, 200000, 0x59494341);
  const sorted = fittedPool.slice().sort((a, b) => a - b);
  const q1 = sortedValue(sorted, 0.01), q5 = sortedValue(sorted, 0.05);
  const crashPool = fittedPool.filter(v => v <= q1);
  const bearPool = fittedPool.filter(v => v <= q5);
  const negativePool = fittedPool.filter(v => v < 0);
  const historicalNegatives = rp.filter(v => v < 0);
  const negMean = historicalNegatives.length ? mean(historicalNegatives) : Math.min(fit.sampleMean, -1e-9);
  const meta = {
    model: 'noncentral-t', method: 'moment-fit-conditional-monte-carlo',
    fit, fittedPoolSize: fittedPool.length, nSims: 10000,
  };
  return {
    model: meta.model, method: meta.method, fit, fittedPoolSize: fittedPool.length,
    crash: {
      label: 'Black Swan Crash（10天，NCT左尾≤1%分位）',
      ...stressTest(crashPool, 10, { seed: 17, detDaily: q1 }),
      ...meta, condition: 'nct<=q0.01', threshold: q1,
      tailPoolMax: maxValue(crashPool),
    },
    bear: {
      label: 'Prolonged Bear（21天，NCT左尾≤5%分位）',
      ...stressTest(bearPool, 21, { seed: 18, detDaily: q5 }),
      ...meta, condition: 'nct<=q0.05', threshold: q5,
      tailPoolMax: maxValue(bearPool),
    },
    grind: {
      label: 'Slow Grind Down（126天，NCT負收益）',
      ...stressTest(negativePool, 126, { seed: 19, detDaily: negMean }),
      ...meta, condition: 'nct<0', threshold: 0,
      historicalNegativeMean: negMean,
      tailPoolMax: maxValue(negativePool),
    },
  };
}
function normalizeHistory(rows) {
  const byDate = new Map();
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const date = String(row && row.date || '').slice(0, 10), ret = Number(row && row.ret);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && isFinite(ret) && ret > -1 && Math.abs(ret) <= 1) {
      byDate.set(date, { date, ret: round(ret, 10) });
    }
  });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-5000);
}
function normalizeNavRows(rows) {
  const byDate = new Map();
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const date = String(row && row.date || '').slice(0, 10);
    const nav = Number(row && (row.nav ?? row.unitNav));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isFinite(nav) || nav <= 0) return;
    const clean = { date, nav: round(nav, 10) };
    [
      'ret', 'unitNav', 'units', 'marketValue', 'cash', 'liability',
      'totalAssets', 'netValue', 'mv', 'divPerUnit',
    ].forEach(key => {
      const value = Number(row[key]);
      if (isFinite(value)) clean[key] = value;
    });
    byDate.set(date, clean);
  });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-5000);
}
function cleanMetrics(value) {
  const out = {};
  METRIC_FIELDS.forEach(k => {
    const v = Number(value && value[k]);
    if (isFinite(v)) out[k] = v;
  });
  return out;
}
function calculatePortfolioMetrics(history) {
  const rows = normalizeHistory(history), rp = rows.map(x => x.ret), days = rp.length;
  if (!days) return {
    metrics: null, drawdown: [], rollVol: [], rollSharpe: [],
    hist: null, varTable: [], stress: null,
  };
  const totalRet = rp.reduce((c, r) => c * (1 + r), 1) - 1;
  const annRet = Math.pow(Math.max(0.000001, 1 + totalRet), TRADING_DAYS / days) - 1;
  const dailyStd = std(rp), vol = dailyStd * Math.sqrt(TRADING_DAYS);
  const sharpe = dailyStd ? (mean(rp.map(r => r - RISK_FREE / TRADING_DAYS)) / dailyStd) * Math.sqrt(TRADING_DAYS) : 0;
  const neg = rp.filter(r => r < 0), pos = rp.filter(r => r > 0);
  const downStd = neg.length > 1 ? std(neg) * Math.sqrt(TRADING_DAYS) : 0;
  const sortino = downStd ? (annRet - RISK_FREE) / downStd : 0;
  let growth = 1, peak = 1, maxDD = 0;
  const drawdown = rows.map(row => {
    growth *= 1 + row.ret; peak = Math.max(peak, growth);
    const v = growth / peak - 1; maxDD = Math.min(maxDD, v);
    return { date: row.date, v: round(v, 10) };
  });
  const var95 = quantile(rp, 0.05);
  const tail = rp.filter(r => r <= var95);
  const avgLoss = neg.length ? Math.abs(mean(neg)) : 0;
  return {
    metrics: {
      totalRet, annRet, vol, sharpe, sortino,
      calmar: maxDD ? annRet / Math.abs(maxDD) : 0,
      maxDD, winRate: pos.length / days,
      plRatio: avgLoss ? mean(pos) / avgLoss : 0,
      var95, cvar95: tail.length ? mean(tail) : var95,
      skew: skewness(rp), kurt: excessKurtosis(rp), days, wins: pos.length,
    },
    drawdown,
    rollVol: rollingMetric(rows, 20, values => std(values) * Math.sqrt(TRADING_DAYS)),
    rollSharpe: rollingMetric(rows, 20, values => {
      const s = std(values);
      return s ? mean(values.map(r => r - RISK_FREE / TRADING_DAYS)) / s * Math.sqrt(TRADING_DAYS) : 0;
    }),
    hist: histogram(rp),
    varTable: buildVarTable(rp),
    stress: stressScenarios(rp),
  };
}
function makePortfolioCache(led, live, status) {
  const sourceHistory = normalizeHistory(led.history);
  const liveRows = normalizeHistory(live.rows);
  const combined = normalizeHistory([...sourceHistory, ...liveRows]);
  const complete = sourceHistory.length > 0;
  let calculated = calculatePortfolioMetrics(complete ? combined : liveRows);
  const sourceMetricValues = cleanMetrics(led.sourceMetrics || led.snap);
  let metrics = complete
    ? { ...sourceMetricValues, ...(calculated.metrics || {}) }
    : { ...(calculated.metrics || {}), ...sourceMetricValues };
  let drawdown = calculated.drawdown;
  let snap;

  if (complete) {
    const growth = combined.reduce((c, r) => c * (1 + r.ret), 1);
    let peakGrowth = 1, cursor = 1;
    combined.forEach(r => { cursor *= 1 + r.ret; peakGrowth = Math.max(peakGrowth, cursor); });
    snap = {
      ...led.snap, totalRet: metrics.totalRet, annRet: metrics.annRet, maxDD: metrics.maxDD,
      days: metrics.days, start: combined[0] && combined[0].date,
      end: combined[combined.length - 1] && combined[combined.length - 1].date,
      peakGrowth, endGrowth: growth,
    };
  } else {
    // 舊版 ledger 沒有完整歷史時，用既有 snap 延伸日更收益；不假造歷史 Sharpe。
    const base = led.snap || {}, liveFactor = liveRows.reduce((c, r) => c * (1 + r.ret), 1);
    let current = Number(base.endGrowth) || 1, peak = Math.max(Number(base.peakGrowth) || 1, current);
    let maxDD = Number(base.maxDD) || 0;
    drawdown = liveRows.map(row => {
      current *= 1 + row.ret; peak = Math.max(peak, current);
      const v = current / peak - 1; maxDD = Math.min(maxDD, v);
      return { date: row.date, v: round(v, 10) };
    });
    const totalRet = (1 + (Number(base.totalRet) || 0)) * liveFactor - 1;
    const days = (Number(base.days) || 0) + liveRows.length;
    metrics = {
      ...metrics, totalRet, days, maxDD,
      annRet: days > 0 ? Math.pow(Math.max(0.000001, 1 + totalRet), TRADING_DAYS / days) - 1 : Number(base.annRet) || 0,
    };
    snap = {
      ...base, totalRet: metrics.totalRet, annRet: metrics.annRet, maxDD: metrics.maxDD,
      days, end: liveRows.length ? liveRows[liveRows.length - 1].date : base.end,
      peakGrowth: peak, endGrowth: (Number(base.endGrowth) || 1) * liveFactor,
    };
  }

  const publicHistory = complete ? combined : liveRows;
  const monthGrowth = new Map();
  publicHistory.forEach(row => {
    const month = row.date.slice(0, 7);
    monthGrowth.set(month, (monthGrowth.get(month) || 1) * (1 + row.ret));
  });
  const monthly = [...monthGrowth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, growth]) => ({ month, ret: growth - 1 }));
  const holdings = live.holdings || led.sourceHoldings || [];
  const end = publicHistory.length ? publicHistory[publicHistory.length - 1].date : (snap.end || led.lastDate);
  const asOf = live.marketDate || (holdings[0] && holdings[0].date) || end;

  const sourceNavRows = normalizeNavRows(led.navRows);
  const liveNavRows = normalizeNavRows((live.rows || []).map(row => ({
    ...row, nav: Number(row.unitNav ?? row.nav),
  })));
  let navRows;
  if (sourceNavRows.length) {
    navRows = normalizeNavRows([...sourceNavRows, ...liveNavRows]);
  } else {
    const sourceFactor = sourceHistory.reduce((factor, row) => factor * (1 + row.ret), 1);
    let navValue = complete && Number(led.lastUnitNav) > 0 && sourceFactor > 0
      ? Number(led.lastUnitNav) / sourceFactor
      : 1;
    navRows = publicHistory.map(row => {
      navValue *= 1 + row.ret;
      return { date: row.date, nav: navValue, ret: row.ret };
    });
  }
  let curveValue = 10000;
  const curve = publicHistory.map(row => ({
    date: row.date,
    v: (curveValue *= 1 + row.ret),
  }));

  return {
    ok: true, enabled: true, portfolio: led.portfolio, currency: led.currency,
    base: {
      date: led.lastDate, unitNav: led.lastUnitNav, marketValue: led.baseMarketValue,
      totalAssets: led.baseTotalAssets, netValue: led.baseNetValue, cash: led.cash,
      liability: led.liability, units: led.units,
    },
    snap, summary: snap, metrics, statistics: metrics,
    history: publicHistory, rets: publicHistory, rp: publicHistory.map(row => row.ret),
    historyComplete: complete, navRows, curve, drawdown, monthly,
    rollVol: calculated.rollVol, rollSharpe: calculated.rollSharpe,
    hist: calculated.hist, varTable: calculated.varTable, stress: calculated.stress,
    rows: live.rows || [], holdings, assets: holdings,
    asOf, end,
    marketDate: live.marketDate || null, updatedAt: live.updatedAt || led.savedAt || null,
    status: status || null, cacheVersion: 2,
  };
}
async function persistPortfolioCache(env, pf, led, live, status) {
  const cache = makePortfolioCache({ ...led, portfolio: pf }, live, status);
  await Promise.all([
    env.YC_KV.put('live:' + pf, JSON.stringify(live)),
    env.YC_KV.put('navstatus:' + pf, JSON.stringify(status)),
    env.YC_KV.put('navcache:' + pf, JSON.stringify(cache)),
  ]);
  return cache;
}

/* 持倉/現金/負債/份額為唯一營運基準；行情日期為實際追加日期。 */
async function updatePortfolioNav(env, pf) {
  const now = new Date(), st = { pf, ranAt: now.toISOString() };
  const ledRaw = await env.YC_KV.get('ledger:' + pf);
  if (!ledRaw) {
    st.skip = 'no-ledger';
    await Promise.all([
      env.YC_KV.put('navstatus:' + pf, JSON.stringify(st)),
      env.YC_KV.put('navcache:' + pf, JSON.stringify({ ok: true, enabled: false, portfolio: pf, history: [], rows: [], holdings: [], status: st, cacheVersion: 2 })),
    ]);
    return st;
  }
  const led = JSON.parse(ledRaw), market = led.market || pf;
  const liveRaw = await env.YC_KV.get('live:' + pf), live = liveRaw ? JSON.parse(liveRaw) : { rows: [] };
  const lastPxRaw = await env.YC_KV.get('lastpx:' + pf), lastPx = lastPxRaw ? JSON.parse(lastPxRaw) : {};
  const fetched = await Promise.all(led.positions.map(async p => ({ p, q: await quote(p.t, market).catch(() => null) })));
  const freshDates = fetched.filter(x => x.q && x.q.date).map(x => x.q.date).sort();
  if (!freshDates.length) {
    st.skip = 'no-quotes';
    await persistPortfolioCache(env, pf, led, live, st);
    return st;
  }
  const marketDate = freshDates[freshDates.length - 1];
  const lastDate = live.rows.length ? live.rows[live.rows.length - 1].date : led.lastDate;
  if (lastDate && marketDate <= lastDate) {
    st.skip = 'already-updated:' + lastDate; st.marketDate = marketDate;
    await persistPortfolioCache(env, pf, led, live, st);
    return st;
  }

  const missing = [], stale = [], holdings = [];
  for (const item of fetched) {
    const p = item.p; let q = item.q;
    if (q && q.close) {
      lastPx[p.t] = q;
      if (q.date && q.date < marketDate) stale.push(p.t);
    }
    else {
      const old = pxRecord(lastPx[p.t]);
      if (old && old.close) { q = old; stale.push(p.t); } else { missing.push(p.t); continue; }
    }
    const mv = Number(p.q) * Number(q.close);
    const pnl = Number(p.pnl) + mv - Number(p.mv);
    holdings.push({
      t: p.t, n: p.n || p.t, q: Number(p.q), price: round(Number(q.close), 6),
      marketValue: round(mv, 2), date: q.date || marketDate,
      buyCost: Number(p.buyCost) || 0, sellProceeds: Number(p.sellProceeds) || 0,
      dividend: Number(p.dividend) || 0, netCost: Number(p.netCost) || 0,
      pnl: round(pnl, 2),
      exposureReturn: Number(p.buyCost) ? round(pnl / Number(p.buyCost) * 100, 8) : null,
      weight: 0,
    });
  }
  if (missing.length) {
    st.skip = 'missing-quotes:' + missing.join(',');
    await persistPortfolioCache(env, pf, led, live, st);
    return st;
  }
  const marketValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  holdings.forEach(h => { h.weight = marketValue ? round(h.marketValue / marketValue * 100, 6) : 0; });
  const cash = Number(led.cash) || 0, liability = Number(led.liability) || 0;
  const totalAssets = marketValue + cash, netValue = totalAssets - liability, units = Number(led.units) || 0;
  const prev = live.rows.length ? live.rows[live.rows.length - 1] : { netValue: led.baseNetValue || led.baseMV, unitNav: led.lastUnitNav };
  const unitNav = units > 0 ? netValue / units : (prev.unitNav && prev.netValue ? prev.unitNav * netValue / prev.netValue : 0);
  const ret = prev.unitNav > 0 ? unitNav / prev.unitNav - 1 : netValue / prev.netValue - 1;
  if (!isFinite(ret) || !isFinite(unitNav) || Math.abs(ret) > 0.75) {
    st.skip = 'sanity-fail:' + ret;
    await persistPortfolioCache(env, pf, led, live, st);
    return st;
  }
  live.rows.push({
    date: marketDate, ret: round(ret, 10), unitNav: round(unitNav, 8), units: round(units, 6),
    marketValue: round(marketValue, 2), cash: round(cash, 2), liability: round(liability, 2),
    totalAssets: round(totalAssets, 2), netValue: round(netValue, 2), mv: round(netValue, 2),
  });
  if (live.rows.length > 1300) live.rows = live.rows.slice(-1300);
  live.holdings = holdings; live.updatedAt = now.toISOString(); live.marketDate = marketDate;
  live.note = stale.length ? 'stale:' + stale.join(',') : null;
  Object.assign(st, { appended: marketDate, marketValue: round(marketValue, 2), netValue: round(netValue, 2), stale });
  await Promise.all([
    env.YC_KV.put('lastpx:' + pf, JSON.stringify(lastPx)),
    persistPortfolioCache(env, pf, led, live, st),
  ]);
  return st;
}

async function refreshMarketCaches(env, portfolios, benchmarkSets, trigger, by) {
  const ranAt = new Date().toISOString();
  const nav = await Promise.all(portfolios.map(pf => updatePortfolioNav(env, pf)));
  const benchmarks = await prewarmBenchmark(env, benchmarkSets);
  const result = { ok: true, trigger, by: by || 'system', ranAt, nav, benchmarks };
  await env.YC_KV.put('refresh:last:' + trigger, JSON.stringify(result));
  return result;
}

async function streamToText(stream) {
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(buf);
}
const latin1ToUtf8 = s => { try { return decodeURIComponent(escape(s)); } catch (e) { return s; } };
const decodeQP = s => latin1ToUtf8(s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
function decodeWords(s) { // =?UTF-8?B?..?= / =?UTF-8?Q?..?=
  return String(s || '').replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    try { return enc.toUpperCase() === 'B' ? latin1ToUtf8(atob(data)) : decodeQP(data.replace(/_/g, ' ')); } catch (e) { return data; }
  });
}
function extractMimeText(raw, depth) {
  if ((depth || 0) > 4) return '';
  const m = raw.match(/\r?\n\r?\n/);
  if (!m) return raw.slice(0, 4000);
  const head = raw.slice(0, m.index), body = raw.slice(m.index + m[0].length);
  const ct = (head.match(/^content-type:\s*([^\r\n]+(?:\r?\n[ \t][^\r\n]+)*)/im) || [])[1] || 'text/plain';
  const cte = ((head.match(/^content-transfer-encoding:\s*([^\r\n]+)/im) || [])[1] || '').trim().toLowerCase();
  const bm = ct.match(/boundary="?([^";\r\n]+)"?/i);
  if (bm) {
    const esc = bm[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = body.split(new RegExp('--' + esc + '(?:--)?\\r?\\n?')).filter(p => p.trim());
    let best = parts.find(p => /content-type:\s*text\/plain/i.test(p)) || parts.find(p => /content-type:\s*text\/html/i.test(p)) || parts[0] || '';
    return extractMimeText(best, (depth || 0) + 1);
  }
  let text = body;
  if (cte === 'base64') { try { text = latin1ToUtf8(atob(body.replace(/\s+/g, ''))); } catch (e) {} }
  else if (cte === 'quoted-printable') text = decodeQP(body);
  if (/text\/html/i.test(ct)) text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ');
  return text.trim().slice(0, 8000);
}

function contentHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function normalizeContentItems(items, kind) {
  const used = new Set();
  return (Array.isArray(items) ? items : []).filter(Boolean).map((it, index) => {
    const copy = { ...it };
    let id = String(copy.id || '').trim();
    if (!id) {
      const title = copy.title && (copy.title.tw || copy.title.cn || copy.title.en) || '';
      id = (kind === 'reports' ? 'rep-' : 'post-') + contentHash([copy.url, copy.pdf, copy.date, title, index].join('|'));
    }
    let unique = id, n = 2;
    while (used.has(unique)) unique = id + '-' + n++;
    copy.id = unique; used.add(unique);
    return copy;
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });

    try {
      /* ════ 健康檢查：各配置是否被運行時讀到（只返回布爾）════ */
      if (path === '/api/health' && request.method === 'GET') {
        let kvOk = false;
        try { await env.YC_KV.get('__ping__'); kvOk = true; } catch (e) {}
        return J(env, {
          ok: true, version: 'v8.2',
          kv: kvOk,
          admin: !!(env.ADMIN_USERNAME && env.ADMIN_PASSWORD),
          github: !!(env.GH_TOKEN && env.GH_OWNER && env.GH_REPO),
          resend: !!env.RESEND_API_KEY,
          mail_from: env.MAIL_FROM || '(未設置)',
          google: !!env.GOOGLE_CLIENT_ID,
          origin: env.ALLOWED_ORIGIN || '(未設置)',
        });
      }

      /* ════ 註冊：用戶名 + 密碼 + 郵箱 ════ */
      if (path === '/api/signup' && request.method === 'POST') {
        const b = await request.json();
        const username = String(b.username || '').trim();
        const email = String(b.email || '').trim().toLowerCase();
        const password = b.password || '';
        if (!isUsername(username)) return J(env, { error: '用戶名 2–24 位，僅限中英文、數字、_-（不能是郵箱）' }, 400);
        if (!isEmail(email)) return J(env, { error: '請填寫有效郵箱' }, 400);
        if (password.length < 6) return J(env, { error: '密碼至少 6 位' }, 400);
        if (username === env.ADMIN_USERNAME) return J(env, { error: '該用戶名不可用' }, 400);
        if (b.terms !== true) return J(env, { error: '必須同意服務條款才能註冊' }, 400);
        const newsletter = b.newsletter === true;
        if (await env.YC_KV.get('user:' + username)) return J(env, { error: '用戶名已存在' }, 409);
        if (await env.YC_KV.get('email:' + email)) return J(env, { error: '該郵箱已被註冊' }, 409);
        const salt = randomHex(16);
        const hash = await pbkdf2(password, salt);
        if (env.RESEND_API_KEY) {
          const code = String(Math.floor(100000 + Math.random() * 900000));
          await env.YC_KV.put('pending:' + email, JSON.stringify({ u: username, email, salt, hash, code, tries: 0, newsletter }), { expirationTtl: 900 });
          if (!await sendCode(env, email, code)) { await env.YC_KV.delete('pending:' + email); return J(env, { error: '驗證郵件發送失敗，請稍後再試' }, 502); }
          return J(env, { ok: true, needCode: true, message: '驗證碼已發送至 ' + email });
        }
        await createUser(env, { u: username, email, salt, hash, provider: 'password', role: 'guest', disabled: false, newsletter, terms: true, termsAt: new Date().toISOString(), created: new Date().toISOString(), lastLogin: null });
        await sendWelcome(env, email, username);
        return J(env, { ok: true, message: '註冊成功，請登入' });
      }

      /* ════ 郵箱驗證碼確認 ════ */
      if (path === '/api/verify' && request.method === 'POST') {
        const b = await request.json();
        const email = String(b.email || '').trim().toLowerCase();
        const pkey = 'pending:' + email;
        const raw = await env.YC_KV.get(pkey);
        if (!raw) return J(env, { error: '驗證已過期，請重新註冊' }, 410);
        const p = JSON.parse(raw);
        p.tries = (p.tries || 0) + 1;
        if (p.tries > 5) { await env.YC_KV.delete(pkey); return J(env, { error: '嘗試次數過多，請重新註冊' }, 429); }
        if (String(b.code || '').trim() !== p.code) { await env.YC_KV.put(pkey, JSON.stringify(p), { expirationTtl: 900 }); return J(env, { error: '驗證碼錯誤' }, 400); }
        if (await env.YC_KV.get('user:' + p.u)) { await env.YC_KV.delete(pkey); return J(env, { error: '用戶名剛被佔用，請重新註冊' }, 409); }
        await createUser(env, { u: p.u, email: p.email, salt: p.salt, hash: p.hash, provider: 'password', role: 'guest', disabled: false, newsletter: p.newsletter === true, terms: true, termsAt: new Date().toISOString(), created: new Date().toISOString(), lastLogin: null });
        await env.YC_KV.delete(pkey);
        await sendWelcome(env, p.email, p.u);
        return J(env, { ok: true, message: '驗證成功，請登入' });
      }

      /* ════ 登入：用戶名或郵箱 + 密碼 ════ */
      if (path === '/api/login' && request.method === 'POST') {
        const b = await request.json();
        let username = String(b.username || '').trim();
        const password = b.password || '';
        if (username === env.ADMIN_USERNAME) {
          if (!safeEqual(password, env.ADMIN_PASSWORD)) return J(env, { error: '帳號或密碼錯誤' }, 401);
          const token = await newSession(env, username, 'admin');
          return J(env, { ok: true, token, role: 'admin', username });
        }
        if (isEmail(username)) {
          const mapped = await env.YC_KV.get('email:' + username.toLowerCase());
          if (!mapped) return J(env, { error: '帳號或密碼錯誤' }, 401);
          username = mapped;
        }
        const raw = await env.YC_KV.get('user:' + username);
        if (!raw) return J(env, { error: '帳號或密碼錯誤' }, 401);
        const u = JSON.parse(raw);
        if (u.disabled) return J(env, { error: '此帳號已被停用' }, 403);
        if (!u.hash) return J(env, { error: '此帳號未設置密碼，請用 Google 登入' }, 400);
        const hash = await pbkdf2(password, u.salt);
        if (!safeEqual(hash, u.hash)) return J(env, { error: '帳號或密碼錯誤' }, 401);
        u.lastLogin = new Date().toISOString();
        await env.YC_KV.put('user:' + username, JSON.stringify(u));
        const token = await newSession(env, username, 'guest');
        return J(env, { ok: true, token, role: 'guest', username });
      }

      /* ════ Google：老用戶直接登入；新用戶引導設置用戶名密碼 ════ */
      if (path === '/api/google' && request.method === 'POST') {
        if (!env.GOOGLE_CLIENT_ID) return J(env, { error: '未配置 Google 登入' }, 501);
        const { credential } = await request.json();
        if (!credential) return J(env, { error: '缺少憑證' }, 400);
        const gr = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
        if (!gr.ok) return J(env, { error: 'Google 憑證無效' }, 401);
        const t = await gr.json();
        if (t.aud !== env.GOOGLE_CLIENT_ID) return J(env, { error: '憑證受眾不匹配' }, 401);
        if (String(t.email_verified) !== 'true' || !t.email) return J(env, { error: 'Google 郵箱未驗證' }, 401);
        const email = t.email.toLowerCase();
        const mapped = await env.YC_KV.get('email:' + email);
        if (mapped) {
          const u = JSON.parse(await env.YC_KV.get('user:' + mapped) || 'null');
          if (!u) return J(env, { error: '帳號數據異常' }, 500);
          if (u.disabled) return J(env, { error: '此帳號已被停用' }, 403);
          u.lastLogin = new Date().toISOString();
          await env.YC_KV.put('user:' + mapped, JSON.stringify(u));
          const token = await newSession(env, mapped, 'guest');
          return J(env, { ok: true, token, role: 'guest', username: mapped });
        }
        // 新用戶 → 發放 15 分鐘設置票據，前端引導其設置用戶名+密碼
        const setupToken = randomHex(24);
        await env.YC_KV.put('gsetup:' + setupToken, JSON.stringify({ email, name: t.name || '' }), { expirationTtl: 900 });
        return J(env, { ok: true, needSetup: true, setupToken, email });
      }

      if (path === '/api/google/complete' && request.method === 'POST') {
        const b = await request.json();
        const skey = 'gsetup:' + String(b.setupToken || '');
        const raw = await env.YC_KV.get(skey);
        if (!raw) return J(env, { error: '設置已過期，請重新用 Google 登入' }, 410);
        const g = JSON.parse(raw);
        const username = String(b.username || '').trim();
        const password = b.password || '';
        if (!isUsername(username)) return J(env, { error: '用戶名 2–24 位，僅限中英文、數字、_-' }, 400);
        if (password.length < 6) return J(env, { error: '密碼至少 6 位' }, 400);
        if (b.terms !== true) return J(env, { error: '必須同意服務條款才能註冊' }, 400);
        if (username === env.ADMIN_USERNAME || await env.YC_KV.get('user:' + username)) return J(env, { error: '用戶名已存在，換一個' }, 409);
        if (await env.YC_KV.get('email:' + g.email)) return J(env, { error: '該郵箱已被註冊' }, 409);
        const salt = randomHex(16);
        const hash = await pbkdf2(password, salt);
        await createUser(env, { u: username, email: g.email, name: g.name, salt, hash, provider: 'google', role: 'guest', disabled: false, newsletter: b.newsletter === true, terms: true, termsAt: new Date().toISOString(), created: new Date().toISOString(), lastLogin: new Date().toISOString() });
        await env.YC_KV.delete(skey);
        await sendWelcome(env, g.email, username);
        const token = await newSession(env, username, 'guest');
        return J(env, { ok: true, token, role: 'guest', username });
      }

      /* ════ 基準行情：公開 GET 僅讀 Cron/手動刷新寫入的持久 KV 快照 ════ */
      if (path === '/api/benchmark' && request.method === 'GET') {
        const set = String(url.searchParams.get('set') || 'us').toLowerCase();
        if (!BM_SETS[set]) return J(env, { error: 'set 只支持 us/hk/a' }, 400);
        const cacheKey = 'bmset:' + set, cached = await env.YC_KV.get(cacheKey);
        if (cached) return J(env, JSON.parse(cached));
        const status = await env.YC_KV.get('bmstatus:' + set);
        return J(env, {
          ok: false, set, pending: true, data: {},
          status: status ? JSON.parse(status) : null,
          error: '基準快照尚未建立，請等待每日任務或由管理員手動刷新',
        }, 503);
      }

      /* ════ 會話 ════ */
      const sess = await getSession(request, env);

      if (path === '/api/me' && request.method === 'GET') {
        if (!sess) return J(env, { error: '未登入' }, 401);
        return J(env, { ok: true, username: sess.u, role: sess.role });
      }
      if (path === '/api/logout' && request.method === 'POST') {
        if (sess) await env.YC_KV.delete('sess:' + sess.token);
        return J(env, { ok: true });
      }

      /* ════ 管理員 ════ */
      const needAdmin = () => (!sess ? J(env, { error: '未登入' }, 401) : sess.role !== 'admin' ? J(env, { error: '需要管理員權限' }, 403) : null);

      /* 手動刷新與 Cron 使用同一條寫入鏈；只有 POST 會抓行情和重算快照。 */
      if (path === '/api/refresh' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json().catch(() => ({}));
        const requested = String(b.portfolio || b.set || 'all').toLowerCase();
        if (!/^(all|us|hk|a)$/.test(requested)) return J(env, { error: 'portfolio 只支持 all/us/hk/a' }, 400);
        const portfolios = requested === 'all' ? ['us', 'hk', 'a'] : [requested];
        const result = b.benchmarks === false
          ? {
              ok: true, trigger: 'manual', by: sess.u, ranAt: new Date().toISOString(),
              nav: await Promise.all(portfolios.map(pf => updatePortfolioNav(env, pf))), benchmarks: [],
            }
          : await refreshMarketCaches(env, portfolios, portfolios, 'manual', sess.u);
        if (b.benchmarks === false) await env.YC_KV.put('refresh:last:manual', JSON.stringify(result));
        return J(env, result);
      }

      if (path === '/api/users' && request.method === 'GET') {
        const deny = needAdmin(); if (deny) return deny;
        const list = await env.YC_KV.list({ prefix: 'user:' });
        const users = [];
        for (const k of list.keys) {
          const raw = await env.YC_KV.get(k.name);
          if (!raw) continue;
          const { u, email, provider, role, disabled, created, lastLogin, newsletter } = JSON.parse(raw);
          users.push({ username: u, email: email || '—', provider: provider || 'password', role, disabled, created, lastLogin, newsletter: newsletter === true });
        }
        users.sort((a, b) => (a.created < b.created ? -1 : 1));
        return J(env, { ok: true, admin: env.ADMIN_USERNAME, users });
      }

      if (path === '/api/users/update' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        const { username, action, newPassword } = await request.json();
        const key = 'user:' + username;
        const raw = await env.YC_KV.get(key);
        if (!raw) return J(env, { error: '用戶不存在' }, 404);
        const u = JSON.parse(raw);
        if (action === 'delete') {
          await env.YC_KV.delete(key);
          if (u.email) await env.YC_KV.delete('email:' + u.email);
          return J(env, { ok: true, message: '已刪除 ' + username });
        }
        if (action === 'disable') u.disabled = true;
        else if (action === 'enable') u.disabled = false;
        else if (action === 'resetpw') {
          if (!newPassword || newPassword.length < 6) return J(env, { error: '新密碼至少 6 位' }, 400);
          u.salt = randomHex(16); u.hash = await pbkdf2(newPassword, u.salt);
        } else return J(env, { error: '未知操作' }, 400);
        await env.YC_KV.put(key, JSON.stringify(u));
        return J(env, { ok: true, message: '已更新 ' + username });
      }

      /* ════ 郵件中心：群發（admin）════
         sender: 'insight'（僅發給訂閱者）| 'information'（可發任何用戶，見條款）
         mode: 'all' | 'selected'（usernames: [...]） */
      if (path === '/api/broadcast' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        if (!env.RESEND_API_KEY) return J(env, { error: '未配置 RESEND_API_KEY' }, 501);
        const b = await request.json();
        const sender = b.sender === 'information' ? 'information' : 'insight';
        const subject = String(b.subject || '').trim();
        const content = String(b.content || '').trim();
        if (!subject || !content) return J(env, { error: '主題和內容不能為空' }, 400);
        const domain = env.MAIL_DOMAIN || 'yicapital.co';
        const fromAddr = sender === 'insight'
          ? 'Yi Capital Insights <insight@' + domain + '>'
          : 'Yi Capital <information@' + domain + '>';
        // 收集收件人
        const list = await env.YC_KV.list({ prefix: 'user:' });
        const all = [];
        for (const k of list.keys) {
          const raw = await env.YC_KV.get(k.name); if (!raw) continue;
          const u = JSON.parse(raw);
          if (!u.email || u.disabled) continue;
          all.push(u);
        }
        let targets = all;
        if (b.mode === 'selected') {
          const sel = new Set((b.usernames || []).map(x => String(x).toLowerCase()));
          targets = all.filter(u => sel.has(u.u.toLowerCase()) || sel.has((u.email || '').toLowerCase()));
        }
        let skipped = 0;
        if (sender === 'insight') { const n = targets.length; targets = targets.filter(u => u.newsletter === true); skipped = n - targets.length; }
        if (!targets.length) return J(env, { error: '沒有符合條件的收件人' + (skipped ? '（' + skipped + ' 人未訂閱 insight，已跳過）' : '') }, 400);
        if (targets.length > 200) return J(env, { error: '單次最多 200 人' }, 400);
        const compliance = '<div style="max-width:640px;margin:0 auto"><hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">'
          + '<p style="color:#888;font-size:12px;font-family:Arial,sans-serif;line-height:1.7">Yi Capital · yicapital.co'
          + (sender === 'insight' ? '<br>你收到此郵件是因為訂閱了 Yi Capital Insights；如需退訂請回覆本郵件。' : '<br>此為 Yi Capital 帳號/服務相關通知（見服務條款 04）。')
          + '<br>本郵件內容不構成投資建議，過往表現不代表未來回報。</p></div>';
        const htmlBody = (b.format === 'html')
          ? content + compliance
          : '<div style="font-family:sans-serif;line-height:1.8;color:#222;max-width:640px;margin:0 auto">'
            + content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>') + '</div>' + compliance;
        let sent = 0, failed = 0;
        for (const u of targets) {
          try {
            const r = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: fromAddr, to: [u.email], reply_to: sender + '@' + domain, subject, html: htmlBody }),
            });
            if (r.ok) sent++; else failed++;
          } catch (e) { failed++; }
        }
        await env.YC_KV.put('sentlog:' + Date.now().toString(36), JSON.stringify({ by: sess.u, sender, subject, sent, failed, skipped, at: new Date().toISOString() }));
        return J(env, { ok: true, sent, failed, skipped });
      }

      /* ════ 收件箱（admin）：Email Routing 轉入的回信 ════ */
      if (path === '/api/inbox' && request.method === 'GET') {
        const deny = needAdmin(); if (deny) return deny;
        const list = await env.YC_KV.list({ prefix: 'inbox:' });
        const items = [];
        for (const k of list.keys.slice(-80)) {
          const raw = await env.YC_KV.get(k.name); if (!raw) continue;
          items.push({ id: k.name.slice(6), ...JSON.parse(raw) });
        }
        items.sort((a, b) => (a.date < b.date ? 1 : -1));
        return J(env, { ok: true, items });
      }
      if (path === '/api/inbox/delete' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        const { id } = await request.json();
        if (!/^[a-z0-9]+$/i.test(id || '')) return J(env, { error: '無效 id' }, 400);
        await env.YC_KV.delete('inbox:' + id);
        return J(env, { ok: true });
      }

      /* ════ 發布淨值表（服務端持有 GH_TOKEN）════ */
      /* ════ 內容管理：研報庫 / 研究觀點 條目（KV 為準，前端內置種子為後備）════ */
      if (path === '/api/content' && request.method === 'GET') {
        const [r, p] = await Promise.all([env.YC_KV.get('content:reports'), env.YC_KV.get('content:posts')]);
        const flt = x => (x ? JSON.parse(x) : null);
        const rep0 = flt(r), pos0 = flt(p);
        const rep = rep0 ? normalizeContentItems(rep0, 'reports') : null;
        const pos = pos0 ? normalizeContentItems(pos0, 'posts') : null;
        return J(env, {
          ok: true,
          managed: !!(rep || pos),   // false = 前端用內置種子
          reports: rep ? rep.filter(i => !i.disabled) : null,
          posts: pos ? pos.filter(i => !i.disabled) : null,
        });
      }
      if (path === '/api/content/all' && request.method === 'GET') {
        const deny = needAdmin(); if (deny) return deny;
        const [r, p] = await Promise.all([env.YC_KV.get('content:reports'), env.YC_KV.get('content:posts')]);
        return J(env, {
          ok: true,
          reports: r ? normalizeContentItems(JSON.parse(r), 'reports') : null,
          posts: p ? normalizeContentItems(JSON.parse(p), 'posts') : null,
        });
      }
      if (path === '/api/content/save' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json();
        const kind = b.kind === 'posts' ? 'posts' : b.kind === 'reports' ? 'reports' : null;
        if (!kind || !Array.isArray(b.items)) return J(env, { error: 'kind 需為 reports/posts 且 items 為數組' }, 400);
        if (b.items.length > 500) return J(env, { error: '條目過多' }, 400);
        const items = normalizeContentItems(b.items, kind);
        for (const it of items) if (!it.title) return J(env, { error: '每條需含 title' }, 400);
        await env.YC_KV.put('content:' + kind, JSON.stringify(items));
        return J(env, { ok: true, kind, count: items.length });
      }

      /* ════ 找回密碼：郵箱驗證碼 → 重設 ════ */
      if (path === '/api/forgot' && request.method === 'POST') {
        const b = await request.json();
        const email = String(b.email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return J(env, { error: '郵箱格式不正確' }, 400);
        // 用 email 索引直查（避免枚舉：無論是否存在都返回成功文案）
        const uname = await env.YC_KV.get('email:' + email);
        if (uname && await env.YC_KV.get('user:' + uname)) {
          const code = String(Math.floor(100000 + Math.random() * 900000));
          await env.YC_KV.put('reset:' + email, JSON.stringify({ code, u: uname, tries: 0, ts: Date.now() }), { expirationTtl: 900 });
          await sendResetCode(env, email, code);
        }
        return J(env, { ok: true, message: '若該郵箱已註冊，重設驗證碼已發送（15 分鐘內有效，請查收郵件含垃圾箱）。' });
      }
      if (path === '/api/reset' && request.method === 'POST') {
        const b = await request.json();
        const email = String(b.email || '').trim().toLowerCase();
        const code = String(b.code || '').trim();
        const password = String(b.password || '');
        if (password.length < 6) return J(env, { error: '密碼至少 6 位' }, 400);
        const recRaw = await env.YC_KV.get('reset:' + email);
        if (!recRaw) return J(env, { error: '驗證碼不存在或已過期，請重新獲取' }, 400);
        const rec = JSON.parse(recRaw);
        if (rec.tries >= 5) { await env.YC_KV.delete('reset:' + email); return J(env, { error: '錯誤次數過多，請重新獲取驗證碼' }, 400); }
        if (rec.code !== code) {
          rec.tries++; await env.YC_KV.put('reset:' + email, JSON.stringify(rec), { expirationTtl: 900 });
          return J(env, { error: '驗證碼不正確（剩餘 ' + (5 - rec.tries) + ' 次）' }, 400);
        }
        const uRaw = await env.YC_KV.get('user:' + rec.u);
        if (!uRaw) return J(env, { error: '用戶不存在' }, 400);
        const u = JSON.parse(uRaw);
        u.salt = randomHex(16); u.hash = await pbkdf2(password, u.salt);
        await env.YC_KV.put('user:' + rec.u, JSON.stringify(u));
        await env.YC_KV.delete('reset:' + email);
        return J(env, { ok: true, username: rec.u, message: '密碼已重設，請用新密碼登入。' });
      }

      /* ════ 管理員重設任意用戶密碼 ════ */
      if (path === '/api/users/setpw' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json();
        const username = String(b.username || '').trim();
        const password = String(b.password || '');
        if (!username || password.length < 6) return J(env, { error: '需 username 且密碼至少 6 位' }, 400);
        const uRaw = await env.YC_KV.get('user:' + username);
        if (!uRaw) return J(env, { error: '用戶不存在' }, 404);
        const u = JSON.parse(uRaw);
        u.salt = randomHex(16); u.hash = await pbkdf2(password, u.salt);
        await env.YC_KV.put('user:' + username, JSON.stringify(u));
        return J(env, { ok: true, username });
      }

      /* ════ 賬本：發布時前端自動提取持倉+現金，後端每日按收盤價自算淨值 ════ */
      if (path === '/api/ledger' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json();
        const pf = String(b.portfolio || 'us').toLowerCase();
        if (!/^(us|hk|a)$/.test(pf)) return J(env, { error: 'portfolio 只支持 us/hk/a' }, 400);
        if (!Array.isArray(b.positions) || !b.positions.length) return J(env, { error: 'positions 為空' }, 400);
        const positions = b.positions.filter(p => p && p.t && isFinite(p.q)).map(p => ({
          t: String(p.t).slice(0, 16), n: String(p.n || p.name || p.t).slice(0, 100), q: Number(p.q),
          p: Number(p.p) || 0, mv: Number(p.mv) || 0, netCost: Number(p.netCost) || 0,
          buyCost: Number(p.buyCost) || 0, sellProceeds: Number(p.sellProceeds) || 0,
          dividend: Number(p.dividend) || 0, pnl: Number(p.pnl) || 0,
        })).slice(0, 120);
        const sourceDate = String(b.sourceDate || b.lastDate || '').slice(0, 10);
        const baseNetValue = Number(b.baseNetValue ?? b.baseMV);
        const units = Number(b.units) || 0;
        const fingerprint = contentHash(JSON.stringify({
          positions: positions.map(p => [p.t, p.q]).sort((a, z) => a[0].localeCompare(z[0])),
          cash: Number(b.cash) || 0, liability: Number(b.liability) || 0, units,
        }));
        const sourceHoldings = positions.map(p => ({
          t: p.t, n: p.n, q: p.q, price: p.p, marketValue: p.mv, date: sourceDate,
          buyCost: p.buyCost, sellProceeds: p.sellProceeds, dividend: p.dividend,
          netCost: p.netCost, pnl: p.pnl,
          exposureReturn: p.buyCost ? round(p.pnl / p.buyCost * 100, 8) : null,
        }));
        const sourceMv = sourceHoldings.reduce((s, h) => s + h.marketValue, 0);
        sourceHoldings.forEach(h => { h.weight = sourceMv ? round(h.marketValue / sourceMv * 100, 6) : 0; });
        const history = normalizeHistory(b.history || b.rets);
        const navRows = normalizeNavRows(b.navRows);
        const sourceMetrics = cleanMetrics(b.metrics || b.statistics || b.snap);
        const led = {
          market: /^(us|hk|a)$/.test(String(b.market || '')) ? b.market : pf,
          currency: String(b.currency || ({ us: 'USD', hk: 'HKD', a: 'CNY' }[pf])).slice(0, 3),
          positions, sourceHoldings, cash: Number(b.cash) || 0, liability: Number(b.liability) || 0,
          sourceDate, lastDate: sourceDate,
          baseMarketValue: Number(b.baseMarketValue) || sourceMv,
          baseTotalAssets: Number(b.baseTotalAssets) || sourceMv + (Number(b.cash) || 0),
          baseNetValue, baseMV: baseNetValue,
          lastUnitNav: Number(b.lastUnitNav) || (units > 0 ? baseNetValue / units : 0),
          units, fingerprint, history, navRows, sourceMetrics,
          snap: b.snap && typeof b.snap === 'object' ? {
            totalRet: Number(b.snap.totalRet) || 0, annRet: Number(b.snap.annRet) || 0,
            maxDD: Number(b.snap.maxDD) || 0, days: Number(b.snap.days) || 0,
            start: String(b.snap.start || '').slice(0, 10), end: String(b.snap.end || '').slice(0, 10),
            peakGrowth: Number(b.snap.peakGrowth) || 1, endGrowth: Number(b.snap.endGrowth) || 1,
          } : null,
          savedBy: sess.u, savedAt: new Date().toISOString(),
        };
        if (!led.lastDate || !isFinite(led.baseNetValue) || !(led.units > 0)) return J(env, { error: '缺 sourceDate / baseNetValue / units' }, 400);
        const [oldLedRaw, oldLiveRaw] = await Promise.all([env.YC_KV.get('ledger:' + pf), env.YC_KV.get('live:' + pf)]);
        const oldLed = oldLedRaw ? JSON.parse(oldLedRaw) : null;
        const oldLive = oldLiveRaw ? JSON.parse(oldLiveRaw) : { rows: [] };
        const sameSource = oldLed && oldLed.fingerprint === fingerprint;
        if (!led.history.length && sameSource && oldLed.history) led.history = normalizeHistory(oldLed.history);
        if (!led.navRows.length && sameSource && oldLed.navRows) led.navRows = normalizeNavRows(oldLed.navRows);
        if (!Object.keys(led.sourceMetrics).length && sameSource && oldLed.sourceMetrics) led.sourceMetrics = cleanMetrics(oldLed.sourceMetrics);
        // sourceDate 是新工作簿已覆蓋到的日期；只保留其後的自動日更，交易/份額改變則重置。
        const rows = sameSource ? (oldLive.rows || []).filter(r => r.date > sourceDate) : [];
        const live = {
          rows, holdings: sameSource && oldLive.holdings ? oldLive.holdings : sourceHoldings,
          updatedAt: new Date().toISOString(), marketDate: sameSource ? oldLive.marketDate || null : sourceDate,
          reset: !sameSource,
        };
        const seedStatus = {
          pf, seededAt: new Date().toISOString(), sourceDate,
          historyPoints: led.history.length, preservedRows: rows.length, sourceChanged: !sameSource,
        };
        await env.YC_KV.put('ledger:' + pf, JSON.stringify(led));
        await persistPortfolioCache(env, pf, led, live, seedStatus);
        return J(env, {
          ok: true, portfolio: pf, positions: positions.length, cash: led.cash,
          liability: led.liability, units: led.units, base: led.lastDate + ' / ' + led.baseNetValue,
          historyPoints: led.history.length, preservedRows: rows.length, sourceChanged: !sameSource,
        });
      }

      if (path.startsWith('/api/nav/') && request.method === 'GET') {
        const pf = path.split('/')[3];
        if (!/^(us|hk|a)$/.test(pf)) return J(env, { error: 'not found' }, 404);
        const cached = await env.YC_KV.get('navcache:' + pf);
        if (cached) return J(env, JSON.parse(cached));
        return J(env, {
          ok: false, enabled: false, portfolio: pf, pending: true,
          history: [], rets: [], rows: [], holdings: [], assets: [],
          error: '組合快照尚未建立，請等待每日任務或由管理員手動刷新',
        }, 503);
      }

      /* ════ PDF 直傳：後台拖入 → 提交 GitHub assets/pdf/（新增或覆蓋同名）════ */
      if (path === '/api/uploadpdf' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json();
        let name = String(b.filename || '').trim();
        name = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
        if (!/\.pdf$/i.test(name)) return J(env, { error: '只接受 .pdf 文件' }, 400);
        if (name.length > 80) name = name.slice(-80);
        const content_b64 = b.content_b64 || '';
        if (content_b64.length < 100) return J(env, { error: '文件內容為空' }, 400);
        if (content_b64.length > 34 * 1024 * 1024) return J(env, { error: 'PDF 過大（上限約 25MB）' }, 413);
        const ghPath = 'assets/pdf/' + name;
        const gh = 'https://api.github.com/repos/' + env.GH_OWNER + '/' + env.GH_REPO + '/contents/' + ghPath;
        const ghHeaders = {
          'Authorization': 'Bearer ' + env.GH_TOKEN,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'yicapital-portal',
          'X-GitHub-Api-Version': '2022-11-28',
        };
        let sha, replaced = false;
        const r0 = await fetch(gh + '?ref=' + env.GH_BRANCH, { headers: ghHeaders });
        if (r0.ok) { sha = (await r0.json()).sha; replaced = true; }
        const body = { message: 'pdf: ' + (replaced ? '更換 ' : '上傳 ') + name + '（via Portal, ' + sess.u + '）', content: content_b64, branch: env.GH_BRANCH };
        if (sha) body.sha = sha;
        const r1 = await fetch(gh, { method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j1 = await r1.json().catch(() => ({}));
        if (!r1.ok) {
          let hint = r1.status === 403 ? '｜提示：GH_TOKEN 需 Contents: Read and write 且勾選本倉庫。' : '';
          return J(env, { error: 'GitHub ' + r1.status + ' ' + (j1.message || '') + hint }, 502);
        }
        return J(env, { ok: true, path: ghPath, replaced, commit: j1.commit && j1.commit.sha });
      }

      if (path === '/api/publish' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        const { content_b64, message, portfolio } = await request.json();
        if (!content_b64 || content_b64.length < 100) return J(env, { error: '文件內容為空' }, 400);
        if (content_b64.length > 30 * 1024 * 1024) return J(env, { error: '文件過大' }, 413);
        const pf = /^(us|hk|a)$/.test(String(portfolio || '').toLowerCase()) ? String(portfolio).toLowerCase() : 'us';
        const paths = {
          us: env.GH_PATH || 'assets/data/Yi_Capital_US.xlsx',
          hk: env.GH_PATH_HK || 'assets/data/Yi_Capital_HK.xlsx',
          a: env.GH_PATH_A || 'assets/data/Yi_Capital_A.xlsx',
        };
        const gh = 'https://api.github.com/repos/' + env.GH_OWNER + '/' + env.GH_REPO + '/contents/' + paths[pf];
        const ghHeaders = {
          'Authorization': 'Bearer ' + env.GH_TOKEN,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'yicapital-portal',
          'X-GitHub-Api-Version': '2022-11-28',
        };
        let sha;
        const r0 = await fetch(gh + '?ref=' + env.GH_BRANCH, { headers: ghHeaders });
        if (r0.ok) sha = (await r0.json()).sha;
        const body = { message: message || ('data: 更新 ' + pf.toUpperCase() + ' 基金來源工作簿（via Portal, ' + sess.u + '）'), content: content_b64, branch: env.GH_BRANCH };
        if (sha) body.sha = sha;
        const r1 = await fetch(gh, { method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j1 = await r1.json().catch(() => ({}));
        if (!r1.ok) {
          let hint = '';
          if (r1.status === 403) hint = '｜提示：403 多為 Token 權限不足——fine-grained token 需勾選本倉庫並開 Contents: Read and write；classic token 需勾 repo 範圍。重生成後更新 Worker 變量 GH_TOKEN。';
          if (r1.status === 404) hint = '｜提示：檢查 GH_OWNER / GH_REPO / GH_PATH 是否與倉庫一致，且 Token 有權訪問該倉庫。';
          return J(env, { error: 'GitHub ' + r1.status + ' ' + (j1.message || '') + hint }, 502);
        }
        return J(env, { ok: true, portfolio: pf, path: paths[pf], commit: j1.commit && j1.commit.sha, url: j1.commit && j1.commit.html_url });
      }

      return J(env, { error: 'Not found' }, 404);
    } catch (e) {
      return J(env, { error: '服務器錯誤: ' + e.message }, 500);
    }
  },

  /* ⏰ Cron Triggers：Cloudflare → Worker → Settings → Triggers → Cron 添加
     "30 21 * * *"  美股收盤後約1小時（21:30 UTC ≈ 美東 4:30/5:30PM）→ 更新 US
     "0 9 * * *"    北京時間 17:00 → HK / A ＋ 基準預熱 */
  async scheduled(event, env, ctx) {
    const cron = event.cron || '';
    if (cron === '30 21 * * *') {
      ctx.waitUntil(refreshMarketCaches(env, ['us'], ['us'], 'cron:us'));
    } else if (cron === '0 9 * * *') {
      ctx.waitUntil(refreshMarketCaches(env, ['hk', 'a'], ['hk', 'a'], 'cron:asia'));
    } else {
      ctx.waitUntil(refreshMarketCaches(env, ['us', 'hk', 'a'], ['us', 'hk', 'a'], 'cron:all'));
    }
  },

  /* Cloudflare Email Routing → 此處收信（insight@ / information@ 的回覆進後台收件箱） */
  async email(message, env) {
    try {
      const raw = await streamToText(message.raw);
      const to = String(message.to || '').toLowerCase();
      const box = to.startsWith('insight') ? 'insight' : to.startsWith('information') ? 'information' : 'other';
      const item = {
        from: decodeWords(message.headers.get('from') || message.from || ''),
        to, box,
        subject: decodeWords(message.headers.get('subject') || '(無主題)'),
        date: new Date().toISOString(),
        text: extractMimeText(raw, 0),
      };
      await env.YC_KV.put('inbox:' + Date.now().toString(36) + randomHex(3), JSON.stringify(item));
    } catch (e) { /* 收信失敗不拋錯，避免退信 */ }
  }
};
