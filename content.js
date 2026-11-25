// Odoo Attendance Monitor — content script for https://www.odoo.com/odoo*
//
// - Adds a green/red dot to the tab favicon (checked in / checked out)
// - Shows a small toast when the state changes while the page is open
// - Polls attendance every minute (same-origin request from the page) and
//   reports to the service worker, which also polls on its own; whichever
//   works keeps the state fresh (same mechanism as the original extension).

(() => {
  'use strict';

  const COLORS = { checked_in: '#1fa855', checked_out: '#e5322d' }; // vivid: read at 16px
  const MARK = 'data-attendance-monitor';

  let currentState = null;
  let originalHref = null;
  let originalImage = null; // HTMLImageElement of the page's own favicon
  let appliedHref = null;

  // ── Fetch ──────────────────────────────────────────────────────────

  async function fetchAttendanceJson() {
    const resp = await fetch('/hr_attendance/attendance_user_data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {}, id: Date.now() }),
      credentials: 'same-origin',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  function stateFromJson(json) {
    const r = json?.result;
    return (r?.attendance_state || r?.attendance_user_data?.attendance_state) || null;
  }

  // ── Favicon ────────────────────────────────────────────────────────

  function faviconLink() {
    return document.querySelector("link[rel~='icon']");
  }

  function loadOriginalFavicon() {
    const link = faviconLink();
    originalHref = link?.href || `${location.origin}/favicon.ico`;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { originalImage = img; resolve(); };
      img.onerror = () => resolve();
      img.src = originalHref;
    });
  }

  // The whole Odoo "O" in green/red: much easier to spot than a small dot.
  function drawFavicon(state) {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (originalImage) {
      try {
        ctx.drawImage(originalImage, 0, 0, size, size);
        // Recolour only if the icon has a transparent background (the O ring);
        // tinting an opaque icon would give a plain coloured square.
        if (ctx.getImageData(0, 0, 1, 1).data[3] === 0) {
          ctx.globalCompositeOperation = 'source-in';
          ctx.fillStyle = COLORS[state];
          ctx.fillRect(0, 0, size, size);
          return canvas.toDataURL('image/png');
        }
      } catch {
        // Cross-origin favicon (tainted canvas): draw our own O below.
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, size, size);
    }
    // Fallback: an O ring like Odoo's.
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 11, 0, Math.PI * 2);
    ctx.lineWidth = 7;
    ctx.strokeStyle = COLORS[state];
    ctx.stroke();
    return canvas.toDataURL('image/png');
  }

  function applyFavicon() {
    let link = faviconLink();
    if (!COLORS[currentState]) {
      // Unknown state: restore the page's own favicon.
      if (link?.hasAttribute(MARK) && originalHref) link.href = originalHref;
      appliedHref = null;
      return;
    }
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    appliedHref = drawFavicon(currentState);
    link.setAttribute(MARK, '');
    link.type = 'image/png';
    link.href = appliedHref;
  }

  // The web client may swap the favicon; put ours back (one observer only).
  new MutationObserver(() => {
    const link = faviconLink();
    if (appliedHref && link && link.href !== appliedHref) applyFavicon();
  }).observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });

  // ── Toast (state changes only) ─────────────────────────────────────

  function showToast(state) {
    document.getElementById('attendance-monitor-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'attendance-monitor-toast';
    toast.setAttribute('role', 'status');
    const dot = document.createElement('span');
    const label = document.createElement('span');
    label.textContent = state === 'checked_in' ? 'Checked in' : 'Checked out';
    toast.append(dot, label);
    Object.assign(toast.style, {
      position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647',
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '8px 14px', borderRadius: '6px',
      background: '#1f2328', color: '#ffffff',
      font: '500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
      boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      opacity: '0', transition: 'opacity 0.2s',
    });
    Object.assign(dot.style, {
      width: '8px', height: '8px', borderRadius: '50%', background: COLORS[state],
    });
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 250);
    }, 3000);
  }

  function setState(state) {
    const previous = currentState;
    currentState = state;
    if (state !== previous) {
      applyFavicon();
      if (previous && COLORS[state]) showToast(state);
    }
  }

  // ── Messages ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ATTENDANCE_UPDATE') {
      setState(msg.state);
      return false;
    }
    if (msg.type === 'FORCE_POLL_TAB') {
      fetchAttendanceJson()
        .then((json) => { setState(stateFromJson(json)); sendResponse({ json }); })
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }
  });

  // ── Start: poll now, then every minute ────────────────────────────

  async function pollAndReport() {
    try {
      const json = await fetchAttendanceJson();
      setState(stateFromJson(json));
      chrome.runtime.sendMessage({ type: 'ATTENDANCE_DATA', json }).catch(() => {});
    } catch {
      // Network hiccup: the next poll (or the service worker) will catch up.
    }
  }

  loadOriginalFavicon().then(() => {
    pollAndReport();
    setInterval(pollAndReport, 60 * 1000);
  });
})();
