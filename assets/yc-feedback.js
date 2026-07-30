/* ═══════════════════════════════════════════════════════════
   Yi Capital user feedback
   Public, trilingual, dependency-free and privacy-minimizing.
   User text is sent to the portal API and never rendered as HTML.
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__YC_FEEDBACK_MOUNTED__) return;
  window.__YC_FEEDBACK_MOUNTED__ = true;

  const API = String(window.YC_API || '').replace(/\/+$/, '');
  if (!API) return;
  const t = key => window.YCI && typeof window.YCI.t === 'function' ? window.YCI.t(key) : key;
  const esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const locale = window.YCI && window.YCI.lang === 'cn'
    ? 'zh-Hans' : window.YCI && window.YCI.lang === 'en' ? 'en' : 'zh-Hant';
  const token = localStorage.getItem('yc-token') || '';
  let returnFocus = null;
  let previousOverflow = '';

  const css = document.createElement('style');
  css.textContent = `
    .ycf-trigger{position:fixed;right:max(18px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));
      z-index:1180;display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(110,154,244,.58);
      border-radius:999px;padding:10px 15px;background:rgba(8,17,33,.94);color:#e8edf5;
      box-shadow:0 12px 34px rgba(0,0,0,.42);backdrop-filter:blur(12px);
      font-family:var(--sans,"Space Grotesk",sans-serif);font-size:13px;font-weight:650;cursor:pointer}
    .ycf-trigger:hover,.ycf-trigger:focus-visible{border-color:#8b9df5;color:#fff;box-shadow:0 0 0 3px rgba(110,154,244,.15),0 12px 34px rgba(0,0,0,.42);outline:none}
    .ycf-trigger-dot{width:8px;height:8px;border-radius:50%;background:linear-gradient(135deg,#6E9AF4,#B54BFA);
      box-shadow:0 0 12px rgba(181,75,250,.75)}
    .ycf-overlay{position:fixed;inset:0;z-index:1190;display:none;align-items:center;justify-content:center;
      padding:24px;background:rgba(2,6,13,.74);backdrop-filter:blur(6px)}
    .ycf-overlay.open{display:flex}
    .ycf-dialog{position:relative;width:min(620px,100%);max-height:min(760px,calc(100vh - 36px));overflow:auto;
      border:1px solid #263553;border-radius:16px;background:#091221;color:#e8edf5;
      box-shadow:0 30px 90px rgba(0,0,0,.68);padding:30px}
    .ycf-dialog::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;border-radius:16px 16px 0 0;
      background:linear-gradient(90deg,#6E9AF4,#B54BFA)}
    .ycf-close{position:absolute;right:18px;top:17px;width:36px;height:36px;border:1px solid #263553;border-radius:50%;
      background:#0c182b;color:#aeb9c8;font-size:22px;line-height:1;cursor:pointer}
    .ycf-close:hover,.ycf-close:focus-visible{color:#fff;border-color:#6E9AF4;outline:none}
    .ycf-kicker{font-family:var(--mono,"IBM Plex Mono",monospace);font-size:10px;letter-spacing:2px;
      text-transform:uppercase;color:#8fa9f5;margin:0 48px 9px 0}
    .ycf-dialog h2{font-family:var(--sans,"Space Grotesk",sans-serif);font-size:24px;line-height:1.25;color:#fff;margin:0 48px 8px 0}
    .ycf-sub{color:#8b98ab;font-size:14px;line-height:1.7;margin:0 0 23px}
    .ycf-field{display:block;margin:0 0 17px}
    .ycf-field>span,.ycf-rating legend{display:block;margin:0 0 8px;color:#cdd6e3;
      font-family:var(--sans,"Space Grotesk",sans-serif);font-size:12px;font-weight:650;letter-spacing:.2px}
    .ycf-field select,.ycf-field textarea{width:100%;box-sizing:border-box;border:1px solid #263553;border-radius:8px;
      background:#060d18;color:#e8edf5;padding:11px 12px;font-family:inherit;font-size:14px}
    .ycf-field textarea{min-height:130px;resize:vertical;line-height:1.7}
    .ycf-field select:focus,.ycf-field textarea:focus{border-color:#6E9AF4;box-shadow:0 0 0 3px rgba(110,154,244,.13);outline:none}
    .ycf-count{display:block;text-align:right;color:#65748a;font-family:var(--mono,"IBM Plex Mono",monospace);font-size:10px;margin-top:5px}
    .ycf-rating{border:0;padding:0;margin:0 0 17px}
    .ycf-rate-row{display:flex;gap:7px}
    .ycf-rate-row label{position:relative}
    .ycf-rate-row input{position:absolute;opacity:0;pointer-events:none}
    .ycf-rate-row span{display:flex;width:38px;height:34px;align-items:center;justify-content:center;border:1px solid #263553;
      border-radius:7px;background:#060d18;color:#8b98ab;font-family:var(--mono,"IBM Plex Mono",monospace);font-size:12px;cursor:pointer}
    .ycf-rate-row input:checked+span{border-color:#8b9df5;background:rgba(110,154,244,.16);color:#fff}
    .ycf-rate-row input:focus-visible+span{outline:2px solid #8b9df5;outline-offset:2px}
    .ycf-account{display:flex;gap:10px;align-items:flex-start;color:#aeb9c8;font-size:12.5px;line-height:1.55;margin:2px 0 14px}
    .ycf-account input{margin-top:3px;accent-color:#6E9AF4}
    .ycf-note{color:#65748a;font-size:11.5px;line-height:1.65;margin:0 0 18px}
    .ycf-actions{display:flex;align-items:center;gap:13px;flex-wrap:wrap}
    .ycf-submit{border:0;border-radius:8px;padding:11px 20px;background:linear-gradient(90deg,#6E9AF4,#B54BFA);
      color:#050914;font-family:var(--sans,"Space Grotesk",sans-serif);font-weight:750;font-size:14px;cursor:pointer}
    .ycf-submit:hover,.ycf-submit:focus-visible{filter:brightness(1.08);outline:2px solid #a9b8ff;outline-offset:2px}
    .ycf-submit:disabled{opacity:.55;cursor:wait}
    .ycf-status{min-height:20px;color:#7dd3a8;font-size:12.5px;line-height:1.5}
    .ycf-status.err{color:#ff8373}
    .ycf-honey{position:absolute!important;left:-10000px!important;width:1px!important;height:1px!important;overflow:hidden!important}
    @media(max-width:640px){
      .ycf-overlay{align-items:flex-end;padding:0}
      .ycf-dialog{width:100%;max-height:88vh;border-radius:18px 18px 0 0;padding:27px 20px max(22px,env(safe-area-inset-bottom))}
      .ycf-dialog::before{border-radius:18px 18px 0 0}
      .ycf-trigger{right:14px;bottom:max(14px,env(safe-area-inset-bottom));padding:9px 13px}
    }
    @media(prefers-reduced-motion:no-preference){
      .ycf-dialog{animation:ycf-rise .18s ease-out}
      @keyframes ycf-rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
    }`;
  document.head.appendChild(css);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ycf-trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.innerHTML = '<span class="ycf-trigger-dot" aria-hidden="true"></span><span>' + esc(t('fb.button')) + '</span>';

  const overlay = document.createElement('div');
  overlay.className = 'ycf-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <section class="ycf-dialog" role="dialog" aria-modal="true" aria-labelledby="ycf-title" tabindex="-1">
      <button class="ycf-close" type="button" aria-label="${esc(t('fb.close'))}">×</button>
      <p class="ycf-kicker">${esc(t('fb.button'))}</p>
      <h2 id="ycf-title">${esc(t('fb.title'))}</h2>
      <p class="ycf-sub">${esc(t('fb.subtitle'))}</p>
      <form novalidate>
        <label class="ycf-field">
          <span>${esc(t('fb.category'))}</span>
          <select name="category" required>
            <option value="bug">${esc(t('fb.cat.bug'))}</option>
            <option value="content">${esc(t('fb.cat.content'))}</option>
            <option value="data">${esc(t('fb.cat.data'))}</option>
            <option value="ux">${esc(t('fb.cat.ux'))}</option>
            <option value="accessibility">${esc(t('fb.cat.accessibility'))}</option>
            <option value="performance">${esc(t('fb.cat.performance'))}</option>
            <option value="feature">${esc(t('fb.cat.feature'))}</option>
            <option value="other">${esc(t('fb.cat.other'))}</option>
          </select>
        </label>
        <fieldset class="ycf-rating">
          <legend>${esc(t('fb.rating'))}</legend>
          <div class="ycf-rate-row">
            ${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="rating" value="${n}"><span>${n}</span></label>`).join('')}
          </div>
        </fieldset>
        <label class="ycf-field">
          <span>${esc(t('fb.message'))}</span>
          <textarea name="message" minlength="5" maxlength="2000" required placeholder="${esc(t('fb.placeholder'))}"></textarea>
          <small class="ycf-count">0 / 2000</small>
        </label>
        <label class="ycf-honey" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
        ${token ? `<label class="ycf-account"><input type="checkbox" name="associateAccount"><span>${esc(t('fb.account'))}</span></label>` : ''}
        <p class="ycf-note">${esc(t('fb.privacy'))}</p>
        <div class="ycf-actions">
          <button class="ycf-submit" type="submit">${esc(t('fb.submit'))}</button>
          <div class="ycf-status" role="status" aria-live="polite"></div>
        </div>
      </form>
    </section>`;

  document.body.append(trigger, overlay);
  const dialog = overlay.querySelector('.ycf-dialog');
  const closeButton = overlay.querySelector('.ycf-close');
  const form = overlay.querySelector('form');
  const message = form.elements.message;
  const counter = overlay.querySelector('.ycf-count');
  const submit = overlay.querySelector('.ycf-submit');
  const status = overlay.querySelector('.ycf-status');

  function open() {
    returnFocus = document.activeElement;
    previousOverflow = document.body.style.overflow;
    status.className = 'ycf-status';
    status.textContent = '';
    document.body.style.overflow = 'hidden';
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    closeButton.focus();
  }
  function close() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = previousOverflow;
    if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
  }
  function browserFamily() {
    const ua = navigator.userAgent || '';
    if (/Edg\//.test(ua)) return 'edge';
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/CriOS|Chrome\//.test(ua)) return 'chrome';
    if (/Safari\//.test(ua) && !/Chrome|Chromium/.test(ua)) return 'safari';
    return 'other';
  }
  function deviceClass() {
    const width = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    return width < 720 ? 'mobile' : width < 1080 ? 'tablet' : 'desktop';
  }
  function submissionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'sub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
  }

  trigger.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll(
      'button:not([disabled]),select:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([tabindex="-1"])'
    )].filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  message.addEventListener('input', () => { counter.textContent = message.value.length + ' / 2000'; });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    status.className = 'ycf-status';
    status.textContent = '';
    if (!form.reportValidity()) return;
    submit.disabled = true;
    const originalLabel = submit.textContent;
    submit.textContent = t('fb.submitting');
    const rating = form.querySelector('input[name="rating"]:checked');
    const body = {
      schemaVersion: 1,
      submissionId: submissionId(),
      category: form.elements.category.value,
      rating: rating ? Number(rating.value) : null,
      message: message.value.trim(),
      website: form.elements.website.value,
      associateAccount: !!(form.elements.associateAccount && form.elements.associateAccount.checked),
      pagePath: location.pathname || '/',
      pageTitle: document.title || '',
      locale,
      release: String(window.YC_RELEASE || ''),
      diagnostics: {
        device: deviceClass(),
        browser: browserFamily(),
        viewportWidth: Math.round(window.innerWidth || 0),
        viewportHeight: Math.round(window.innerHeight || 0),
      },
    };
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      const response = await fetch(API + '/api/feedback', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || ('HTTP ' + response.status));
      form.reset();
      counter.textContent = '0 / 2000';
      status.textContent = t('fb.success');
      setTimeout(close, 1400);
    } catch (error) {
      status.className = 'ycf-status err';
      status.textContent = t('fb.error');
    } finally {
      submit.disabled = false;
      submit.textContent = originalLabel;
    }
  });
})();
