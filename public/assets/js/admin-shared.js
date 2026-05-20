// Shared admin utilities — loaded on every admin page

// Load pending access request count and update sidebar badge
(async function loadArSidebarBadge() {
  const el = document.getElementById('sb-ar-badge');
  if (!el) return;
  try {
    const r = await fetch('/api/exams/access-requests/all?status=pending', {credentials:'include'});
    if (!r.ok) return;
    const data = await r.json();
    el.textContent = data.length;
    el.style.display = data.length ? '' : 'none';
  } catch(e) {}
})();
