// Shared admin utilities — loaded on every admin page
(function () {
  'use strict';

  /* ── HELPERS ── */
  function escHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
  function fmtRelative(ts) {
    if (!ts) return '';
    const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
  }
  function getSeenIds() {
    try { return new Set(JSON.parse(localStorage.getItem('_notif_seen_ids') || '[]')); } catch { return new Set(); }
  }
  function markSeen(id) {
    const seen = getSeenIds(); seen.add(id);
    const arr = Array.from(seen); if (arr.length > 500) arr.splice(0, arr.length - 500);
    localStorage.setItem('_notif_seen_ids', JSON.stringify(arr));
  }
  function markAllSeen(items) { items.forEach(n => markSeen(n.id)); }

  const TYPE_META = {
    access_request: { icon: '📩', color: '#0078d4', label: 'Access request' },
    submission:     { icon: '📝', color: '#107c10', label: 'Submission'     },
    candidate:      { icon: '👤', color: '#7c3aed', label: 'New registration'},
    flag:           { icon: '⚠️', color: '#d97706', label: 'Risk flagged'   },
  };

  /* ── STYLES ── */
  function injectStyles() {
    if (document.getElementById('admin-notif-styles')) return;
    const s = document.createElement('style');
    s.id = 'admin-notif-styles';
    s.textContent = `
#notif-bell-wrap{position:relative;display:inline-flex}
#notif-bell{background:none;border:none;cursor:pointer;padding:5px 7px;border-radius:6px;color:var(--gray,#666);transition:background .15s;display:flex;align-items:center}
#notif-bell:hover{background:rgba(0,0,0,.07)}
#notif-bell svg{width:20px;height:20px}
#notif-badge{position:absolute;top:2px;right:2px;min-width:16px;height:16px;background:#e3503e;color:#fff;font-size:10px;font-weight:700;border-radius:8px;display:none;align-items:center;justify-content:center;padding:0 3px;line-height:1}
#notif-dropdown{position:absolute;top:calc(100% + 8px);right:0;width:340px;background:#fff;border:1px solid #e0e0e0;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.16);z-index:9000;display:none;overflow:hidden}
#notif-dropdown.open{display:block}
.notif-dd-header{padding:11px 14px;font-size:.72rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between}
.notif-dd-header a{font-size:.75rem;color:#0078d4;font-weight:600;text-decoration:none;text-transform:none;letter-spacing:0;cursor:pointer}
.notif-dd-header a:hover{text-decoration:underline}
.notif-dd-list{max-height:320px;overflow-y:auto}
.notif-dd-item{padding:10px 14px;border-bottom:1px solid #f5f5f5;cursor:pointer;transition:background .12s;display:flex;align-items:flex-start;gap:10px}
.notif-dd-item:hover{background:#f7f9fc}
.notif-dd-item:last-child{border-bottom:none}
.notif-dd-item.is-new .notif-dd-icon::after{content:'';position:absolute;top:0;right:0;width:7px;height:7px;border-radius:50%;background:#e3503e;border:1.5px solid #fff}
.notif-dd-icon{position:relative;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:.95rem;flex-shrink:0}
.notif-dd-text{flex:1;min-width:0}
.notif-dd-title{font-size:.8rem;font-weight:600;color:#1b1a19;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.notif-dd-sub{font-size:.72rem;color:#888;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.notif-dd-empty{padding:28px 16px;text-align:center;color:#bbb;font-size:.82rem}
.notif-dd-empty-icon{font-size:1.8rem;display:block;margin-bottom:6px}
#admin-toast-stack{position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.admin-toast{background:#fff;border:1px solid #e0e0e0;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.15);padding:12px 14px 12px 12px;min-width:290px;max-width:360px;display:flex;align-items:flex-start;gap:10px;pointer-events:auto;animation:aToastIn .22s ease;border-left:4px solid #0078d4}
.admin-toast.toast-success{border-left-color:#107c10}
.admin-toast.toast-error{border-left-color:#d13438}
.admin-toast.toast-warning{border-left-color:#ca5010}
.admin-toast-icon{flex-shrink:0;font-size:1.1rem;margin-top:1px}
.admin-toast-body{flex:1;min-width:0}
.admin-toast-msg{font-size:.8125rem;font-weight:700;color:#1b1a19;line-height:1.35}
.admin-toast-sub{font-size:.75rem;color:#666;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.admin-toast-action{display:inline-block;margin-top:5px;font-size:.78rem;color:#0078d4;text-decoration:none;font-weight:600;background:none;border:none;padding:0;cursor:pointer}
.admin-toast-action:hover{text-decoration:underline}
.admin-toast-close{background:none;border:none;cursor:pointer;color:#bbb;font-size:1.1rem;line-height:1;padding:0 2px;flex-shrink:0;transition:color .12s;align-self:flex-start}
.admin-toast-close:hover{color:#333}
@keyframes aToastIn{from{opacity:0;transform:translateX(28px)}to{opacity:1;transform:none}}
@keyframes aToastOut{from{opacity:1}to{opacity:0;transform:translateX(28px)}}
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
          <span>Notifications</span>
          <a id="notif-mark-all" onclick="window._notifMarkAll && window._notifMarkAll()">Mark all read</a>
        </div>
        <div class="notif-dd-list" id="notif-dd-list">
          <div class="notif-dd-empty"><span class="notif-dd-empty-icon">🔔</span>No notifications</div>
        </div>
      </div>
    `;

    const logoutBtn = actions.querySelector('[id*="logout"],[id*="Logout"]') || actions.lastElementChild;
    if (logoutBtn) actions.insertBefore(wrap, logoutBtn);
    else actions.prepend(wrap);

    const bell = document.getElementById('notif-bell');
    const dropdown = document.getElementById('notif-dropdown');
    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) dropdown.classList.remove('open');
    });

    if (!document.getElementById('admin-toast-stack')) {
      const stack = document.createElement('div');
      stack.id = 'admin-toast-stack';
      document.body.appendChild(stack);
    }
  }

  /* ── TOAST ── */
  function showAdminToast(msg, sub, type, actionText, actionHref) {
    let stack = document.getElementById('admin-toast-stack');
    if (!stack) { stack = document.createElement('div'); stack.id = 'admin-toast-stack'; document.body.appendChild(stack); }
    const toast = document.createElement('div');
    toast.className = 'admin-toast' + (type && type !== 'default' ? ' toast-' + type : '');
    const meta = TYPE_META[type] || {};
    const icon = meta.icon || '🔔';
    toast.innerHTML = `
      <div class="admin-toast-icon">${escHtml(icon)}</div>
      <div class="admin-toast-body">
        <div class="admin-toast-msg">${escHtml(msg)}</div>
        ${sub ? `<div class="admin-toast-sub">${escHtml(sub)}</div>` : ''}
        ${actionText ? `<a class="admin-toast-action" href="${escHtml(actionHref || '#')}">${escHtml(actionText)}</a>` : ''}
      </div>
      <button class="admin-toast-close" aria-label="Dismiss">&times;</button>
    `;
    toast.querySelector('.admin-toast-close').addEventListener('click', () => toast.remove());
    stack.appendChild(toast);
    setTimeout(() => {
      if (!toast.parentNode) return;
      toast.style.animation = 'aToastOut .22s ease forwards';
      setTimeout(() => toast.remove(), 230);
    }, 6000);
  }

  /* ── UPDATE BELL UI ── */
  let _allNotifs = [];
  function updateBellUi(items) {
    _allNotifs = items;
    const seen = getSeenIds();
    const unread = items.filter(n => !seen.has(n.id));
    const badge = document.getElementById('notif-badge');
    if (badge) {
      if (unread.length) { badge.textContent = unread.length > 9 ? '9+' : unread.length; badge.style.display = 'flex'; }
      else badge.style.display = 'none';
    }
    const listEl = document.getElementById('notif-dd-list');
    if (listEl) {
      if (!items.length) {
        listEl.innerHTML = '<div class="notif-dd-empty"><span class="notif-dd-empty-icon">🔔</span>All caught up!</div>';
      } else {
        listEl.innerHTML = items.slice(0, 12).map(n => {
          const meta = TYPE_META[n.type] || { icon: '🔔', color: '#0078d4', label: n.type };
          const isNew = !seen.has(n.id);
          return `<div class="notif-dd-item${isNew ? ' is-new' : ''}" onclick="window.location='${escHtml(n.href || '#')}'">
            <div class="notif-dd-icon" style="background:${meta.color}18">${meta.icon}</div>
            <div class="notif-dd-text">
              <div class="notif-dd-title">${escHtml(n.body)}</div>
              <div class="notif-dd-sub">${escHtml(meta.label)} · ${fmtRelative(n.created_at)}</div>
            </div>
          </div>`;
        }).join('');
      }
    }
    // Sidebar access-requests badge (backwards compat)
    const sbBadge = document.getElementById('sb-ar-badge');
    if (sbBadge) {
      const arCount = items.filter(n => n.type === 'access_request' && !seen.has(n.id)).length;
      sbBadge.textContent = arCount; sbBadge.style.display = arCount ? '' : 'none';
    }
  }

  window._notifMarkAll = function () {
    markAllSeen(_allNotifs);
    updateBellUi(_allNotifs);
    document.getElementById('notif-dropdown')?.classList.remove('open');
  };

  /* ── POLL ── */
  async function pollNotifications() {
    try {
      const r = await fetch('/api/settings/notifications', { credentials: 'include' });
      if (!r.ok) return;
      const items = await r.json();
      const seen = getSeenIds();
      const newOnes = items.filter(n => !seen.has(n.id));
      newOnes.forEach(n => {
        const meta = TYPE_META[n.type] || { label: n.type };
        markSeen(n.id);
        showAdminToast(meta.label, n.body, n.type, 'View →', n.href || '#');
      });
      updateBellUi(items);
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

  /* ── CONFIRM MODAL ── */
  function injectConfirmModal() {
    if (document.getElementById('_sc-overlay')) return;
    const s = document.createElement('style');
    s.textContent = `
#_sc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99100;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .18s}
#_sc-overlay.sc-show{opacity:1;pointer-events:auto}
#_sc-box{background:#fff;border-radius:12px;width:92%;max-width:440px;box-shadow:0 12px 40px rgba(0,0,0,.22);transform:scale(.95) translateY(-8px);transition:transform .18s,opacity .18s;overflow:hidden}
#_sc-overlay.sc-show #_sc-box{transform:scale(1) translateY(0)}
#_sc-head{padding:18px 20px 0;display:flex;align-items:center;gap:10px}
#_sc-icon{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:1.15rem;flex-shrink:0}
#_sc-title{font-size:.9375rem;font-weight:700;color:#1b1a19;margin:0}
#_sc-body{padding:10px 20px 20px 20px}
#_sc-msg{font-size:.8375rem;color:#444;line-height:1.6;margin:0}
#_sc-foot{padding:0 20px 18px;display:flex;justify-content:flex-end;gap:8px}
#_sc-cancel{background:#f3f2f1;border:1px solid #e0e0e0;border-radius:7px;padding:7px 16px;font-size:.8125rem;font-weight:600;color:#444;cursor:pointer;transition:background .12s}
#_sc-cancel:hover{background:#e8e6e4}
#_sc-ok{border:none;border-radius:7px;padding:7px 18px;font-size:.8125rem;font-weight:700;cursor:pointer;transition:background .12s,opacity .12s;min-width:80px}
#_sc-ok.sc-danger{background:#d13438;color:#fff}
#_sc-ok.sc-danger:hover{background:#a4262c}
#_sc-ok.sc-primary{background:#0078d4;color:#fff}
#_sc-ok.sc-primary:hover{background:#005a9e}
#_sc-ok:disabled{opacity:.5;cursor:not-allowed}
    `;
    document.head.appendChild(s);
    const el = document.createElement('div');
    el.id = '_sc-overlay';
    el.innerHTML = `<div id="_sc-box"><div id="_sc-head"><div id="_sc-icon"></div><h3 id="_sc-title">Confirm</h3></div><div id="_sc-body"><p id="_sc-msg"></p></div><div id="_sc-foot"><button id="_sc-cancel">Cancel</button><button id="_sc-ok" class="sc-primary">Confirm</button></div></div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) _scClose(false); });
    document.getElementById('_sc-cancel').addEventListener('click', () => _scClose(false));
    document.getElementById('_sc-ok').addEventListener('click', async () => {
      const btn = document.getElementById('_sc-ok');
      btn.disabled = true;
      if (window._scCb) await window._scCb();
      _scClose(null);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.getElementById('_sc-overlay').classList.contains('sc-show')) _scClose(false);
    });
  }
  function _scClose(run) {
    const el = document.getElementById('_sc-overlay');
    if (el) el.classList.remove('sc-show');
    window._scCb = null;
  }
  window.showConfirm = function(message, onConfirm, { title = 'Confirm', danger = false, confirmText, icon } = {}) {
    injectConfirmModal();
    window._scCb = onConfirm;
    const defIcon = danger ? '⚠️' : 'ℹ️';
    const iconEl = document.getElementById('_sc-icon');
    iconEl.textContent = icon || defIcon;
    iconEl.style.background = danger ? '#fde7e9' : '#eff6ff';
    document.getElementById('_sc-title').textContent = title;
    document.getElementById('_sc-msg').textContent = message;
    const btn = document.getElementById('_sc-ok');
    btn.textContent = confirmText || (danger ? 'Delete' : 'Confirm');
    btn.className = danger ? 'sc-danger' : 'sc-primary';
    btn.disabled = false;
    document.getElementById('_sc-overlay').classList.add('sc-show');
  };

  /* ── LIVE WS NOTIFICATIONS (works on every admin page) ─────────────────── */
  let _liveWs       = null;
  let _liveWsTimer  = null;
  let _knownWait    = new Set();   // tokens already seen — avoid dupe toasts
  let _monitorBadge = null;        // injected badge on sidebar Live Monitor link

  function _getOrCreateMonitorBadge() {
    if (_monitorBadge && _monitorBadge.isConnected) return _monitorBadge;
    // Find the Live Monitor nav link and attach a badge
    const link = Array.from(document.querySelectorAll('#sidebar nav a'))
      .find(a => a.href && a.href.includes('/admin/monitor'));
    if (!link) return null;
    let b = link.querySelector('.sb-monitor-badge');
    if (!b) {
      b = document.createElement('span');
      b.className = 'sb-monitor-badge';
      b.style.cssText = 'display:none;background:#ef4444;color:#fff;font-size:10px;font-weight:700;border-radius:10px;padding:1px 6px;margin-left:4px;vertical-align:middle';
      link.appendChild(b);
    }
    _monitorBadge = b;
    return b;
  }

  function _setMonitorBadge(n) {
    const b = _getOrCreateMonitorBadge();
    if (!b) return;
    if (n > 0) { b.textContent = n > 99 ? '99+' : n; b.style.display = ''; }
    else b.style.display = 'none';
  }

  function _handleWaitingList(candidates) {
    const newArrivals = candidates.filter(c => !_knownWait.has(c.token));
    // Reset known set to current list
    _knownWait = new Set(candidates.map(c => c.token));

    newArrivals.forEach(c => {
      showAdminToast(
        `🔐 ${c.candidateName || 'Candidate'} is waiting`,
        `${c.examTitle || 'Exam'} — identity verification required`,
        'access_request',
        'Open Live Monitor →',
        '/admin/monitor'
      );
      // Browser notification (if granted)
      if (window.Notification && Notification.permission === 'granted') {
        new Notification('Candidate Waiting', {
          body: `${c.candidateName || 'Candidate'} is waiting for ID verification`,
          icon: '/favicon.ico',
        });
      }
    });

    _setMonitorBadge(candidates.length);
  }

  function _handleSessionsList(sessions) {
    const active = (sessions || []).filter(s => !s.disconnected).length;
    const waiting = _knownWait.size;
    _setMonitorBadge(waiting + active);
  }

  function _connectLiveWs() {
    if (_liveWs && _liveWs.readyState < 2) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    _liveWs = ws;

    ws.onopen = () => { clearTimeout(_liveWsTimer); };

    ws.onmessage = e => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }

      // auth_ok includes the initial waiting room state
      if (msg.type === 'auth_ok') {
        _handleWaitingList(msg.waitingCandidates || []);
        _handleSessionsList(msg.sessions || []);
      }
      if (msg.type === 'waiting_list') {
        _handleWaitingList(msg.candidates || []);
      }
      if (msg.type === 'sessions_list') {
        _handleSessionsList(msg.sessions || []);
      }
      // A new candidate entered the waiting room
      if (msg.type === 'proctor_join_ok') {
        // Proctor already joined — no extra toast needed
      }
    };

    ws.onclose = () => {
      _liveWsTimer = setTimeout(_connectLiveWs, 5000);
    };
    ws.onerror = () => {};
  }

  // Expose for live monitor bridge (monitor has its own WS but needs the badge)
  window._handleWaitingList = _handleWaitingList;

  /* ── REQUEST BROWSER NOTIFICATION PERMISSION ── */
  function _requestNotifPermission() {
    if (window.Notification && Notification.permission === 'default') {
      // Only ask if user interacts — use a subtle toast first
      setTimeout(() => {
        showAdminToast(
          'Enable desktop notifications?',
          'Get alerts when candidates are waiting for verification',
          'default',
          'Allow →',
          '#'
        );
        // Override the action click to request permission
        const stack = document.getElementById('admin-toast-stack');
        if (stack) {
          const btn = stack.querySelector('.admin-toast-action');
          if (btn) btn.onclick = (e) => {
            e.preventDefault();
            Notification.requestPermission();
            btn.closest('.admin-toast')?.remove();
          };
        }
      }, 3000);
    }
  }

  /* ── INIT ── */
  function init() {
    injectBell();
    applyBranding();
    pollNotifications();
    setInterval(pollNotifications, 30000);
    // Real-time WS — fires on every admin page except live monitor
    // (monitor has its own WS; skip to avoid duplicate connections)
    if (!location.pathname.startsWith('/admin/monitor')) {
      _connectLiveWs();
      _requestNotifPermission();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
