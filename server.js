const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// 1. Configure CORS so your Netlify frontend can talk to this backend
const io = new Server(server, {
  cors: {
    origin: "*", // You can restrict this to "https://transfiosa.netlify.app" later for security
    methods: ["GET", "POST"]
  }
});

// We keep this just in case you ever want to serve static files from here again
app.use(express.static(__dirname + '/public'));

// rooms -> Map<socketId, {name, id}>
const rooms = new Map();

function broadcastRoom(room) {
  const peers = rooms.get(room);
  if (!peers) return;
  const list = [...peers.entries()].map(([id, p]) => ({ id, name: p.name }));
  for (const id of peers.keys()) {
    io.to(id).emit('peers', list.filter(p => p.id !== id));
  }
}

const ADJECTIVES = ['Swift', 'Quiet', 'Amber', 'Cobalt', 'Nimble', 'Bright', 'Violet', 'Rapid', 'Cedar', 'Coral'];
const NOUNS = ['Falcon', 'Otter', 'Maple', 'Comet', 'Lynx', 'Harbor', 'Ridge', 'Willow', 'Sparrow', 'Delta'];
function randomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a} ${n}`;
}

io.on('connection', (socket) => {
  // 2. Removed IP subnet logic. 
  // Devices now join a "global" room by default, meaning users anywhere 
  // can see each other, or you can pass a specific room code from app.js.
  const room = socket.handshake.query.room || 'global';
  const deviceName = (socket.handshake.query.name || '').toString().slice(0, 40) || randomName();

  socket.join(room);
  socket.data.room = room;
  socket.data.name = deviceName;

  if (!rooms.has(room)) rooms.set(room, new Map());
  rooms.get(room).set(socket.id, { name: deviceName });

  socket.emit('self', { id: socket.id, name: deviceName });
  broadcastRoom(room);

  // Relay WebRTC signaling only (SDP offers/answers, ICE candidates).
  socket.on('signal', ({ to, data }) => {
    if (!to || !rooms.get(room)?.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, name: deviceName, data });
  });

  socket.on('rename', (name) => {
    const clean = (name || '').toString().slice(0, 40);
    if (!clean) return;
    socket.data.name = clean;
    const peers = rooms.get(room);
    if (peers?.has(socket.id)) peers.get(socket.id).name = clean;
    socket.emit('self', { id: socket.id, name: clean });
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    const peers = rooms.get(room);
    if (!peers) return;
    peers.delete(socket.id);
    if (peers.size === 0) rooms.delete(room);
    else broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nCloud signaling server running on port ${PORT}.\n`);
});