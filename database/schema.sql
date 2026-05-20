PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- 1. Users (admin panel users)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('super_admin','exam_manager','checker','viewer')),
  totp_secret TEXT,
  totp_enabled INTEGER DEFAULT 0,
  azure_id TEXT,
  is_active INTEGER DEFAULT 1,
  last_login TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 2. Sessions (JWT revocation list)
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jti TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER DEFAULT 0,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_jti ON sessions(jti);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 3. Departments
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT UNIQUE,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 4. Exams
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  instructions TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  total_marks REAL DEFAULT 0,
  pass_marks REAL DEFAULT 0,
  negative_marking REAL DEFAULT 0,
  shuffle_questions INTEGER DEFAULT 0,
  shuffle_options INTEGER DEFAULT 0,
  show_result_immediately INTEGER DEFAULT 1,
  allow_review INTEGER DEFAULT 1,
  max_attempts INTEGER DEFAULT 1,
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  start_date TEXT,
  end_date TEXT,
  is_public INTEGER DEFAULT 0,
  catalog_description TEXT,
  catalog_image TEXT,
  branding_logo TEXT,
  branding_color TEXT DEFAULT '#002B5C',
  certificate_template TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 5. Exam Sections
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER,
  marks_per_question REAL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sections_exam ON sections(exam_id);

-- 6. Questions
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  bank_id INTEGER REFERENCES question_bank(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK(type IN ('mcq','multi_mcq','text','drag_drop','match','fill_blank','hotspot','file_upload')),
  body TEXT NOT NULL,
  body_html TEXT,
  explanation TEXT,
  marks REAL DEFAULT 1,
  negative_marks REAL DEFAULT 0,
  time_limit_seconds INTEGER,
  difficulty TEXT DEFAULT 'medium' CHECK(difficulty IN ('easy','medium','hard')),
  tags TEXT,
  sort_order INTEGER DEFAULT 0,
  is_required INTEGER DEFAULT 1,
  version INTEGER DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_questions_section ON questions(section_id);

-- 7. Question Options (MCQ, match, drag-drop)
CREATE TABLE IF NOT EXISTS question_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  body_html TEXT,
  is_correct INTEGER DEFAULT 0,
  match_key TEXT,
  sort_order INTEGER DEFAULT 0,
  image_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_options_question ON question_options(question_id);

-- 8. Question Version History
CREATE TABLE IF NOT EXISTS question_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  changed_at TEXT DEFAULT (datetime('now'))
);

-- 9. Question Bank (standalone, reusable questions)
CREATE TABLE IF NOT EXISTS question_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT,
  subcategory TEXT,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  body_html TEXT,
  explanation TEXT,
  marks REAL DEFAULT 1,
  difficulty TEXT DEFAULT 'medium',
  tags TEXT,
  usage_count INTEGER DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 10. Question Bank Options
CREATE TABLE IF NOT EXISTS bank_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER NOT NULL REFERENCES question_bank(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  is_correct INTEGER DEFAULT 0,
  match_key TEXT,
  sort_order INTEGER DEFAULT 0
);

-- 11. Candidates
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  employee_id TEXT,
  department_id INTEGER REFERENCES departments(id),
  tags TEXT,
  notes TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates(email);

-- 12. Exam Links (one-time-use per candidate)
CREATE TABLE IF NOT EXISTS exam_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
  candidate_name TEXT,
  candidate_email TEXT,
  expires_at TEXT,
  used_at TEXT,
  is_used INTEGER DEFAULT 0,
  is_revoked INTEGER DEFAULT 0,
  ip_used TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_links_token ON exam_links(token);
CREATE INDEX IF NOT EXISTS idx_links_exam ON exam_links(exam_id);

-- 13. Submissions (exam attempts)
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER REFERENCES exam_links(id),
  exam_id INTEGER NOT NULL REFERENCES exams(id),
  candidate_id INTEGER REFERENCES candidates(id),
  candidate_name TEXT,
  candidate_email TEXT,
  status TEXT DEFAULT 'in_progress' CHECK(status IN ('in_progress','submitted','auto_submitted','grading','graded','published')),
  started_at TEXT DEFAULT (datetime('now')),
  submitted_at TEXT,
  time_taken_seconds INTEGER,
  auto_score REAL DEFAULT 0,
  manual_score REAL,
  final_score REAL,
  pass_fail TEXT CHECK(pass_fail IN ('pass','fail',NULL)),
  result_released INTEGER DEFAULT 0,
  ip_address TEXT,
  browser TEXT,
  integrity_flags TEXT,
  tab_switches INTEGER DEFAULT 0,
  fullscreen_exits INTEGER DEFAULT 0,
  snapshot_count INTEGER DEFAULT 0,
  ai_paste_count INTEGER DEFAULT 0,
  risk_level TEXT DEFAULT 'low' CHECK(risk_level IN ('low','medium','high')),
  review_notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_submissions_exam ON submissions(exam_id);
CREATE INDEX IF NOT EXISTS idx_submissions_candidate ON submissions(candidate_id);

