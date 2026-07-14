/* ═══════════════════════════════════════════════════════════════
   Yi Capital Portal Backend — Cloudflare Worker（單文件，粘貼即部署）
   ─────────────────────────────────────────────────────────────
   功能：
     POST /api/signup          訪客註冊
     POST /api/login           管理員 / 訪客登入 → 返回 Bearer token
     POST /api/logout          登出
     GET  /api/me              當前會話信息
     GET  /api/users           [admin] 列出所有帳號
     POST /api/users/update    [admin] 停用/啟用/刪除/重置密碼
     POST /api/publish         [admin] 上傳淨值表 → 服務端提交到 GitHub

   需要的綁定與密鑰（Worker 設置頁配置，見 README）：
     KV 綁定:  YC_KV
     Secrets:  ADMIN_USERNAME, ADMIN_PASSWORD, GH_TOKEN
     變量:     GH_OWNER, GH_REPO, GH_BRANCH, GH_PATH, ALLOWED_ORIGIN
   安全模型：密碼 PBKDF2-SHA256(10萬次) 加鹽哈希存 KV；
             GitHub Token 只存在 Worker Secret，永不下發到瀏覽器。
   ═══════════════════════════════════════════════════════════════ */

const SESSION_TTL = 7 * 24 * 3600;           // 會話 7 天
const enc = new TextEncoder();

/* ── 工具 ── */
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));

async function pbkdf2(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return hex(bits);
}
// 恆時比較，防時序攻擊
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
}
const J = (env, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(env) } });

async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (!m) return null;
  const raw = await env.YC_KV.get('sess:' + m[1]);
  return raw ? { token: m[1], ...JSON.parse(raw) } : null;
}

const validUser = u => /^[a-zA-Z0-9_\-\u4e00-\u9fff]{2,24}$/.test(u || '');

/* ── 主路由 ── */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });

    try {
      /* ---- 註冊（訪客）---- */
      if (path === '/api/signup' && request.method === 'POST') {
        const { username, password } = await request.json();
        if (!validUser(username)) return J(env, { error: '用戶名 2–24 位，僅限中英文、數字、_-' }, 400);
        if (!password || password.length < 6) return J(env, { error: '密碼至少 6 位' }, 400);
        if (username === env.ADMIN_USERNAME) return J(env, { error: '該用戶名不可用' }, 400);
        if (await env.YC_KV.get('user:' + username)) return J(env, { error: '用戶名已存在' }, 409);
        const salt = randomHex(16);
        const hash = await pbkdf2(password, salt);
        await env.YC_KV.put('user:' + username, JSON.stringify({
          u: username, salt, hash, role: 'guest', disabled: false,
          created: new Date().toISOString(), lastLogin: null,
        }));
        return J(env, { ok: true, message: '註冊成功，請登入' });
      }

      /* ---- 登入 ---- */
      if (path === '/api/login' && request.method === 'POST') {
        const { username, password } = await request.json();
        let role = null;
        if (username === env.ADMIN_USERNAME) {
          if (!safeEqual(password || '', env.ADMIN_PASSWORD)) return J(env, { error: '帳號或密碼錯誤' }, 401);
          role = 'admin';
        } else {
          const raw = await env.YC_KV.get('user:' + username);
          if (!raw) return J(env, { error: '帳號或密碼錯誤' }, 401);
          const u = JSON.parse(raw);
          if (u.disabled) return J(env, { error: '此帳號已被停用' }, 403);
          const hash = await pbkdf2(password || '', u.salt);
          if (!safeEqual(hash, u.hash)) return J(env, { error: '帳號或密碼錯誤' }, 401);
          role = 'guest';
          u.lastLogin = new Date().toISOString();
          await env.YC_KV.put('user:' + username, JSON.stringify(u));
        }
        const token = randomHex(32);
        await env.YC_KV.put('sess:' + token, JSON.stringify({ u: username, role }), { expirationTtl: SESSION_TTL });
        return J(env, { ok: true, token, role, username });
      }

      /* ---- 會話 ---- */
      const sess = await getSession(request, env);

      if (path === '/api/me' && request.method === 'GET') {
        if (!sess) return J(env, { error: '未登入' }, 401);
        return J(env, { ok: true, username: sess.u, role: sess.role });
      }
      if (path === '/api/logout' && request.method === 'POST') {
        if (sess) await env.YC_KV.delete('sess:' + sess.token);
        return J(env, { ok: true });
      }

      /* ---- 以下均需管理員 ---- */
      const needAdmin = () => (!sess ? J(env, { error: '未登入' }, 401) : sess.role !== 'admin' ? J(env, { error: '需要管理員權限' }, 403) : null);

      if (path === '/api/users' && request.method === 'GET') {
        const deny = needAdmin(); if (deny) return deny;
        const list = await env.YC_KV.list({ prefix: 'user:' });
        const users = [];
        for (const k of list.keys) {
          const raw = await env.YC_KV.get(k.name);
          if (!raw) continue;
          const { u, role, disabled, created, lastLogin } = JSON.parse(raw);
          users.push({ username: u, role, disabled, created, lastLogin });
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
        if (action === 'delete') { await env.YC_KV.delete(key); return J(env, { ok: true, message: '已刪除 ' + username }); }
        if (action === 'disable') u.disabled = true;
        else if (action === 'enable') u.disabled = false;
        else if (action === 'resetpw') {
          if (!newPassword || newPassword.length < 6) return J(env, { error: '新密碼至少 6 位' }, 400);
          u.salt = randomHex(16); u.hash = await pbkdf2(newPassword, u.salt);
        } else return J(env, { error: '未知操作' }, 400);
        await env.YC_KV.put(key, JSON.stringify(u));
        return J(env, { ok: true, message: '已更新 ' + username });
      }

      /* ---- 發布淨值表（服務端持有 GH_TOKEN）---- */
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
