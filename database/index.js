const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || './database/alaric.db';

let db;

function getDb() {
  if (!db) {
    db = new Database(path.resolve(DB_PATH));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDb() {
  const d = getDb();
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Split on ; but not inside quoted strings
  const stmts = splitSql(schema).map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of stmts) {
    try {
      d.prepare(stmt).run();
    } catch (e) {
      // ignore "already exists" errors
      if (!e.message.includes('already exists') && !e.message.includes('UNIQUE') && !e.message.includes('duplicate column name')) {
        console.error('Schema error:', e.message, '\nStatement:', stmt.substring(0, 80));
      }
    }
  }
  // JS migration: expand email_profiles to support api_key + resend/sendgrid providers
  migrateEmailProfiles(d);
  // JS migration: one_time_link flag on exam_links
  try { d.exec(`ALTER TABLE exam_links ADD COLUMN one_time_link INTEGER DEFAULT 1`); } catch(e) { /* already exists */ }
  // JS migration: exam events log table
  try { d.exec(`CREATE TABLE IF NOT EXISTS exam_events (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE, event_type TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}
  try { d.exec(`CREATE INDEX IF NOT EXISTS idx_exam_events_sub ON exam_events(submission_id)`); } catch(e) {}
  // JS migration: add password_hash column to candidates
  try { d.exec(`ALTER TABLE candidates ADD COLUMN password_hash TEXT`); } catch(e) { /* already exists */ }
  // JS migration: extended candidate profile fields
  const candidateExtras = ['organization', 'address', 'city', 'state', 'country', 'postal_code', 'photo'];
  for (const col of candidateExtras) {
    try { d.exec(`ALTER TABLE candidates ADD COLUMN ${col} TEXT`); } catch(e) { /* already exists */ }
  }
  // JS migration: phone_verified flag on candidates
  try { d.exec(`ALTER TABLE candidates ADD COLUMN phone_verified INTEGER DEFAULT 0`); } catch(e) {}
  // Geo tables + seed
  d.exec(`CREATE TABLE IF NOT EXISTS geo_countries (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, iso2 TEXT UNIQUE, phone_code TEXT, is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0)`);
  d.exec(`CREATE TABLE IF NOT EXISTS geo_states (id INTEGER PRIMARY KEY AUTOINCREMENT, country_id INTEGER NOT NULL REFERENCES geo_countries(id) ON DELETE CASCADE, name TEXT NOT NULL, code TEXT, is_active INTEGER DEFAULT 1)`);
  d.exec(`CREATE TABLE IF NOT EXISTS geo_cities (id INTEGER PRIMARY KEY AUTOINCREMENT, country_id INTEGER NOT NULL, state_id INTEGER REFERENCES geo_states(id) ON DELETE SET NULL, name TEXT NOT NULL, is_active INTEGER DEFAULT 1)`);
  const { seedGeo } = require('./geo-seed');
  seedGeo(d);
  // Seed default super admin if none exists
  try {
    const adminExists = d.prepare("SELECT id FROM users WHERE role='super_admin' LIMIT 1").get();
    if (!adminExists) {
      const hash = bcrypt.hashSync('Admin@1234', 12);
      d.prepare("INSERT INTO users(username, email, password_hash, full_name, role) VALUES('admin','admin@alaric.local',?,'Super Admin','super_admin')").run(hash);
      console.log('Database: default admin created (admin / Admin@1234)');
    }
  } catch(e) { console.error('Database: admin seed failed:', e.message); }
  // Seed default departments if none exist
  try {
    const deptExists = d.prepare('SELECT id FROM departments LIMIT 1').get();
    if (!deptExists) {
      const ins = d.prepare('INSERT OR IGNORE INTO departments(name, code) VALUES(?,?)');
      for (const [n, c] of [['Engineering','ENG'],['Finance','FIN'],['Human Resources','HR'],['Operations','OPS'],['Sales','SALES']]) ins.run(n, c);
      console.log('Database: default departments created');
    }
  } catch(e) {}
  // Seed app_url from APP_URL env var if not set
  try {
    const appUrl = process.env.APP_URL || '';
    if (appUrl) d.prepare("INSERT OR IGNORE INTO settings(key, value, description) VALUES('app_url',?,'Public base URL of the platform (e.g. https://alaric-exam.onrender.com)')").run(appUrl);
    else d.prepare("INSERT OR IGNORE INTO settings(key, value, description) VALUES('app_url','','Public base URL of the platform (e.g. https://alaric-exam.onrender.com)')").run();
  } catch(e) {}
  // JS migration: is_abandoned flag on submissions
  try { d.exec(`ALTER TABLE submissions ADD COLUMN is_abandoned INTEGER DEFAULT 0`); } catch(e) {}
  // JS migration: screen monitoring consent gate per exam
  try { d.exec(`ALTER TABLE exams ADD COLUMN require_screen_consent INTEGER DEFAULT 0`); } catch(e) {}
  // JS migration: per-exam Secure Browser pre-check toggles (1=required, 0=skipped)
  for (const col of ['check_antivirus','check_firewall','check_processes','check_services',
                      'check_vm','check_remote','check_displays','check_camera','check_mic']) {
    try { d.exec(`ALTER TABLE exams ADD COLUMN ${col} INTEGER DEFAULT 1`); } catch(e) {}
  }
  // JS migration: display control mode (0=software disconnect only, 1=require physical cable removal)
  try { d.exec(`ALTER TABLE exams ADD COLUMN display_control_mode INTEGER DEFAULT 0`); } catch(e) {}
  // JS migration: violation / flag monitoring settings
  // max_tab_switches: 0 = disabled (no auto-submit), 1-99 = limit (default 3)
  try { d.exec(`ALTER TABLE exams ADD COLUMN max_tab_switches INTEGER DEFAULT 3`); } catch(e) {}
  // JS migration: pre-exam identity + environment verification
  try { d.exec(`CREATE TABLE IF NOT EXISTS exam_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_code TEXT NOT NULL UNIQUE,
    link_token TEXT NOT NULL,
    candidate_name TEXT,
    candidate_email TEXT,
    exam_title TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','photos_submitted','approved','rejected')),
    photo_id_front TEXT,
    photo_id_back TEXT,
    photo_face TEXT,
    photo_desk_front TEXT,
    photo_desk_back TEXT,
    photo_desk_left TEXT,
    photo_desk_right TEXT,
    reject_reason TEXT,
    approved_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`); } catch(e) {}
  try { d.exec(`CREATE INDEX IF NOT EXISTS idx_ev_token ON exam_verifications(link_token)`); } catch(e) {}
  try { d.exec(`CREATE INDEX IF NOT EXISTS idx_ev_code  ON exam_verifications(session_code)`); } catch(e) {}
  // JS migration: exam chat log table (proctor ↔ candidate messages during exam)
  try { d.exec(`CREATE TABLE IF NOT EXISTS exam_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK(sender IN ('candidate','proctor')),
    sender_name TEXT,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`); } catch(e) {}
  try { d.exec(`CREATE INDEX IF NOT EXISTS idx_exam_chats_sub ON exam_chats(submission_id)`); } catch(e) {}
  // JS migration: exam recordings table (webcam video + screen recordings)
  try { d.exec(`CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('webcam','screen')),
    file_path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`); } catch(e) {}
  try { d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_sub_type ON recordings(submission_id, type)`); } catch(e) {}
  // JS migration: recycle bin tables
  try { d.exec(`CREATE TABLE IF NOT EXISTS deleted_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_type TEXT NOT NULL,
    record_id INTEGER,
    record_data TEXT NOT NULL,
    deleted_by INTEGER,
    deleted_by_name TEXT,
    deleted_at TEXT DEFAULT (datetime('now')),
    scheduled_purge_at TEXT
  )`); } catch(e) {}
  try { d.exec(`CREATE INDEX IF NOT EXISTS idx_deleted_records_type ON deleted_records(record_type)`); } catch(e) {}
  try { d.exec(`CREATE TABLE IF NOT EXISTS deletion_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_type TEXT NOT NULL,
    record_id INTEGER,
    summary TEXT,
    deleted_by_id INTEGER,
    deleted_by_name TEXT,
    originally_deleted_at TEXT,
    purged_by_id INTEGER,
    purged_by_name TEXT,
    purged_at TEXT DEFAULT (datetime('now')),
    purge_reason TEXT DEFAULT 'manual'
  )`); } catch(e) {}
  try { d.exec(`INSERT OR IGNORE INTO settings(key, value, description) VALUES('recycle_bin_days','30','Days before auto-permanent-delete (0 = never)')`); } catch(e) {}
  // Seed default URL slugs for portal and catalog
  try { d.exec(`INSERT OR IGNORE INTO settings(key, value, description) VALUES('portal_slug','portal','URL path slug for the candidate portal')`); } catch(e) {}
  try { d.exec(`INSERT OR IGNORE INTO settings(key, value, description) VALUES('catalog_slug','catalog','URL path slug for the exam catalog')`); } catch(e) {}
  // JS migration: test candidate for portal demos
  try {
    const existing = d.prepare("SELECT id FROM candidates WHERE email='test@test.com'").get();
    if (!existing) {
      const hash = bcrypt.hashSync('Test@1234', 10);
      d.prepare("INSERT INTO candidates(name, email, password_hash, is_active, created_at, updated_at) VALUES('Test Candidate','test@test.com',?,1,datetime('now'),datetime('now'))").run(hash);
      console.log('Database: test candidate created (test@test.com / Test@1234)');
    }
  } catch(e) { console.error('Database: test candidate seed failed:', e.message); }
  console.log('Database initialized at', path.resolve(DB_PATH));
}

