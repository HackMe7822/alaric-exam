const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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
  // Execute each statement
  const stmts = schema.split(';').map(s => s.trim()).filter(s => s.length > 0);
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
  console.log('Database initialized at', path.resolve(DB_PATH));
}

module.exports = { getDb, initDb };
