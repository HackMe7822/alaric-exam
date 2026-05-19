const { getDb } = require('../../database/index');

function scoreAnswer(question, answer) {
  if (!answer || answer.response == null) return { score: 0, isCorrect: false };

  const db = getDb();
  const options = db.prepare('SELECT * FROM question_options WHERE question_id=?').all(question.id);
  const response = answer.response;

  switch (question.type) {
    case 'mcq': {
      const correct = options.find(o => o.is_correct);
      if (!correct) return { score: 0, isCorrect: false };
      const isCorrect = String(response) === String(correct.id);
      return {
        score: isCorrect ? question.marks : -Math.abs(question.negative_marks || 0),
        isCorrect
      };
    }
    case 'multi_mcq': {
      let selected;
      try { selected = JSON.parse(response); } catch { selected = []; }
      const correctIds = options.filter(o => o.is_correct).map(o => String(o.id));
      const selectedIds = (Array.isArray(selected) ? selected : []).map(String);
      const allCorrect = correctIds.every(id => selectedIds.includes(id));
      const noWrong = selectedIds.every(id => correctIds.includes(id));
      if (allCorrect && noWrong) return { score: question.marks, isCorrect: true };
      if (noWrong && selectedIds.length > 0) {
        const partial = (selectedIds.length / correctIds.length) * question.marks;
        return { score: parseFloat(partial.toFixed(2)), isCorrect: false, partial: true };
      }
      return { score: -Math.abs(question.negative_marks || 0), isCorrect: false };
    }
    case 'fill_blank': {
      const correct = options.find(o => o.is_correct);
      if (!correct) return { score: 0, isCorrect: false };
      const isCorrect = response.trim().toLowerCase() === correct.body.trim().toLowerCase();
      return { score: isCorrect ? question.marks : 0, isCorrect };
    }
    case 'match': {
      let pairs;
      try { pairs = JSON.parse(response); } catch { pairs = {}; }
      const correctPairs = {};
      options.forEach(o => { if (o.match_key) correctPairs[o.id] = o.match_key; });
      let correct = 0;
      const total = Object.keys(correctPairs).length;
      for (const [k, v] of Object.entries(pairs)) {
        if (correctPairs[k] === v) correct++;
      }
      const score = total > 0 ? (correct / total) * question.marks : 0;
      return { score: parseFloat(score.toFixed(2)), isCorrect: correct === total };
    }
    case 'drag_drop': {
      let order;
      try { order = JSON.parse(response); } catch { order = []; }
      const correctOrder = options.sort((a, b) => a.sort_order - b.sort_order).map(o => String(o.id));
      const isCorrect = JSON.stringify(order.map(String)) === JSON.stringify(correctOrder);
      return { score: isCorrect ? question.marks : 0, isCorrect };
    }
    case 'hotspot': {
      // Hotspot: response = {x, y} and correct options have x,y,width,height in body JSON
      let point;
      try { point = JSON.parse(response); } catch { return { score: 0, isCorrect: false }; }
      const correctArea = options.find(o => o.is_correct);
      if (!correctArea) return { score: 0, isCorrect: false };
      let area;
      try { area = JSON.parse(correctArea.body); } catch { return { score: 0, isCorrect: false }; }
      const inBounds = point.x >= area.x && point.x <= area.x + area.w &&
                       point.y >= area.y && point.y <= area.y + area.h;
      return { score: inBounds ? question.marks : 0, isCorrect: inBounds };
    }
    default:
      return { score: 0, isCorrect: null, needsReview: true };
  }
}

function autoScoreSubmission(submissionId) {
  const db = getDb();
  const answers = db.prepare('SELECT a.*, q.type, q.marks, q.negative_marks FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.submission_id=?').all(submissionId);

  let total = 0;
  const update = db.prepare('UPDATE answers SET auto_score=?, is_auto_scored=? WHERE id=?');

  for (const ans of answers) {
    if (['text', 'file_upload'].includes(ans.type)) {
      update.run(null, 0, ans.id);
      continue;
    }
    const result = scoreAnswer({ id: ans.question_id, type: ans.type, marks: ans.marks, negative_marks: ans.negative_marks }, ans);
    update.run(result.score, 1, ans.id);
    total += result.score || 0;
  }

  db.prepare(`UPDATE submissions SET auto_score=?, updated_at=datetime('now') WHERE id=?`).run(parseFloat(total.toFixed(2)), submissionId);
  return total;
}

module.exports = { scoreAnswer, autoScoreSubmission };
