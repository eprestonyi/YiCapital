/* ═══════════════════════════════════════════════════════════════
   Yi Capital Portal Backend v3.1 — Cloudflare Worker（單文件，粘貼即部署）
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

async function sendCode(env, email, code) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Yi Capital <onboarding@resend.dev>',
      to: [email],
      subject: 'Yi Capital 註冊驗證碼：' + code,
      html: '<p>你的 Yi Capital 註冊驗證碼是：</p><h2 style="letter-spacing:4px">' + code + '</h2><p>15 分鐘內有效。若非本人操作請忽略。</p>',
    }),
  });
  return r.ok;
}
async function createUser(env, rec) {
  await env.YC_KV.put('user:' + rec.u, JSON.stringify(rec));
  if (rec.email) await env.YC_KV.put('email:' + rec.email, rec.u);
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
          ok: true, version: 'v3.1',
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
        if (await env.YC_KV.get('user:' + username)) return J(env, { error: '用戶名已存在' }, 409);
        if (await env.YC_KV.get('email:' + email)) return J(env, { error: '該郵箱已被註冊' }, 409);
        const salt = randomHex(16);
        const hash = await pbkdf2(password, salt);
        if (env.RESEND_API_KEY) {
          const code = String(Math.floor(100000 + Math.random() * 900000));
          await env.YC_KV.put('pending:' + email, JSON.stringify({ u: username, email, salt, hash, code, tries: 0 }), { expirationTtl: 900 });
          if (!await sendCode(env, email, code)) { await env.YC_KV.delete('pending:' + email); return J(env, { error: '驗證郵件發送失敗，請稍後再試' }, 502); }
          return J(env, { ok: true, needCode: true, message: '驗證碼已發送至 ' + email });
        }
        await createUser(env, { u: username, email, salt, hash, provider: 'password', role: 'guest', disabled: false, created: new Date().toISOString(), lastLogin: null });
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
        await createUser(env, { u: p.u, email: p.email, salt: p.salt, hash: p.hash, provider: 'password', role: 'guest', disabled: false, created: new Date().toISOString(), lastLogin: null });
        await env.YC_KV.delete(pkey);
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
        if (username === env.ADMIN_USERNAME || await env.YC_KV.get('user:' + username)) return J(env, { error: '用戶名已存在，換一個' }, 409);
        if (await env.YC_KV.get('email:' + g.email)) return J(env, { error: '該郵箱已被註冊' }, 409);
        const salt = randomHex(16);
        const hash = await pbkdf2(password, salt);
        await createUser(env, { u: username, email: g.email, name: g.name, salt, hash, provider: 'google', role: 'guest', disabled: false, created: new Date().toISOString(), lastLogin: new Date().toISOString() });
        await env.YC_KV.delete(skey);
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
          const { u, email, provider, role, disabled, created, lastLogin } = JSON.parse(raw);
          users.push({ username: u, email: email || '—', provider: provider || 'password', role, disabled, created, lastLogin });
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

      /* ════ 發布淨值表（服務端持有 GH_TOKEN）════ */
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
        if (!r1.ok) return J(env, { error: 'GitHub ' + r1.status + ' ' + (j1.message || '') }, 502);
        return J(env, { ok: true, commit: j1.commit && j1.commit.sha, url: j1.commit && j1.commit.html_url });
      }

      return J(env, { error: 'Not found' }, 404);
    } catch (e) {
      return J(env, { error: '服務器錯誤: ' + e.message }, 500);
    }
  }
};
