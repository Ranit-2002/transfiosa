const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname + '/public'));

// Group peers by /24 subnet so only devices on the same LAN see each other.
function subnetOf(ip) {
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  const parts = ip.split('.');
  if (parts.length !== 4) return ip; // ipv6 or unparsable -> isolate
  return parts.slice(0, 3).join('.') + '.0/24';
}

// room -> Map<socketId, {name, id}>
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
  const rawIp = socket.handshake.address;
  const room = subnetOf(rawIp);
  const deviceName = (socket.handshake.query.name || '').toString().slice(0, 40) || randomName();

  socket.join(room);
  socket.data.room = room;
  socket.data.name = deviceName;

  if (!rooms.has(room)) rooms.set(room, new Map());
  rooms.get(room).set(socket.id, { name: deviceName });

  socket.emit('self', { id: socket.id, name: deviceName });
  broadcastRoom(room);

  // Relay WebRTC signaling only (SDP offers/answers, ICE candidates).
  // File contents never pass through the server.
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
  const nets = os.networkInterfaces();
  console.log(`\nLocal file transfer server running.\n`);
  console.log(`On this machine:  http://localhost:${PORT}`);
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`On your LAN:      http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`\nOpen the LAN address on every device you want to connect.\n`);
});
