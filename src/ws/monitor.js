const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { getDb } = require('../../database/index');

// In-memory state — resets on server restart (acceptable; sessions are live only)
const examSessions = new Map();  // submissionId -> SessionInfo
const adminClients = new Map();  // ws -> AdminInfo

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i < 1) return;
    out[decodeURIComponent(p.slice(0, i).trim())] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function sessionSnapshot() {
  return Array.from(examSessions.entries()).map(([id, s]) => ({
    submissionId: id,
    candidateName: s.candidateName,
    candidateEmail: s.candidateEmail,
    examTitle: s.examTitle,
    questionIndex: s.questionIndex,
    totalQuestions: s.totalQuestions,
    timeLeft: s.timeLeft,
    answeredCount: s.answeredCount,
    flaggedCount: s.flaggedCount,
    tabSwitches: s.tabSwitches,
    connectedAt: s.connectedAt,
    lastSeen: s.lastSeen,
  }));
}

function sendToAdmins(data, filter) {
  const msg = JSON.stringify(data);
  adminClients.forEach((info, ws) => {
    if (ws.readyState === WebSocket.OPEN && (!filter || filter(info))) ws.send(msg);
  });
}

function broadcastSessions() {
  sendToAdmins({ type: 'sessions_list', sessions: sessionSnapshot() });
}

function setupMonitor(wss) {
  // Ping keepalive — Render drops idle WS after ~60s of silence
  const pingTimer = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws._alive) { ws.terminate(); return; }
      ws._alive = false;
      ws.ping();
    });
  }, 25000);
  wss.on('close', () => clearInterval(pingTimer));

  wss.on('connection', (ws, req) => {
    ws._alive = true;
    ws._role = null;
    ws.on('pong', () => { ws._alive = true; });
    ws.on('error', () => {});

    // Auto-auth as admin if JWT cookie is present
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['token'];
    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const db = getDb();
        const sess = db.prepare('SELECT * FROM sessions WHERE jti=? AND revoked=0').get(payload.jti);
        const user = sess && db.prepare('SELECT * FROM users WHERE id=? AND is_active=1').get(payload.sub);
        if (user && ['exam_manager', 'super_admin'].includes(user.role)) {
          ws._role = 'admin';
          adminClients.set(ws, { userId: user.id, userName: user.full_name || user.username, subscribedTo: null });
          ws.send(JSON.stringify({ type: 'auth_ok', sessions: sessionSnapshot() }));
        }
      } catch(e) {}
    }

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Exam registration (unauthenticated connection first message)
      if (!ws._role && msg.type === 'exam_register') {
        const db = getDb();
        const link = db.prepare(
          'SELECT el.*, e.title as exam_title FROM exam_links el JOIN exams e ON e.id=el.exam_id WHERE el.token=?'
        ).get(msg.token);
        if (!link) { ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' })); return; }

        ws._role = 'exam';
        ws._submissionId = msg.submissionId;

        examSessions.set(msg.submissionId, {
          ws,
          candidateName: msg.candidateName || 'Unknown',
          candidateEmail: msg.candidateEmail || '',
          examTitle: msg.examTitle || link.exam_title,
          questionIndex: msg.questionIndex || 0,
          totalQuestions: msg.totalQuestions || 0,
          timeLeft: msg.timeLeft || 0,
          answeredCount: msg.answeredCount || 0,
          flaggedCount: 0,
          tabSwitches: 0,
          events: [],
          connectedAt: Date.now(),
          lastSeen: Date.now(),
        });

        ws.send(JSON.stringify({ type: 'registered' }));
        broadcastSessions();
        return;
      }

      if (ws._role === 'exam') handleExamMsg(ws, msg);
      else if (ws._role === 'admin') handleAdminMsg(ws, msg);
    });

    ws.on('close', () => {
      if (ws._role === 'exam' && ws._submissionId) {
        examSessions.delete(ws._submissionId);
        sendToAdmins({ type: 'session_ended', submissionId: ws._submissionId });
        broadcastSessions();
      } else if (ws._role === 'admin') {
        adminClients.delete(ws);
      }
    });
  });
}

function handleExamMsg(ws, msg) {
  const session = examSessions.get(msg.submissionId);
  if (!session || session.ws !== ws) return;

  if (msg.type === 'exam_state') {
    if (msg.questionIndex != null) session.questionIndex = msg.questionIndex;
    if (msg.totalQuestions != null) session.totalQuestions = msg.totalQuestions;
    if (msg.timeLeft != null) session.timeLeft = msg.timeLeft;
    if (msg.answeredCount != null) session.answeredCount = msg.answeredCount;
    if (msg.tabSwitches != null) session.tabSwitches = msg.tabSwitches;
    session.lastSeen = Date.now();

    if (msg.event) {
      session.events.push({ event: msg.event, at: new Date().toISOString() });
      if (/tab_switch|paste|fullscreen|copy|flag/i.test(msg.event)) session.flaggedCount++;
    }

    broadcastSessions();
    sendToAdmins(
      { type: 'detail_update', submissionId: msg.submissionId,
        questionIndex: session.questionIndex, totalQuestions: session.totalQuestions,
        timeLeft: session.timeLeft, answeredCount: session.answeredCount,
        tabSwitches: session.tabSwitches, flaggedCount: session.flaggedCount,
        event: msg.event || null },
      info => info.subscribedTo === msg.submissionId
    );
  }

  // WebRTC signaling — exam is the caller (creates offer, sends to admin)
  if (msg.type === 'rtc_offer') {
    sendToAdmins(
      { type: 'rtc_offer', submissionId: msg.submissionId, offer: msg.offer },
      info => info.subscribedTo === msg.submissionId
    );
  }

  if (msg.type === 'rtc_ice' && msg.dir === 'exam_to_admin') {
    sendToAdmins(
      { type: 'rtc_ice', candidate: msg.candidate, dir: 'exam_to_admin' },
      info => info.subscribedTo === msg.submissionId
    );
  }
}

function handleAdminMsg(ws, msg) {
  const info = adminClients.get(ws);
  if (!info) return;

  if (msg.type === 'subscribe') {
    info.subscribedTo = msg.submissionId || null;
    if (msg.submissionId) {
      const s = examSessions.get(msg.submissionId);
      if (s) {
        ws.send(JSON.stringify({
          type: 'session_detail',
          submissionId: msg.submissionId,
          candidateName: s.candidateName,
          candidateEmail: s.candidateEmail,
          examTitle: s.examTitle,
          questionIndex: s.questionIndex,
          totalQuestions: s.totalQuestions,
          timeLeft: s.timeLeft,
          answeredCount: s.answeredCount,
          flaggedCount: s.flaggedCount,
          tabSwitches: s.tabSwitches,
          events: s.events,
          connectedAt: s.connectedAt,
        }));
      }
    }
  }

  if (msg.type === 'request_screen') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: 'screen_request' }));
  }

  if (msg.type === 'stop_screen') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: 'screen_stop' }));
  }

  // WebRTC signaling — admin is the answerer (receives offer, sends answer back)
  if (msg.type === 'rtc_answer') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'rtc_answer', answer: msg.answer }));
    }
  }

  if (msg.type === 'rtc_ice' && msg.dir === 'admin_to_exam') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'rtc_ice', candidate: msg.candidate, dir: 'admin_to_exam' }));
    }
  }
}

module.exports = { setupMonitor };
