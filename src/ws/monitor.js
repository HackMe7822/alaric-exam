const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { getDb } = require('../../database/index');

// In-memory state — resets on server restart (acceptable; sessions are live only)
const examSessions     = new Map();  // submissionId -> SessionInfo
const adminClients     = new Map();  // ws -> AdminInfo
const waitingCandidates = new Map(); // token -> WaitingInfo  (Secure Browser waiting room)

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
    paused: s.paused || false,
    micMuted: s.micMuted || false,
    pendingViolation: s.pendingViolation || null,
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

// ── Waiting room helpers ──────────────────────────────────────────────────────
function waitingSnapshot() {
  return Array.from(waitingCandidates.entries()).map(([token, c]) => ({
    token,
    candidateName:  c.candidateName,
    candidateEmail: c.candidateEmail,
    examTitle:      c.examTitle,
    machineId:      c.machineId,
    waitingSince:   c.waitingSince,
    verifyCode:     c.verifyCode || null,
  }));
}

function broadcastWaitingList() {
  sendToAdmins({ type: 'waiting_list', candidates: waitingSnapshot() });
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
          ws.send(JSON.stringify({ type: 'auth_ok', sessions: sessionSnapshot(), waitingCandidates: waitingSnapshot() }));
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
          cameraRequested: false, // reset so camera is re-requested on fresh connection
        });

        ws.send(JSON.stringify({ type: 'registered' }));
        broadcastSessions();
        return;
      }

      // Secure Browser — waiting room registration
      if (!ws._role && msg.type === 'proctor_wait') {
        const db = getDb();
        const link = db.prepare(
          'SELECT el.*, e.title as exam_title, c.name as cname, c.email as cemail FROM exam_links el JOIN exams e ON e.id=el.exam_id LEFT JOIN candidates c ON c.id=el.candidate_id WHERE el.token=?'
        ).get(msg.token);
        if (!link) { ws.send(JSON.stringify({ type: 'error', message: 'Invalid exam token' })); return; }

        ws._role      = 'waiting';
        ws._waitToken = msg.token;

        waitingCandidates.set(msg.token, {
          ws,
          candidateName:  link.cname  || msg.candidateName || 'Unknown',
          candidateEmail: link.cemail || '',
          examTitle:      link.exam_title || '',
          machineId:      msg.machineId || '',
          verifyCode:     msg.verifyCode || null,
          waitingSince:   Date.now(),
        });

        ws.send(JSON.stringify({ type: 'proctor_wait_ok' }));
        broadcastWaitingList();
        return;
      }

      if (ws._role === 'exam')    handleExamMsg(ws, msg);
      else if (ws._role === 'admin')   handleAdminMsg(ws, msg);
      else if (ws._role === 'waiting') handleWaitingMsg(ws, msg);
    });

    ws.on('close', () => {
      if (ws._role === 'exam' && ws._submissionId) {
        examSessions.delete(ws._submissionId);
        sendToAdmins({ type: 'session_ended', submissionId: ws._submissionId });
        broadcastSessions();
      } else if (ws._role === 'admin') {
        adminClients.delete(ws);
      } else if (ws._role === 'waiting' && ws._waitToken) {
        waitingCandidates.delete(ws._waitToken);
        broadcastWaitingList();
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

  // ── Violation resume request (exam → subscribed admin) ──────────────────
  if (msg.type === 'resume_request') {
    session.pendingViolation = { remark: msg.remark, violationNum: msg.violationNum, at: new Date().toISOString() };
    sendToAdmins(
      { type: 'resume_request', submissionId: msg.submissionId,
        candidateName: session.candidateName, remark: msg.remark, violationNum: msg.violationNum },
      info => info.subscribedTo === msg.submissionId
    );
    broadcastSessions();
  }

  // ── Active exam camera (exam is caller, admin is answerer) ───────────────
  if (msg.type === 'exam_camera_offer') {
    sendToAdmins(
      { type: 'exam_camera_offer', submissionId: msg.submissionId, offer: msg.offer },
      info => info.subscribedTo === msg.submissionId
    );
  }

  if (msg.type === 'exam_camera_ice' && msg.dir === 'exam_to_admin') {
    sendToAdmins(
      { type: 'exam_camera_ice', candidate: msg.candidate, dir: 'exam_to_admin' },
      info => info.subscribedTo === msg.submissionId
    );
  }

  // ── Exam chat reply (exam → admin) ───────────────────────────────────────
  if (msg.type === 'exam_chat_reply') {
    sendToAdmins(
      { type: 'exam_chat_reply', submissionId: msg.submissionId, message: msg.message, candidateName: session.candidateName },
      info => info.subscribedTo === msg.submissionId
    );
    // Persist to DB
    try {
      const db = getDb();
      const sub = db.prepare('SELECT id FROM submissions WHERE id=? LIMIT 1').get(parseInt(msg.submissionId));
      if (sub) db.prepare('INSERT INTO exam_chats(submission_id, sender, sender_name, message) VALUES(?,?,?,?)').run(sub.id, 'candidate', session.candidateName, msg.message);
    } catch(e) {}
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
          paused: s.paused || false,
          micMuted: s.micMuted || false,
          pendingViolation: s.pendingViolation || null,
        }));
        // Request live camera feed from exam — only if not already streaming.
        // s.cameraRequested flag prevents re-requesting every subscribe (which
        // would tear down and restart WebRTC on every 10s session update).
        if (s.ws.readyState === WebSocket.OPEN && !s.cameraRequested) {
          s.cameraRequested = true;
          s.ws.send(JSON.stringify({ type: 'request_exam_camera' }));
        }
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

  // ── Waiting room: proctor joins a candidate ──
  if (msg.type === 'proctor_join') {
    info.watchingToken = msg.token || null;
    const c = msg.token && waitingCandidates.get(msg.token);
    if (c && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: 'proctor_joined', proctorName: info.userName }));
    }
    ws.send(JSON.stringify({ type: 'proctor_join_ok', token: msg.token,
      candidateName: c ? c.candidateName : '' }));
  }

  // ── Waiting room: proctor starts the exam ──
  if (msg.type === 'proctor_start') {
    const c = msg.token && waitingCandidates.get(msg.token);
    if (c && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: 'start_exam' }));
    }
  }

  // ── Waiting room: proctor chat to candidate ──
  if (msg.type === 'proctor_chat') {
    const c = msg.token && waitingCandidates.get(msg.token);
    if (c && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: 'proctor_chat', message: msg.message }));
    }
  }

  // ── Camera WebRTC answer (admin is answerer for waiting-room candidate camera) ──
  if (msg.type === 'camera_answer') {
    const c = info.watchingToken && waitingCandidates.get(info.watchingToken);
    if (c && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: 'camera_answer', answer: msg.answer }));
    }
  }

  if (msg.type === 'camera_ice' && msg.dir === 'admin_to_candidate') {
    const c = info.watchingToken && waitingCandidates.get(info.watchingToken);
    if (c && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: 'camera_ice', candidate: msg.candidate, dir: 'admin_to_candidate' }));
    }
  }

  // ── Active exam: admin controls ──────────────────────────────────────────
  if (msg.type === 'exam_chat') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'exam_chat', message: msg.message, proctorName: info.userName }));
      // Persist to DB
      try {
        const db = getDb();
        const sub = db.prepare('SELECT id FROM submissions WHERE id=? LIMIT 1').get(parseInt(info.subscribedTo));
        if (sub) db.prepare('INSERT INTO exam_chats(submission_id, sender, sender_name, message) VALUES(?,?,?,?)').run(sub.id, 'proctor', info.userName, msg.message);
      } catch(e) {}
    }
  }

  if (msg.type === 'pause_exam') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'pause_exam' }));
      s.paused = true;
      broadcastSessions();
    }
  }

  if (msg.type === 'resume_exam') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'resume_exam' }));
      s.paused = false;
      s.pendingViolation = null;
      broadcastSessions();
    }
  }

  if (msg.type === 'stop_exam') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'stop_exam' }));
    }
  }

  if (msg.type === 'mute_mic') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'mute_mic', muted: !!msg.muted }));
      s.micMuted = !!msg.muted;
    }
  }

  // ── Active exam camera WebRTC (admin is answerer) ─────────────────────────
  if (msg.type === 'exam_camera_answer') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'exam_camera_answer', answer: msg.answer }));
    }
  }

  if (msg.type === 'exam_camera_ice' && msg.dir === 'admin_to_exam') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'exam_camera_ice', candidate: msg.candidate, dir: 'admin_to_exam' }));
    }
  }
}

