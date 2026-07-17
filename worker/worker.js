/* ═══════════════════════════════════════════════════════════════
   Yi Capital Portal Backend v4 — Cloudflare Worker（單文件，粘貼即部署）
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
     GET  /api/benchmark?symbols=spy.us,qqq.us     基準行情（KV 緩存 12h）
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
     GET  /api/nav/us           公開：每日自動計算的實時淨值行
     ⏰ Cron: "30 21 * * *" 美股收盤後1小時更新 US ｜ "0 9 * * *" 北京 17:00 更新 HK/A（預留）
   KV 鍵：
     user:{用戶名} / email:{郵箱}→用戶名 / sess:{token} /
     pending:{郵箱}(驗證碼,15分鐘) / gsetup:{token}(Google待設置,15分鐘) / bm:{…}
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

async function sendResetCode(env, email, code) {
  const html = '<div style="max-width:560px;margin:0 auto;font-family:Georgia,\'Noto Serif TC\',serif;color:#1a1a1a;background:#ffffff">'
    + '<div style="border-bottom:3px solid #0e7490;padding:20px 0 12px"><span style="font-family:Arial,sans-serif;font-weight:800;font-size:20px;letter-spacing:1px">YI<span style="color:#0e7490">CAPITAL</span></span><span style="float:right;font-family:Arial,sans-serif;font-size:11px;color:#888;letter-spacing:2px;padding-top:6px">PASSWORD RESET</span></div>'
    + '<div style="padding:26px 0 4px">'
    + '<p style="font-size:15px;line-height:1.9;margin:0 0 6px">您好，</p>'
    + '<p style="font-size:15px;line-height:1.9;margin:0 0 18px">我們收到了重設您 Yi Capital 帳號密碼的請求。請在頁面輸入以下驗證碼以繼續：</p>'
    + '<p style="font-size:13.5px;line-height:1.8;color:#555;margin:0 0 18px">We received a request to reset your Yi Capital password. Enter the code below to continue:</p>'
    + '<div style="background:#f4f7f9;border:1px solid #dbe3e8;border-radius:8px;text-align:center;padding:22px 0;margin:6px 0 20px"><span style="font-family:Arial,sans-serif;font-size:34px;font-weight:800;letter-spacing:10px;color:#0e7490">' + code + '</span></div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;font-size:12.5px;color:#666;line-height:1.9"><tr><td>'
    + '· 驗證碼於 <b>15 分鐘</b>內有效。若您並未發起此請求，請忽略本郵件，密碼不會被更改。<br>'
    + '· This code expires in <b>15 minutes</b>. If you did not request this, ignore this email — your password will not change.'
    + '</td></tr></table>'
    + '<p style="font-size:15px;line-height:1.9;margin:26px 0 0">Preston<br><span style="color:#777">YiCapital</span></p>'
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
    + '<div style="border-bottom:3px solid #0e7490;padding:20px 0 12px"><span style="font-family:Arial,sans-serif;font-weight:800;font-size:20px;letter-spacing:1px">YI<span style="color:#0e7490">CAPITAL</span></span><span style="float:right;font-family:Arial,sans-serif;font-size:11px;color:#888;letter-spacing:2px;padding-top:6px">ACCOUNT VERIFICATION</span></div>'
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
    + '<p style="font-size:15px;line-height:1.9;margin:26px 0 0">Preston<br><span style="color:#777">YiCapital</span></p>'
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
    + '<div style="border-bottom:3px solid #0e7490;padding:18px 0 10px"><span style="font-family:Arial,sans-serif;font-weight:800;font-size:20px;letter-spacing:1px">YI<span style="color:#0e7490">CAPITAL</span></span></div>'
    + '<p style="margin-top:26px">' + username + '，你好：</p>'
    + '<p>歡迎加入 Yi Capital——Key to Extraordinary Research and Opensource Portfolio。</p>'
    + '<p>這裡是一個開源的個人投資組合：全部淨值、持倉與風險數據由淨值表即時計算，全部研究公開可讀，<b>歡迎抄作業</b>（註明出處即可），更歡迎來信交流——回覆本郵件就能找到我。</p>'
    + '<p>先從這三處開始：<br>· 組合實錄：<a href="https://www.yicapital.co/portfolios.html" style="color:#0e7490">yicapital.co/portfolios.html</a><br>· 研究觀點：<a href="https://www.yicapital.co/insights.html" style="color:#0e7490">yicapital.co/insights.html</a><br>· 致股東的信：<a href="https://www.yicapital.co/filings.html" style="color:#0e7490">yicapital.co/filings.html</a></p>'
    + '<p style="margin-top:30px">坐在牌桌上，是一切正期望值交易兌現的前提。</p>'
    + '<p style="margin-top:26px">Preston<br><span style="color:#777">YiCapital</span></p>'
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
/* Stooq 最新收盤價：AAPL → aapl.us；BRK.B → brk-b.us */
async function stooqQuote(ticker) {
  const sym = String(ticker).trim().toLowerCase().replace(/\./g, '-') + '.us';
  const r = await fetch('https://stooq.com/q/l/?s=' + encodeURIComponent(sym) + '&f=sd2t2ohlcv&h&e=csv', { headers: { 'User-Agent': 'yicapital-portal' } });
  if (!r.ok) return null;
  const lines = (await r.text()).trim().split('\n');
  if (lines.length < 2) return null;
  const c = lines[1].split(',');
  const close = parseFloat(c[6]);
  return isFinite(close) && close > 0 ? { date: c[1], close } : null;
}
/* Stooq 歷史序列（供基準預熱） */
async function stooqSeries(s) {
  const r = await fetch('https://stooq.com/q/d/l/?s=' + encodeURIComponent(s) + '&i=d', { headers: { 'User-Agent': 'yicapital-portal' } });
  if (!r.ok) return null;
  const rows = (await r.text()).trim().split('\n').slice(1).map(l => l.split(','));
  const series = rows.filter(c => c.length >= 5 && c[4] && c[4] !== 'N/D').slice(-500).map(c => ({ date: c[0], close: parseFloat(c[4]) })).filter(p => isFinite(p.close));
  return series.length > 20 ? series : null;
}
/* 每日淨值更新：賬本（持倉+現金）× 收盤價 → 追加一行；一天只算一次 */
async function updatePortfolioNav(env, pf) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const dow = now.getUTCDay();
  const st = { pf, ranAt: now.toISOString() };
  if (dow === 0 || dow === 6) { st.skip = 'weekend'; await env.YC_KV.put('navstatus:' + pf, JSON.stringify(st)); return st; }
  const ledRaw = await env.YC_KV.get('ledger:' + pf);
  if (!ledRaw) { st.skip = 'no-ledger'; await env.YC_KV.put('navstatus:' + pf, JSON.stringify(st)); return st; }
  const led = JSON.parse(ledRaw);
  const liveRaw = await env.YC_KV.get('live:' + pf);
  const live = liveRaw ? JSON.parse(liveRaw) : { rows: [] };
  const lastDate = live.rows.length ? live.rows[live.rows.length - 1].date : led.lastDate;
  if (today <= lastDate) { st.skip = 'already-updated:' + lastDate; await env.YC_KV.put('navstatus:' + pf, JSON.stringify(st)); return st; }
  const lastPxRaw = await env.YC_KV.get('lastpx:' + pf);
  const lastPx = lastPxRaw ? JSON.parse(lastPxRaw) : {};
  let mv = led.cash || 0, missing = [], stale = [];
  for (const p of led.positions) {
    if (!p.q) continue;
    let q = null;
    try { q = await stooqQuote(p.t); } catch (e) { /* noop */ }
    if (q && q.close) { mv += p.q * q.close; lastPx[p.t] = q.close; }
    else if (lastPx[p.t]) { mv += p.q * lastPx[p.t]; stale.push(p.t); }
    else missing.push(p.t);
  }
  if (missing.length) { st.skip = 'missing-quotes:' + missing.join(','); await env.YC_KV.put('navstatus:' + pf, JSON.stringify(st)); return st; }
  const prev = live.rows.length ? live.rows[live.rows.length - 1] : { mv: led.baseMV, unitNav: led.lastUnitNav };
  if (!prev.mv || !isFinite(prev.mv)) { st.skip = 'no-base-mv'; await env.YC_KV.put('navstatus:' + pf, JSON.stringify(st)); return st; }
  const ret = mv / prev.mv - 1;
  if (!isFinite(ret) || Math.abs(ret) > 0.5) { st.skip = 'sanity-fail:' + ret; await env.YC_KV.put('navstatus:' + pf, JSON.stringify(st)); return st; }
  live.rows.push({ date: today, ret: Math.round(ret * 1e8) / 1e8, mv: Math.round(mv * 100) / 100, unitNav: Math.round((prev.unitNav || 0) * (1 + ret) * 1e6) / 1e6 });
  if (live.rows.length > 500) live.rows = live.rows.slice(-500);
  live.updatedAt = now.toISOString();
  if (stale.length) live.note = 'stale:' + stale.join(',');
  await env.YC_KV.put('live:' + pf, JSON.stringify(live));
  await env.YC_KV.put('lastpx:' + pf, JSON.stringify(lastPx));
  st.appended = today; st.mv = mv;
  await env.YC_KV.put('navstatus:' + pf, JSON.stringify(st));
  return st;
}
async function prewarmBenchmark(env) {
  const symbols = ['spy.us', 'qqq.us'];
  const data = {};
  for (const s of symbols) { try { const ser = await stooqSeries(s); if (ser) data[s.replace(/\.us$/, '').toUpperCase()] = ser; } catch (e) {} }
  if (Object.keys(data).length) await env.YC_KV.put('bm:spy.us,qqq.us', JSON.stringify({ ok: true, data, fetched: new Date().toISOString() }), { expirationTtl: 26 * 3600 });
}

