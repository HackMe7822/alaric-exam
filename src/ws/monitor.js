const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { getDb } = require('../../database/index');

// In-memory state — resets on server restart (acceptable; sessions are live only)
const examSessions      = new Map();  // submissionId -> SessionInfo (live)
const completedSessions = new Map();  // submissionId -> CompletedInfo (keeps last 50)
const adminClients      = new Map();  // ws -> AdminInfo
const waitingCandidates = new Map();  // token -> WaitingInfo

const MAX_COMPLETED = 50; // keep last N completed sessions across restarts

function addCompleted(submissionId, s, reason) {
  completedSessions.set(submissionId, {
    submissionId,
    candidateName: s.candidateName,
    examTitle:     s.examTitle,
    flaggedCount:  s.flaggedCount || 0,
    tabSwitches:   s.tabSwitches  || 0,
    endedAt:       Date.now(),
    reason:        reason || 'unknown',
  });
  // Trim oldest entries when over limit
  if (completedSessions.size > MAX_COMPLETED) {
    const oldest = completedSessions.keys().next().value;
    completedSessions.delete(oldest);
  }
}

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
    disconnected: s.disconnected || false,
  }));
}

function sendToAdmins(data, filter) {
  const msg = JSON.stringify(data);
  adminClients.forEach((info, ws) => {
    if (ws.readyState === WebSocket.OPEN && (!filter || filter(info))) ws.send(msg);
  });
}

function completedSnapshot() {
  return Array.from(completedSessions.values());
}