// ── Waiting room message handler (Secure Browser candidate) ──────────────────
function handleWaitingMsg(ws, msg) {
  const c = waitingCandidates.get(ws._waitToken);
  if (!c || c.ws !== ws) return;

  // Camera WebRTC — candidate is caller
  if (msg.type === 'camera_offer') {
    sendToAdmins(
      { type: 'camera_offer', token: ws._waitToken, offer: msg.offer,
        candidateName: c.candidateName, candidateEmail: c.candidateEmail },
      info => info.watchingToken === ws._waitToken
    );
  }

  if (msg.type === 'camera_ice' && msg.dir === 'candidate_to_admin') {
    sendToAdmins(
      { type: 'camera_ice', token: ws._waitToken, candidate: msg.candidate, dir: 'candidate_to_admin' },
      info => info.watchingToken === ws._waitToken
    );
  }

  // Candidate chat message → forward to watching admin
  if (msg.type === 'candidate_chat') {
    sendToAdmins(
      { type: 'candidate_chat', token: ws._waitToken, message: msg.message, candidateName: c.candidateName },
      info => info.watchingToken === ws._waitToken
    );
  }
}

// Push a WS message to a specific waiting candidate (by their exam link token)
// Used by verify.js to notify the Secure Browser when photos are submitted
function notifyWaitingCandidate(linkToken, msg) {
  for (const [, c] of waitingCandidates) {
    if (c.ws && c.ws.readyState === 1) {
      // Match by linkToken via the exam link token stored in the session
      // The waiting candidate's ws._waitToken is the exam link token
      if (c.ws._waitToken === linkToken) {
        c.ws.send(JSON.stringify(msg));
        return true;
      }
    }
  }
  return false;
}

// Push verify status update to all admins watching the waiting room
function notifyAdminsVerifyUpdate(sessionCode, status) {
  sendToAdmins({ type: 'verify_status_update', sessionCode, status });
}

module.exports = { setupMonitor, notifyWaitingCandidate, notifyAdminsVerifyUpdate };
