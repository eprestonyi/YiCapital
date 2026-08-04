import {
  createTushareAdapter,
  handleTushareTerminalRequest,
  refreshTushareTerminalSnapshots,
} from './tushare.js';
import { createTerminalWarehouseAdapter } from './warehouse.js';
import {
  assertLedgerRevision,
  drainLedgerOutbox,
  enqueueDailyNavReplay,
  extendLedgerPriceTape,
  freezeLedgerPriceTape,
  handleLedgerAdminRequest,
  ledgerHealth,
  loadLedgerReplayInput,
  loadFrozenLedgerPriceTape,
  loadPriorFrozenLedgerPriceTape,
  materializeLedgerKv,
  persistLedgerValuation,
  persistLedgerValuationBatch,
  portfolioDerivationState,
} from './ledger-store.js';
import { replayPortfolioLedger } from './portfolio-ledger.js';
import {
  GoogleIdTokenInvalidError,
  GoogleJwksUnavailableError,
  verifyGoogleIdToken,
} from './google-id-token.js';
import {
  AuthStoreUnavailableError,
  authRateAllowed,
  authRateLimitHealth,
  cleanupAuthState,
  getSession,
  newSession,
  revokeSession,
  revokeUserSessions,
  sessionStoreHealth,
} from './auth-sessions.js';

/* ═══════════════════════════════════════════════════════════════
   Yi Capital Portal Backend v9.1 — Cloudflare Worker（D1 Ledger + D1 Auth Sessions）
   ─────────────────────────────────────────────────────────────
   帳號模型：
     · 註冊 = 用戶名 + 密碼 + 郵箱（配置了 Resend 則發 6 位驗證碼）
     · Google 註冊 = Google 驗證身份 → 一鍵建立無密碼帳號
     · 登入 = 用戶名或郵箱 + 密碼；Google 用戶也可直接點 Google 登入
     · Guest = 不建立帳號、不發 session；沿用現有匿名訪客限制
   接口：
     POST /api/signup           {username,password,email}
     POST /api/verify           {email,code}
     POST /api/login            {username(或郵箱),password}
     POST /api/google           {credential,autoCreate,terms} → 登入或一鍵建號
     POST /api/google/complete  {setupToken,username,password}
     GET  /api/me   POST /api/logout
     POST /api/feedback         公開：提交三語用戶意見（登入可選）
     GET  /api/feedback         [admin] 查詢、篩選及匯出 user log
     POST /api/feedback/update  [admin] 分流、排期、處理及關聯 Issue / PR
     GET  /api/benchmark?set=us|hk|a               三市場基準行情（只讀 KV 快照）
     GET  /api/entry-market                          登入入口全歷史精簡快照
     POST /api/refresh          [admin] 手動重算 NAV / 統計 / 基準並覆蓋 KV
     GET  /api/users            [admin]
     POST /api/users/update     [admin] disable/enable/delete/resetpw
     POST /api/publish          [admin] 淨值表 → GitHub
     POST /api/ledger           [admin] 舊快照入口（永久 410）
     /api/admin/ledger/*        [admin] D1 事件賬本、Pending/Confirm、Excel 雙向同步
     GET  /api/content          公開：研報庫+研究觀點條目（僅啟用項）
     GET  /api/content/all      [admin] 全部條目（含停用）
     POST /api/content/save     [admin] 覆蓋保存 {kind:'reports'|'posts', items:[…]}
     POST /api/forgot           找回密碼第一步 {email} → 郵箱驗證碼
     POST /api/reset            找回密碼第二步 {email, code, password}
     POST /api/users/setpw      [admin] 重設任意用戶密碼
     GET  /api/nav/us|hk|a      公開：只讀每日持久化快照（不即時計算/抓行情）
     ⏰ Cron: "30 21 * * *" 美股 ｜ "0 9 * * *" 亞洲即時 ｜ "30 10 * * *" 亞洲 EOD 對賬
   KV 鍵：
     user:{用戶名} / email:{郵箱}→用戶名 /
     sess:{token}（v9.1 僅作一個版本的舊會話遷移與緊急回退副本）/
     pending:{郵箱}(驗證碼,15分鐘) / gsetup:{token}(Google待設置,15分鐘) /
     ledger:{us|hk|a} / live:{us|hk|a} / navcache:{us|hk|a} /
     navstatus:{us|hk|a} / bmset:{us|hk|a} / bmstatus:{us|hk|a}
   綁定與密鑰：KV=YC_KV；D1=FEEDBACK_DB；Secrets: ADMIN_USERNAME, ADMIN_PASSWORD,
     GH_TOKEN, TUSHARE_TOKEN, FEEDBACK_RATE_SALT, GOOGLE_CLIENT_ID,
     （可選）RESEND_API_KEY；Text: GH_OWNER, GH_REPO,
     GH_BRANCH, GH_PATH, ALLOWED_ORIGIN,（可選）MAIL_FROM
   ═══════════════════════════════════════════════════════════════ */

const enc = new TextEncoder();

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const verificationCode = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));

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
function normalizedCorsOrigin(request, env) {
  const origin = request && request.headers && request.headers.get('Origin');
  if (!origin) return env.ALLOWED_ORIGIN || '*';
  const normalized = String(origin).replace(/\/+$/, '');
  const configured = String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(value => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const allowed = new Set([
    ...configured,
    'https://www.yicapital.co',
    'https://yicapital.co',
  ]);
  if (allowed.has(normalized)) return normalized;
  return null;
}
const corsHeaders = (env, request) => {
  const origin = normalizedCorsOrigin(request, env);
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
};
const baseJsonResponse = (env, data, status = 200, extraHeaders = {}, request = null) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env, request), ...extraHeaders },
  });
const J = baseJsonResponse;

const FEEDBACK_CATEGORIES = new Set([
  'bug', 'content', 'data', 'ux',
  'accessibility', 'performance', 'feature', 'other',
]);
const FEEDBACK_LOCALES = new Set(['zh-Hant', 'zh-Hans', 'en']);
const FEEDBACK_STATUSES = new Set([
  'new', 'triaged', 'planned', 'in_progress',
  'resolved', 'dismissed', 'duplicate',
]);
const FEEDBACK_PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3']);

async function sha256Hex(value) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(String(value || ''))));
}
async function hmacSha256Hex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(String(value || ''))));
}
function cleanPlain(value, max) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}
function cleanPagePath(value) {
  const path = cleanPlain(value, 300).split(/[?#]/)[0];
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
  return path || '/';
}
function feedbackOriginAllowed(request, env) {
  const origin = request.headers.get('Origin');
  // Same-origin Sites proxy requests do not forward Origin to the portal Worker.
  if (!origin) return true;
  return normalizedCorsOrigin(request, env) !== null;
}
async function feedbackActor(sess, env, associateAccount) {
  if (!associateAccount || !sess) return { actorType: 'anonymous', username: null };
  if (sess.role === 'admin') return { actorType: 'user', username: sess.u };
  const raw = await env.YC_KV.get('user:' + sess.u);
  if (!raw) return { actorType: 'anonymous', username: null };
  const user = JSON.parse(raw);
  if (user.disabled) return { actorType: 'anonymous', username: null };
  return { actorType: 'user', username: sess.u };
}
async function consumeFeedbackRateLimit(request, env, sess) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const windowId = Math.floor(now / windowMs);
  const ip = String(request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')
    || 'unknown').split(',')[0].trim();
  const actorKind = sess ? 'user' : 'anon';
  const actorReference = sess ? 'user:' + sess.u : 'anon:' + ip;
  const identity = actorKind + ':'
    + (await hmacSha256Hex(env.FEEDBACK_RATE_SALT, actorReference)).slice(0, 24);
  const bucket = windowId + ':' + identity;
  await env.FEEDBACK_DB.prepare(`
    INSERT INTO feedback_rate_limits (bucket, count, reset_at)
    VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET
      count = feedback_rate_limits.count + 1,
      reset_at = excluded.reset_at
  `).bind(bucket, (windowId + 1) * windowMs).run();
  const row = await env.FEEDBACK_DB.prepare(
    'SELECT count, reset_at FROM feedback_rate_limits WHERE bucket = ?'
  ).bind(bucket).first();
  const limit = sess ? 8 : 5;
  if (row && row.count === 1 && parseInt(randomHex(1), 16) < 8) {
    await env.FEEDBACK_DB.prepare(
      'DELETE FROM feedback_rate_limits WHERE reset_at < ?'
    ).bind(now - 24 * 60 * 60 * 1000).run();
  }
  return {
    allowed: !row || Number(row.count) <= limit,
    retryAfter: Math.max(1, Math.ceil((Number(row && row.reset_at || now + windowMs) - now) / 1000)),
  };
}
async function cleanupFeedbackRateLimits(env) {
  if (!env.FEEDBACK_DB) return;
  await env.FEEDBACK_DB.prepare(
    'DELETE FROM feedback_rate_limits WHERE reset_at < ?'
  ).bind(Date.now()).run();
}
function feedbackItem(row) {
  return {
    id: row.id,
    source: row.source,
    actorType: row.actor_type,
    username: row.username || null,
    category: row.category,
    rating: row.rating == null ? null : Number(row.rating),
    message: row.message,
    pagePath: row.page_path,
    pageTitle: row.page_title || '',
    locale: row.locale,
    release: row.release_id || '',
    diagnostics: {
      device: row.device_class || null,
      browser: row.browser_family || null,
      viewportWidth: row.viewport_width == null ? null : Number(row.viewport_width),
      viewportHeight: row.viewport_height == null ? null : Number(row.viewport_height),
    },
    fingerprint: row.fingerprint,
    status: row.status,
    priority: row.priority || null,
    adminNote: row.admin_note || '',
    linkedIssue: row.linked_issue || '',
    linkedPr: row.linked_pr || '',
    resolvedRelease: row.resolved_release || '',
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    resolvedAt: row.resolved_at == null ? null : new Date(Number(row.resolved_at)).toISOString(),
  };
}

const isUsername = u => /^[a-zA-Z0-9_\-\u4e00-\u9fff]{2,24}$/.test(u || '');
const isEmail = e => /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(e || '');

async function nextGoogleUsername(env, profile) {
  const localPart = String(profile.email || '').split('@')[0];
  let base = String(profile.name || localPart || 'YiMember')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '')
    .slice(0, 20);
  if (base.length < 2) base = ('Yi_' + localPart).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
  if (base.length < 2) base = 'YiMember';
  let candidate = base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    if (candidate !== env.ADMIN_USERNAME && !await env.YC_KV.get('user:' + candidate)) return candidate;
    candidate = (base.slice(0, Math.max(2, 24 - String(suffix).length)) + suffix).slice(0, 24);
  }
  return 'Yi_' + randomHex(6);
}
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

async function afterResponse(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
    return;
  }
  await promise;
}

async function createUser(env, rec) {
  await env.YC_KV.put('user:' + rec.u, JSON.stringify(rec));
  if (rec.email) await env.YC_KV.put('email:' + rec.email, rec.u);
}

/* ── 收件：極簡 MIME 文本提取（best-effort，覆蓋常見 text/plain、QP、base64、multipart）── */
const BM_SETS = {
  us: [
    { label: 'S&P 500', tushare: { dataset: 'index_global', tsCode: 'SPX' } },
    { label: 'NASDAQ', tushare: { dataset: 'index_global', tsCode: 'IXIC' } },
    { label: 'DOW', tushare: { dataset: 'index_global', tsCode: 'DJI' } },
  ],
  hk: [
    { label: 'HSI', tushare: { dataset: 'index_global', tsCode: 'HSI' } },
    { label: 'HSTECH', tushare: { dataset: 'index_global', tsCode: 'HKTECH' } },
  ],
  a: [{ label: 'HS300', tushare: { dataset: 'index_daily', tsCode: '000300.SH' } }],
};
function mergeBenchmarkSeries(oldRows, freshRows) {
  const byDate = new Map();
  [oldRows, freshRows].forEach(rows => {
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const date = String(row && row.date || '').slice(0, 10);
      const close = Number(row && row.close);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && isFinite(close) && close > 0) {
        byDate.set(date, { date, close });
      }
    });
  });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function benchmarkLabelIsTushare(snapshot, label, endpoint) {
  if (!snapshot || !Array.isArray(snapshot.data && snapshot.data[label])) return false;
  const meta = snapshot.source_meta && snapshot.source_meta[label] || {};
  const source = String(meta.source || snapshot.sources && snapshot.sources[label] || '');
  const sourceEndpoint = String(meta.source_endpoint || '');
  return source === `tushare:${endpoint}`
    || (source.startsWith('tushare:') && sourceEndpoint === endpoint);
}

function benchmarkSnapshotIsTushare(snapshot, set) {
  const config = BM_SETS[set];
  if (!snapshot || !config || snapshot.source !== 'tushare') return false;
  const published = config.filter(item =>
    Array.isArray(snapshot.data && snapshot.data[item.label]));
  return published.length > 0 && published.every(item =>
    benchmarkLabelIsTushare(snapshot, item.label, item.tushare.dataset));
}

const isoTradeDate = value => {
  const text = String(value || '').replaceAll('-', '');
  return /^\d{8}$/.test(text)
    ? text.slice(0, 4) + '-' + text.slice(4, 6) + '-' + text.slice(6, 8)
    : null;
};
const compactUtcDate = date => date.toISOString().slice(0, 10).replaceAll('-', '');
const maxText = values => values.filter(Boolean).map(String).sort().at(-1) || null;

function tusharePortfolioSymbol(ticker, market) {
  const value = String(ticker || '').trim().toUpperCase();
  if (market === 'hk') {
    const digits = value.replace(/\.HK$/i, '').replace(/\D/g, '');
    return digits ? digits.padStart(5, '0') + '.HK' : value;
  }
  if (market === 'a') {
    if (/\.SS$/.test(value)) return value.replace(/\.SS$/, '.SH');
    if (/\.(SH|SZ|BJ)$/.test(value)) return value;
    if (/^\d{6}$/.test(value)) {
      return value + (/^[5689]/.test(value) ? '.SH' : /^[48]/.test(value) ? '.BJ' : '.SZ');
    }
    return value;
  }
  return value.replace(/\.US$/i, '');
}

function portfolioDataset(market) {
  return { us: 'us_daily', hk: 'hk_daily', a: 'daily' }[market] || null;
}

function portfolioRealtimeDataset(market) {
  return { hk: 'rt_hk_k', a: 'rt_k' }[market] || null;
}

function portfolioMarketDate(now, market) {
  const timeZone = market === 'us' ? 'America/New_York' : 'Asia/Hong_Kong';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function realtimeQuoteDate(row) {
  const raw = String(row && (row.trade_time || row.trade_date || row.date) || '');
  const match = raw.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function asiaRealtimeQuoteTimestamp(row, verifiedSessionDate) {
  const raw = String(row && row.trade_time || '').trim();
  if (!raw) return null;
  const full = raw.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})[^\d]?(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (full) {
    return Date.parse(
      `${full[1]}-${full[2]}-${full[3]}T${full[4]}:${full[5]}:${full[6] || '00'}+08:00`,
    );
  }
  const time = raw.match(/(?:^|\s)(\d{2}):(\d{2})(?::(\d{2}))?(?:$|\s)/);
  if (!time || !/^\d{4}-\d{2}-\d{2}$/.test(String(verifiedSessionDate || ''))) return null;
  return Date.parse(
    `${verifiedSessionDate}T${time[1]}:${time[2]}:${time[3] || '00'}+08:00`,
  );
}

function marketLocalMinute(nowValue, market) {
  const timeZone = market === 'us' ? 'America/New_York' : 'Asia/Hong_Kong';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowValue));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function marketLocalWeekday(nowValue, market) {
  const timeZone = market === 'us' ? 'America/New_York' : 'Asia/Hong_Kong';
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
    .format(new Date(nowValue));
}

function portfolioRealtimeWindowOpen(nowValue, market) {
  const weekday = marketLocalWeekday(nowValue, market);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const minute = marketLocalMinute(nowValue, market);
  if (market === 'us') return minute >= 9 * 60 + 30 && minute < 16 * 60;
  if (market === 'a') {
    return minute >= 9 * 60 + 30 && minute < 11 * 60 + 30 ||
      minute >= 13 * 60 && minute < 15 * 60;
  }
  if (market === 'hk') {
    return minute >= 9 * 60 + 30 && minute < 12 * 60 ||
      minute >= 13 * 60 && minute < 16 * 60;
  }
  return false;
}

