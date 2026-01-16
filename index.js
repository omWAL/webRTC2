const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Create recordings directory if it doesn't exist
const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

// Setup multer for file uploads
const upload = multer({ dest: recordingsDir });

// Middleware
app.use(express.json());
app.use(express.static('dist'));

// API endpoint for recording uploads
app.post('/api/recordings', upload.single('recording'), (req, res) => {
  try {
    const fileName = req.body.fileName || `recording-${Date.now()}.webm`;
    const oldPath = req.file.path;
    const newPath = path.join(recordingsDir, fileName);
    
    fs.renameSync(oldPath, newPath);
    console.log('Recording saved:', newPath);
    
    res.json({ ok: true, message: 'Recording uploaded', fileName, path: newPath });
  } catch (err) {
    console.error('Recording upload failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// In-memory sessions: { CODE: { host: socketId, queue: [], activeCandidate: null } }
const sessions = {};

function makeCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('create_session', (_, cb) => {
    let code;
    do { code = makeCode(6); } while (sessions[code]);
    sessions[code] = { host: socket.id, queue: [], activeCandidate: null };
    socket.join(code);
    socket.data.role = 'host';
    socket.data.sessionCode = code;
    console.log('Session created', code);
    if (cb) cb({ ok: true, code });
    io.to(socket.id).emit('session_created', { code });
  });

  socket.on('join_session', ({ code }, cb) => {
    const session = sessions[code];
    if (!session) {
      if (cb) cb({ ok: false, error: 'Invalid session code' });
      return;
    }
    // Add to queue if not already present
    if (!session.queue.includes(socket.id) && session.activeCandidate !== socket.id) {
      session.queue.push(socket.id);
      socket.data.role = 'candidate';
      socket.data.sessionCode = code;
      socket.join(code);
      // Send ack
      const pos = session.queue.indexOf(socket.id) + 1;
      if (cb) cb({ ok: true, position: pos });

      // notify host of queue update
      io.to(session.host).emit('queue_update', { queue: session.queue });

      // Notify all candidates their positions
      session.queue.forEach((cid) => {
        const you = session.queue.indexOf(cid) + 1;
        io.to(cid).emit('queue_update', { queue: session.queue, you });
      });
    } else {
      // already in queue
      const pos = session.queue.indexOf(socket.id) + 1 || null;
      if (cb) cb({ ok: true, position: pos });
    }
  });

  socket.on('start_next', ({ code }) => {
    const session = sessions[code];
    if (!session) return;

    // if there is an active candidate, end their interview first
    if (session.activeCandidate) {
      const prev = session.activeCandidate;
      session.activeCandidate = null;
      io.to(prev).emit('interview_ended');
      io.to(session.host).emit('interview_ended_host');
    }

    if (session.queue.length === 0) {
      io.to(session.host).emit('queue_update', { queue: session.queue });
      return;
    }

    const next = session.queue.shift();
    session.activeCandidate = next;

    // notify candidate
    io.to(next).emit('interview_start', { hostId: session.host });

    // notify host
    io.to(session.host).emit('candidate_selected', { candidate: next });

    // update the host with queue
    io.to(session.host).emit('queue_update', { queue: session.queue });

    // update remaining candidates with positions
    session.queue.forEach((cid) => {
      const you = session.queue.indexOf(cid) + 1;
      io.to(cid).emit('queue_update', { queue: session.queue, you });
    });
  });

  socket.on('end_interview', ({ code }) => {
    const session = sessions[code];
    if (!session) return;
    const candidate = session.activeCandidate;
    session.activeCandidate = null;
    if (candidate) io.to(candidate).emit('interview_ended');
    io.to(session.host).emit('interview_ended_host');

    // update host with current queue and notify positions
    if (session) {
      io.to(session.host).emit('queue_update', { queue: session.queue });
      session.queue.forEach((cid) => {
        const you = session.queue.indexOf(cid) + 1;
        io.to(cid).emit('queue_update', { queue: session.queue, you });
      });
    }
  });

  // host can request to end current interview without providing code (fallback)
  socket.on('end_interview_now', () => {
    // find session where this socket is host
    const code = Object.keys(sessions).find((c) => sessions[c].host === socket.id);
    if (!code) return;
    const session = sessions[code];
    const candidate = session.activeCandidate;
    session.activeCandidate = null;
    if (candidate) io.to(candidate).emit('interview_ended');
    io.to(session.host).emit('interview_ended_host');
  });

  // WebRTC signaling forwarding
  socket.on('webrtc_offer', ({ to, sdp }) => {
    // forward to recipient
    if (!to) return;
    console.log('Signal: offer from', socket.id, 'to', to);
    io.to(to).emit('webrtc_offer', { from: socket.id, sdp });
  });

  socket.on('webrtc_answer', ({ to, sdp }) => {
    if (!to) return;
    console.log('Signal: answer from', socket.id, 'to', to);
    io.to(to).emit('webrtc_answer', { from: socket.id, sdp });
  });

  socket.on('webrtc_ice', ({ to, candidate }) => {
    if (!to) return;
    console.log('Signal: ice from', socket.id, 'to', to, candidate && candidate.candidate);
    io.to(to).emit('webrtc_ice', { from: socket.id, candidate });
  });

  // host informs server it's ready to receive offers
  socket.on('host_ready', ({ to }) => {
    if (!to) return;
    console.log('Host', socket.id, 'ready for candidate', to);
    io.to(to).emit('host_ready', { from: socket.id });
  });

  // forward explicit screen share signals to help clients classify incoming streams
  socket.on('screen_share_started', ({ to }) => {
    if (!to) return;
    console.log('Signal: screen_share_started from', socket.id, 'to', to);
    io.to(to).emit('screen_share_started', { from: socket.id });
  });
  socket.on('screen_share_stopped', ({ to }) => {
    if (!to) return;
    console.log('Signal: screen_share_stopped from', socket.id, 'to', to);
    io.to(to).emit('screen_share_stopped', { from: socket.id });
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    // If host disconnected, delete session and notify candidates
    if (socket.data.role === 'host') {
      const code = socket.data.sessionCode;
      const session = sessions[code];
      if (session) {
        // notify queued and active
        session.queue.forEach((cid) => {
          io.to(cid).emit('session_deleted');
        });
        if (session.activeCandidate) {
          io.to(session.activeCandidate).emit('session_deleted');
        }
        delete sessions[code];
      }
    }

    // If candidate disconnected, remove from queue or active
    if (socket.data.role === 'candidate') {
      const code = socket.data.sessionCode;
      const session = sessions[code];
      if (session) {
        // remove from queue
        const idx = session.queue.indexOf(socket.id);
        if (idx !== -1) {
          session.queue.splice(idx, 1);
          // update positions
          session.queue.forEach((cid) => {
            const you = session.queue.indexOf(cid) + 1;
            io.to(cid).emit('queue_update', { queue: session.queue, you });
          });
          io.to(session.host).emit('queue_update', { queue: session.queue });
        }
        // if active
        if (session.activeCandidate === socket.id) {
          session.activeCandidate = null;
          io.to(session.host).emit('candidate_disconnected');
        }
      }
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('Server running on http://localhost:' + port);
});