function broadcastSessions() {
  sendToAdmins({ type: 'sessions_list', sessions: sessionSnapshot(), completed: completedSnapshot() });
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
          ws.send(JSON.stringify({ type: 'auth_ok', sessions: sessionSnapshot(), completed: completedSnapshot(), waitingCandidates: waitingSnapshot() }));
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

        // ── Reconnect: session still alive from brief disconnect (e.g. HDMI plug-in) ──
        const existing = examSessions.get(msg.submissionId);
        if (existing && existing.disconnected) {
          clearTimeout(existing._cleanupTimer);
          existing.ws = ws;
          existing.disconnected = false;
          existing.disconnectedAt = null;
          existing.cameraRequested = false; // re-request camera on reconnect
          existing.lastSeen = Date.now();
          if (msg.questionIndex != null) existing.questionIndex = msg.questionIndex;
          if (msg.timeLeft      != null) existing.timeLeft      = msg.timeLeft;
          if (msg.answeredCount != null) existing.answeredCount  = msg.answeredCount;
          ws.send(JSON.stringify({ type: 'registered' }));
          // Re-sync paused state — the exam page may have missed pause_exam if the WS
          // dropped between the admin clicking Pause and the message being delivered.
          if (existing.paused) {
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pause_exam' }));
            }, 300);
          }
          sendToAdmins({ type: 'session_reconnected', submissionId: msg.submissionId });
          broadcastSessions();
          return;
        }

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
          cameraRequested: false,
          disconnected: false,
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
        const s = examSessions.get(ws._submissionId);
        // Only process if this WS is still the active one (not already replaced by reconnect)
        if (s && s.ws === ws) {
          // If exam was explicitly submitted, the session was already removed in handleExamMsg.
          // If it's still in examSessions here, the WS closed unexpectedly — start reconnect window.
          if (s.ended) return; // already cleaned up by exam_submitted handler
          s.ws = null;
          s.disconnected = true;
          s.disconnectedAt = Date.now();
          // Keep session alive for 30 s — allows candidate to reconnect after
          // brief disconnect (HDMI plug-in, network hiccup, page reload).
          // Only send session_ended + delete after the timeout if still disconnected.
          clearTimeout(s._cleanupTimer);
          s._cleanupTimer = setTimeout(() => {
            const curr = examSessions.get(ws._submissionId);
            if (curr && curr.disconnected) {
              addCompleted(ws._submissionId, curr, 'disconnected');
              examSessions.delete(ws._submissionId);
              sendToAdmins({
                type: 'session_ended',
                submissionId: ws._submissionId,
                candidateName: curr.candidateName,
                reason: 'disconnected',
              });
              broadcastSessions();
            }
          }, 30000);
          // Tell admins the candidate is temporarily disconnected (do NOT delete session)
          sendToAdmins({ type: 'session_disconnected', submissionId: ws._submissionId });
          broadcastSessions();
        }
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
  session.lastSeen = Date.now();

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
      info => info.subscribedTo == msg.submissionId
    );
  }

  // WebRTC signaling — exam is the caller (creates offer, sends to admin)
  if (msg.type === 'rtc_offer') {
    sendToAdmins(
      { type: 'rtc_offer', submissionId: msg.submissionId, offer: msg.offer },
      info => info.subscribedTo == msg.submissionId
    );
  }

  if (msg.type === 'rtc_ice' && msg.dir === 'exam_to_admin') {
    sendToAdmins(
      { type: 'rtc_ice', candidate: msg.candidate, dir: 'exam_to_admin' },
      info => info.subscribedTo == msg.submissionId
    );
  }

  // ── Violation resume request (exam → ALL admins) ─────────────────────────
  // Broadcast to every connected admin, not just the subscribed one.
  // If the proctor hasn't clicked the session pill yet, they still see the alert.
  if (msg.type === 'resume_request') {
    session.pendingViolation = { remark: msg.remark, violationNum: msg.violationNum, at: new Date().toISOString() };
    sendToAdmins(
      { type: 'resume_request', submissionId: msg.submissionId,
        candidateName: session.candidateName, remark: msg.remark, violationNum: msg.violationNum }
      // No filter — send to all admins so anyone can act on it
    );
    broadcastSessions();
  }

  // ── Active exam camera (exam is caller, admin is answerer) ───────────────
  if (msg.type === 'exam_camera_offer') {
    // Send to admin subscribed to this session (single-view OR multi-view)
    sendToAdmins(
      { type: 'exam_camera_offer', submissionId: msg.submissionId, offer: msg.offer },
      info => info.subscribedTo == msg.submissionId ||
              (info.subscribedSet && info.subscribedSet.has(msg.submissionId))
    );
  }

  if (msg.type === 'exam_camera_ice' && msg.dir === 'exam_to_admin') {
    sendToAdmins(
      { type: 'exam_camera_ice', candidate: msg.candidate, dir: 'exam_to_admin', submissionId: msg.submissionId },
      info => info.subscribedTo == msg.submissionId ||
              (info.subscribedSet && info.subscribedSet.has(msg.submissionId))
    );
  }

  // ── Candidate explicitly submitted / closed exam ─────────────────────────
  if (msg.type === 'exam_submitted') {
    session.ended = true;
    session.endedAt = Date.now();
    const endReason = msg.reason || 'submitted';
    session.endReason = endReason;
    clearTimeout(session._cleanupTimer);
    addCompleted(msg.submissionId, session, endReason);
    sendToAdmins({
      type: 'session_ended',
      submissionId: msg.submissionId,
      reason: endReason,
      candidateName: session.candidateName,
    });
    session.ws = null;
    examSessions.delete(msg.submissionId);
    broadcastSessions();
    return;
  }

  // ── Exam chat reply (exam → admin) ───────────────────────────────────────
  if (msg.type === 'exam_chat_reply') {
    sendToAdmins(
      { type: 'exam_chat_reply', submissionId: msg.submissionId, message: msg.message, candidateName: session.candidateName },
      info => info.subscribedTo == msg.submissionId
    );
    try {
      const db = getDb();
      const sub = db.prepare('SELECT id FROM submissions WHERE id=? LIMIT 1').get(parseInt(msg.submissionId));
      if (sub) db.prepare('INSERT INTO exam_chats(submission_id, sender, sender_name, message) VALUES(?,?,?,?)').run(sub.id, 'candidate', session.candidateName, msg.message);
    } catch(e) {}
  }

  // ── Violation limit reached — broadcast to all admins for decision ────────
  if (msg.type === 'violation_limit_reached') {
    session.violationLimitReached = true;
    sendToAdmins({
      type: 'violation_limit_reached',
      submissionId: msg.submissionId,
      candidateName: session.candidateName,
      count: msg.count,
      limit: msg.limit,
    }); // no filter — all admins see it
    broadcastSessions();
  }

  // ── Proctor call answer + ICE (exam → admin) ──────────────────────────────
  if (msg.type === 'proctor_call_answer') {
    sendToAdmins(
      { type: 'proctor_call_answer', answer: msg.answer },
      info => info.subscribedTo == msg.submissionId
    );
  }
  if (msg.type === 'proctor_call_ice' && msg.dir === 'exam_to_admin') {
    sendToAdmins(
      { type: 'proctor_call_ice', candidate: msg.candidate, dir: 'exam_to_admin' },
      info => info.subscribedTo == msg.submissionId
    );
  }
}