async function tusharePortfolioVerifiedSession(adapter, market, now = Date.now) {
  const request = {
    us: { dataset: 'us_tradecal' },
    hk: { dataset: 'hk_tradecal' },
    a: { dataset: 'trade_cal', exchange: 'SSE' },
  }[market];
  if (!request) throw new Error('portfolio_market_unsupported');
  const nowValue = now();
  const currentDate = portfolioMarketDate(nowValue, market);
  const startDate = addIsoDays(currentDate, -14);
  const result = await adapter.query(request.dataset, {
    params: {
      ...(request.exchange ? { exchange: request.exchange } : {}),
      start_date: compactIsoDate(startDate),
      end_date: compactIsoDate(currentDate),
    },
    fields: 'cal_date,is_open',
  });
  const rows = (Array.isArray(result.data) ? result.data : [])
    .map(row => ({ date: isoTradeDate(row.cal_date), isOpen: Number(row.is_open) === 1 }))
    .filter(row => row.date && row.date >= startDate && row.date <= currentDate)
    .sort((left, right) => left.date.localeCompare(right.date));
  const byDate = new Map(rows.map(row => [row.date, row]));
  for (let date = startDate; date <= currentDate; date = addIsoDays(date, 1)) {
    if (!byDate.has(date)) throw new Error(`portfolio_verified_session_incomplete:${date}`);
  }
  const verifiedDate = rows.filter(row => row.isOpen).map(row => row.date).at(-1) || null;
  if (!verifiedDate) throw new Error('portfolio_verified_session_unavailable');
  const currentIsOpen = byDate.get(currentDate).isOpen;
  const minute = marketLocalMinute(nowValue, market);
  const regularCloseMinute = market === 'a' ? 15 * 60 : 16 * 60;
  const intraday = currentIsOpen && verifiedDate === currentDate &&
    minute >= 9 * 60 + 30 && minute < regularCloseMinute;
  return {
    date: verifiedDate,
    currentDate,
    currentIsOpen,
    intraday,
    source: `tushare:${request.dataset}`,
    source_endpoint: request.dataset,
    fetched_at: result.fetched_at || result.retrieved_at || new Date(nowValue).toISOString(),
  };
}

function yahooUsSymbol(ticker) {
  return String(ticker || '').trim().toUpperCase().replace(/\.US$/, '').replaceAll('.', '-');
}

async function yahooUsCounterQuote(ticker, now = Date.now, options = {}) {
  const fetchFn = options.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('yahoo_counter_fetch_unavailable');
  const symbol = yahooUsSymbol(ticker);
  if (!symbol) throw new Error('yahoo_counter_symbol_invalid');
  const nowValue = now();
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    '?interval=1m&range=1d&includePrePost=false&events=div%2Csplits';
  const timeoutSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(5000)
    : undefined;
  const response = await fetchFn(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 YiCapital/1.0' },
    ...(timeoutSignal ? { signal: timeoutSignal } : {}),
  });
  if (!response || response.ok !== true || typeof response.json !== 'function') {
    throw new Error('yahoo_counter_http_unavailable');
  }
  const payload = await response.json();
  const meta = payload && payload.chart && Array.isArray(payload.chart.result) &&
    payload.chart.result[0] && payload.chart.result[0].meta;
  const close = Number(meta && meta.regularMarketPrice);
  const quoteSeconds = Number(meta && meta.regularMarketTime);
  const quoteAgeMs = nowValue - quoteSeconds * 1000;
  if (!(close > 0) || !Number.isFinite(quoteSeconds) || quoteSeconds <= 0 ||
      quoteAgeMs < -5 * 60 * 1000 || quoteAgeMs > 15 * 60 * 1000) {
    throw new Error('yahoo_counter_payload_invalid');
  }
  const date = portfolioMarketDate(quoteSeconds * 1000, 'us');
  return {
    date,
    close,
    source: 'yahoo:query2-chart',
    source_endpoint: 'query2.finance.yahoo.com/v8/finance/chart',
    fetched_at: new Date(nowValue).toISOString(),
    as_of: new Date(quoteSeconds * 1000).toISOString(),
    freshness_class: 'intraday_snapshot',
    quote_mode: 'realtime',
    session_verified: false,
    regular_market_time: quoteSeconds,
    market_state: String(meta && meta.marketState || '').toUpperCase() || null,
    price_basis: 'raw_counter',
    adjusted: false,
    fallback: null,
  };
}

async function tushareSeries(adapter, request, now = Date.now) {
  const endDate = new Date(now());
  const startDate = new Date('2010-01-01T00:00:00.000Z');
  const result = await adapter.query(request.dataset, {
    params: {
      ts_code: request.tsCode,
      start_date: compactUtcDate(startDate),
      end_date: compactUtcDate(endDate),
    },
    fields: 'ts_code,trade_date,close',
  });
  const series = (Array.isArray(result.data) ? result.data : [])
    .map(row => ({ date: isoTradeDate(row.trade_date), close: Number(row.close) }))
    .filter(point => point.date && Number.isFinite(point.close) && point.close > 0)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (series.length < 20) throw new Error('tushare_series_unavailable');
  return {
    series,
    source: `tushare:${request.dataset}`,
    source_endpoint: request.dataset,
    fetched_at: result.fetched_at || result.retrieved_at || new Date(now()).toISOString(),
    as_of: series[series.length - 1].date,
    freshness_class: result.freshness_class || 'eod',
  };
}

async function tusharePortfolioQuote(adapter, ticker, market, now = Date.now, options = {}) {
  const dataset = portfolioDataset(market);
  if (!dataset) throw new Error('portfolio_market_unsupported');
  const configuredRealtimeDataset = portfolioRealtimeDataset(market);
  const realtimeDataset = options.skipRealtime ? null : configuredRealtimeDataset;
  const symbol = tusharePortfolioSymbol(ticker, market);
  const verifiedSessionDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options.verifiedSessionDate || ''))
    ? String(options.verifiedSessionDate)
    : null;
  let realtimeFailure = null;
  if (realtimeDataset) {
    try {
      const realtimeResult = await adapter.query(realtimeDataset, {
        params: { ts_code: symbol },
        fields: realtimeDataset === 'rt_k'
          ? 'ts_code,close,trade_time'
          : 'ts_code,close,trade_date,trade_time',
      });
      const realtime = (Array.isArray(realtimeResult.data) ? realtimeResult.data : [])
        .map(row => {
          const observedDate = realtimeQuoteDate(row);
          // rt_hk_k commonly omits the quote date. It may only be bound to a
          // market session independently verified for the current HK date;
          // otherwise realtime is rejected and the raw EOD path is tried.
          const sessionDate = !observedDate && market === 'hk' &&
            verifiedSessionDate === portfolioMarketDate(now(), market)
            ? verifiedSessionDate
            : null;
          const quoteTimestamp = asiaRealtimeQuoteTimestamp(
            row,
            observedDate || sessionDate || verifiedSessionDate,
          );
          const quoteAgeMs = Number.isFinite(quoteTimestamp) ? now() - quoteTimestamp : null;
          return {
            date: observedDate || sessionDate,
            close: Number(row.close),
            session_bound: Boolean(sessionDate),
            quote_timestamp: quoteTimestamp,
            quote_age_ms: quoteAgeMs,
          };
        })
        .find(point => point.date && Number.isFinite(point.close) && point.close > 0 &&
          (!options.requireFreshRealtime || point.quote_age_ms == null ||
            point.quote_age_ms >= -5 * 60 * 1000 && point.quote_age_ms <= 15 * 60 * 1000));
      if (!realtime) throw new Error('tushare_realtime_quote_unavailable');
      return {
        ...realtime,
        source: `tushare:${realtimeDataset}`,
        source_endpoint: realtimeDataset,
        fetched_at: realtimeResult.fetched_at || realtimeResult.retrieved_at || new Date(now()).toISOString(),
        as_of: realtime.date,
        freshness_class: realtimeResult.freshness_class || 'intraday_snapshot',
        quote_mode: 'realtime',
        session_verified: realtime.session_bound,
        price_basis: 'raw_counter',
        adjusted: false,
        fallback: null,
      };
    } catch (error) {
      realtimeFailure = error && (error.code || error.message) || 'tushare_realtime_quote_unavailable';
    }
  }
  const endDate = new Date(now());
  const startDate = new Date(endDate.getTime() - 14 * 86400000);
  const result = await adapter.query(dataset, {
    params: {
      ts_code: symbol,
      start_date: compactUtcDate(startDate),
      end_date: compactUtcDate(endDate),
    },
    fields: 'ts_code,trade_date,close',
  });
  const latest = (Array.isArray(result.data) ? result.data : [])
    .map(row => ({ date: isoTradeDate(row.trade_date), close: Number(row.close) }))
    .filter(point => point.date && Number.isFinite(point.close) && point.close > 0)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  if (!latest) throw new Error('tushare_quote_unavailable');
  return {
    ...latest,
    source: `tushare:${dataset}`,
    source_endpoint: dataset,
    fetched_at: result.fetched_at || result.retrieved_at || new Date(now()).toISOString(),
    as_of: latest.date,
    freshness_class: result.freshness_class || 'eod',
    quote_mode: configuredRealtimeDataset ? 'eod_fallback' : 'eod',
    price_basis: 'raw_close',
    adjusted: false,
    fallback: configuredRealtimeDataset ? 'latest_eod_snapshot' : null,
    realtime_failure: configuredRealtimeDataset
      ? realtimeFailure || options.realtimeFailure || null
      : null,
  };
}

async function tushareSessionBoundQuote(adapter, ticker, market, session, now = Date.now) {
  if (!session || !isoDatePattern.test(String(session.date || ''))) {
    throw new Error('verified_session_unavailable');
  }
  const quote = await tusharePortfolioQuote(adapter, ticker, market, now, {
    verifiedSessionDate: session.date,
    requireFreshRealtime: session.intraday === true,
  });
  if (quote.quote_mode === 'realtime') {
    if (session.intraday && session.date === session.currentDate &&
        quote.date === session.currentDate) {
      return { ...quote, session_verified: true, verified_session_date: session.date };
    }
    const eod = await tusharePortfolioQuote(adapter, ticker, market, now, {
      skipRealtime: true,
      realtimeFailure: 'realtime_outside_current_verified_session',
    });
    return { ...eod, session_verified: true, verified_session_date: session.date };
  }
  return { ...quote, session_verified: true, verified_session_date: session.date };
}

async function usPortfolioQuote(adapter, ticker, session, now = Date.now, options = {}) {
  if (!session || !isoDatePattern.test(String(session.date || ''))) {
    throw new Error('us_verified_session_unavailable');
  }
  if (session.intraday) {
    try {
      const quote = await yahooUsCounterQuote(ticker, now, { fetch: options.fetch });
      if (quote.date !== session.date || session.date !== session.currentDate) {
        throw new Error('yahoo_counter_session_mismatch');
      }
      return {
        ...quote,
        session_verified: true,
        verified_session_date: session.date,
      };
    } catch (cause) {
      const error = new Error('us_intraday_counter_unavailable');
      error.code = 'US_INTRADAY_COUNTER_UNAVAILABLE';
      error.cause = String(cause && (cause.code || cause.message) || 'yahoo_counter_unavailable');
      throw error;
    }
  }
  // Weekends, holidays, premarket and after-close never reuse Yahoo's stale
  // last-trade value as realtime. Only the raw EOD row for the verified
  // session is eligible, otherwise the valuation fails closed.
  const eod = await tusharePortfolioQuote(adapter, ticker, 'us', now);
  if (eod.date !== session.date || eod.price_basis !== 'raw_close' || eod.adjusted !== false) {
    throw new Error('us_eod_session_mismatch');
  }
  return {
    ...eod,
    quote_mode: 'eod_fallback',
    fallback: 'latest_eod_snapshot',
    realtime_failure: 'outside_current_regular_session',
    session_verified: true,
    verified_session_date: session.date,
  };
}

