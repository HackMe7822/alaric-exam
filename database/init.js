require('dotenv').config();
const { initDb, getDb } = require('./index');
const bcrypt = require('bcryptjs');

initDb();

const db = getDb();

// Create default super admin if none exists
const adminExists = db.prepare('SELECT id FROM users WHERE role=?').get('super_admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('Admin@1234', 12);
  db.prepare(`INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?,?,?,?,?)`)
    .run('admin', 'admin@alaric.local', hash, 'Super Admin', 'super_admin');
  console.log('Default admin created: admin / Admin@1234 — CHANGE THIS PASSWORD IMMEDIATELY');
}

// Insert default departments
const deptExists = db.prepare('SELECT id FROM departments LIMIT 1').get();
if (!deptExists) {
  const depts = [
    ['Engineering', 'ENG'],
    ['Finance', 'FIN'],
    ['Human Resources', 'HR'],
    ['Operations', 'OPS'],
    ['Sales', 'SALES']
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO departments(name, code) VALUES(?,?)');
  for (const [name, code] of depts) ins.run(name, code);
  console.log('Default departments created');
}

console.log('Initialization complete.');
process.exit(0);