function migrateEmailProfiles(d) {
  try {
    const row = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='email_profiles'").get();
    if (!row || row.sql.includes("'resend'")) return; // not yet created or already migrated
    d.transaction(() => {
      d.prepare(`CREATE TABLE IF NOT EXISTS _ep_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        provider TEXT DEFAULT 'smtp' CHECK(provider IN ('azure_graph','smtp','resend','sendgrid')),
        tenant_id TEXT, client_id TEXT, client_secret TEXT,
        from_email TEXT, from_name TEXT, reply_to TEXT,
        smtp_host TEXT, smtp_port INTEGER, smtp_user TEXT, smtp_pass TEXT,
        smtp_secure INTEGER DEFAULT 1, api_key TEXT,
        is_default INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      )`).run();
      d.prepare(`INSERT OR IGNORE INTO _ep_v2(id,name,provider,tenant_id,client_id,client_secret,
        from_email,from_name,reply_to,smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure,
        api_key,is_default,is_active,created_at,updated_at)
        SELECT id,name,provider,tenant_id,client_id,client_secret,
          from_email,from_name,reply_to,smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure,
          NULL,is_default,is_active,created_at,updated_at FROM email_profiles`).run();
      d.prepare('DROP TABLE email_profiles').run();
      d.prepare('ALTER TABLE _ep_v2 RENAME TO email_profiles').run();
    })();
    console.log('Database: email_profiles migrated (api_key + resend/sendgrid support)');
  } catch (e) {
    console.error('Database: email_profiles migration failed:', e.message);
  }
}

function splitSql(sql) {
  const stmts = [];
  let cur = '', inStr = false, strChar = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (!inStr && (c === "'" || c === '"')) { inStr = true; strChar = c; cur += c; }
    else if (inStr && c === strChar) {
      cur += c;
      if (sql[i + 1] === strChar) { cur += sql[++i]; } // escaped quote
      else inStr = false;
    } else if (!inStr && c === ';') {
      const t = cur.trim(); if (t) stmts.push(t); cur = '';
    } else { cur += c; }
  }
  const t = cur.trim(); if (t) stmts.push(t);
  return stmts;
}

module.exports = { getDb, initDb };