function handleAdminMsg(ws, msg) {
  const info = adminClients.get(ws);
  if (!info) return;

  if (msg.type === 'subscribe') {
    // Normalise to the same type as examSessions keys (which come from the exam's state.submissionId)
    // Use loose lookup so string '123' finds numeric key 123 and vice versa
    info.subscribedTo  = msg.submissionId != null ? msg.submissionId : null;
    info.subscribedSet = null; // clear multi-subscribe when going single
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
        if (s.ws && s.ws.readyState === WebSocket.OPEN && !s.cameraRequested) {
          s.cameraRequested = true;
          s.ws.send(JSON.stringify({ type: 'request_exam_camera' }));
        }
      }
    }
  }

  // ── Multi-subscribe: admin monitors several sessions simultaneously ──────
  if (msg.type === 'subscribe_multi') {
    const ids = Array.isArray(msg.submissionIds) ? msg.submissionIds : [];
    info.subscribedTo  = ids[0] || null;  // primary for backwards-compat signals
    info.subscribedSet = new Set(ids);
    // Request camera from every subscribed exam
    ids.forEach(subId => {
      const s = examSessions.get(subId);
      if (s && s.ws && s.ws.readyState === WebSocket.OPEN) {
        s.cameraRequested = true;
        s.ws.send(JSON.stringify({ type: 'request_exam_camera' }));
      }
    });
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

  if (msg.type === 'grant_extra_tries') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws.readyState === WebSocket.OPEN) {
      s.violationLimitReached = false;
      s.ws.send(JSON.stringify({ type: 'grant_extra_tries', extra: msg.extra || 1 }));
      s.ws.send(JSON.stringify({ type: 'resume_exam' }));
      s.paused = false;
      broadcastSessions();
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
    // forSubId is set by multi-view; fall back to subscribedTo for single-view
    const targetId = msg.forSubId || info.subscribedTo;
    const s = targetId && examSessions.get(targetId);
    if (s && s.ws && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'exam_camera_answer', answer: msg.answer }));
    }
  }

  if (msg.type === 'exam_camera_ice' && msg.dir === 'admin_to_exam') {
    const targetId = msg.forSubId || info.subscribedTo;
    const s = targetId && examSessions.get(targetId);
    if (s && s.ws && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'exam_camera_ice', candidate: msg.candidate, dir: 'admin_to_exam' }));
    }
  }

  // ── Proctor ↔ Candidate audio/video call (during exam) ───────────────────
  if (msg.type === 'proctor_call_offer') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'proctor_call_offer', offer: msg.offer }));
    }
  }
  if (msg.type === 'proctor_call_ice' && msg.dir === 'admin_to_exam') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'proctor_call_ice', candidate: msg.candidate, dir: 'admin_to_exam' }));
    }
  }
  if (msg.type === 'proctor_call_end') {
    const s = info.subscribedTo && examSessions.get(info.subscribedTo);
    if (s && s.ws && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'proctor_call_end' }));
    }
  }

  // ── Proctor ↔ Waiting-room candidate call (before exam starts) ────────────
  if (msg.type === 'proctor_wr_call_offer') {
    const c = msg.token && waitingCandidates.get(msg.token);
    if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: 'proctor_wr_call_offer', offer: msg.offer }));
    }
  }
  if (msg.type === 'proctor_wr_call_ice' && msg.dir === 'admin_to_waiting') {
    const c = msg.token && waitingCandidates.get(msg.token);
    if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: 'proctor_wr_call_ice', candidate: msg.candidate, dir: 'admin_to_waiting' }));
    }
  }
  if (msg.type === 'proctor_wr_call_end') {
    const c = msg.token && waitingCandidates.get(msg.token);
    if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: 'proctor_wr_call_end' }));
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

  // Waiting-room proctor call answer/ICE (candidate → admin)
  if (msg.type === 'proctor_wr_call_answer') {
    sendToAdmins(
      { type: 'proctor_wr_call_answer', token: ws._waitToken, answer: msg.answer },
      info => info.watchingToken === ws._waitToken
    );
  }
  if (msg.type === 'proctor_wr_call_ice' && msg.dir === 'waiting_to_admin') {
    sendToAdmins(
      { type: 'proctor_wr_call_ice', token: ws._waitToken, candidate: msg.candidate, dir: 'waiting_to_admin' },
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
