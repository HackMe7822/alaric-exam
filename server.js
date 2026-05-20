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
  crossOriginEmbedderPolicy: false
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
app.get('/portal/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal', 'index.html')));
app.get('/catalog', (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalog', 'index.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register', 'index.html')));
app.get('/e/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'exam', 'index.html')));

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