async function fetchBenchmarkSet(set, env, options = {}) {
  const cfg = BM_SETS[set]; if (!cfg) return null;
  const adapter = options.adapter || createTushareAdapter(env, options);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const data = {}, sources = {}, sourceMeta = {};
  await Promise.all(cfg.map(async b => {
    try {
      const result = await tushareSeries(adapter, b.tushare, now);
      data[b.label] = result.series;
      sources[b.label] = result.source;
      sourceMeta[b.label] = {
        source: result.source,
        source_endpoint: result.source_endpoint,
        as_of: result.as_of,
        fetched_at: result.fetched_at,
        freshness_class: result.freshness_class,
        stale: false,
      };
    } catch (e) {}
  }));
  return Object.keys(data).length ? { data, sources, sourceMeta } : null;
}
async function prewarmBenchmark(env, sets, options = {}) {
  return Promise.all((sets || ['us', 'hk', 'a']).map(async set => {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const ranAt = new Date(now()).toISOString(), cacheKey = 'bmset:' + set, statusKey = 'bmstatus:' + set;
    let fresh = null, error = null;
    try { fresh = await fetchBenchmarkSet(set, env, options); } catch (e) { error = 'tushare_unavailable'; }
    const oldRaw = await env.YC_KV.get(cacheKey);
    const old = oldRaw ? JSON.parse(oldRaw) : null;
    const config = BM_SETS[set];
    const expected = config.map(x => x.label);
    const data = {}, sources = {}, sourceMeta = {};
    config.forEach(item => {
      const label = item.label;
      const oldIsTushare = benchmarkLabelIsTushare(
        old,
        label,
        item.tushare.dataset,
      );
      if (fresh && fresh.data[label]) {
        data[label] = mergeBenchmarkSeries(
          oldIsTushare ? old.data[label] : [],
          fresh.data[label],
        );
        sources[label] = fresh.sources[label];
        sourceMeta[label] = fresh.sourceMeta[label];
      }
      else if (oldIsTushare) {
        data[label] = old.data[label];
        if (old.sources && old.sources[label]) sources[label] = old.sources[label];
        const previousMeta = old.source_meta && old.source_meta[label] || {};
        sourceMeta[label] = {
          ...previousMeta,
          source: previousMeta.source || old.sources && old.sources[label] || 'persisted-snapshot',
          as_of: previousMeta.as_of || old.as_of || null,
          fetched_at: previousMeta.fetched_at || old.fetched || null,
          freshness_class: previousMeta.freshness_class || 'eod',
          stale: true,
          fallback_reason: 'latest_tushare_request_failed',
          last_attempt_at: ranAt,
        };
      }
    });
    const refreshed = expected.filter(label => fresh && fresh.data[label]);
    const missing = expected.filter(label => !(fresh && fresh.data[label]));
    const unavailable = expected.filter(label => !data[label]);
    const status = {
      ok: unavailable.length === 0, set, ranAt, refreshed, missing, unavailable,
      stale: missing.length > 0, error, sources, source_meta: sourceMeta,
    };
    if (Object.keys(data).length) {
      const asOf = maxText(Object.values(sourceMeta).map(meta => meta.as_of));
      const payload = {
        ok: true, set, data, sources, source_meta: sourceMeta,
        source: 'tushare',
        as_of: asOf,
        freshness_class: 'eod',
        freshness: {
          class: 'eod',
          stale: missing.length > 0,
          fallback: missing.length > 0 ? 'last_successful_snapshot' : null,
        },
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
function buildEntryMarketPoints(navRows, benchmarkRows) {
  const navByDate = new Map();
  (Array.isArray(navRows) ? navRows : []).forEach(row => {
    const date = String(row && row.date || '').slice(0, 10);
    const nav = Number(row && (row.unitNav ?? row.nav));
    const dividend = Number(row && row.divPerUnit || 0);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && isFinite(nav) && nav > 0 && isFinite(dividend)) {
      navByDate.set(date, { date, nav, dividend });
    }
  });
  const nav = [...navByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (nav.length < 20) return null;
  let value = 100;
  const portfolio = new Map([[nav[0].date, value]]);
  for (let index = 1; index < nav.length; index += 1) {
    const current = nav[index], previous = nav[index - 1];
    const dailyReturn = (current.nav + current.dividend) / previous.nav - 1;
    if (!isFinite(dailyReturn) || dailyReturn <= -1) continue;
    value *= 1 + dailyReturn;
    portfolio.set(current.date, value);
  }
  const benchmark = new Map();
  (Array.isArray(benchmarkRows) ? benchmarkRows : []).forEach(row => {
    const date = String(row && row.date || '').slice(0, 10), close = Number(row && row.close);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && isFinite(close) && close > 0) benchmark.set(date, close);
  });
  const dates = [...portfolio.keys()].filter(date => benchmark.has(date)).sort();
  if (dates.length < 20) return null;
  const firstNavDate = nav[0].date;
  const lastNavDate = nav[nav.length - 1].date;
  const benchmarkTradingDates = [...benchmark.keys()]
    .filter(date => date >= firstNavDate && date <= lastNavDate)
    .sort();
  const missingCloseCount = benchmarkTradingDates.reduce(
    (count, date) => count + (portfolio.has(date) ? 0 : 1),
    0,
  );
  const portfolioBase = portfolio.get(dates[0]);
  const benchmarkBase = benchmark.get(dates[0]);
  const points = dates.map(date => [
    date,
    round(portfolio.get(date) / portfolioBase * 100, 6),
    round(benchmark.get(date) / benchmarkBase * 100, 6),
  ]);
  return {
    points,
    start: dates[0],
    end: dates[dates.length - 1],
    missingCloseCount,
    coverage: dates.length / Math.max(1, benchmarkTradingDates.length),
  };
}
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
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
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
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
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
  const sourceMeta = live.sourceMeta || {
    source: 'ledger',
    source_endpoint: 'portfolio-ledger',
    as_of: asOf,
    fetched_at: led.savedAt || live.updatedAt || null,
    freshness_class: 'disclosure',
  };
  const snapshotId = 'portfolio-' + contentHash(JSON.stringify({
    portfolio: led.portfolio,
    end,
    navRows,
    holdings: holdings.map(row => [
      row.t || row.ticker, row.q || row.qty, row.price, row.marketValue || row.mv, row.date,
    ]),
  }));

  return {
    ok: true, enabled: true, portfolio: led.portfolio, currency: led.currency,
    ledgerRevision: Number(led.ledgerRevision ?? live.ledgerRevision ??
      (status && status.ledgerRevision) ?? 0),
    snapshot_id: snapshotId,
    source: sourceMeta.source,
    source_endpoint: sourceMeta.source_endpoint,
    as_of: sourceMeta.as_of || asOf,
    fetched_at: sourceMeta.fetched_at || live.updatedAt || led.savedAt || null,
    freshness_class: sourceMeta.freshness_class || 'eod',
    freshness: {
      class: sourceMeta.freshness_class || 'eod',
      stale: false,
      fallback: null,
    },
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
    status: status || null, cacheVersion: 3,
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

async function restorePortfolioCacheWrites(env, pf, previous, published) {
  const entries = [
    ['live:' + pf, previous.live, JSON.stringify(published.live)],
    ['navstatus:' + pf, previous.status, JSON.stringify(published.status)],
    ['navcache:' + pf, previous.cache, JSON.stringify(published.cache)],
  ];
  await Promise.all(entries.map(async ([key, priorValue, publishedValue]) => {
    const currentValue = await env.YC_KV.get(key);
    if (currentValue !== publishedValue) return;
    if (priorValue == null) {
      if (typeof env.YC_KV.delete === 'function') await env.YC_KV.delete(key);
      return;
    }
    await env.YC_KV.put(key, priorValue);
  }));
}

async function writePortfolioAttempt(env, pf, status) {
  await env.YC_KV.put('navstatus:' + pf, JSON.stringify(status));
  return status;
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const HISTORICAL_NAV_DEFAULT_BATCH_SIZE = 20;
const HISTORICAL_NAV_MAX_BATCH_SIZE = 50;
const compactIsoDate = value => String(value || '').slice(0, 10).replaceAll('-', '');
const addIsoDays = (value, days) => {
  const time = Date.parse(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  return new Date(time + days * 86400000).toISOString().slice(0, 10);
};
const eventEffectiveDate = event => String(event && (event.trade_date || event.date) || '').slice(0, 10);
const eventKind = event => String(event && (event.event_type || event.type) || '').trim().toUpperCase();

function portfolioHistoricalTickers(events) {
  const tickers = new Set();
  for (const event of events || []) {
    const type = eventKind(event);
    const ticker = String(event.ticker || '').trim().toUpperCase();
    if (type === 'BUY' && Number(event.quantity ?? event.qty ?? event.shares ?? 0) > 0 && ticker) {
      tickers.add(ticker);
    }
    if (type === 'CORPORATE_ACTION') {
      if (ticker) tickers.add(ticker);
      const outputs = Array.isArray(event.outputs) ? event.outputs : [];
      for (const output of outputs) {
        const value = String(output && (output.ticker || output.symbol) || '').trim().toUpperCase();
        if (value) tickers.add(value);
      }
    }
  }
  return [...tickers].sort();
}

function portfolioTickerFirstHoldingDates(events) {
  const dates = new Map();
  const remember = (ticker, date) => {
    const normalized = String(ticker || '').trim().toUpperCase();
    if (!normalized || !isoDatePattern.test(date)) return;
    if (!dates.has(normalized) || date < dates.get(normalized)) dates.set(normalized, date);
  };
  for (const event of events || []) {
    const type = eventKind(event);
    const date = eventEffectiveDate(event);
    if (type === 'BUY' && Number(event.quantity ?? event.qty ?? event.shares ?? 0) > 0) {
      remember(event.ticker, date);
    }
    if (type === 'CORPORATE_ACTION') {
      remember(event.ticker, date);
      for (const output of Array.isArray(event.outputs) ? event.outputs : []) {
        remember(output && (output.ticker || output.symbol), date);
      }
    }
  }
  return dates;
}

async function tusharePortfolioHistory(adapter, ticker, market, startDate, endDate, nowFn = Date.now) {
  const dataset = portfolioDataset(market);
  if (!dataset) throw new Error('portfolio_market_unsupported');
  const result = await adapter.query(dataset, {
    params: {
      ts_code: tusharePortfolioSymbol(ticker, market),
      start_date: compactIsoDate(startDate),
      end_date: compactIsoDate(endDate),
    },
    fields: 'ts_code,trade_date,close',
  });
  return {
    ticker,
    rows: (Array.isArray(result.data) ? result.data : [])
      .map(row => ({
        ticker,
        date: isoTradeDate(row.trade_date),
        price: Number(row.close),
        close: Number(row.close),
        source: `tushare:${dataset}`,
        sourceRef: `${dataset}:close:raw-unadjusted`,
        valuation: { priceBasis: 'raw_close', adjusted: false },
        fetchedAt: result.fetched_at || result.retrieved_at || new Date(nowFn()).toISOString(),
      }))
      .filter(row => row.date && Number.isFinite(row.price) && row.price > 0)
      .sort((left, right) => left.date.localeCompare(right.date)),
  };
}

async function tusharePortfolioCalendarTape(
  adapter,
  market,
  startDate,
  endDate,
  nowValue = Date.now(),
) {
  const request = {
    // Tushare's us_daily coverage does not publish SPY. AAPL is the provider's
    // documented liquid US example and gives the independent raw-EOD
    // watermark needed before a session can enter the immutable price tape.
    us: { dataset: 'us_tradecal', watermarkDataset: 'us_daily', watermarkTicker: 'AAPL' },
    hk: { dataset: 'hk_tradecal', watermarkDataset: 'index_global', watermarkTicker: 'HSI' },
    a: {
      dataset: 'trade_cal', exchange: 'SSE',
      watermarkDataset: 'index_daily', watermarkTicker: '000300.SH',
    },
  }[market];
  if (!request) throw new Error('portfolio_market_unsupported');
  const result = await adapter.query(request.dataset, {
    params: {
      ...(request.exchange ? { exchange: request.exchange } : {}),
      start_date: compactIsoDate(startDate),
      end_date: compactIsoDate(endDate),
    },
    fields: 'cal_date,is_open',
  });
  const rows = (Array.isArray(result.data) ? result.data : [])
    .map(row => ({
      date: isoTradeDate(row.cal_date),
      isOpen: Number(row.is_open) === 1,
    }))
    .filter(row => row.date && row.date >= startDate && row.date <= endDate);
  const observedDates = new Set(rows.map(row => row.date));
  for (let date = startDate; date <= endDate; date = addIsoDays(date, 1)) {
    if (!observedDates.has(date)) {
      const error = new Error(`portfolio_calendar_tape_incomplete:${date}`);
      error.code = 'HISTORICAL_NAV_CALENDAR_UNAVAILABLE';
      throw error;
    }
  }
  const dates = [...new Set(rows.filter(row => row.isOpen).map(row => row.date))].sort();
  const watermarkResult = await adapter.query(request.watermarkDataset, {
    params: {
      ts_code: request.watermarkTicker,
      start_date: compactIsoDate(addIsoDays(startDate, -14)),
      end_date: compactIsoDate(endDate),
    },
    fields: 'ts_code,trade_date,close',
  });
  const watermark = (Array.isArray(watermarkResult.data) ? watermarkResult.data : [])
    .map(row => isoTradeDate(row.trade_date))
    .filter(date => date && date <= endDate)
    .sort()
    .at(-1) || null;
  const localToday = portfolioMarketDate(nowValue, market);
  // The current market date is not an EOD session until the raw-close
  // watermark reaches it. During trading hours, keep it out of the immutable
  // historical tape and let the separate counter-price path value today.
  // A watermark gap strictly before the market's current date is still a
  // missing completed session and must fail closed.
  const unavailableCompletedSession = dates.find(date =>
    date < localToday && (!watermark || date > watermark)) || null;
  if (unavailableCompletedSession) {
    const error = new Error(`portfolio_eod_watermark_incomplete:${unavailableCompletedSession}`);
    error.code = 'HISTORICAL_NAV_CALENDAR_UNAVAILABLE';
    throw error;
  }
  const completedDates = watermark ? dates.filter(date => date <= watermark) : [];
  return {
    dates: [...new Set(completedDates)].sort(),
    source: `tushare:${request.dataset}+${request.watermarkDataset}`,
    sourceRef: `${request.dataset}:is_open+${request.watermarkDataset}:${request.watermarkTicker}:eod-watermark`,
  };
}

async function tusharePortfolioCalendar(adapter, market, startDate, endDate) {
  const request = {
    us: { dataset: 'us_daily', tsCode: 'AAPL' },
    hk: { dataset: 'index_global', tsCode: 'HSI' },
    a: { dataset: 'index_daily', tsCode: '000300.SH' },
  }[market];
  if (!request) throw new Error('portfolio_market_unsupported');
  const result = await adapter.query(request.dataset, {
    params: {
      ts_code: request.tsCode,
      start_date: compactIsoDate(startDate),
      end_date: compactIsoDate(endDate),
    },
    fields: 'ts_code,trade_date,close',
  });
  return [...new Set((Array.isArray(result.data) ? result.data : [])
    .map(row => isoTradeDate(row.trade_date))
    .filter(date => date && date >= startDate && date <= endDate))].sort();
}

async function tusharePortfolioCalendarQuote(adapter, market, nowFn = Date.now) {
  const endDate = portfolioMarketDate(nowFn(), market);
  const dates = await tusharePortfolioCalendar(adapter, market, addIsoDays(endDate, -14), endDate);
  const date = dates.at(-1);
  if (!date) throw new Error('portfolio_calendar_quote_unavailable');
  const endpoint = market === 'us' ? 'us_daily' : market === 'hk' ? 'index_global' : 'index_daily';
  return {
    date,
    close: 1,
    source: `tushare:${endpoint}`,
    source_endpoint: endpoint,
    fetched_at: new Date(nowFn()).toISOString(),
    freshness_class: 'eod',
    quote_mode: 'calendar',
    fallback: null,
  };
}

function priceAsOf(rows, date) {
  let value = null;
  for (const row of rows || []) {
    if (row.date > date) break;
    value = row;
  }
  return value;
}

function fundCashOnDate(events, date) {
  let adjustment = 0;
  let dividend = 0;
  for (const event of events || []) {
    if (eventKind(event) !== 'FUND_ACTION' || eventEffectiveDate(event) !== date) continue;
    const cash = Number(event.cash_amount ?? event.cash_change ?? event.net_cash ?? event.net_amount ?? 0);
    if (!Number.isFinite(cash) || cash >= 0) continue;
    adjustment += cash;
    const type = String(event.action_type || event.fund_action_type || '').toUpperCase();
    if (!type.includes('FEE') && !type.includes('管理')) dividend += -cash;
  }
  return { adjustment, dividend };
}

function corporateActionReplayPrices(events, priceMap) {
  const selected = new Map();
  const add = row => {
    if (row) selected.set(`${row.ticker}:${row.date}`, row);
  };
  for (const event of events || []) {
    if (eventKind(event) !== 'CORPORATE_ACTION') continue;
    const start = eventEffectiveDate(event);
    const end = addIsoDays(start, 7);
    const sourceTicker = String(event.ticker || '').toUpperCase();
    add(priceAsOf(priceMap.get(sourceTicker) || [], addIsoDays(start, -1)));
    for (const output of Array.isArray(event.outputs) ? event.outputs : []) {
      const ticker = String(output.ticker || '').toUpperCase();
      add((priceMap.get(ticker) || []).find(item => item.date >= start && item.date <= end));
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.date.localeCompare(right.date) || left.ticker.localeCompare(right.ticker));
}

function historicalNavBatchSize(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return HISTORICAL_NAV_DEFAULT_BATCH_SIZE;
  return Math.min(HISTORICAL_NAV_MAX_BATCH_SIZE, parsed);
}

async function materializedHistoricalReplayTarget(
  env,
  portfolio,
  market,
  events,
  affectedFrom,
  materializedThrough,
  navRows,
  ledgerRevision,
) {
  const rows = (Array.isArray(navRows) ? navRows : [])
    .filter(row => row && isoDatePattern.test(String(row.date || '').slice(0, 10)))
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
  if (!rows.length || rows.some(row => Number(row.ledgerRevision) !== ledgerRevision)) return null;
  const eventDates = (Array.isArray(events) ? events : [])
    .map(eventEffectiveDate).filter(date => isoDatePattern.test(date)).sort();
  if (!eventDates.length) return null;
  let tape;
  try {
    tape = await loadFrozenLedgerPriceTape(env, portfolio, ledgerRevision, {
      tapeFrom: eventDates[0],
      tapeThrough: materializedThrough,
      calendarFrom: eventDates[0],
      requiredTickers: portfolioHistoricalTickers(events),
      priceSource: `tushare:${portfolioDataset(market)}`,
    });
  } catch {
    return null;
  }
  if (!tape) return null;
  const tradingDays = tape.calendarDates;
  const targetThrough = tradingDays.at(-1) || null;
  if (!targetThrough || rows.at(-1).date !== targetThrough) return null;
  const replayDays = tradingDays.filter(date => date >= affectedFrom && date <= targetThrough);
  const rebuiltDates = rows
    .map(row => String(row.date).slice(0, 10))
    .filter(date => date >= affectedFrom && date <= targetThrough);
  if (rebuiltDates.length !== replayDays.length ||
      rebuiltDates.some((date, index) => date !== replayDays[index])) {
    return null;
  }
  return { targetThrough, priceTapeId: tape.priceTapeId };
}

function materializedReplayRangeCurrent(navRows, affectedFrom, targetThrough, ledgerRevision) {
  const rows = (Array.isArray(navRows) ? navRows : []).filter(row => {
    const date = String(row && row.date || '').slice(0, 10);
    return date >= affectedFrom && date <= targetThrough;
  });
  return rows.some(row => String(row.date).slice(0, 10) === targetThrough) &&
    rows.every(row => Number(row.ledgerRevision) === ledgerRevision &&
      row.recalculationRequired !== true);
}

function historicalReplayMissingSession(
  tradingDays,
  affectedFrom,
  targetThrough,
  navRows,
  ledgerRevision,
) {
  const replayDays = (Array.isArray(tradingDays) ? tradingDays : [])
    .filter(date => date >= affectedFrom && date <= targetThrough);
  if (!replayDays.length || replayDays.at(-1) !== targetThrough) {
    throw new Error('historical_nav_coverage_calendar_incomplete');
  }
  const currentRows = new Map((Array.isArray(navRows) ? navRows : []).map(row => [row.date, row]));
  const missingIndex = replayDays.findIndex(date => {
    const row = currentRows.get(date);
    return !row || Number(row.ledgerRevision) !== ledgerRevision ||
      row.recalculationRequired === true;
  });
  if (missingIndex < 0) return null;
  const missingDate = replayDays[missingIndex];
  const priorRows = (Array.isArray(navRows) ? navRows : [])
    .filter(row => row && row.date < missingDate)
    .sort((left, right) => left.date.localeCompare(right.date));
  const prior = priorRows.at(-1) || null;
  const priorUnitNav = prior ? Number(prior.unitNav ?? prior.nav) : 0;
  return {
    missingDate,
    lastNavDate: prior && prior.date || addIsoDays(missingDate, -1),
    lastUnitNav: Number.isFinite(priorUnitNav) ? priorUnitNav : 0,
  };
}

export async function rebuildPortfolioNavHistory(env, pf, led, options = {}) {
  const market = led.market || pf;
  const nowFn = typeof options.now === 'function' ? options.now : Date.now;
  const adapter = options.adapter || createTushareAdapter(env, options);
  const ledgerRevision = Number(options.ledgerRevision ?? led.ledgerRevision);
  const phase = String(options.phase || 'replay').toLowerCase();
  const prepareTapeOnly = options.prepareTapeOnly === true;
  if (!['replay', 'materialize', 'publish'].includes(phase)) {
    throw new Error('historical_nav_replay_phase_invalid');
  }
  if (prepareTapeOnly && phase !== 'replay') {
    throw new Error('historical_nav_price_tape_prepare_phase_invalid');
  }
  const events = Array.isArray(led.confirmedEvents) ? led.confirmedEvents : [];
  if (!events.length || !Number.isInteger(ledgerRevision) || ledgerRevision < 0) {
    throw new Error('historical_nav_replay_inputs_missing');
  }
  const eventDates = events.map(eventEffectiveDate).filter(date => isoDatePattern.test(date)).sort();
  const historyStart = eventDates[0];
  const tickers = portfolioHistoricalTickers(events);
  const priceSource = `tushare:${portfolioDataset(market)}`;
  const priorFrozenTape = ledgerRevision > 0
    ? await loadPriorFrozenLedgerPriceTape(env, pf, ledgerRevision)
    : null;
  // A brand-new ledger whose first event is after the prior revision's EOD
  // still needs a valid child tape before today's counter row can be written.
  // In that no-overlap case retain the parent's tape/calendar start; replay
  // itself remains bounded by affectedFrom, so no pre-event NAV is invented.
  const noEventOverlapWithParent = priorFrozenTape && historyStart > priorFrozenTape.tapeThrough;
  const priceTapeFrom = noEventOverlapWithParent ? priorFrozenTape.tapeFrom : historyStart;
  const priceCalendarFrom = noEventOverlapWithParent
    ? priorFrozenTape.calendarFrom
    : historyStart;
  const affectedFrom = String(options.affectedFrom || eventDates[0] || '').slice(0, 10);
  if (!isoDatePattern.test(affectedFrom)) throw new Error('historical_nav_replay_start_invalid');
  const cursor = String(options.cursor || '').slice(0, 10);
  if (phase === 'replay' && cursor && (!isoDatePattern.test(cursor) || cursor < affectedFrom)) {
    throw new Error('historical_nav_replay_cursor_invalid');
  }
  const requestedFrom = phase === 'replay' ? cursor || affectedFrom : affectedFrom;
  const dirtyDates = Array.isArray(options.dirtyNavDates) ? options.dirtyNavDates : [];
  const marketToday = portfolioMarketDate(nowFn(), market);
  const existingLast = (Array.isArray(led.navRows) ? led.navRows : [])
    .map(row => String(row.date || '').slice(0, 10)).filter(date => isoDatePattern.test(date)).sort().at(-1);
  const calculatedEndTarget = [marketToday, existingLast, ...dirtyDates].filter(Boolean).sort().at(-1);
  const frozenTarget = String(options.targetThrough || '').slice(0, 10);
  if (frozenTarget && !isoDatePattern.test(frozenTarget)) {
    throw new Error('historical_nav_replay_target_invalid');
  }
  const endTarget = frozenTarget || calculatedEndTarget;
  if (!isoDatePattern.test(endTarget) ||
      (phase === 'replay' && !prepareTapeOnly && requestedFrom > endTarget)) {
    throw new Error('historical_nav_replay_range_invalid');
  }
  if (phase !== 'replay' && !frozenTarget) {
    throw new Error('historical_nav_replay_target_required');
  }
  const phaseLastNavDate = String(options.lastNavDate || endTarget).slice(0, 10);
  const phaseLastUnitNav = Number(options.previousUnitNav);
  if (phase !== 'replay' && (!isoDatePattern.test(phaseLastNavDate) ||
      !Number.isFinite(phaseLastUnitNav))) {
    throw new Error('historical_nav_replay_checkpoint_invalid');
  }
  if (phase === 'replay' && cursor && (!isoDatePattern.test(phaseLastNavDate) ||
      phaseLastNavDate >= cursor || !Number.isFinite(phaseLastUnitNav))) {
    throw new Error('historical_nav_replay_checkpoint_invalid');
  }
  const requireFrozenTape = async targetThrough => {
    const tape = await loadFrozenLedgerPriceTape(env, pf, ledgerRevision, {
      tapeFrom: priceTapeFrom,
      tapeThrough: targetThrough,
      calendarFrom: priceCalendarFrom,
      requiredTickers: tickers,
      priceSource,
    });
    if (!tape) {
      const error = new Error('historical_nav_price_tape_unavailable');
      error.code = 'HISTORICAL_NAV_PRICE_TAPE_UNAVAILABLE';
      throw error;
    }
    return tape;
  };
  if (phase === 'materialize') {
    const tape = await requireFrozenTape(endTarget);
    const freshLedger = await materializeLedgerKv(env, pf, {
      expectedLedgerRevision: ledgerRevision,
    });
    const freshNavRows = Array.isArray(freshLedger.navRows) ? freshLedger.navRows : [];
    const freshLast = freshNavRows.length ? freshNavRows.at(-1) : null;
    const freshTarget = freshNavRows.find(row => row.date === endTarget);
    const missingSession = historicalReplayMissingSession(
      tape.calendarDates,
      affectedFrom,
      endTarget,
      freshNavRows,
      ledgerRevision,
    );
    if (missingSession) {
      return {
        pf,
        ranAt: new Date(nowFn()).toISOString(),
        source: 'tushare',
        freshness_class: 'eod',
        historicalReplay: true,
        complete: false,
        phase: 'materialize',
        nextPhase: 'replay',
        ledgerRevision,
        rebuiltFrom: affectedFrom,
        batchFrom: null,
        batchThrough: null,
        appended: freshLast && freshLast.date || null,
        as_of: freshLast && freshLast.date || null,
        targetThrough: endTarget,
        nextCursor: missingSession.missingDate,
        lastNavDate: missingSession.lastNavDate,
        lastUnitNav: missingSession.lastUnitNav,
        navRows: 0,
        priceRows: 0,
        priceTapeId: tape.priceTapeId,
        priceTapeRows: tape.priceRows.length,
        unavailable: [],
        calendarFallback: false,
        fallback: false,
        coverageRestartFrom: missingSession.missingDate,
      };
    }
    if (!freshLast || !freshTarget || !materializedReplayRangeCurrent(
      freshNavRows,
      affectedFrom,
      endTarget,
      ledgerRevision,
    ) || freshLast.date !== endTarget ||
        freshNavRows.some(row => row.recalculationRequired === true)) {
      throw new Error('historical_nav_materialization_incomplete');
    }
    return {
      pf,
      ranAt: new Date(nowFn()).toISOString(),
      source: 'tushare',
      freshness_class: 'eod',
      historicalReplay: true,
      complete: false,
      phase: 'materialize',
      nextPhase: 'publish',
      ledgerRevision,
      rebuiltFrom: affectedFrom,
      batchFrom: null,
      batchThrough: null,
      appended: freshLast.date,
      as_of: freshLast.date,
      targetThrough: endTarget,
      nextCursor: null,
      lastNavDate: freshTarget.date,
      lastUnitNav: Number(freshTarget.unitNav ?? freshTarget.nav),
      navRows: 0,
      priceRows: 0,
      priceTapeId: tape.priceTapeId,
      priceTapeRows: tape.priceRows.length,
      unavailable: [],
      calendarFallback: false,
      fallback: false,
    };
  }
  if (phase === 'publish') {
    const tape = await requireFrozenTape(endTarget);
    const materializedRows = Array.isArray(led.navRows) ? led.navRows : [];
    const materializedLast = materializedRows.length ? materializedRows.at(-1) : null;
    if (Number(led.ledgerRevision) !== ledgerRevision) {
      const error = new Error('historical_nav_publish_revision_changed');
      error.code = 'LEDGER_REVISION_CHANGED';
      throw error;
    }
    if (!materializedLast || materializedLast.date !== endTarget ||
        materializedRows.some(row => row.recalculationRequired === true) ||
        !materializedReplayRangeCurrent(
      materializedRows,
      affectedFrom,
      endTarget,
      ledgerRevision,
    )) {
      throw new Error('historical_nav_publish_materialization_missing');
    }
    if (historicalReplayMissingSession(
      tape.calendarDates,
      affectedFrom,
      endTarget,
      materializedRows,
      ledgerRevision,
    )) {
      throw new Error('historical_nav_publish_calendar_coverage_missing');
    }
    const publishedThrough = materializedLast.date;
    const live = {
      rows: [],
      holdings: led.sourceHoldings || [],
      updatedAt: new Date(nowFn()).toISOString(),
      marketDate: publishedThrough,
      ledgerRevision,
      sourceMeta: {
        source: 'tushare',
        source_endpoint: 'historical-nav-replay:raw-close',
        as_of: publishedThrough,
        fetched_at: new Date(nowFn()).toISOString(),
        freshness_class: 'eod',
        price_basis: 'raw_close',
        adjusted: false,
        price_tape_id: tape.priceTapeId,
      },
    };
    const status = {
      pf,
      ranAt: new Date(nowFn()).toISOString(),
      source: 'tushare',
      freshness_class: 'eod',
      historicalReplay: true,
      complete: true,
      phase: 'publish',
      nextPhase: null,
      ledgerRevision,
      rebuiltFrom: affectedFrom,
      batchFrom: null,
      batchThrough: null,
      appended: publishedThrough,
      as_of: publishedThrough,
      targetThrough: endTarget,
      nextCursor: null,
      lastNavDate: materializedLast.date,
      lastUnitNav: Number(materializedLast.unitNav ?? materializedLast.nav),
      navRows: materializedRows.length,
      priceRows: 0,
      priceTapeId: tape.priceTapeId,
      priceTapeRows: tape.priceRows.length,
      unavailable: [],
      calendarFallback: false,
      fallback: false,
    };
    const [previousLive, previousStatus, previousCache] = await Promise.all([
      env.YC_KV.get('live:' + pf),
      env.YC_KV.get('navstatus:' + pf),
      env.YC_KV.get('navcache:' + pf),
    ]);
    await assertLedgerRevision(env, pf, ledgerRevision);
    const publishedCache = await persistPortfolioCache(env, pf, led, live, status);
    try {
      await assertLedgerRevision(env, pf, ledgerRevision);
    } catch (error) {
      await restorePortfolioCacheWrites(env, pf, {
        live: previousLive,
        status: previousStatus,
        cache: previousCache,
      }, {
        live,
        status,
        cache: publishedCache,
      }).catch(() => {});
      throw error;
    }
    return status;
  }
  let tape = await loadFrozenLedgerPriceTape(env, pf, ledgerRevision, {
    tapeFrom: priceTapeFrom,
    ...(frozenTarget ? { tapeThrough: frozenTarget } : {}),
    calendarFrom: priceCalendarFrom,
    requiredTickers: tickers,
    priceSource,
  });
  if (tape && tape.tapeThrough > endTarget) {
    const error = new Error('historical_nav_price_tape_target_invalid');
    error.code = 'HISTORICAL_NAV_PRICE_TAPE_INVALID';
    throw error;
  }
  if (tape && !cursor && !frozenTarget && tape.tapeThrough < endTarget) {
    let calendarExtension;
    const extensionFrom = addIsoDays(tape.tapeThrough, 1);
    try {
      calendarExtension = await tusharePortfolioCalendarTape(
        adapter,
        market,
        extensionFrom,
        endTarget,
        nowFn(),
      );
    } catch (cause) {
      const error = new Error('historical_nav_calendar_extension_unavailable');
      error.code = 'HISTORICAL_NAV_CALENDAR_UNAVAILABLE';
      error.cause = cause;
      throw error;
    }
    if (calendarExtension.dates.length) {
      const extensionThrough = calendarExtension.dates.at(-1);
      const fetchedExtension = await Promise.all(tickers.map(async ticker => {
        try {
          const result = await tusharePortfolioHistory(
            adapter,
            ticker,
            market,
            addIsoDays(tape.tapeThrough, 1),
            extensionThrough,
            nowFn,
          );
          // A sold/delisted or temporarily suspended ticker can legitimately
          // have no new counter print. Its previously frozen raw close remains
          // available to priceAsOf; active holdings still fail below if no
          // as-of price exists in the combined tape.
          return result;
        } catch (error) {
          return {
            ticker,
            rows: [],
            error: String(error && (error.code || error.message) || 'unavailable'),
          };
        }
      }));
      const unavailableExtension = fetchedExtension
        .filter(item => item.error).map(item => item.ticker);
      if (unavailableExtension.length) {
        const error = new Error(
          `historical_nav_price_history_extension_unavailable:${unavailableExtension.join(',')}`,
        );
        error.code = 'HISTORICAL_NAV_PRICE_HISTORY_UNAVAILABLE';
        throw error;
      }
      tape = await extendLedgerPriceTape(env, pf, {
        priceTapeId: tape.priceTapeId,
        expectedPriceTapeHash: tape.priceTapeHash,
        requiredTickers: tickers,
        priceSource,
        calendarDates: calendarExtension.dates,
        calendarSource: calendarExtension.source,
        calendarSourceRef: calendarExtension.sourceRef,
        priceRows: fetchedExtension.flatMap(item => item.rows),
      }, ledgerRevision);
    }
  }
  if (!tape && !cursor && (!frozenTarget || prepareTapeOnly)) {
    const priorTape = priorFrozenTape;
    // Every later revision inherits the immediately preceding frozen tape.
    // The overlap may be empty when the new ledger begins later, but the
    // parent lineage is still mandatory so a revision can never silently
    // switch historical price truth.
    const parentTape = priorTape;
    if (parentTape) {
      const tickerFirstDates = portfolioTickerFirstHoldingDates(events);
      const commonTickers = new Set(
        tickers.filter(ticker => parentTape.requiredTickers.includes(ticker)),
      );
      const newTickers = tickers.filter(ticker => !commonTickers.has(ticker));
      if (endTarget < parentTape.tapeThrough) {
        const error = new Error('historical_nav_parent_tape_newer_than_target');
        error.code = 'HISTORICAL_NAV_PRICE_TAPE_PARENT_REQUIRED';
        throw error;
      }
      const inheritedThrough = parentTape.tapeThrough;
      const calendarDates = parentTape.calendarDates
        .filter(date => date >= priceCalendarFrom && date <= inheritedThrough);
      const inheritedRows = parentTape.priceRows
        .filter(row => commonTickers.has(row.ticker) && row.date >= priceTapeFrom &&
          row.date <= inheritedThrough);
      const calendarSegments = [];
      if (priceCalendarFrom < parentTape.calendarFrom) {
        calendarSegments.push({
          from: priceCalendarFrom,
          through: addIsoDays(parentTape.calendarFrom, -1),
          kind: 'prefix',
        });
      }
      if (endTarget > parentTape.tapeThrough) {
        const futureFrom = historyStart > addIsoDays(parentTape.tapeThrough, 1)
          ? historyStart
          : addIsoDays(parentTape.tapeThrough, 1);
        calendarSegments.push({
          from: futureFrom,
          through: endTarget,
          kind: 'future',
        });
      }
      const segmentTapes = [];
      for (const segment of calendarSegments) {
        try {
          const segmentTape = await tusharePortfolioCalendarTape(
            adapter,
            market,
            segment.from,
            segment.through,
            nowFn(),
          );
          if (segmentTape.source !== parentTape.calendarSource ||
              segmentTape.sourceRef !== parentTape.calendarSourceRef) {
            const error = new Error('historical_nav_parent_calendar_source_changed');
            error.code = 'HISTORICAL_NAV_PRICE_TAPE_IMMUTABLE_CONFLICT';
            throw error;
          }
          segmentTapes.push({ ...segment, tape: segmentTape });
          calendarDates.push(...segmentTape.dates);
        } catch (cause) {
          const error = new Error(`historical_nav_inherited_calendar_${segment.kind}_unavailable`);
          error.code = cause && cause.code || 'HISTORICAL_NAV_CALENDAR_UNAVAILABLE';
          error.cause = cause;
          throw error;
        }
      }
      const combinedCalendarDates = [...new Set(calendarDates)].sort();
      const targetThrough = combinedCalendarDates.at(-1);
      if (!targetThrough) {
        const error = new Error('historical_nav_inherited_calendar_empty');
        error.code = 'HISTORICAL_NAV_CALENDAR_UNAVAILABLE';
        throw error;
      }

      const fetchPlans = [];
      for (const ticker of newTickers) {
        const firstHoldingDate = tickerFirstDates.get(ticker) || historyStart;
        if (firstHoldingDate > targetThrough) continue;
        fetchPlans.push({
          ticker,
          from: firstHoldingDate,
          through: targetThrough,
          requireRows: true,
        });
      }
      for (const ticker of commonTickers) {
        for (const segment of segmentTapes) {
          const segmentThrough = segment.tape.dates.at(-1);
          if (!segmentThrough) continue;
          fetchPlans.push({
            ticker,
            from: segment.from,
            through: segmentThrough,
            requireRows: false,
          });
        }
      }
      const fetchedSegments = await Promise.all(fetchPlans.map(async plan => {
        try {
          const result = await tusharePortfolioHistory(
            adapter,
            plan.ticker,
            market,
            plan.from,
            plan.through,
            nowFn,
          );
          return { ...plan, rows: result.rows, error: plan.requireRows && !result.rows.length };
        } catch (error) {
          return {
            ...plan,
            rows: [],
            error: String(error && (error.code || error.message) || 'unavailable'),
          };
        }
      }));
      const unavailable = fetchedSegments.filter(item => item.error).map(item => item.ticker);
      if (unavailable.length) {
        const error = new Error(
          `historical_nav_inherited_price_history_unavailable:${[...new Set(unavailable)].sort().join(',')}`,
        );
        error.code = 'HISTORICAL_NAV_PRICE_HISTORY_UNAVAILABLE';
        throw error;
      }
      const combinedRowsByKey = new Map();
      for (const row of [...inheritedRows, ...fetchedSegments.flatMap(item => item.rows)]) {
        if (row.date > targetThrough || !tickers.includes(row.ticker)) continue;
        combinedRowsByKey.set(`${row.ticker}:${row.date}`, row);
      }
      tape = await freezeLedgerPriceTape(env, pf, {
        tapeFrom: priceTapeFrom,
        tapeThrough: targetThrough,
        calendarFrom: priceCalendarFrom,
        calendarDates: combinedCalendarDates.filter(date => date <= targetThrough),
        calendarSource: parentTape.calendarSource,
        calendarSourceRef: parentTape.calendarSourceRef,
        parentPriceTapeId: parentTape.priceTapeId,
        inheritedThrough,
        requiredTickers: tickers,
        priceSource,
        priceBasis: 'raw_close',
        adjusted: false,
        priceRows: [...combinedRowsByKey.values()],
      }, ledgerRevision);
    }
  }
  if (!tape && (cursor || frozenTarget) && !prepareTapeOnly) {
    const error = new Error('historical_nav_frozen_price_tape_missing');
    error.code = 'HISTORICAL_NAV_PRICE_TAPE_UNAVAILABLE';
    throw error;
  }
  if (!tape) {
    let calendarTape;
    try {
      calendarTape = await tusharePortfolioCalendarTape(
        adapter,
        market,
        priceCalendarFrom,
        endTarget,
        nowFn(),
      );
    } catch (cause) {
      const causeCode = String(cause && cause.code || 'CALENDAR_QUERY_FAILED')
        .replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 96);
      const causeMessage = String(cause && cause.message || 'calendar query failed')
        .replace(/[\r\n\t]+/g, ' ').slice(0, 300);
      const error = new Error(
        `historical_nav_calendar_unavailable:${causeCode}:${causeMessage}`,
      );
      error.code = 'HISTORICAL_NAV_CALENDAR_UNAVAILABLE';
      error.cause = cause;
      throw error;
    }
    const targetThrough = calendarTape.dates.at(-1);
    if (!targetThrough) {
      const error = new Error('historical_nav_calendar_empty');
      error.code = 'HISTORICAL_NAV_CALENDAR_UNAVAILABLE';
      throw error;
    }
    const tickerFirstDates = portfolioTickerFirstHoldingDates(events);
    const fetched = await Promise.all(tickers.map(async ticker => {
      const firstHoldingDate = tickerFirstDates.get(ticker) || historyStart;
      if (firstHoldingDate > targetThrough) {
        return { ticker, rows: [], futureHolding: true };
      }
      try {
        const result = await tusharePortfolioHistory(
          adapter,
          ticker,
          market,
          firstHoldingDate,
          targetThrough,
          nowFn,
        );
        return result.rows.length
          ? result
          : { ...result, error: 'empty_raw_close_rows' };
      } catch (error) {
        return {
          ticker,
          rows: [],
          error: String(error && (error.code || error.message) || 'unavailable'),
        };
      }
    }));
    const unavailableHistory = fetched.filter(item => item.error).map(item => item.ticker);
    if (unavailableHistory.length) {
      const error = new Error(`historical_nav_price_history_unavailable:${unavailableHistory.join(',')}`);
      error.code = 'HISTORICAL_NAV_PRICE_HISTORY_UNAVAILABLE';
      throw error;
    }
    tape = await freezeLedgerPriceTape(env, pf, {
      tapeFrom: priceTapeFrom,
      tapeThrough: targetThrough,
      calendarFrom: priceCalendarFrom,
      calendarDates: calendarTape.dates,
      calendarSource: calendarTape.source,
      calendarSourceRef: calendarTape.sourceRef,
      requiredTickers: tickers,
      priceSource,
      priceBasis: 'raw_close',
      adjusted: false,
      priceRows: fetched.flatMap(item => item.rows),
    }, ledgerRevision);
  }
  const targetThrough = tape.tapeThrough;
  if (prepareTapeOnly) {
    return {
      pf,
      ranAt: new Date(nowFn()).toISOString(),
      source: 'tushare',
      freshness_class: 'eod',
      historicalReplay: true,
      complete: true,
      phase: 'prepare-tape',
      nextPhase: null,
      ledgerRevision,
      rebuiltFrom: affectedFrom,
      appended: null,
      as_of: targetThrough,
      targetThrough,
      priceTapeId: tape.priceTapeId,
      priceTapeRows: tape.priceRows.length,
      preparedTapeOnly: true,
      adjusted: false,
      priceBasis: 'raw_close',
      fallback: false,
    };
  }
  const tradingDays = tape.calendarDates.filter(date => date >= affectedFrom);
  const priceMap = new Map(tickers.map(ticker => [
    ticker,
    tape.priceRows.filter(row => row.ticker === ticker),
  ]));
  const remainingTradingDays = cursor
    ? tradingDays.filter(date => date > phaseLastNavDate)
    : tradingDays;
  if (!remainingTradingDays.length) throw new Error('historical_nav_trading_days_empty');
  const batchSize = historicalNavBatchSize(options.batchSize);
  const batchDays = remainingTradingDays.slice(0, batchSize);
  const batchFrom = batchDays[0];
  const batchThrough = batchDays.at(-1);
  const nextCursor = remainingTradingDays[batchSize] || null;
  const complete = nextCursor == null;
  const replayPrices = corporateActionReplayPrices(events, priceMap);
  const currency = { us: 'USD', hk: 'HKD', a: 'CNY' }[pf];
  const navRows = [];
  const checkpointUnitNav = Number(options.previousUnitNav);
  let previousUnitNav = Number.isFinite(checkpointUnitNav) ? checkpointUnitNav : null;
  const priorRows = (Array.isArray(led.navRows) ? led.navRows : [])
    .filter(row => row && row.date < batchFrom)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (previousUnitNav == null && priorRows.length) {
    previousUnitNav = Number(priorRows.at(-1).unitNav ?? priorRows.at(-1).nav);
  }
  const orderedEvents = [...events].sort((left, right) =>
    eventEffectiveDate(left).localeCompare(eventEffectiveDate(right)));
  const cutoffEvents = [];
  let eventIndex = 0;
  for (const date of batchDays) {
    while (eventIndex < orderedEvents.length && eventEffectiveDate(orderedEvents[eventIndex]) <= date) {
      cutoffEvents.push(orderedEvents[eventIndex]);
      eventIndex += 1;
    }
    const projection = replayPortfolioLedger(cutoffEvents, {
      portfolio: pf,
      currency,
      include_pending: false,
      corporate_action_prices: replayPrices,
      as_of_date: date,
    });
    let marketValue = 0;
    const missing = [];
    for (const position of projection.positions || []) {
      const quantity = Number(position.quantity || 0);
      if (!(quantity > 1e-12)) continue;
      const quote = priceAsOf(priceMap.get(position.ticker) || [], date);
      if (!quote) missing.push(position.ticker);
      else marketValue += quantity * quote.price;
    }
    if (missing.length) {
      const error = new Error(
        `historical_nav_price_tape_gap:${date}:${[...new Set(missing)].sort().join(',')}`,
      );
      error.code = 'HISTORICAL_NAV_PRICE_TAPE_GAP';
      throw error;
    }
    const cash = Number(projection.cash && projection.cash.amount || 0);
    const liability = Number(projection.liability && projection.liability.amount || 0);
    const units = Number(projection.units && projection.units.total || 0);
    const totalAssets = cash + marketValue;
    const netValue = totalAssets - liability;
    const unitNav = units > 0 ? netValue / units : 0;
    const fund = fundCashOnDate(cutoffEvents, date);
    const divPerUnit = units > 0 ? fund.dividend / units : 0;
    const dailyReturn = previousUnitNav > 0
      ? (unitNav + divPerUnit) / previousUnitNav - 1
      : null;
    const warnings = [];
    if (Number.isFinite(dailyReturn) && Math.abs(dailyReturn) > 0.10) {
      warnings.push({ code: 'NAV_CHANGE_WARNING', return: dailyReturn });
    }
    navRows.push({
      date,
      currency,
      cash,
      market_value: marketValue,
      total_assets: totalAssets,
      liability,
      liability_asset_ratio: totalAssets > 0 ? liability / totalAssets : 0,
      net_value: netValue,
      units,
      unit_nav: unitNav,
      fund_action_adjustment: fund.adjustment,
      sourceRef: 'python-parity-historical-replay:raw-close',
      valuation: {
        source: 'tushare',
        calendar: market === 'us' ? 'AAPL' : market === 'hk' ? 'HSI' : '000300.SH',
        calendarFallback: false,
        priceBasis: 'raw_close',
        adjusted: false,
        priceTapeId: tape.priceTapeId,
        as_of: date,
      },
      warnings,
    });
    previousUnitNav = unitNav;
  }
  await persistLedgerValuationBatch(env, pf, {
    replaceFrom: batchFrom,
    replaceThrough: batchThrough,
    pruneAfter: complete,
    navRows,
    priceRows: [],
  }, ledgerRevision);
  const baseStatus = {
    pf,
    ranAt: new Date(nowFn()).toISOString(),
    source: 'tushare',
    freshness_class: 'eod',
    historicalReplay: true,
    complete: false,
    phase: 'replay',
    nextPhase: complete ? 'materialize' : 'replay',
    ledgerRevision,
    rebuiltFrom: affectedFrom,
    batchFrom,
    batchThrough,
    appended: batchThrough,
    as_of: batchThrough,
    targetThrough,
    nextCursor,
    lastNavDate: batchThrough,
    lastUnitNav: previousUnitNav,
    navRows: navRows.length,
    priceRows: 0,
    priceTapeId: tape.priceTapeId,
    priceTapeRows: tape.priceRows.length,
    unavailable: [],
    calendarFallback: false,
    fallback: false,
  };
  return baseStatus;
}

function publicPortfolioSnapshot(cache, latestStatus) {
  const latestFailed = latestStatus && latestStatus.fallback === true;
  const source = cache.source || cache.source_endpoint || 'persisted-snapshot';
  const asOf = cache.as_of || cache.asOf || cache.marketDate || cache.end || null;
  const fetchedAt = cache.fetched_at || cache.updatedAt || null;
  const freshnessClass = cache.freshness_class || 'eod';
  return {
    ...cache,
    source,
    as_of: asOf,
    fetched_at: fetchedAt,
    freshness_class: freshnessClass,
    freshness: {
      class: freshnessClass,
      stale: latestFailed || cache.freshness && cache.freshness.stale === true,
      fallback: latestFailed ? 'last_successful_snapshot' : cache.freshness && cache.freshness.fallback || null,
      last_attempt_at: latestStatus && latestStatus.ranAt || null,
      reason: latestFailed ? latestStatus.reason || 'latest_tushare_request_failed' : null,
    },
    fallback: latestFailed,
    status: latestStatus || cache.status || null,
  };
}

async function publicPortfolioLedgerRevision(env, portfolio) {
  if (!env || !(env.LEDGER_DB || env.FEEDBACK_DB)) return undefined;
  try {
    const state = await portfolioDerivationState(env, portfolio);
    return state.derivedWorkPending ? null : state.ledgerRevision;
  } catch {
    return null;
  }
}

function portfolioCacheMatchesRevision(cache, ledgerRevision) {
  if (ledgerRevision === undefined) return true;
  if (!Number.isInteger(ledgerRevision)) return false;
  const rawRevision = cache && (cache.ledgerRevision ??
    (cache.status && cache.status.ledgerRevision));
  if (rawRevision == null) return ledgerRevision === 0;
  return Number(rawRevision) === ledgerRevision;
}

/* 持倉/現金/負債/份額為唯一營運基準；Tushare 日線是唯一自動估值源。 */
async function updatePortfolioNav(env, pf, options = {}) {
  const nowFn = typeof options.now === 'function' ? options.now : Date.now;
  const now = new Date(nowFn());
  const st = {
    pf,
    ranAt: now.toISOString(),
    source: 'tushare',
    freshness_class: 'eod',
  };
  const affectedFrom = String(options.affectedFrom || '').slice(0, 10);
  const continuationRequested = Boolean(options.phase) || isoDatePattern.test(affectedFrom);
  const ledRaw = await env.YC_KV.get('ledger:' + pf);
  const cachedLedger = ledRaw ? JSON.parse(ledRaw) : null;
  let led = cachedLedger;
  if (continuationRequested && (env.LEDGER_DB || env.FEEDBACK_DB)) {
    // Confirm necessarily advances D1 before KV. A continuation must therefore
    // derive from current-revision D1 facts; the previous KV may contribute
    // presentation-only metadata but never events, cash, positions or units.
    const replayInput = await loadLedgerReplayInput(env, pf, options.ledgerRevision);
    led = cachedLedger && portfolioCacheMatchesRevision(cachedLedger, replayInput.ledgerRevision)
      ? {
        ...cachedLedger,
        ...replayInput,
        sourceMetrics: cachedLedger.sourceMetrics || {},
        snap: cachedLedger.snap || null,
      }
      : replayInput;
  }
  if (!led) {
    st.skip = 'no-ledger';
    await Promise.all([
      env.YC_KV.put('navstatus:' + pf, JSON.stringify(st)),
      env.YC_KV.put('navcache:' + pf, JSON.stringify({
        ok: true,
        enabled: false,
        portfolio: pf,
        history: [],
        rows: [],
        holdings: [],
        status: st,
        source: 'portfolio-ledger',
        as_of: null,
        fetched_at: null,
        freshness_class: 'eod',
        freshness: { class: 'eod', stale: true, fallback: null },
        cacheVersion: 3,
      })),
    ]);
    return st;
  }
  const market = led.market || pf;
  if (!continuationRequested && (env.LEDGER_DB || env.FEEDBACK_DB)) {
    let derivation;
    try {
      derivation = await portfolioDerivationState(env, pf);
    } catch {
      return writePortfolioAttempt(env, pf, {
        ...st,
        skip: 'ledger-derivation-state-unavailable',
        reason: 'ledger_derivation_state_unavailable',
        fallback: true,
      });
    }
    st.ledgerRevision = derivation.ledgerRevision;
    if (derivation.derivedWorkPending) {
      return writePortfolioAttempt(env, pf, {
        ...st,
        skip: 'ledger-derived-work-pending',
        reason: 'drain_ledger_outbox_to_resume',
        pendingCount: derivation.pendingCount,
        fallback: true,
      });
    }
    if (Number(led.ledgerRevision) !== derivation.ledgerRevision) {
      return writePortfolioAttempt(env, pf, {
        ...st,
        skip: 'ledger-kv-revision-mismatch',
        reason: 'rebuild_ledger_kv_before_nav_refresh',
        fallback: true,
      });
    }
  }
  const liveRaw = await env.YC_KV.get('live:' + pf);
  let live = liveRaw ? JSON.parse(liveRaw) : { rows: [] };
  const lastPxRaw = await env.YC_KV.get('lastpx:' + pf), lastPx = lastPxRaw ? JSON.parse(lastPxRaw) : {};
  const adapter = options.adapter || createTushareAdapter(env, options);
  const ledgerRevision = Number(options.ledgerRevision ?? led.ledgerRevision);
  if (live && live.ledgerRevision != null && Number(live.ledgerRevision) !== ledgerRevision) {
    live = { rows: [], holdings: [], ledgerRevision };
  }
  st.ledgerRevision = ledgerRevision;
  const dirtyNavDates = Array.isArray(led.navRecalculationRequired)
    ? led.navRecalculationRequired
    : [];
  const historicalReplayRequested = isoDatePattern.test(affectedFrom) &&
    (!led.lastDate || affectedFrom <= led.lastDate);
  const marketToday = portfolioMarketDate(nowFn(), led.market || pf);
  const recentCorporateActionDates = (Array.isArray(led.corporateActionPricePending)
    ? led.corporateActionPricePending : []).filter(date =>
    isoDatePattern.test(date) && date <= marketToday && marketToday <= addIsoDays(date, 7));
  if (dirtyNavDates.length || historicalReplayRequested || recentCorporateActionDates.length) {
    if (!isoDatePattern.test(affectedFrom) && !options.phase) {
      return writePortfolioAttempt(env, pf, {
        ...st,
        skip: 'historical-replay-requires-outbox-continuation',
        reason: 'drain_ledger_outbox_to_resume',
        fallback: true,
      });
    }
    const replayFrom = [affectedFrom, dirtyNavDates[0], recentCorporateActionDates[0]]
      .filter(date => isoDatePattern.test(date)).sort()[0];
    const materializedRows = Array.isArray(led.navRows) ? led.navRows : [];
    const materializedLast = materializedRows.length ? materializedRows.at(-1) : null;
    const recoverPublishedTarget = !options.phase && historicalReplayRequested &&
      dirtyNavDates.length === 0 && recentCorporateActionDates.length === 0 &&
      Number(led.ledgerRevision) === ledgerRevision && materializedLast
      ? await materializedHistoricalReplayTarget(
        env,
        pf,
        market,
        led.confirmedEvents,
        replayFrom,
        materializedLast.date,
        materializedRows,
        ledgerRevision,
      )
      : null;
    return rebuildPortfolioNavHistory(env, pf, led, {
      ...options,
      adapter,
      ledgerRevision,
      affectedFrom: replayFrom,
      dirtyNavDates,
      ...(recoverPublishedTarget ? {
        phase: 'publish',
        targetThrough: recoverPublishedTarget.targetThrough,
        lastNavDate: materializedLast.date,
        previousUnitNav: Number(materializedLast.unitNav ?? materializedLast.nav),
      } : {}),
    });
  }

  if (continuationRequested && ledgerRevision > 0 &&
      (env.LEDGER_DB || env.FEEDBACK_DB)) {
    let currentTape = await loadFrozenLedgerPriceTape(env, pf, ledgerRevision);
    if (!currentTape) {
      const priorTape = await loadPriorFrozenLedgerPriceTape(env, pf, ledgerRevision);
      if (!priorTape) {
        return writePortfolioAttempt(env, pf, {
          ...st,
          skip: 'current-revision-parent-tape-unavailable',
          reason: 'historical_raw_close_rebuild_required_before_realtime',
          fallback: true,
        });
      }
      await rebuildPortfolioNavHistory(env, pf, led, {
        ...options,
        phase: 'replay',
        cursor: null,
        targetThrough: priorTape.tapeThrough,
        affectedFrom: isoDatePattern.test(affectedFrom) ? affectedFrom : led.sourceDate,
        prepareTapeOnly: true,
        adapter,
        ledgerRevision,
      });
      currentTape = await loadFrozenLedgerPriceTape(env, pf, ledgerRevision);
      if (!currentTape) {
        throw new Error('current_revision_raw_tape_bootstrap_incomplete');
      }
    }
  }
  const activePositions = (Array.isArray(led.positions) ? led.positions : [])
    .filter(position => position && position.t && Number(position.q) > 1e-12);
  // Every live holding quote is bound to an independent official market
  // calendar. Missing session truth fails the whole refresh.
  const verifiedSession = await tusharePortfolioVerifiedSession(adapter, market, nowFn)
    .catch(() => null);
  if (!verifiedSession) {
    return writePortfolioAttempt(env, pf, {
      ...st,
      skip: 'valuation-session-unavailable',
      reason: 'latest_tushare_request_failed',
      failure_code: 'verified_market_session_unavailable',
      unavailable: activePositions.map(position => position.t),
      fallback: true,
    });
  }
  const fetched = await Promise.all(activePositions.map(async p => ({
    p,
    q: await (market === 'us'
      ? usPortfolioQuote(adapter, p.t, verifiedSession, nowFn, { fetch: options.fetch })
      : tushareSessionBoundQuote(adapter, p.t, market, verifiedSession, nowFn))
      .catch(() => null),
  })));
  const unavailable = fetched.filter(item => !item.q).map(item => item.p.t);
  // A live valuation is all-or-nothing. Each active holding must have a quote
  // obtained by this refresh (realtime, or tusharePortfolioQuote's matching
  // raw EOD fallback). Never value a missing holding from D1/KV lastPx or the
  // ledger's reference/book price.
  if (unavailable.length) {
    return writePortfolioAttempt(env, pf, {
      ...st,
      skip: 'valuation-price-unavailable',
      reason: 'latest_tushare_request_failed',
      failure_code: 'active_holding_quote_unavailable',
      unavailable,
      fallback: true,
    });
  }
  const calendarQuote = fetched.length ? null : {
    date: verifiedSession.date,
    close: 1,
    source: verifiedSession.source,
    source_endpoint: verifiedSession.source_endpoint,
    fetched_at: verifiedSession.fetched_at || now.toISOString(),
    freshness_class: verifiedSession.intraday ? 'intraday_snapshot' : 'eod',
    quote_mode: 'verified_session_cash_only',
    price_basis: 'cash_only',
    adjusted: false,
    session_verified: true,
    verified_session_date: verifiedSession.date,
    fallback: null,
  };
  const holdingQuoteDates = fetched.map(item => String(item.q && item.q.date || '').slice(0, 10));
  const distinctHoldingDates = [...new Set(holdingQuoteDates)].sort();
  if (fetched.length && (distinctHoldingDates.length !== 1 ||
      !isoDatePattern.test(distinctHoldingDates[0]))) {
    return writePortfolioAttempt(env, pf, {
      ...st,
      skip: 'valuation-date-mismatch',
      reason: 'active_holding_quote_dates_mixed',
      failure_code: 'active_holding_quote_dates_mixed',
      quote_dates: fetched.map((item, index) => ({
        ticker: item.p.t,
        date: holdingQuoteDates[index] || null,
      })),
      fallback: true,
    });
  }
  if (fetched.length && verifiedSession && distinctHoldingDates[0] !== verifiedSession.date) {
    return writePortfolioAttempt(env, pf, {
      ...st,
      skip: 'valuation-session-mismatch',
      reason: 'active_holding_quote_session_mismatch',
      failure_code: 'active_holding_quote_session_mismatch',
      verified_session_date: verifiedSession.date,
      quote_dates: fetched.map((item, index) => ({
        ticker: item.p.t,
        date: holdingQuoteDates[index] || null,
      })),
      fallback: true,
    });
  }
  const valuationQuotes = fetched.length
    ? fetched.map(item => item.q)
    : calendarQuote ? [calendarQuote] : [];
  const marketDate = fetched.length
    ? distinctHoldingDates[0]
    : calendarQuote && calendarQuote.date;
  if (!marketDate || !isoDatePattern.test(marketDate)) {
    return writePortfolioAttempt(env, pf, {
      ...st,
      skip: 'latest-source-unavailable',
      reason: 'latest_tushare_request_failed',
      fallback: true,
    });
  }
  if (isoDatePattern.test(affectedFrom) && marketDate < affectedFrom) {
    return writePortfolioAttempt(env, pf, {
      ...st,
      skip: 'valuation-session-precedes-confirmed-event',
      reason: 'verified_market_session_has_not_reached_event_date',
      eventDate: affectedFrom,
      marketDate,
      fallback: true,
    });
  }
  const pricingFreshness = valuationQuotes.every(quote =>
    quote.freshness_class === 'intraday_snapshot')
    ? 'intraday_snapshot'
    : 'eod';
  const pricingFallback = valuationQuotes.some(quote =>
    quote.fallback === 'latest_eod_snapshot');
  const valuationSource = [...new Set(valuationQuotes.map(quote => quote.source).filter(Boolean))]
    .join(',') || 'portfolio-ledger';
  const priceBases = [...new Set(fetched.map(item => item.q.price_basis).filter(Boolean))];
  const valuationPriceBasis = fetched.length
    ? priceBases.length === 1 ? priceBases[0] : 'mixed_raw_counter_raw_close'
    : 'cash_only';
  const quoteAudit = fetched.map(item => ({
    ticker: item.p.t,
    date: item.q.date,
    source: item.q.source,
    sourceEndpoint: item.q.source_endpoint,
    quoteMode: item.q.quote_mode,
    priceBasis: item.q.price_basis,
    adjusted: false,
    sessionVerified: item.q.session_verified === true,
  }));
  Object.assign(st, {
    source: valuationSource,
    freshness_class: pricingFreshness,
    source_endpoint: [...new Set(valuationQuotes.map(quote => quote.source_endpoint))].join(','),
    pricing_fallback: pricingFallback ? 'latest_eod_snapshot' : null,
    priceBasis: valuationPriceBasis,
    adjusted: false,
    quoteDate: marketDate,
  });
  const lastDate = live.rows.length ? live.rows[live.rows.length - 1].date : led.lastDate;
  if (lastDate && marketDate < lastDate) {
    st.skip = 'latest-source-older-than-ledger:' + lastDate; st.marketDate = marketDate;
    st.as_of = marketDate;
    st.fallback = true;
    st.reason = 'latest_realtime_unavailable_eod_not_newer';
    return writePortfolioAttempt(env, pf, st);
  }
  // Counter prices overwrite the current session on every realtime refresh.
  // Once every holding has the same official raw EOD date, that close is also
  // allowed to replace the earlier intraday row for that same date.
  const sameDayRealtimeRefresh = marketDate === lastDate && marketDate === marketToday &&
    verifiedSession && verifiedSession.intraday && verifiedSession.date === marketToday &&
    fetched.some(item => item.q && item.q.quote_mode === 'realtime');
  const priorMarketRow = [
    ...(Array.isArray(led.navRows) ? led.navRows : []),
    ...(Array.isArray(live.rows) ? live.rows : []),
  ].filter(row => row && row.date === marketDate).at(-1) || null;
  const priorMarketFreshness = priorMarketRow && priorMarketRow.valuation &&
    priorMarketRow.valuation.freshness_class ||
    (live.marketDate === marketDate && live.sourceMeta && live.sourceMeta.freshness_class) || null;
  const sameDayOfficialEodRefresh = marketDate === lastDate && fetched.length > 0 &&
    priorMarketFreshness === 'intraday_snapshot' &&
    fetched.every(item => item.q && item.q.date === marketDate &&
      ['eod', 'eod_fallback'].includes(item.q.quote_mode) &&
      item.q.source_endpoint === portfolioDataset(market));
  const recalculateMarketDate = marketDate === lastDate &&
    (affectedFrom === marketDate || sameDayRealtimeRefresh || sameDayOfficialEodRefresh);
  if (lastDate && marketDate === lastDate && !recalculateMarketDate) {
    if (pricingFallback) {
      return writePortfolioAttempt(env, pf, {
        ...st,
        skip: 'already-updated:' + lastDate,
        marketDate,
        as_of: marketDate,
        fallback: true,
        reason: 'latest_realtime_unavailable_eod_not_newer',
      });
    }
    return writePortfolioAttempt(env, pf, {
      ...st,
      upToDate: marketDate,
      marketDate,
      as_of: marketDate,
      fallback: false,
      complete: true,
    });
  }
  if (!Number.isInteger(ledgerRevision) || ledgerRevision < 0) {
    return writePortfolioAttempt(env, pf, {
      ...st,
      skip: 'ledger-revision-missing',
      reason: 'd1_ledger_revision_required',
      fallback: true,
    });
  }
  if (recalculateMarketDate) {
    live.rows = (live.rows || []).filter(row => row.date !== marketDate);
  }

  const stale = [], holdings = [], exactMarketValues = [];
  for (const item of fetched) {
    const p = item.p;
    const q = item.q;
    lastPx[p.t] = q;
    if (q.date && q.date < marketDate) stale.push(p.t);
    const mv = Number(p.q) * Number(q.close);
    exactMarketValues.push(mv);
    const pnl = Number(p.pnl) + mv - Number(p.mv);
    holdings.push({
      t: p.t, n: p.n || p.t, q: Number(p.q), price: round(Number(q.close), 6),
      marketValue: round(mv, 2), date: q.date || marketDate,
      priceBasis: q.price_basis, adjusted: false,
      quoteSource: q.source, quoteSourceEndpoint: q.source_endpoint,
      quoteMode: q.quote_mode, sessionVerified: q.session_verified === true,
      buyCost: Number(p.buyCost) || 0, sellProceeds: Number(p.sellProceeds) || 0,
      dividend: Number(p.dividend) || 0, netCost: Number(p.netCost) || 0,
      pnl: round(pnl, 2),
      exposureReturn: Number(p.buyCost) ? round(pnl / Number(p.buyCost) * 100, 8) : null,
      weight: 0,
    });
  }
  // Python parity: sum exact quantity * raw counter price first. Per-position
  // rounding is display-only and must never feed NAV arithmetic.
  const marketValue = exactMarketValues.reduce((sum, value) => sum + value, 0);
  holdings.forEach((holding, index) => {
    holding.weight = marketValue
      ? round(exactMarketValues[index] / marketValue * 100, 6)
      : 0;
  });
  const cash = Number(led.cash) || 0, liability = Number(led.liability) || 0;
  const totalAssets = marketValue + cash, netValue = totalAssets - liability, units = Number(led.units) || 0;
  const previousRows = [
    ...(Array.isArray(led.navRows) ? led.navRows : []),
    ...(Array.isArray(live.rows) ? live.rows : []),
  ].filter(row => row && row.date < marketDate)
    .sort((left, right) => left.date.localeCompare(right.date));
  const prev = previousRows.length
    ? previousRows[previousRows.length - 1]
    : { netValue: led.baseNetValue || led.baseMV, unitNav: led.lastUnitNav };
  const unitNav = units > 0
    ? netValue / units
    : (prev.unitNav && prev.netValue ? prev.unitNav * netValue / prev.netValue : 0);
  const fundActionAdjustment = Number(led.fundActionAdjustments && led.fundActionAdjustments[marketDate]) || 0;
  const fundDividend = Number(led.fundDividends && led.fundDividends[marketDate]) || 0;
  const divPerUnit = units > 0 ? fundDividend / units : 0;
  const ret = prev.unitNav > 0 ? (unitNav + divPerUnit) / prev.unitNav - 1 : netValue / prev.netValue - 1;
  if (!isFinite(ret) || !isFinite(unitNav)) {
    return writePortfolioAttempt(env, pf, {
      ...st,
      skip: 'sanity-fail',
      reason: 'portfolio_nav_sanity_check_failed',
      fallback: true,
    });
  }
  const navWarnings = [];
  if (Math.abs(ret) > 0.10) {
    navWarnings.push({
      code: 'NAV_CHANGE_WARNING',
      severity: 'warning',
      return: ret,
      message: 'NAV per unit changed by more than 10%; Python parity keeps the result and warns.',
    });
  }
  const navRow = {
    date: marketDate, ret: round(ret, 10), unitNav: round(unitNav, 8), units: round(units, 6),
    marketValue: round(marketValue, 2), cash: round(cash, 2), liability: round(liability, 2),
    totalAssets: round(totalAssets, 2), netValue: round(netValue, 2), mv: round(netValue, 2),
    fundActionAdjustment: round(fundActionAdjustment, 2), divPerUnit: round(divPerUnit, 10),
    ledgerRevision,
  };
  live.holdings = holdings; live.updatedAt = now.toISOString(); live.marketDate = marketDate;
  live.sourceMeta = {
    source: valuationSource,
    source_endpoint: [...new Set(valuationQuotes.map(quote => quote.source_endpoint))].join(','),
    as_of: marketDate,
    fetched_at: maxText(valuationQuotes.map(quote => quote.fetched_at)) || now.toISOString(),
    freshness_class: pricingFreshness,
    priceBasis: valuationPriceBasis,
    adjusted: false,
    quoteDate: marketDate,
    sessionVerified: valuationQuotes.every(quote => quote.session_verified === true),
    quoteSources: quoteAudit,
  };
  live.note = stale.length ? 'stale:' + stale.join(',') : null;
  Object.assign(st, {
    appended: marketDate,
    as_of: marketDate,
    fetched_at: live.sourceMeta.fetched_at,
    marketValue: round(marketValue, 2),
    netValue: round(netValue, 2),
    stale,
    unavailable,
    fallback: false,
    complete: true,
  });
  await persistLedgerValuation(env, pf, {
    ...navRow,
    source: valuationSource,
    sourceRef: live.sourceMeta.source_endpoint,
    valuation: {
      source: valuationSource,
      source_endpoint: live.sourceMeta.source_endpoint,
      as_of: marketDate,
      fetched_at: live.sourceMeta.fetched_at,
      freshness_class: pricingFreshness,
      priceBasis: valuationPriceBasis,
      adjusted: false,
      quoteDate: marketDate,
      sessionVerified: valuationQuotes.every(quote => quote.session_verified === true),
      quoteSources: quoteAudit,
      stale_tickers: stale,
    },
    warnings: [
      ...(stale.length ? [{ code: 'STALE_PRICE', tickers: stale }] : []),
      ...navWarnings,
    ],
  }, fetched.filter(item => item.q && item.q.persist !== false).map(item => ({
    ticker: item.p.t,
    date: item.q.date || marketDate,
    close: item.q.close,
    source: item.q.source,
    source_endpoint: item.q.source_endpoint,
    valuation: {
      priceBasis: item.q.price_basis,
      adjusted: false,
      quoteDate: item.q.date,
      quoteSource: item.q.source,
      quoteSourceEndpoint: item.q.source_endpoint,
      quoteMode: item.q.quote_mode,
      sessionVerified: item.q.session_verified === true,
    },
  })), ledgerRevision);
  const freshLedger = await materializeLedgerKv(env, pf, {
    expectedLedgerRevision: ledgerRevision,
    currentDate: marketDate,
  });
  // D1 snapshots are the complete derived history. Keep KV live rows empty so
  // the same NAV date is never maintained in two independent stores.
  live.rows = [];
  live.ledgerRevision = ledgerRevision;
  await Promise.all([
    env.YC_KV.put('lastpx:' + pf, JSON.stringify(lastPx)),
    persistPortfolioCache(env, pf, freshLedger, live, st),
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

export {
  benchmarkSnapshotIsTushare,
  fetchBenchmarkSet,
  makePortfolioCache,
  portfolioDataset,
  portfolioRealtimeDataset,
  prewarmBenchmark,
  publicPortfolioSnapshot,
  tusharePortfolioQuote,
  tusharePortfolioVerifiedSession,
  tusharePortfolioSymbol,
  updatePortfolioNav,
  yahooUsCounterQuote,
};

export default {
  async fetch(request, env, ctx) {
    const J = (responseEnv, data, status = 200, extraHeaders = {}) =>
      baseJsonResponse(responseEnv, data, status, extraHeaders, request);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (request.method === 'OPTIONS') {
      const origin = normalizedCorsOrigin(request, env);
      if (!origin) return new Response(null, { status: 403, headers: { 'Vary': 'Origin' } });
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    try {
      const terminalResponse = await handleTushareTerminalRequest(request, env, {
        warehouse: createTerminalWarehouseAdapter(env),
      });
      if (terminalResponse) return terminalResponse;

      /* ════ 健康檢查：各配置是否被運行時讀到（只返回布爾）════ */
      if (path === '/api/health' && request.method === 'GET') {
        let kvOk = false, feedbackOk = false;
        try { await env.YC_KV.get('__ping__'); kvOk = true; } catch (e) {}
        try {
          if (env.FEEDBACK_DB) {
            const schema = await env.FEEDBACK_DB.prepare(`
              SELECT COUNT(*) AS count
              FROM sqlite_master
              WHERE type = 'table'
                AND name IN ('feedback_entries', 'feedback_changes', 'feedback_rate_limits')
            `).first();
            feedbackOk = Number(schema && schema.count || 0) === 3;
          }
        } catch (e) {}
        const [ledger, authSessions, authRateLimit] = await Promise.all([
          ledgerHealth(env),
          sessionStoreHealth(env),
          authRateLimitHealth(env),
        ]);
        return J(env, {
          ok: true, version: 'v9.1-d1-auth-sessions',
          kv: kvOk,
          feedback: feedbackOk,
          ledger: ledger.ready,
          ledger_outbox_pending: ledger.outboxPending,
          raw_nav_ready: ledger.rawNavReady,
          raw_nav_portfolios: ledger.rawNavPortfolios,
          auth_sessions: authSessions,
          auth_rate_limit: authRateLimit,
          feedback_rate_limit: !!env.FEEDBACK_RATE_SALT,
          tushare: !!env.TUSHARE_TOKEN,
          terminal_warehouse: !!env.YC_KV,
          admin: !!(env.ADMIN_USERNAME && env.ADMIN_PASSWORD),
          admin_google: false,
          github: !!(env.GH_TOKEN && env.GH_OWNER && env.GH_REPO),
          resend: !!env.RESEND_API_KEY,
          mail_from: !!env.MAIL_FROM,
          google: !!env.GOOGLE_CLIENT_ID,
          origin: !!env.ALLOWED_ORIGIN,
        }, 200, { 'Cache-Control': 'no-store' });
      }

      /* ════ 註冊：用戶名 + 密碼 + 郵箱 ════ */
      if (path === '/api/signup' && request.method === 'POST') {
        if (!await authRateAllowed(request, env, 'signup', 8, 3600)) return J(env, { error: '請求過於頻繁，請稍後再試' }, 429);
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
          const code = verificationCode();
          await env.YC_KV.put('pending:' + email, JSON.stringify({ u: username, email, salt, hash, code, tries: 0, newsletter }), { expirationTtl: 900 });
          if (!await sendCode(env, email, code)) { await env.YC_KV.delete('pending:' + email); return J(env, { error: '驗證郵件發送失敗，請稍後再試' }, 502); }
          return J(env, { ok: true, needCode: true, message: '驗證碼已發送至 ' + email });
        }
        await createUser(env, { u: username, email, salt, hash, provider: 'password', role: 'guest', disabled: false, newsletter, terms: true, termsAt: new Date().toISOString(), created: new Date().toISOString(), lastLogin: null });
        const token = await newSession(env, username, 'guest');
        await afterResponse(ctx, sendWelcome(env, email, username));
        return J(env, { ok: true, token, role: 'guest', username });
      }

      /* ════ 郵箱驗證碼確認 ════ */
      if (path === '/api/verify' && request.method === 'POST') {
        if (!await authRateAllowed(request, env, 'verify', 12, 900)) return J(env, { error: '請求過於頻繁，請稍後再試' }, 429);
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
        const token = await newSession(env, p.u, 'guest');
        await afterResponse(ctx, sendWelcome(env, p.email, p.u));
        return J(env, { ok: true, token, role: 'guest', username: p.u });
      }

      /* ════ 登入：用戶名或郵箱 + 密碼 ════ */
      if (path === '/api/login' && request.method === 'POST') {
        if (!await authRateAllowed(request, env, 'login', 30, 900)) return J(env, { error: '登入嘗試過多，請稍後再試' }, 429);
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

      /* ════ Google：只解析普通用戶；管理員僅允許用戶名 + 密碼 ════ */
      if (path === '/api/google' && request.method === 'POST') {
        if (!await authRateAllowed(request, env, 'google', 30, 900)) return J(env, { error: '登入嘗試過多，請稍後再試' }, 429);
        if (!env.GOOGLE_CLIENT_ID) return J(env, { error: '未配置 Google 登入' }, 501);
        const b = await request.json();
        const credential = b.credential;
        if (!credential) return J(env, { error: '缺少憑證' }, 400);
        let t;
        try {
          t = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID);
        } catch (error) {
          if (error instanceof GoogleJwksUnavailableError) {
            return J(env, {
              error: 'Google 身份驗證暫時不可用，請稍後再試',
              code: 'google_keys_unavailable',
            }, 503, { 'Retry-After': '5' });
          }
          if (error instanceof GoogleIdTokenInvalidError) {
            return J(env, { error: 'Google 憑證無效', code: 'google_credential_invalid' }, 401);
          }
          throw error;
        }
        const email = t.email;
        const mapped = await env.YC_KV.get('email:' + email);
        if (mapped) {
          const u = JSON.parse(await env.YC_KV.get('user:' + mapped) || 'null');
          if (!u) return J(env, { error: '帳號數據異常' }, 500);
          if (u.disabled) return J(env, { error: '此帳號已被停用' }, 403);
          if (u.googleSub && !safeEqual(String(u.googleSub), String(t.sub))) return J(env, { error: 'Google 身份與既有帳號不匹配' }, 409);
          u.googleSub = String(t.sub);
          u.lastLogin = new Date().toISOString();
          await env.YC_KV.put('user:' + mapped, JSON.stringify(u));
          const token = await newSession(env, mapped, 'guest');
          return J(env, { ok: true, token, role: 'guest', username: mapped });
        }
        if (b.autoCreate === true) {
          if (b.terms !== true) return J(env, { error: '必須同意服務條款才能註冊' }, 400);
          const username = await nextGoogleUsername(env, t);
          await createUser(env, {
            u: username, email, name: t.name || '', googleSub: String(t.sub),
            salt: null, hash: null, provider: 'google', role: 'guest', disabled: false,
            newsletter: b.newsletter === true, terms: true, termsAt: new Date().toISOString(),
            created: new Date().toISOString(), lastLogin: new Date().toISOString(),
          });
          const token = await newSession(env, username, 'guest');
          await afterResponse(ctx, sendWelcome(env, email, username));
          return J(env, { ok: true, token, role: 'guest', username });
        }
        // 新用戶 → 發放 15 分鐘設置票據，前端引導其設置用戶名+密碼
        const setupToken = randomHex(24);
        await env.YC_KV.put('gsetup:' + setupToken, JSON.stringify({ email, name: t.name || '', googleSub: String(t.sub) }), { expirationTtl: 900 });
        return J(env, { ok: true, needSetup: true, setupToken, email });
      }

      if (path === '/api/google/complete' && request.method === 'POST') {
        if (!await authRateAllowed(request, env, 'google-complete', 12, 900)) return J(env, { error: '請求過於頻繁，請稍後再試' }, 429);
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
        await createUser(env, { u: username, email: g.email, name: g.name, googleSub: g.googleSub || null, salt, hash, provider: 'google', role: 'guest', disabled: false, newsletter: b.newsletter === true, terms: true, termsAt: new Date().toISOString(), created: new Date().toISOString(), lastLogin: new Date().toISOString() });
        await env.YC_KV.delete(skey);
        const token = await newSession(env, username, 'guest');
        await afterResponse(ctx, sendWelcome(env, g.email, username));
        return J(env, { ok: true, token, role: 'guest', username });
      }

      /* ════ 基準行情：公開 GET 僅讀 Cron/手動刷新寫入的持久 KV 快照 ════ */
      if (path === '/api/benchmark' && request.method === 'GET') {
        const set = String(url.searchParams.get('set') || 'us').toLowerCase();
        if (!BM_SETS[set]) return J(env, { error: 'set 只支持 us/hk/a' }, 400);
        const cacheKey = 'bmset:' + set, cached = await env.YC_KV.get(cacheKey);
        if (cached) {
          const snapshot = JSON.parse(cached);
          if (!benchmarkSnapshotIsTushare(snapshot, set)) {
            const status = await env.YC_KV.get('bmstatus:' + set);
            return J(env, {
              ok: false, set, pending: true, data: {},
              status: status ? JSON.parse(status) : null,
              error: '基準快照來源不符合 Tushare 發布口徑，等待刷新',
            }, 503);
          }
          return J(env, {
            ...snapshot,
            source: snapshot.source || 'tushare',
            as_of: snapshot.as_of || maxText(Object.values(snapshot.data || {}).flat().map(row => row.date)),
            freshness_class: snapshot.freshness_class || 'eod',
            freshness: snapshot.freshness || {
              class: 'eod',
              stale: snapshot.stale === true,
              fallback: snapshot.stale === true ? 'last_successful_snapshot' : null,
            },
          });
        }
        const status = await env.YC_KV.get('bmstatus:' + set);
        return J(env, {
          ok: false, set, pending: true, data: {},
          status: status ? JSON.parse(status) : null,
          error: '基準快照尚未建立，請等待每日任務或由管理員手動刷新',
        }, 503);
      }

      /* ════ 登入首屏：返回三市場全部共同歷史的歸一化點，不暴露金額/持倉 ════ */
      if (path === '/api/entry-market' && request.method === 'GET') {
        const specs = {
          hk: { benchmark: 'HSI' },
          us: { benchmark: 'S&P 500' },
          a: { benchmark: 'HS300' },
        };
        const markets = {};
        await Promise.all(Object.entries(specs).map(async ([market, spec]) => {
          const [navRaw, benchmarkRaw, ledgerRevision] = await Promise.all([
            env.YC_KV.get('navcache:' + market),
            env.YC_KV.get('bmset:' + market),
            publicPortfolioLedgerRevision(env, market),
          ]);
          if (!navRaw || !benchmarkRaw) {
            markets[market] = null;
            return;
          }
          const nav = JSON.parse(navRaw);
          const benchmark = JSON.parse(benchmarkRaw);
          const benchmarkRows = benchmark.data && benchmark.data[spec.benchmark];
          if (!nav.ok || !nav.enabled || !Array.isArray(nav.navRows)
              || !portfolioCacheMatchesRevision(nav, ledgerRevision)
              || !benchmarkSnapshotIsTushare(benchmark, market)
              || !Array.isArray(benchmarkRows)) {
            markets[market] = null;
            return;
          }
          const history = buildEntryMarketPoints(nav.navRows, benchmarkRows);
          if (!history) {
            markets[market] = null;
            return;
          }
          const navReview = !!(
            nav.status && Array.isArray(nav.status.stale) && nav.status.stale.length
            || nav.status && Array.isArray(nav.status.missing) && nav.status.missing.length
          );
          const benchmarkReview = benchmark.stale === true
            || Array.isArray(benchmark.missing) && benchmark.missing.length > 0
            || Array.isArray(benchmark.unavailable) && benchmark.unavailable.length > 0;
          markets[market] = {
            formatVersion: 3,
            points: history.points,
            start: history.start,
            end: history.end,
            pointCount: history.points.length,
            historyComplete: nav.historyComplete === true,
            cacheVersion: 3,
            review: navReview || benchmarkReview || history.missingCloseCount > 0,
            missingCloseCount: history.missingCloseCount,
            coverage: round(history.coverage, 6),
            navAsOf: nav.asOf || nav.marketDate || null,
            navSource: nav.source || nav.source_endpoint || null,
            navFreshness: nav.freshness || null,
            benchmarkLabel: spec.benchmark,
            benchmarkSource: benchmark.sources && benchmark.sources[spec.benchmark] || null,
            benchmarkSourceMeta: benchmark.source_meta && benchmark.source_meta[spec.benchmark] || null,
            benchmarkStatus: {
              stale: benchmark.stale === true,
              fetched: benchmark.fetched || null,
            },
          };
        }));
        return J(env, {
          ok: Object.values(markets).some(Boolean),
          fetchedAt: new Date().toISOString(),
          markets,
        }, 200, { 'Cache-Control': 'public, max-age=120, stale-while-revalidate=300' });
      }

      /* ════ 會話 ════ */
      if (path === '/api/logout' && request.method === 'POST') {
        const match = String(request.headers.get('Authorization') || '')
          .match(/^Bearer\s+([a-f0-9]{64})$/i);
        if (match && !await revokeSession(env, match[1])) {
          return J(env, { error: '登出暫時未能完成，請重試' }, 503, {
            'Cache-Control': 'no-store',
            'Retry-After': '2',
          });
        }
        return J(env, { ok: true }, 200, { 'Cache-Control': 'no-store' });
      }
      const sess = await getSession(request, env);

      /* ════ 用戶意見：公開提交，登入可選；所有文字均視為不可信輸入 ════ */
      if (path === '/api/feedback' && request.method === 'POST') {
        if (!env.FEEDBACK_DB) return J(env, { error: '意見服務暫時不可用' }, 503);
        if (!env.FEEDBACK_RATE_SALT) return J(env, { error: '意見服務配置尚未完成' }, 503);
        if (!feedbackOriginAllowed(request, env)) return J(env, { error: '不允許的來源' }, 403);
        const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
        if (!contentType.startsWith('application/json')) {
          return J(env, { error: 'Content-Type 必須是 application/json' }, 415);
        }
        const declaredLength = Number(request.headers.get('Content-Length') || 0);
        if (declaredLength > 16 * 1024) return J(env, { error: '提交內容過大' }, 413);
        const rawBody = await request.text();
        if (enc.encode(rawBody).byteLength > 16 * 1024) return J(env, { error: '提交內容過大' }, 413);
        let b;
        try { b = JSON.parse(rawBody); } catch (e) { return J(env, { error: 'JSON 格式無效' }, 400); }
        if (!b || typeof b !== 'object' || Array.isArray(b)) return J(env, { error: '提交格式無效' }, 400);
        // Honeypot: bots receive a generic success without creating a record.
        if (cleanPlain(b.website, 200)) return J(env, { ok: true, id: null }, 200, { 'Cache-Control': 'no-store' });

        const submissionId = cleanPlain(b.submissionId, 80);
        if (!/^[a-z0-9][a-z0-9_-]{15,79}$/i.test(submissionId)) {
          return J(env, { error: 'submissionId 無效' }, 400);
        }
        const category = cleanPlain(b.category, 32);
        if (!FEEDBACK_CATEGORIES.has(category)) return J(env, { error: '意見類型無效' }, 400);
        const locale = cleanPlain(b.locale, 16);
        if (!FEEDBACK_LOCALES.has(locale)) return J(env, { error: '語言無效' }, 400);
        const message = cleanPlain(b.message, 2001);
        if (message.length < 5 || message.length > 2000) {
          return J(env, { error: '意見內容需要 5–2000 個字元' }, 400);
        }
        const pagePath = cleanPagePath(b.pagePath);
        if (!pagePath) return J(env, { error: '頁面路徑無效' }, 400);
        const ratingValue = b.rating == null || b.rating === '' ? null : Number(b.rating);
        if (ratingValue != null && (!Number.isInteger(ratingValue) || ratingValue < 1 || ratingValue > 5)) {
          return J(env, { error: '評分必須是 1–5' }, 400);
        }
        const releaseCandidate = cleanPlain(b.release, 64);
        const release = /^[a-zA-Z0-9._:-]{1,64}$/.test(releaseCandidate) ? releaseCandidate : '';
        const pageTitle = cleanPlain(b.pageTitle, 160);
        const diagnostics = b.diagnostics && typeof b.diagnostics === 'object' && !Array.isArray(b.diagnostics)
          ? b.diagnostics : {};
        const device = ['mobile', 'tablet', 'desktop'].includes(diagnostics.device)
          ? diagnostics.device : null;
        const browser = cleanPlain(diagnostics.browser, 40) || null;
        const viewportWidth = Number.isFinite(Number(diagnostics.viewportWidth))
          ? Math.max(0, Math.min(10000, Math.round(Number(diagnostics.viewportWidth)))) : null;
        const viewportHeight = Number.isFinite(Number(diagnostics.viewportHeight))
          ? Math.max(0, Math.min(10000, Math.round(Number(diagnostics.viewportHeight)))) : null;
        const actor = await feedbackActor(sess, env, b.associateAccount === true);
        const rate = await consumeFeedbackRateLimit(request, env, sess);
        if (!rate.allowed) {
          return J(env, { error: '提交太頻繁，請稍後再試' }, 429, {
            'Cache-Control': 'no-store',
            'Retry-After': String(rate.retryAfter),
          });
        }

        const now = Date.now();
        const id = 'fb_' + now.toString(36) + '_' + randomHex(4);
        const fingerprint = (await sha256Hex([
          pagePath,
          category,
          message.toLowerCase().replace(/\s+/g, ' '),
        ].join('|'))).slice(0, 24);
        const insert = await env.FEEDBACK_DB.prepare(`
          INSERT OR IGNORE INTO feedback_entries (
            id, submission_id, source, actor_type, username,
            category, rating, message, page_path, page_title, locale,
            release_id, device_class, browser_family,
            viewport_width, viewport_height, fingerprint,
            status, created_at, updated_at
          ) VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
        `).bind(
          id, submissionId, actor.actorType, actor.username,
          category, ratingValue, message, pagePath, pageTitle, locale,
          release, device, browser, viewportWidth, viewportHeight,
          fingerprint, now, now
        ).run();
        if (!insert.meta || Number(insert.meta.changes || 0) === 0) {
          const existing = await env.FEEDBACK_DB.prepare(
            'SELECT id, created_at FROM feedback_entries WHERE submission_id = ?'
          ).bind(submissionId).first();
          return J(env, {
            ok: true,
            id: existing && existing.id || null,
            duplicate: true,
            createdAt: existing ? new Date(Number(existing.created_at)).toISOString() : null,
          }, 200, { 'Cache-Control': 'no-store' });
        }
        await env.FEEDBACK_DB.prepare(`
          INSERT INTO feedback_changes (
            id, feedback_id, changed_at, changed_by_type, changed_by_ref,
            action, from_status, to_status, changes_json, note
          ) VALUES (?, ?, ?, 'system', NULL, 'created', NULL, 'new', ?, NULL)
        `).bind(
          'fbc_' + now.toString(36) + '_' + randomHex(4),
          id,
          now,
          JSON.stringify({ source: 'user', category, pagePath, locale, release })
        ).run();
        return J(env, {
          ok: true,
          id,
          duplicate: false,
          createdAt: new Date(now).toISOString(),
        }, 201, { 'Cache-Control': 'no-store' });
      }

      if (path === '/api/me' && request.method === 'GET') {
        if (!sess) return J(env, { error: '未登入' }, 401);
        return J(env, {
          ok: true,
          username: sess.u,
          role: sess.role,
          expiresAt: new Date(sess.expiresAt).toISOString(),
          absoluteExpiresAt: new Date(sess.absoluteExpiresAt).toISOString(),
        }, 200, { 'Cache-Control': 'no-store' });
      }
      /* ════ 管理員 ════ */
      const needAdmin = () => {
        if (!sess) return J(env, { error: '未登入' }, 401);
        if (sess.role !== 'admin') return J(env, { error: '需要管理員權限' }, 403);
        return null;
      };

      /* Server-to-server event discovery. The immutable source payload is
         staged as AUTOMATION Pending; this endpoint can never Confirm. */
      if (path === '/api/ledger/source' && request.method === 'POST') {
        const configured = String(env.LEDGER_INGEST_TOKEN || '');
        const authorization = String(request.headers.get('Authorization') || '');
        const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        if (!configured) return J(env, { error: '自動事件入口未配置' }, 503);
        if (!safeEqual(supplied, configured)) return J(env, { error: '自動事件憑證無效' }, 401);
        const target = new URL(request.url);
        target.pathname = '/api/admin/ledger/source';
        const proxied = new Request(target.toString(), request);
        return handleLedgerAdminRequest(proxied, env, {
          actor: 'automation-ingest',
          respond: (data, status = 200) => J(env, data, status, { 'Cache-Control': 'no-store' }),
        });
      }

      /* ════ D1 事件賬本：Pending → 修改/扣稅 → Confirm → KV 快照 ════ */
      if (path.startsWith('/api/admin/ledger')) {
        const deny = needAdmin(); if (deny) return deny;
        return handleLedgerAdminRequest(request, env, {
          actor: sess.u,
          refreshPortfolio: updatePortfolioNav,
          respond: (data, status = 200) => J(env, data, status, { 'Cache-Control': 'no-store' }),
          defer: promise => ctx && ctx.waitUntil(promise),
        });
      }

      /* User log：D1 結構化查詢，供人工分流及後續優化 Agent 只讀消費。 */
      if (path === '/api/feedback' && request.method === 'GET') {
        const deny = needAdmin(); if (deny) return deny;
        if (!env.FEEDBACK_DB) return J(env, { error: 'FEEDBACK_DB 未配置' }, 503);
        const status = cleanPlain(url.searchParams.get('status'), 32);
        const category = cleanPlain(url.searchParams.get('category'), 32);
        const locale = cleanPlain(url.searchParams.get('locale'), 16);
        const source = cleanPlain(url.searchParams.get('source'), 16);
        const search = cleanPlain(url.searchParams.get('search'), 100);
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100) || 100));
        const offset = Math.max(0, Math.min(10000, Number(url.searchParams.get('offset') || 0) || 0));
        const where = ['1 = 1'];
        const values = [];
        if (status) {
          if (!FEEDBACK_STATUSES.has(status)) return J(env, { error: 'status 無效' }, 400);
          where.push('status = ?'); values.push(status);
        }
        if (category) {
          if (!FEEDBACK_CATEGORIES.has(category)) return J(env, { error: 'category 無效' }, 400);
          where.push('category = ?'); values.push(category);
        }
        if (locale) {
          if (!FEEDBACK_LOCALES.has(locale)) return J(env, { error: 'locale 無效' }, 400);
          where.push('locale = ?'); values.push(locale);
        }
        if (source) {
          if (!['user', 'monitor', 'agent'].includes(source)) return J(env, { error: 'source 無效' }, 400);
          where.push('source = ?'); values.push(source);
        }
        if (search) {
          const like = '%' + search + '%';
          where.push('(message LIKE ? OR page_path LIKE ? OR page_title LIKE ? OR username LIKE ?)');
          values.push(like, like, like, like);
        }
        const clause = where.join(' AND ');
        const listStmt = env.FEEDBACK_DB.prepare(`
          SELECT * FROM feedback_entries
          WHERE ${clause}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `).bind(...values, limit, offset);
        const countStmt = env.FEEDBACK_DB.prepare(`
          SELECT COUNT(*) AS total FROM feedback_entries WHERE ${clause}
        `).bind(...values);
        const statusStmt = env.FEEDBACK_DB.prepare(
          `SELECT status, COUNT(*) AS count FROM feedback_entries
           WHERE ${clause} GROUP BY status`
        ).bind(...values);
        const categoryStmt = env.FEEDBACK_DB.prepare(
          `SELECT category, COUNT(*) AS count FROM feedback_entries
           WHERE ${clause} GROUP BY category`
        ).bind(...values);
        const [listResult, countResult, statusResult, categoryResult] = await env.FEEDBACK_DB.batch([
          listStmt, countStmt, statusStmt, categoryStmt,
        ]);
        const totalRow = countResult.results && countResult.results[0] || { total: 0 };
        const summary = {
          total: Number(totalRow.total || 0),
          byStatus: Object.fromEntries((statusResult.results || []).map(x => [x.status, Number(x.count || 0)])),
          byCategory: Object.fromEntries((categoryResult.results || []).map(x => [x.category, Number(x.count || 0)])),
        };
        return J(env, {
          ok: true,
          items: (listResult.results || []).map(feedbackItem),
          summary,
          pagination: { limit, offset, hasMore: offset + (listResult.results || []).length < summary.total },
        }, 200, { 'Cache-Control': 'no-store' });
      }

      if (path === '/api/feedback/update' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        if (!env.FEEDBACK_DB) return J(env, { error: 'FEEDBACK_DB 未配置' }, 503);
        const b = await request.json().catch(() => null);
        if (!b || typeof b !== 'object' || Array.isArray(b)) return J(env, { error: '提交格式無效' }, 400);
        const id = cleanPlain(b.id, 80);
        if (!/^fb_[a-z0-9_]+$/i.test(id)) return J(env, { error: 'id 無效' }, 400);
        const current = await env.FEEDBACK_DB.prepare(
          'SELECT * FROM feedback_entries WHERE id = ?'
        ).bind(id).first();
        if (!current) return J(env, { error: '意見不存在' }, 404);
        const status = cleanPlain(b.status == null ? current.status : b.status, 32);
        if (!FEEDBACK_STATUSES.has(status)) return J(env, { error: 'status 無效' }, 400);
        const priorityRaw = b.priority == null || b.priority === '' ? null : cleanPlain(b.priority, 8);
        if (priorityRaw != null && !FEEDBACK_PRIORITIES.has(priorityRaw)) {
          return J(env, { error: 'priority 無效' }, 400);
        }
        const adminNote = cleanPlain(b.adminNote == null ? current.admin_note : b.adminNote, 2000);
        const linkedIssue = cleanPlain(b.linkedIssue == null ? current.linked_issue : b.linkedIssue, 500);
        const linkedPr = cleanPlain(b.linkedPr == null ? current.linked_pr : b.linkedPr, 500);
        const resolvedRelease = cleanPlain(
          b.resolvedRelease == null ? current.resolved_release : b.resolvedRelease,
          100
        );
        const now = Date.now();
        const resolvedAt = status === 'resolved' ? Number(current.resolved_at || now) : null;
        const changes = {
          status,
          priority: priorityRaw,
          adminNote,
          linkedIssue,
          linkedPr,
          resolvedRelease,
        };
        await env.FEEDBACK_DB.batch([
          env.FEEDBACK_DB.prepare(`
            UPDATE feedback_entries SET
              status = ?, priority = ?, admin_note = ?,
              linked_issue = ?, linked_pr = ?, resolved_release = ?,
              updated_at = ?, resolved_at = ?
            WHERE id = ?
          `).bind(
            status, priorityRaw, adminNote,
            linkedIssue, linkedPr, resolvedRelease,
            now, resolvedAt, id
          ),
          env.FEEDBACK_DB.prepare(`
            INSERT INTO feedback_changes (
              id, feedback_id, changed_at, changed_by_type, changed_by_ref,
              action, from_status, to_status, changes_json, note
            ) VALUES (?, ?, ?, 'admin', ?, 'updated', ?, ?, ?, ?)
          `).bind(
            'fbc_' + now.toString(36) + '_' + randomHex(4),
            id,
            now,
            sess.u,
            current.status,
            status,
            JSON.stringify(changes),
            adminNote || null
          ),
        ]);
        const updated = await env.FEEDBACK_DB.prepare(
          'SELECT * FROM feedback_entries WHERE id = ?'
        ).bind(id).first();
        return J(env, { ok: true, item: feedbackItem(updated) }, 200, { 'Cache-Control': 'no-store' });
      }

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
          if (!await revokeUserSessions(env, username)) {
            return J(env, { error: '會話撤銷暫時失敗，未刪除帳號，請重試' }, 503);
          }
          if (env.FEEDBACK_DB) {
            const now = Date.now();
            const statements = [
              env.FEEDBACK_DB.prepare(`
                INSERT INTO feedback_changes (
                  id, feedback_id, changed_at, changed_by_type, changed_by_ref,
                  action, from_status, to_status, changes_json, note
                )
                SELECT
                  'fbc_' || lower(hex(randomblob(12))),
                  id, ?, 'system', NULL,
                  'account_anonymized', status, status,
                  '{"usernameAnonymized":true}', NULL
                FROM feedback_entries
                WHERE username = ?
              `).bind(now, username),
              env.FEEDBACK_DB.prepare(`
                UPDATE feedback_entries
                SET actor_type = 'deleted_user', username = NULL, updated_at = ?
                WHERE username = ?
              `).bind(now, username),
            ];
            if (env.FEEDBACK_RATE_SALT) {
              const rateIdentity = 'user:' + (
                await hmacSha256Hex(env.FEEDBACK_RATE_SALT, 'user:' + username)
              ).slice(0, 24);
              statements.push(env.FEEDBACK_DB.prepare(`
                DELETE FROM feedback_rate_limits
                WHERE substr(bucket, -length(?)) = ?
              `).bind(rateIdentity, rateIdentity));
            }
            await env.FEEDBACK_DB.batch(statements);
          }
          await env.YC_KV.delete(key);
          if (u.email) await env.YC_KV.delete('email:' + u.email);
          return J(env, { ok: true, message: '已刪除 ' + username });
        }
        if (action === 'resetpw' && (!newPassword || newPassword.length < 6)) {
          return J(env, { error: '新密碼至少 6 位' }, 400);
        }
        if ((action === 'disable' || action === 'resetpw') &&
            !await revokeUserSessions(env, username)) {
          return J(env, { error: '會話撤銷暫時失敗，帳號未更新，請重試' }, 503);
        }
        if (action === 'disable') u.disabled = true;
        else if (action === 'enable') u.disabled = false;
        else if (action === 'resetpw') {
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
        if (!await authRateAllowed(request, env, 'forgot', 6, 3600)) return J(env, { error: '請求過於頻繁，請稍後再試' }, 429);
        const b = await request.json();
        const email = String(b.email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return J(env, { error: '郵箱格式不正確' }, 400);
        // 用 email 索引直查（避免枚舉：無論是否存在都返回成功文案）
        const uname = await env.YC_KV.get('email:' + email);
        if (uname && await env.YC_KV.get('user:' + uname)) {
          const code = verificationCode();
          await env.YC_KV.put('reset:' + email, JSON.stringify({ code, u: uname, tries: 0, ts: Date.now() }), { expirationTtl: 900 });
          await sendResetCode(env, email, code);
        }
        return J(env, { ok: true, message: '若該郵箱已註冊，重設驗證碼已發送（15 分鐘內有效，請查收郵件含垃圾箱）。' });
      }
      if (path === '/api/reset' && request.method === 'POST') {
        if (!await authRateAllowed(request, env, 'reset', 12, 900)) return J(env, { error: '請求過於頻繁，請稍後再試' }, 429);
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
        if (!await revokeUserSessions(env, rec.u)) {
          return J(env, { error: '會話撤銷暫時失敗，密碼未重設，請重試' }, 503);
        }
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
        if (!await revokeUserSessions(env, username)) {
          return J(env, { error: '會話撤銷暫時失敗，密碼未更新，請重試' }, 503);
        }
        u.salt = randomHex(16); u.hash = await pbkdf2(password, u.salt);
        await env.YC_KV.put('user:' + username, JSON.stringify(u));
        return J(env, { ok: true, username });
      }

      /* ════ 舊 Excel/KV 快照寫入邊界：永久退役 ════ */
      if (path === '/api/ledger' && request.method === 'POST') {
        const deny = needAdmin(); if (deny) return deny;
        return J(env, {
          error: '舊 Excel 快照入口已永久移除；唯一事實入口是 D1 Pending → Confirm。',
          replacement: '/api/admin/ledger',
        }, 410);
      }

      if (path.startsWith('/api/nav/') && request.method === 'GET') {
        const pf = path.split('/')[3];
        if (!/^(us|hk|a)$/.test(pf)) return J(env, { error: 'not found' }, 404);
        const [cached, statusRaw, ledgerRevision] = await Promise.all([
          env.YC_KV.get('navcache:' + pf),
          env.YC_KV.get('navstatus:' + pf),
          publicPortfolioLedgerRevision(env, pf),
        ]);
        if (cached) {
          const status = statusRaw ? JSON.parse(statusRaw) : null;
          const cache = JSON.parse(cached);
          if (portfolioCacheMatchesRevision(cache, ledgerRevision)) {
            return J(env, publicPortfolioSnapshot(cache, status));
          }
        }
        return J(env, {
          ok: false, enabled: false, portfolio: pf, pending: true,
          history: [], rets: [], rows: [], holdings: [], assets: [],
          source: 'portfolio-snapshot',
          as_of: null,
          fetched_at: null,
          freshness_class: 'eod',
          freshness: { class: 'eod', stale: true, fallback: null },
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
        return J(env, {
          error: 'GitHub/Excel 工作簿輸入已永久移除；Excel 只能導出可視化，反向修改必須經 Preview → Pending → Confirm。',
          replacement: '/api/admin/ledger/export',
        }, 410);
      }

      return J(env, { error: 'Not found' }, 404);
    } catch (e) {
      const requestId = 'req_' + Date.now().toString(36) + '_' + randomHex(3);
      if (e instanceof AuthStoreUnavailableError) {
        console.error('auth_request_unavailable', requestId, e.operation);
        return J(env, {
          error: '身份服務暫時不可用，請稍後重試',
          code: 'auth_store_unavailable',
          requestId,
        }, 503, { 'Cache-Control': 'no-store', 'Retry-After': '2' });
      }
      console.error('request_failed', requestId, e);
      return J(env, { error: '服務器暫時發生錯誤', requestId }, 500);
    }
  },

  /* ⏰ Cron Triggers：Cloudflare → Worker → Settings → Triggers → Cron 添加
     "30 21 * * *"  美股收盤後約1小時（21:30 UTC ≈ 美東 4:30/5:30PM）→ 更新 US
     "0 9 * * *"    北京時間 17:00 → HK / A 即時收盤快照
     "30 10 * * *"  北京時間 18:30 → HK / A 官方 EOD 對賬與回退刷新 */
  async scheduled(event, env, ctx) {
    const cron = event.cron || '';
    if (cron === '* * * * *') {
      ctx.waitUntil((async () => {
        await drainLedgerOutbox(env, { refreshPortfolio: updatePortfolioNav })
          .catch(e => console.error('ledger_outbox_continuation_failed', e));
        const nowValue = Date.now();
        const realtimePortfolios = ['us', 'hk', 'a']
          .filter(portfolio => portfolioRealtimeWindowOpen(nowValue, portfolio));
        if (!realtimePortfolios.length) return;
        const nav = await Promise.all(realtimePortfolios.map(portfolio =>
          updatePortfolioNav(env, portfolio).catch(error => ({
            pf: portfolio,
            complete: false,
            fallback: true,
            reason: String(error && (error.code || error.message) || 'realtime_refresh_failed'),
          }))));
        await env.YC_KV.put('refresh:last:cron:realtime', JSON.stringify({
          ok: nav.every(item => item && item.complete === true && item.fallback !== true),
          trigger: 'cron:realtime',
          ranAt: new Date(nowValue).toISOString(),
          portfolios: realtimePortfolios,
          nav,
        }));
      })());
    } else if (cron === '30 21 * * *') {
      ctx.waitUntil((async () => {
        await enqueueDailyNavReplay(env, ['us'])
          .catch(e => console.error('daily_raw_tape_queue_failed', e));
        await drainLedgerOutbox(env, { refreshPortfolio: updatePortfolioNav })
          .catch(e => console.error('ledger_outbox_failed', e));
        await Promise.all([
          refreshMarketCaches(env, ['us'], ['us'], 'cron:us'),
          refreshTushareTerminalSnapshots(env).catch(e =>
            console.error('terminal_tushare_refresh_failed', e)),
          cleanupFeedbackRateLimits(env).catch(e => console.error('feedback_rate_cleanup_failed', e)),
          cleanupAuthState(env).then(ok => {
            if (!ok) console.error('auth_state_cleanup_failed');
          }).catch(e => console.error('auth_state_cleanup_failed', e)),
        ]);
      })());
    } else if (cron === '0 9 * * *') {
      ctx.waitUntil((async () => {
        await drainLedgerOutbox(env, { refreshPortfolio: updatePortfolioNav })
          .catch(e => console.error('ledger_outbox_failed', e));
        await Promise.all([
          refreshMarketCaches(env, ['hk', 'a'], ['hk', 'a'], 'cron:asia'),
          refreshTushareTerminalSnapshots(env).catch(e =>
            console.error('terminal_tushare_refresh_failed', e)),
          cleanupFeedbackRateLimits(env).catch(e => console.error('feedback_rate_cleanup_failed', e)),
          cleanupAuthState(env).then(ok => {
            if (!ok) console.error('auth_state_cleanup_failed');
          }).catch(e => console.error('auth_state_cleanup_failed', e)),
        ]);
      })());
    } else if (cron === '30 10 * * *') {
      ctx.waitUntil((async () => {
        await enqueueDailyNavReplay(env, ['hk', 'a'])
          .catch(e => console.error('daily_raw_tape_queue_failed', e));
        await drainLedgerOutbox(env, { refreshPortfolio: updatePortfolioNav })
          .catch(e => console.error('ledger_outbox_failed', e));
        await Promise.all([
          refreshMarketCaches(env, ['hk', 'a'], ['hk', 'a'], 'cron:asia-eod'),
          refreshTushareTerminalSnapshots(env).catch(e =>
            console.error('terminal_tushare_refresh_failed', e)),
        ]);
      })());
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
