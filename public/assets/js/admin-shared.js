// Shared admin utilities — loaded on every admin page

(function() {
  'use strict';

  /* ── HELPERS ── */
  function escHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
  function fmtRelative(ts) {
    const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
  }
  function getSeenIds() {
    try { return new Set(JSON.parse(localStorage.getItem('_notif_seen_ids') || '[]')); } catch { return new Set(); }
  }
  function addSeenId(id) {
    const seen = getSeenIds(); seen.add(id);
    const arr = Array.from(seen); if (arr.length > 200) arr.splice(0, arr.length - 200);
    localStorage.setItem('_notif_seen_ids', JSON.stringify(arr));
  }

  /* ── INJECT STYLES ── */
  function injectStyles() {
    if (document.getElementById('admin-notif-styles')) return;
    const s = document.createElement('style');
    s.id = 'admin-notif-styles';
    s.textContent = `
#notif-bell-wrap { position:relative; display:inline-flex; }
#notif-bell { background:none; border:none; cursor:pointer; padding:5px 7px; border-radius:6px; color:var(--gray,#666); transition:background .15s; display:flex; align-items:center; }
#notif-bell:hover { background:rgba(0,0,0,.07); }
#notif-bell svg { width:20px; height:20px; }
#notif-badge { position:absolute; top:2px; right:2px; min-width:16px; height:16px; background:#e3503e; color:#fff; font-size:10px; font-weight:700; border-radius:8px; display:none; align-items:center; justify-content:center; padding:0 3px; line-height:1; }
#notif-dropdown { position:absolute; top:calc(100% + 8px); right:0; width:320px; background:#fff; border:1px solid #e0e0e0; border-radius:8px; box-shadow:0 6px 20px rgba(0,0,0,.15); z-index:9000; display:none; overflow:hidden; }
#notif-dropdown.open { display:block; }
.notif-dd-header { padding:10px 14px; font-size:.72rem; font-weight:700; color:#888; text-transform:uppercase; letter-spacing:.07em; border-bottom:1px solid #f0f0f0; display:flex; align-items:center; justify-content:space-between; }
.notif-dd-header a { font-size:.75rem; color:#0078d4; font-weight:600; text-decoration:none; text-transform:none; letter-spacing:0; }
.notif-dd-header a:hover { text-decoration:underline; }
.notif-dd-list { max-height:300px; overflow-y:auto; }
.notif-dd-item { padding:10px 14px; border-bottom:1px solid #f5f5f5; cursor:pointer; transition:background .12s; display:flex; align-items:flex-start; gap:10px; }
.notif-dd-item:hover { background:#f7f9fc; }
.notif-dd-item:last-child { border-bottom:none; }
.notif-dd-dot { width:8px; height:8px; border-radius:50%; background:#0078d4; flex-shrink:0; margin-top:4px; }
.notif-dd-text { flex:1; min-width:0; }
.notif-dd-title { font-size:.8125rem; font-weight:600; color:#1b1a19; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.notif-dd-sub { font-size:.75rem; color:#888; margin-top:1px; }
.notif-dd-empty { padding:24px; text-align:center; color:#bbb; font-size:.8rem; }
#admin-toast-stack { position:fixed; top:16px; right:16px; z-index:99999; display:flex; flex-direction:column; gap:8px; pointer-events:none; }
.admin-toast { background:#fff; border:1px solid #e0e0e0; border-radius:8px; box-shadow:0 4px 18px rgba(0,0,0,.14); padding:12px 14px 12px 12px; min-width:280px; max-width:360px; display:flex; align-items:flex-start; gap:10px; pointer-events:auto; animation:aToastIn .22s ease; border-left:4px solid #0078d4; }
.admin-toast.toast-success { border-left-color:#107c10; }
.admin-toast.toast-error { border-left-color:#d13438; }
.admin-toast.toast-warning { border-left-color:#ca5010; }
.admin-toast-icon { flex-shrink:0; margin-top:1px; }
.admin-toast-icon svg { width:18px; height:18px; display:block; }
.admin-toast-body { flex:1; min-width:0; }
.admin-toast-msg { font-size:.8125rem; font-weight:600; color:#1b1a19; line-height:1.4; }
.admin-toast-sub { font-size:.75rem; color:#888; margin-top:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.admin-toast-action { display:inline-block; margin-top:5px; font-size:.78rem; color:#0078d4; text-decoration:none; font-weight:600; background:none; border:none; padding:0; cursor:pointer; }
.admin-toast-action:hover { text-decoration:underline; }
.admin-toast-close { background:none; border:none; cursor:pointer; color:#bbb; font-size:1.1rem; line-height:1; padding:0 2px; flex-shrink:0; transition:color .12s; align-self:flex-start; }
.admin-toast-close:hover { color:#333; }
@keyframes aToastIn { from { opacity:0; transform:translateX(28px); } to { opacity:1; transform:none; } }
@keyframes aToastOut { from { opacity:1; } to { opacity:0; transform:translateX(28px); } }
    `;
    document.head.appendChild(s);
  }

  /* ── INJECT BELL ── */
  function injectBell() {
    if (document.getElementById('notif-bell')) return;
    const actions = document.querySelector('#topbar .topbar-actions');
    if (!actions) return;
    injectStyles();

    const wrap = document.createElement('div');
    wrap.id = 'notif-bell-wrap';
    wrap.innerHTML = `
      <button id="notif-bell" title="Notifications" aria-label="Notifications">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        <span id="notif-badge"></span>
      </button>
      <div id="notif-dropdown">
        <div class="notif-dd-header">
          <span>Access Requests</span>
          <a href="/admin/access-requests.html">View all</a>
        </div>
        <div class="notif-dd-list" id="notif-dd-list">
          <div class="notif-dd-empty">No pending requests</div>
        </div>
      </div>
    `;

    const logoutBtn = actions.querySelector('[id*="logout"],[id*="Logout"]') || actions.lastElementChild;
    if (logoutBtn) actions.insertBefore(wrap, logoutBtn);
    else actions.prepend(wrap);

    const bell = document.getElementById('notif-bell');
    const dropdown = document.getElementById('notif-dropdown');
    bell.addEventListener('click', (e) => { e.stopPropagation(); dropdown.classList.toggle('open'); });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) dropdown.classList.remove('open'); });

    // Toast stack
    if (!document.getElementById('admin-toast-stack')) {
      const stack = document.createElement('div');
      stack.id = 'admin-toast-stack';
      document.body.appendChild(stack);
    }
  }

  /* ── TOASTS ── */
  function showAdminToast(msg, sub, type, actionText, actionHref) {
    const stack = document.getElementById('admin-toast-stack');
    if (!stack) return;
    const iconColor = { success:'#107c10', error:'#d13438', warning:'#ca5010', default:'#0078d4' };
    const col = iconColor[type] || iconColor.default;
    const iconSvg = (type === 'success')
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`
      : (type === 'error')
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
    const toast = document.createElement('div');
    toast.className = 'admin-toast' + (type && type !== 'default' ? ' toast-' + type : '');
    toast.innerHTML = `
      <div class="admin-toast-icon">${iconSvg}</div>
      <div class="admin-toast-body">
        <div class="admin-toast-msg">${escHtml(msg)}</div>
        ${sub ? `<div class="admin-toast-sub">${escHtml(sub)}</div>` : ''}
        ${actionText ? `<a class="admin-toast-action" href="${escHtml(actionHref || '#')}">${escHtml(actionText)}</a>` : ''}
      </div>
      <button class="admin-toast-close" onclick="this.closest('.admin-toast').remove()" aria-label="Dismiss">&times;</button>
    `;
    stack.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'aToastOut .22s ease forwards';
      setTimeout(() => toast.remove(), 230);
    }, 6000);
  }

  /* ── UPDATE BELL UI ── */
  function updateBellUi(pending) {
    const badge = document.getElementById('notif-badge');
    const listEl = document.getElementById('notif-dd-list');
    if (badge) {
      if (pending.length) { badge.textContent = pending.length > 9 ? '9+' : pending.length; badge.style.display = 'flex'; }
      else { badge.style.display = 'none'; }
    }
    if (listEl) {
      listEl.innerHTML = pending.length
        ? pending.slice(0, 8).map(r => `<div class="notif-dd-item" onclick="window.location='/admin/access-requests.html'">
            <div class="notif-dd-dot"></div>
            <div class="notif-dd-text">
              <div class="notif-dd-title">${escHtml(r.candidate_name || r.candidate_email || 'Candidate')}</div>
              <div class="notif-dd-sub">${escHtml(r.exam_title || 'Exam')} &mdash; ${fmtRelative(r.created_at)}</div>
            </div>
          </div>`).join('')
        : '<div class="notif-dd-empty">No pending requests</div>';
    }
    // Update sidebar badge too
    const sbBadge = document.getElementById('sb-ar-badge');
    if (sbBadge) { sbBadge.textContent = pending.length; sbBadge.style.display = pending.length ? '' : 'none'; }
  }

  /* ── POLL ── */
  async function pollNotifications() {
    try {
      const r = await fetch('/api/exams/access-requests/all?status=pending', { credentials: 'include' });
      if (!r.ok) return;
      const pending = await r.json();
      const seen = getSeenIds();
      const newOnes = pending.filter(req => !seen.has(req.id));
      newOnes.forEach(req => {
        addSeenId(req.id);
        showAdminToast(
          'New access request',
          `${req.candidate_name || req.candidate_email || 'Candidate'} → ${req.exam_title || 'Exam'}`,
          'default', 'Review →', '/admin/access-requests.html'
        );
      });
      updateBellUi(pending);
    } catch (e) {}
  }

  /* ── BRANDING ── */
  async function applyBranding() {
    try {
      const r = await fetch('/api/settings/branding', { credentials: 'include' });
      if (!r.ok) return;
      const b = await r.json();
      const appName = b.app_name || 'Alaric Exam';
      const brandEl = document.querySelector('#sidebar .brand');
      if (brandEl) {
        const svg = brandEl.querySelector('svg');
        brandEl.innerHTML = (svg ? svg.outerHTML : '') + escHtml(appName);
      }
      const titlePart = document.title.includes('—') ? document.title.split('—')[0].trim() : document.title;
      document.title = titlePart + ' — ' + appName;
    } catch(e) {}
  }

  /* ── INIT ── */
  function init() {
    injectBell();
    applyBranding();
    pollNotifications();
    setInterval(pollNotifications, 12000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