async function streamToText(stream) {
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
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
          ok: true, version: 'v6',
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

      /* ════ 基準行情（公開，Stooq，KV 緩存 12h）════ */
      if (path === '/api/benchmark' && request.method === 'GET') {
        const symbols = (url.searchParams.get('symbols') || 'spy.us,qqq.us').split(',').map(s => s.trim().toLowerCase()).filter(s => /^[a-z0-9.^-]{1,12}$/.test(s)).slice(0, 4);
        const cacheKey = 'bm:' + symbols.join(',');
        const cached = await env.YC_KV.get(cacheKey);
        if (cached) return J(env, JSON.parse(cached));
        const data = {};
        for (const s of symbols) {
          try {
            const r = await fetch('https://stooq.com/q/d/l/?s=' + encodeURIComponent(s) + '&i=d', { headers: { 'User-Agent': 'yicapital-portal' } });
            if (!r.ok) continue;
            const rows = (await r.text()).trim().split('\n').slice(1).map(l => l.split(','));
            const name = s.replace(/\.us$/i, '').toUpperCase();
            const series = rows.filter(c => c.length >= 5 && c[4] && c[4] !== 'N/D').slice(-500).map(c => ({ date: c[0], close: parseFloat(c[4]) })).filter(p => isFinite(p.close));
            if (series.length > 20) data[name] = series;
          } catch (e) { /* 單一代碼失敗不影響其他 */ }
        }
        const resp = { ok: true, data, fetched: new Date().toISOString() };
        if (Object.keys(data).length) await env.YC_KV.put(cacheKey, JSON.stringify(resp), { expirationTtl: 12 * 3600 });
        return J(env, resp);
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
        const rep = flt(r), pos = flt(p);
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
        return J(env, { ok: true, reports: r ? JSON.parse(r) : null, posts: p ? JSON.parse(p) : null });
      }
      if (path === '/api/content/save' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json();
        const kind = b.kind === 'posts' ? 'posts' : b.kind === 'reports' ? 'reports' : null;
        if (!kind || !Array.isArray(b.items)) return J(env, { error: 'kind 需為 reports/posts 且 items 為數組' }, 400);
        if (b.items.length > 500) return J(env, { error: '條目過多' }, 400);
        // 輕量校驗：每條必須有 id 與 title
        for (const it of b.items) {
          if (!it || !it.id || !it.title) return J(env, { error: '每條需含 id 與 title' }, 400);
        }
        await env.YC_KV.put('content:' + kind, JSON.stringify(b.items));
        return J(env, { ok: true, kind, count: b.items.length });
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
        const positions = b.positions.filter(p => p && p.t && isFinite(p.q)).map(p => ({ t: String(p.t).slice(0, 12), q: Number(p.q) })).slice(0, 100);
        const led = {
          positions, cash: Number(b.cash) || 0,
          lastDate: String(b.lastDate || '').slice(0, 10),
          baseMV: Number(b.baseMV) || 0,
          lastUnitNav: Number(b.lastUnitNav) || 0,
          units: Number(b.units) || 0,
          savedBy: sess.u, savedAt: new Date().toISOString(),
        };
        if (!led.lastDate || !led.baseMV) return J(env, { error: '缺 lastDate / baseMV' }, 400);
        await env.YC_KV.put('ledger:' + pf, JSON.stringify(led));
        await env.YC_KV.put('live:' + pf, JSON.stringify({ rows: [], updatedAt: new Date().toISOString() }));   // 新賬本 → 清空舊實時行
        return J(env, { ok: true, positions: positions.length, cash: led.cash, base: led.lastDate + ' / ' + led.baseMV });
      }

      if (path.startsWith('/api/nav/') && request.method === 'GET') {
        const pf = path.split('/')[3];
        if (!/^(us|hk|a)$/.test(pf)) return J(env, { error: 'not found' }, 404);
        const [ledRaw, liveRaw, stRaw] = await Promise.all([
          env.YC_KV.get('ledger:' + pf), env.YC_KV.get('live:' + pf), env.YC_KV.get('navstatus:' + pf)]);
        if (!ledRaw) return J(env, { ok: true, enabled: false, rows: [] });
        const led = JSON.parse(ledRaw); const live = liveRaw ? JSON.parse(liveRaw) : { rows: [] };
        return J(env, { ok: true, enabled: true, base: { date: led.lastDate, unitNav: led.lastUnitNav, mv: led.baseMV }, rows: live.rows, updatedAt: live.updatedAt || null, status: stRaw ? JSON.parse(stRaw) : null });
      }

      if (path === '/api/publish' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        const { content_b64, message } = await request.json();
        if (!content_b64 || content_b64.length < 100) return J(env, { error: '文件內容為空' }, 400);
        if (content_b64.length > 30 * 1024 * 1024) return J(env, { error: '文件過大' }, 413);
        const gh = 'https://api.github.com/repos/' + env.GH_OWNER + '/' + env.GH_REPO + '/contents/' + env.GH_PATH;
        const ghHeaders = {
          'Authorization': 'Bearer ' + env.GH_TOKEN,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'yicapital-portal',
          'X-GitHub-Api-Version': '2022-11-28',
        };
        let sha;
        const r0 = await fetch(gh + '?ref=' + env.GH_BRANCH, { headers: ghHeaders });
        if (r0.ok) sha = (await r0.json()).sha;
        const body = { message: message || ('data: 更新淨值表（via Portal, ' + sess.u + '）'), content: content_b64, branch: env.GH_BRANCH };
        if (sha) body.sha = sha;
        const r1 = await fetch(gh, { method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j1 = await r1.json().catch(() => ({}));
        if (!r1.ok) {
          let hint = '';
          if (r1.status === 403) hint = '｜提示：403 多為 Token 權限不足——fine-grained token 需勾選本倉庫並開 Contents: Read and write；classic token 需勾 repo 範圍。重生成後更新 Worker 變量 GH_TOKEN。';
          if (r1.status === 404) hint = '｜提示：檢查 GH_OWNER / GH_REPO / GH_PATH 是否與倉庫一致，且 Token 有權訪問該倉庫。';
          return J(env, { error: 'GitHub ' + r1.status + ' ' + (j1.message || '') + hint }, 502);
        }
        return J(env, { ok: true, commit: j1.commit && j1.commit.sha, url: j1.commit && j1.commit.html_url });
      }

      return J(env, { error: 'Not found' }, 404);
    } catch (e) {
      return J(env, { error: '服務器錯誤: ' + e.message }, 500);
    }
  },

  /* ⏰ Cron Triggers：Cloudflare → Worker → Settings → Triggers → Cron 添加
     "30 21 * * *"  美股收盤後約1小時（21:30 UTC ≈ 美東 4:30/5:30PM）→ 更新 US
     "0 9 * * *"    北京時間 17:00 → HK / A（預留，賬本就緒後自動生效）＋ 基準預熱 */
  async scheduled(event, env, ctx) {
    const cron = event.cron || '';
    if (cron === '30 21 * * *') {
      ctx.waitUntil((async () => { await updatePortfolioNav(env, 'us'); await prewarmBenchmark(env); })());
    } else if (cron === '0 9 * * *') {
      ctx.waitUntil((async () => { await updatePortfolioNav(env, 'hk'); await updatePortfolioNav(env, 'a'); })());
    } else {
      ctx.waitUntil((async () => { await updatePortfolioNav(env, 'us'); })());   // 手動觸發測試
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