-- 14. Answers
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  response TEXT,
  file_path TEXT,
  is_flagged INTEGER DEFAULT 0,
  is_auto_scored INTEGER DEFAULT 0,
  auto_score REAL,
  manual_score REAL,
  checker_verdict TEXT CHECK(checker_verdict IN ('correct','partial','incorrect',NULL)),
  checker_remarks TEXT,
  checked_by INTEGER REFERENCES users(id),
  checked_at TEXT,
  time_spent_seconds INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_answers_submission ON answers(submission_id);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);

-- 15. Review Assignments (checker queue)
CREATE TABLE IF NOT EXISTS review_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  assigned_to INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_review','done','escalated')),
  escalation_reason TEXT,
  assigned_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

-- 16. Email Configuration
CREATE TABLE IF NOT EXISTS email_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT DEFAULT 'azure_graph' CHECK(provider IN ('azure_graph','smtp')),
  tenant_id TEXT,
  client_id TEXT,
  client_secret TEXT,
  from_email TEXT,
  from_name TEXT,
  reply_to TEXT,
  default_cc TEXT,
  default_bcc TEXT,
  smtp_host TEXT,
  smtp_port INTEGER,
  smtp_user TEXT,
  smtp_pass TEXT,
  smtp_secure INTEGER DEFAULT 1,
  is_active INTEGER DEFAULT 0,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 17. Email Templates
CREATE TABLE IF NOT EXISTS email_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  variables TEXT,
  is_active INTEGER DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 18. Email Log
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_code TEXT,
  to_email TEXT NOT NULL,
  subject TEXT,
  html_body TEXT,
  from_email TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
  error_message TEXT,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
ALTER TABLE email_log ADD COLUMN html_body TEXT;
ALTER TABLE email_log ADD COLUMN from_email TEXT;

-- 19. App Settings
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  description TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 20. API Keys
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  permissions TEXT DEFAULT '[]',
  rate_limit INTEGER DEFAULT 1000,
  last_used TEXT,
  is_active INTEGER DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);

-- 21. Webhooks
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT DEFAULT '[]',
  secret TEXT,
  is_active INTEGER DEFAULT 1,
  last_triggered TEXT,
  fail_count INTEGER DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- 22. Audit Log
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id INTEGER,
  details TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id);

-- Gamification
CREATE TABLE IF NOT EXISTS gamification (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
  badge_code TEXT NOT NULL,
  badge_name TEXT,
  badge_description TEXT,
  badge_image TEXT,
  earned_at TEXT DEFAULT (datetime('now')),
  exam_id INTEGER REFERENCES exams(id)
);
CREATE INDEX IF NOT EXISTS idx_gamification_candidate ON gamification(candidate_id);

-- Webcam snapshots
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  captured_at TEXT DEFAULT (datetime('now')),
  event_type TEXT DEFAULT 'periodic'
);

-- Default seed data
INSERT OR IGNORE INTO settings(key, value, description) VALUES
  ('app_name', 'Alaric Exam', 'Application name'),
  ('app_logo', '', 'Logo URL'),
  ('allow_public_catalog', '1', 'Show public exam catalog'),
  ('candidate_otp_expiry', '10', 'Candidate portal OTP expiry minutes'),
  ('max_tab_switches', '3', 'Max tab switches before auto-submit'),
  ('webcam_enabled', '1', 'Enable webcam snapshots'),
  ('webcam_interval', '60', 'Webcam snapshot interval in seconds'),
  ('fullscreen_enforce', '1', 'Enforce fullscreen mode'),
  ('ai_paste_detect', '1', 'Enable AI paste detection'),
  ('gdpr_enabled', '0', 'Enable GDPR data export');

INSERT OR IGNORE INTO email_templates(code, name, subject, body_html, variables) VALUES
  ('exam_invite', 'Exam Invitation', 'You have been invited to take: {{exam_title}}',
   '<p>Dear {{candidate_name}},</p><p>You have been invited to take the exam: <strong>{{exam_title}}</strong>.</p><p>Click the link below to start your exam:</p><p><a href="{{exam_link}}">{{exam_link}}</a></p><p>This link expires on {{expires_at}} and can only be used once.</p><p>Duration: {{duration}} minutes</p><p>Best regards,<br>Alaric Exam Team</p>',
   '["candidate_name","exam_title","exam_link","expires_at","duration"]'),
  ('result_release', 'Your Exam Results', 'Results Released: {{exam_title}}',
   '<p>Dear {{candidate_name}},</p><p>Your results for <strong>{{exam_title}}</strong> have been released.</p><p>Score: {{score}} / {{total_marks}}</p><p>Result: <strong>{{pass_fail}}</strong></p><p>Login to your portal to view detailed results.</p>',
   '["candidate_name","exam_title","score","total_marks","pass_fail"]'),
  ('password_reset', 'Password Reset', 'Password Reset Request',
   '<p>Click the link below to reset your password:</p><p><a href="{{reset_link}}">{{reset_link}}</a></p><p>This link expires in 1 hour.</p>',
   '["reset_link"]');
