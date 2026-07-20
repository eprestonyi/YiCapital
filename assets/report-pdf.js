/* Managed report PDF
   A report page keeps its article URL while the admin may replace its PDF path. */
(function () {
  const boxes = Array.from(document.querySelectorAll('.yc-managed-pdf'));
  if (!boxes.length) return;

  function hrefFor(path, base) {
    const p = String(path || '').trim();
    if (!p) return '';
    if (/^(?:https?:)?\/\//i.test(p) || p[0] === '/') return p;
    return String(base || '../') + p.replace(/^\.?\//, '');
  }

  function render(box, path) {
    const href = hrefFor(path, box.dataset.base);
    box.replaceChildren();
    box.hidden = !href;
    if (!href) return;

    const bar = document.createElement('div');
    bar.className = 'pdf-bar';
    const title = document.createElement('b');
    title.textContent = box.dataset.label || '報告全文 PDF';
    const link = document.createElement('a');
    link.href = href;
    link.download = '';
    link.textContent = box.dataset.download || '↓ 下載 PDF';
    bar.append(title, link);

    const object = document.createElement('object');
    object.className = 'pdf-frame';
    object.data = href;
    object.type = 'application/pdf';
    const fallback = document.createElement('div');
    fallback.className = 'placeholder';
    fallback.style.margin = '0';
    fallback.append(document.createTextNode(box.dataset.fallback || '你的瀏覽器不支援內嵌預覽，'));
    const fallbackLink = document.createElement('a');
    fallbackLink.href = href;
    fallbackLink.style.color = 'var(--cyan)';
    fallbackLink.textContent = box.dataset.open || '點此下載報告全文';
    fallback.append(fallbackLink);
    object.append(fallback);
    box.append(bar, object);
  }

  boxes.forEach(box => render(box, box.dataset.defaultPdf || ''));

  const api = String(window.YC_API || '').replace(/\/+$/, '');
  if (!api) return;
  fetch(api + '/api/content', { cache: 'no-store' })
    .then(r => r.json())
    .then(j => {
      if (!j || !j.ok || !Array.isArray(j.reports)) return;
      boxes.forEach(box => {
        const item = j.reports.find(r => String(r.id || '') === String(box.dataset.reportId || ''));
        if (!item) return;
        const path = Object.prototype.hasOwnProperty.call(item, 'pdf')
          ? item.pdf
          : box.dataset.defaultPdf || '';
        render(box, path);
      });
    })
    .catch(() => {});
})();
