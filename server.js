require('dotenv').config();
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const path = require('path');
const { WebSocketServer } = require('ws');
const { initDb, getDb } = require('./database/index');
const { setupMonitor } = require('./src/ws/monitor');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_START = Date.now();

// Init DB
initDb();

// Security headers (relaxed for local dev)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // required for OAuth popups
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/exams', require('./src/routes/exams'));
app.use('/api/questions', require('./src/routes/questions'));
app.use('/api/candidates', require('./src/routes/candidates'));
app.use('/api/submissions', require('./src/routes/submissions'));
app.use('/api/checker', require('./src/routes/checker'));
app.use('/api/analytics', require('./src/routes/analytics'));
app.use('/api/settings', require('./src/routes/settings'));
app.use('/api/geo', require('./src/routes/geo'));
app.use('/api/question-bank', require('./src/routes/questionBank'));
app.use('/api/portal', require('./src/routes/portal'));
app.use('/api/catalog', require('./src/routes/catalog'));
app.use('/api/recycle', require('./src/routes/recycle'));
app.use('/exam', require('./src/routes/examPublic'));

// Health endpoint — used by admin panel to detect Render deploys
app.get('/api/health', (req, res) => res.json({ ok: true, started: SERVER_START, uptime: Math.floor(process.uptime()) }));

// SPA fallback — serve admin shell for /admin/* paths
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html')));
app.get('/admin/*', (req, res) => {
  const pg = req.path.replace('/admin/', '');
  const file = path.join(__dirname, 'public', 'admin', pg.endsWith('.html') ? pg : `${pg}.html`);
  const fs = require('fs');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html'));
});
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal', 'index.html')));
app.get('/portal/oauth-callback', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal', 'oauth-callback.html')));
app.get('/portal/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal', 'index.html')));
app.get('/catalog', (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalog', 'index.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register', 'index.html')));
app.get('/e/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'exam', 'index.html')));

// Dynamic custom slug middleware — reads from DB with 10s cache, no restart needed
let _slugCache = null, _slugCacheAt = 0;
app.use((req, res, next) => {
  const now = Date.now();
  if (!_slugCache || now - _slugCacheAt > 10000) {
    try {
      const db = getDb();
      _slugCache = {
        portal:  db.prepare("SELECT value FROM settings WHERE key='portal_slug'").get()?.value  || 'portal',
        catalog: db.prepare("SELECT value FROM settings WHERE key='catalog_slug'").get()?.value || 'catalog',
      };
    } catch(e) { _slugCache = { portal: 'portal', catalog: 'catalog' }; }
    _slugCacheAt = now;
  }
  const p = req.path;
  if (_slugCache.portal !== 'portal' && (p === `/${_slugCache.portal}` || p.startsWith(`/${_slugCache.portal}/`))) {
    return res.sendFile(path.join(__dirname, 'public', 'portal', 'index.html'));
  }
  if (_slugCache.catalog !== 'catalog' && p === `/${_slugCache.catalog}`) {
    return res.sendFile(path.join(__dirname, 'public', 'catalog', 'index.html'));
  }
  next();
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
setupMonitor(wss);

server.listen(PORT, () => {
  console.log(`\nAlaric Exam running at http://localhost:${PORT}`);
  console.log(`  Admin panel: http://localhost:${PORT}/admin`);
  console.log(`  Candidate portal: http://localhost:${PORT}/portal`);
  console.log(`  Public catalog: http://localhost:${PORT}/catalog`);
  console.log(`\nDefault login: admin / Admin@1234 — change this!\n`);
});
