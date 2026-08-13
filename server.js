const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(__dirname + '/public'));

// rooms -> Map<roomName, Map<socketId, peerObj>>
const rooms = new Map();
// Active pairing requests: pairingId -> { from, to, code, confirmations: Set }
const activePairings = new Map();

function broadcastRoom(room) {
  const peers = rooms.get(room);
  if (!peers) return;

  // Deduplicate entries by deviceId to guarantee each physical device appears only once
  const uniqueDevices = new Map();
  for (const [id, p] of peers.entries()) {
    const key = p.deviceId || id;
    if (!uniqueDevices.has(key)) {
      uniqueDevices.set(key, { id, name: p.name, deviceId: p.deviceId, pairedWith: p.pairedWith || null });
    }
  }

  const list = Array.from(uniqueDevices.values());

  for (const id of peers.keys()) {
    io.to(id).emit('peers', list.filter(p => p.id !== id));
  }
}

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

const ADJECTIVES = ['Swift', 'Quiet', 'Amber', 'Cobalt', 'Nimble', 'Bright', 'Violet', 'Rapid', 'Cedar', 'Coral'];
const NOUNS = ['Falcon', 'Otter', 'Maple', 'Comet', 'Lynx', 'Harbor', 'Ridge', 'Willow', 'Sparrow', 'Delta'];
function randomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a} ${n}`;
}

io.on('connection', (socket) => {
  const room = socket.handshake.query.room || 'global';
  const deviceName = (socket.handshake.query.name || '').toString().slice(0, 40) || randomName();
  const deviceId = socket.handshake.query.deviceId;

  socket.join(room);
  socket.data.room = room;
  socket.data.name = deviceName;
  socket.data.deviceId = deviceId;
  socket.data.pairedWith = null;

  if (!rooms.has(room)) rooms.set(room, new Map());
  const peers = rooms.get(room);

  // Remove duplicate/ghost connections for the same deviceId
  if (deviceId) {
    for (const [existingSocketId, peer] of peers.entries()) {
      if (peer.deviceId === deviceId && existingSocketId !== socket.id) {
        peers.delete(existingSocketId);
        io.sockets.sockets.get(existingSocketId)?.disconnect(true);
      }
    }
  }

  peers.set(socket.id, { name: deviceName, deviceId, pairedWith: null });
  socket.emit('self', { id: socket.id, name: deviceName });
  broadcastRoom(room);

  // --- PAIRING WORKFLOW SIGNALS ---

  // Request Pairing
  socket.on('request-pair', ({ targetId }) => {
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket) return;

    // Check if target is already paired
    const targetPeer = peers.get(targetId);
    if (targetPeer?.pairedWith || socket.data.pairedWith) {
      socket.emit('pair-error', { message: 'One of the devices is already paired with another device.' });
      return;
    }

    const pairingId = `${socket.id}_${targetId}_${Date.now()}`;
    const code = generateVerificationCode();

    activePairings.set(pairingId, {
      pairingId,
      from: socket.id,
      to: targetId,
      code,
      confirmations: new Set()
    });

    // Send verification modal data to both initiator and recipient
    io.to(socket.id).emit('pair-verify', {
      pairingId,
      peerId: targetId,
      peerName: targetPeer.name,
      code,
      role: 'initiator'
    });

    io.to(targetId).emit('pair-verify', {
      pairingId,
      peerId: socket.id,
      peerName: socket.data.name,
      code,
      role: 'recipient'
    });
  });

  // Respond to Pairing (Pair / Cancel)
  socket.on('pair-response', ({ pairingId, action }) => {
    const session = activePairings.get(pairingId);
    if (!session) return;

    if (action === 'cancel') {
      // Notify both devices to return to Device Discovery phase
      io.to(session.from).emit('pair-cancelled', { reason: 'Pairing cancelled.' });
      io.to(session.to).emit('pair-cancelled', { reason: 'Pairing cancelled.' });
      activePairings.delete(pairingId);
      return;
    }

    if (action === 'pair') {
      session.confirmations.add(socket.id);

      // Once both devices confirm pairing
      if (session.confirmations.has(session.from) && session.confirmations.has(session.to)) {
        const peerA = peers.get(session.from);
        const peerB = peers.get(session.to);

        if (peerA) peerA.pairedWith = session.to;
        if (peerB) peerB.pairedWith = session.from;

        socket.data.pairedWith = (socket.id === session.from) ? session.to : session.from;

        io.to(session.from).emit('pair-success', { peerId: session.to, peerName: peerB?.name });
        io.to(session.to).emit('pair-success', { peerId: session.from, peerName: peerA?.name });

        activePairings.delete(pairingId);
        broadcastRoom(room);
      }
    }
  });

  // End Current Pairing
  socket.on('unpair', () => {
    const partnerId = socket.data.pairedWith;
    socket.data.pairedWith = null;

    const peerObj = peers.get(socket.id);
    if (peerObj) peerObj.pairedWith = null;

    if (partnerId) {
      const partnerPeer = peers.get(partnerId);
      if (partnerPeer) partnerPeer.pairedWith = null;
      io.to(partnerId).emit('unpaired');
    }

    socket.emit('unpaired');
    broadcastRoom(room);
  });

  // Relay WebRTC signaling ONLY between paired devices
  socket.on('signal', ({ to, data }) => {
    if (!to || !rooms.get(room)?.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, name: deviceName, data });
  });

  socket.on('rename', (name) => {
    const clean = (name || '').toString().slice(0, 40);
    if (!clean) return;
    socket.data.name = clean;
    const roomPeers = rooms.get(room);
    if (roomPeers?.has(socket.id)) roomPeers.get(socket.id).name = clean;
    socket.emit('self', { id: socket.id, name: clean });
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    const roomPeers = rooms.get(room);
    if (!roomPeers) return;

    if (socket.data.pairedWith) {
      io.to(socket.data.pairedWith).emit('unpaired');
      const partnerPeer = roomPeers.get(socket.data.pairedWith);
      if (partnerPeer) partnerPeer.pairedWith = null;
    }

    roomPeers.delete(socket.id);
    if (roomPeers.size === 0) rooms.delete(room);
    else broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nCloud signaling server running on port ${PORT}.\n`);
});