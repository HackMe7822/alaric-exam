const express = require('express');
const router = express.Router();
const { getDb } = require('../../database/index');
const auth = require('../middleware/auth');

router.get('/overview', auth, (req, res) => {
  const db = getDb();
  const stats = {
    total_exams: db.prepare('SELECT COUNT(*) as c FROM exams').get()?.c,
    published_exams: db.prepare(`SELECT COUNT(*) as c FROM exams WHERE status='published'`).get()?.c,
    total_candidates: db.prepare('SELECT COUNT(*) as c FROM candidates').get()?.c,
    total_submissions: db.prepare('SELECT COUNT(*) as c FROM submissions').get()?.c,
    submissions_today: db.prepare(`SELECT COUNT(*) as c FROM submissions WHERE date(started_at)=date('now')`).get()?.c,
    pending_review: db.prepare(`SELECT COUNT(*) as c FROM review_assignments WHERE status='pending'`).get()?.c,
    avg_score_pct: db.prepare('SELECT ROUND(AVG(final_score*100.0/NULLIF(total_marks,0)),1) as avg FROM submissions s JOIN exams e ON e.id=s.exam_id WHERE s.final_score IS NOT NULL').get()?.avg,
    pass_rate: db.prepare(`SELECT ROUND(SUM(CASE WHEN pass_fail='pass' THEN 1.0 ELSE 0 END)*100/NULLIF(COUNT(*),0),1) as rate FROM submissions WHERE pass_fail IS NOT NULL`).get()?.rate
  };
  res.json(stats);
});

router.get('/exam/:id', auth, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(id);
  if (!exam) return res.status(404).json({ error: 'Not found' });

  const submissions = db.prepare(`SELECT * FROM submissions WHERE exam_id=? AND status NOT IN ('in_progress')`).all(id);
  const scores = submissions.map(s => s.final_score ?? s.auto_score ?? 0).filter(s => s > 0);
  const passCount = submissions.filter(s => s.pass_fail === 'pass').length;
  const failCount = submissions.filter(s => s.pass_fail === 'fail').length;

  const distribution = Array(10).fill(0);
  for (const s of scores) {
    const pct = exam.total_marks > 0 ? (s / exam.total_marks) * 100 : 0;
    distribution[Math.min(9, Math.floor(pct / 10))]++;
  }

  const questions = db.prepare('SELECT q.id, q.body, q.marks, q.type FROM questions q WHERE q.exam_id=?').all(id);
  const itemAnalysis = questions.map(q => {
    const answers = db.prepare('SELECT * FROM answers WHERE question_id=?').all(q.id);
    const correct = answers.filter(a => a.auto_score != null && a.auto_score >= q.marks).length;
    return {
      question_id: q.id,
      question_body: q.body.substring(0, 80),
      type: q.type,
      marks: q.marks,
      total_answered: answers.length,
      correct_count: correct,
      difficulty_index: answers.length > 0 ? parseFloat((correct / answers.length).toFixed(2)) : null,
      avg_time: answers.length > 0 ? Math.round(answers.reduce((a, b) => a + (b.time_spent_seconds || 0), 0) / answers.length) : 0
    };
  });

  const timeTaken = submissions.filter(s => s.time_taken_seconds).map(s => Math.round(s.time_taken_seconds / 60));
  const avgTime = timeTaken.length > 0 ? Math.round(timeTaken.reduce((a, b) => a + b, 0) / timeTaken.length) : 0;

  res.json({
    exam: { id: exam.id, title: exam.title, total_marks: exam.total_marks, pass_marks: exam.pass_marks },
    summary: {
      total_submissions: submissions.length,
      pass_count: passCount,
      fail_count: failCount,
      pass_rate: submissions.length > 0 ? parseFloat((passCount / submissions.length * 100).toFixed(1)) : null,
      avg_score: scores.length > 0 ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : null,
      max_score: scores.length > 0 ? Math.max(...scores) : null,
      min_score: scores.length > 0 ? Math.min(...scores) : null,
      avg_time_minutes: avgTime
    },
    score_distribution: distribution.map((count, i) => ({ range: `${i * 10}-${(i + 1) * 10}%`, count })),
    item_analysis: itemAnalysis,
    integrity: {
      high_risk: submissions.filter(s => s.risk_level === 'high').length,
      medium_risk: submissions.filter(s => s.risk_level === 'medium').length,
      low_risk: submissions.filter(s => s.risk_level === 'low').length,
      avg_tab_switches: submissions.length > 0 ? parseFloat((submissions.reduce((a, b) => a + (b.tab_switches || 0), 0) / submissions.length).toFixed(1)) : 0
    }
  });
});

router.get('/leaderboard/:id', auth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.candidate_name, s.final_score, s.auto_score, s.pass_fail, s.time_taken_seconds, e.total_marks
    FROM submissions s JOIN exams e ON e.id=s.exam_id
    WHERE s.exam_id=? AND s.result_released=1 AND (s.final_score IS NOT NULL OR s.auto_score IS NOT NULL)
    ORDER BY COALESCE(s.final_score,s.auto_score) DESC LIMIT 50`).all(parseInt(req.params.id));
  res.json(rows);
});

router.get('/trends', auth, (req, res) => {
  const db = getDb();
  const days = parseInt(req.query.days || 30);
  const rows = db.prepare(`
    SELECT date(started_at) as day, COUNT(*) as submissions,
    ROUND(AVG(COALESCE(final_score,auto_score)*100.0/NULLIF(total_marks,0)),1) as avg_pct
    FROM submissions s JOIN exams e ON e.id=s.exam_id
    WHERE date(started_at) >= date('now', ?)
    GROUP BY date(started_at) ORDER BY day`).all(`-${days} days`);
  res.json(rows);
});

module.exports = router;
