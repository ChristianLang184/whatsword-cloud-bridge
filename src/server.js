import express from 'express';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Session storage
const sessions = new Map();

// WebSocket Server
const wss = new WebSocketServer({ noServer: true });

/**
 * Session structure:
 * {
 *   id: string,
 *   hostId: string,
 *   guestId: string | null,
 *   hostWs: WebSocket | null,
 *   guestWs: WebSocket | null,
 *   createdAt: Date,
 *   lastActivity: Date
 * }
 */

// Create new session
app.post('/api/session/create', (req, res) => {
  const sessionId = uuidv4().substring(0, 8).toUpperCase();
  const hostId = uuidv4();
  
  const session = {
    id: sessionId,
    hostId,
    guestId: null,
    hostWs: null,
    guestWs: null,
    createdAt: new Date(),
    lastActivity: new Date()
  };
  
  sessions.set(sessionId, session);
  
  console.log(`✅ Session created: ${sessionId}`);
  
  res.json({
    sessionId,
    hostId,
    guestUrl: `${process.env.GUEST_URL || 'http://localhost:3001'}/join/${sessionId}`
  });
});

// Get session info
app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json({
    sessionId: session.id,
    hasHost: !!session.hostWs,
    hasGuest: !!session.guestWs,
    createdAt: session.createdAt
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: sessions.size,
    uptime: process.uptime()
  });
});

// WebSocket connection handler
wss.on('connection', (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  const role = url.searchParams.get('role'); // 'host' or 'guest'
  const clientId = url.searchParams.get('clientId');
  
  console.log(`🔌 WebSocket connection: ${role} for session ${sessionId}`);
  
  if (!sessionId || !role) {
    ws.close(1008, 'Missing sessionId or role');
    return;
  }
  
  const session = sessions.get(sessionId);
  
  if (!session) {
    ws.close(1008, 'Session not found');
    return;
  }
  
  // Attach WebSocket to session
  if (role === 'host') {
    if (clientId !== session.hostId) {
      ws.close(1008, 'Invalid host ID');
      return;
    }
    session.hostWs = ws;
    console.log(`✅ Host connected to session ${sessionId}`);
  } else if (role === 'guest') {
    if (!session.guestId) {
      session.guestId = uuidv4();
    }
    session.guestWs = ws;
    console.log(`✅ Guest connected to session ${sessionId}`);
    
    // Notify host that guest joined
    if (session.hostWs && session.hostWs.readyState === 1) {
      session.hostWs.send(JSON.stringify({
        type: 'guest_joined',
        guestId: session.guestId,
        timestamp: new Date().toISOString()
      }));
    }
  }
  
  session.lastActivity = new Date();
  
  // Send initial connection confirmation
  ws.send(JSON.stringify({
    type: 'connected',
    role,
    sessionId,
    timestamp: new Date().toISOString()
  }));
  
  // Ping/Pong to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000); // Every 30 seconds
  
  ws.on('pong', () => {
    session.lastActivity = new Date();
  });
  
  // Handle incoming messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(session, role, message);
    } catch (error) {
      console.error('❌ Error parsing message:', error);
    }
  });
  
  // Handle disconnection
  ws.on('close', () => {
    clearInterval(pingInterval);
    console.log(`🔌 ${role} disconnected from session ${sessionId}`);
    
    if (role === 'host') {
      session.hostWs = null;
      // Notify guest that host left
      if (session.guestWs && session.guestWs.readyState === 1) {
        session.guestWs.send(JSON.stringify({
          type: 'host_left',
          timestamp: new Date().toISOString()
        }));
      }
    } else if (role === 'guest') {
      session.guestWs = null;
      // Notify host that guest left
      if (session.hostWs && session.hostWs.readyState === 1) {
        session.hostWs.send(JSON.stringify({
          type: 'guest_left',
          timestamp: new Date().toISOString()
        }));
      }
    }
    
    // Clean up empty sessions after 5 minutes
    setTimeout(() => {
      if (!session.hostWs && !session.guestWs) {
        sessions.delete(sessionId);
        console.log(`🗑️  Session ${sessionId} cleaned up`);
      }
    }, 5 * 60 * 1000);
  });
  
  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for ${role}:`, error);
  });
});

/**
 * Handle incoming WebSocket messages
 */
function handleMessage(session, senderRole, message) {
  session.lastActivity = new Date();
  
  const { type, ...payload } = message;
  
  console.log(`📨 Message from ${senderRole}: ${type}`);
  
  // Route message to the other party
  const targetWs = senderRole === 'host' ? session.guestWs : session.hostWs;
  
  if (!targetWs || targetWs.readyState !== 1) {
    console.log(`⚠️  Target not connected for session ${session.id}`);
    return;
  }
  
  // Forward message with sender info
  targetWs.send(JSON.stringify({
    ...message,
    sender: senderRole,
    timestamp: new Date().toISOString()
  }));
}

// Create HTTP server
const server = app.listen(PORT, () => {
  console.log(`🚀 WhatsWord Cloud Bridge Server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`🌐 Guest URL: ${process.env.GUEST_URL || 'http://localhost:3001'}`);
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Cleanup old sessions every 10 minutes
setInterval(() => {
  const now = new Date();
  const timeout = 30 * 60 * 1000; // 30 minutes
  
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivity > timeout) {
      if (session.hostWs) session.hostWs.close();
      if (session.guestWs) session.guestWs.close();
      sessions.delete(sessionId);
      console.log(`🗑️  Session ${sessionId} timed out`);
    }
  }
}, 10 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, closing server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
