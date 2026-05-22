require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const path = require('path');
const { initDb } = require('./database/index');

const app = express();
const PORT = process.env.PORT || 3000;

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
app.use('/exam', require('./src/routes/examPublic'));

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

// Custom URL slug routes — read from DB settings once at startup
;(function registerCustomSlugs() {
  try {
    const { getDb } = require('./database/index');
    const db = getDb();
    const portalSlug = db.prepare("SELECT value FROM settings WHERE key='portal_slug'").get()?.value || 'portal';
    const catalogSlug = db.prepare("SELECT value FROM settings WHERE key='catalog_slug'").get()?.value || 'catalog';
    if (portalSlug !== 'portal') {
      app.get(`/${portalSlug}`, (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal', 'index.html')));
      app.get(`/${portalSlug}/*`, (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal', 'index.html')));
      console.log(`  Custom portal slug: /${portalSlug} → /portal`);
    }
    if (catalogSlug !== 'catalog') {
      app.get(`/${catalogSlug}`, (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalog', 'index.html')));
      console.log(`  Custom catalog slug: /${catalogSlug} → /catalog`);
    }
  } catch(e) { /* DB not ready yet — default slugs in use */ }
}());

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\nAlaric Exam running at http://localhost:${PORT}`);
  console.log(`  Admin panel: http://localhost:${PORT}/admin`);
  console.log(`  Candidate portal: http://localhost:${PORT}/portal`);
  console.log(`  Public catalog: http://localhost:${PORT}/catalog`);
  console.log(`\nDefault login: admin / Admin@1234 — change this!\n`);
});
