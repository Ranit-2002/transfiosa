(() => {
  'use strict';

  const CHUNK_SIZE = 64 * 1024;
  const BUFFERED_AMOUNT_LOW = 1 * 1024 * 1024;
  const BUFFERED_AMOUNT_HIGH = 4 * 1024 * 1024;
  const RTC_CONFIG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  };

  const state = {
    selfId: null,
    selfName: '',
    peers: new Map(),
    activePairingId: null,
    pairedPeer: null, // { id, name }
    connection: null, // RTCConnWrapper for paired peer
    transfers: new Map(),
  };

  let deviceId = localStorage.getItem('beam_device_id');
  if (!deviceId) {
    deviceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('beam_device_id', deviceId);
  }

  const socket = io('https://transfiosa-backend.onrender.com', { 
    query: { 
      name: localStorage.getItem('beam_name') || '',
      deviceId: deviceId
    } 
  });

  // DOM Elements
  const el = {
    netDot: document.getElementById('netDot'),
    netLabel: document.getElementById('netLabel'),
    selfName: document.getElementById('selfName'),
    renameBtn: document.getElementById('renameBtn'),
    discoverySection: document.getElementById('discoverySection'),
    radar: document.getElementById('radar'),
    radarCaption: document.getElementById('radarCaption'),
    peersList: document.getElementById('peersList'),
    peersEmpty: document.getElementById('peersEmpty'),
    peerCount: document.getElementById('peerCount'),
    pairedSection: document.getElementById('pairedSection'),
    pairedDeviceName: document.getElementById('pairedDeviceName'),
    unpairBtn: document.getElementById('unpairBtn'),
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    dzSub: document.getElementById('dzSub'),
    transfersZone: document.getElementById('transfersZone'),
    transfersList: document.getElementById('transfersList'),
    pairingModalBackdrop: document.getElementById('pairingModalBackdrop'),
    pairPeerName: document.getElementById('pairPeerName'),
    verifyCodeDisplay: document.getElementById('verifyCodeDisplay'),
    pairCancelBtn: document.getElementById('pairCancelBtn'),
    pairConfirmBtn: document.getElementById('pairConfirmBtn'),
    toastStack: document.getElementById('toastStack'),
  };

  function fmtBytes(n) {
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }
  function fmtSpeed(b) { return b <= 0 ? '—' : fmtBytes(b) + '/s'; }
  function fmtEta(s) { return (!isFinite(s) || s <= 0) ? '—' : `${Math.ceil(s)}s left`; }
  function initials(name) { return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
  function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // --- Network Connection Events ---
  socket.on('connect', () => {
    el.netDot.classList.add('online');
    el.netDot.classList.remove('offline');
    el.netLabel.textContent = 'On network';
  });
  socket.on('disconnect', () => {
    el.netDot.classList.remove('online');
    el.netDot.classList.add('offline');
    el.netLabel.textContent = 'Disconnected';
    resetToDiscovery();
  });

  socket.on('self', ({ id, name }) => {
    state.selfId = id;
    state.selfName = name;
    el.selfName.textContent = name;
  });

  socket.on('peers', (list) => {
    // Only keep unpaired devices in discovery list
    const filtered = list.filter(p => !p.pairedWith);
    state.peers = new Map(filtered.map(p => [p.id, p]));
    if (!state.pairedPeer) {
      renderPeers();
    }
  });

  // --- Rename Device ---
  el.renameBtn.addEventListener('click', () => {
    const next = prompt('Name this device', state.selfName);
    if (next && next.trim()) {
      const clean = next.trim().slice(0, 40);
      localStorage.setItem('beam_name', clean);
      socket.emit('rename', clean);
    }
  });

  // --- Render Discovered Devices ---
  function renderPeers() {
    const list = [...state.peers.values()];

    el.peerCount.textContent = `${list.length} found`;
    el.peersEmpty.hidden = list.length > 0;
    [...el.peersList.querySelectorAll('.peer-row')].forEach(n => n.remove());

    list.forEach(peer => {
      const row = document.createElement('div');
      row.className = 'peer-row';
      row.tabIndex = 0;
      row.innerHTML = `
        <div class="peer-avatar">${initials(peer.name)}</div>
        <div class="peer-info">
          <span class="peer-name">${escapeHtml(peer.name)}</span>
          <span class="peer-status-tag">Ready to Connect</span>
        </div>
        <button class="connect-action-btn">Connect</button>
      `;
      const trigger = () => initiatePairing(peer.id);
      row.addEventListener('click', trigger);
      el.peersList.appendChild(row);
    });

    [...el.radar.querySelectorAll('.peer-node')].forEach(n => n.remove());
    const radius = el.radar.clientWidth ? el.radar.clientWidth * 0.5 - 20 : 110;
    list.forEach((peer, i) => {
      const angle = (i / Math.max(list.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle) * radius * 0.65;
      const y = Math.sin(angle) * radius * 0.65;
      const node = document.createElement('button');
      node.className = 'peer-node';
      node.style.left = `calc(50% + ${x}px - 20px)`;
      node.style.top = `calc(50% + ${y}px - 20px)`;
      node.textContent = initials(peer.name);
      node.title = `${peer.name} - Ready to Connect`;
      node.addEventListener('click', () => initiatePairing(peer.id));
      el.radar.appendChild(node);
    });

    el.radarCaption.textContent = list.length
      ? `${list.length} device${list.length === 1 ? '' : 's'} ready to connect`
      : 'Searching network for available devices…';
  }

  // --- PAIRING WORKFLOW ---

  function initiatePairing(peerId) {
    socket.emit('request-pair', { targetId: peerId });
  }

  // Receive Pairing Verification Request (Same code shown on both devices)
  socket.on('pair-verify', ({ pairingId, peerName, code }) => {
    state.activePairingId = pairingId;
    el.pairPeerName.textContent = peerName;
    el.verifyCodeDisplay.textContent = code;
    el.pairingModalBackdrop.hidden = false;
  });

  // Cancel Pairing
  el.pairCancelBtn.addEventListener('click', () => {
    if (state.activePairingId) {
      socket.emit('pair-response', { pairingId: state.activePairingId, action: 'cancel' });
    }
    closePairingModal();
  });

  // Confirm Pairing
  el.pairConfirmBtn.addEventListener('click', () => {
    if (state.activePairingId) {
      el.pairConfirmBtn.disabled = true;
      el.pairConfirmBtn.textContent = 'Waiting for partner…';
      socket.emit('pair-response', { pairingId: state.activePairingId, action: 'pair' });
    }
  });

  socket.on('pair-cancelled', ({ reason }) => {
    closePairingModal();
    pushToast({ text: reason || 'Pairing request was cancelled.' });
  });

  socket.on('pair-error', ({ message }) => {
    closePairingModal();
    pushToast({ text: message });
  });

  // Pairing Confirmed -> Hide other devices, lock to exclusive connection
  socket.on('pair-success', ({ peerId, peerName }) => {
    closePairingModal();
    state.pairedPeer = { id: peerId, name: peerName };

    // Hide Discovery Phase, Show Paired View
    el.discoverySection.hidden = true;
    el.pairedSection.hidden = false;
    el.pairedDeviceName.textContent = peerName;
    el.dzSub.textContent = `Ready to send files exclusively to ${peerName}`;

    // Establish WebRTC Data Connection
    state.connection = new RTCConnWrapper(peerId, peerName, true);
  });

  function closePairingModal() {
    el.pairingModalBackdrop.hidden = true;
    el.pairConfirmBtn.disabled = false;
    el.pairConfirmBtn.textContent = 'Pair';
    state.activePairingId = null;
  }

  // --- UNPAIR / DISCONNECT WORKFLOW ---
  el.unpairBtn.addEventListener('click', () => {
    socket.emit('unpair');
  });

  socket.on('unpaired', () => {
    resetToDiscovery();
    pushToast({ text: 'Pairing ended. Returning to device discovery.' });
  });

  function resetToDiscovery() {
    if (state.connection) {
      state.connection.close();
      state.connection = null;
    }
    state.pairedPeer = null;
    el.pairedSection.hidden = true;
    el.discoverySection.hidden = false;
    el.dzSub.textContent = 'Pair with a device above to begin file transfer';
    renderPeers();
  }

  // --- FILE TRANSFER WORKFLOW ---
  el.dropzone.addEventListener('click', () => {
    if (!state.pairedPeer) {
      pushToast({ text: 'Please select and pair with a device first.' });
      return;
    }
    el.fileInput.click();
  });

  el.fileInput.addEventListener('change', () => {
    if (el.fileInput.files.length) handleSendFiles(el.fileInput.files);
    el.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(evt =>
    el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); el.dropzone.classList.add('drag-over'); })
  );
  ['dragleave', 'drop'].forEach(evt =>
    el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); el.dropzone.classList.remove('drag-over'); })
  );
  el.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('drag-over');
    if (!state.pairedPeer) {
      pushToast({ text: 'Please select and pair with a device first.' });
      return;
    }
    if (e.dataTransfer?.files?.length) handleSendFiles(e.dataTransfer.files);
  });

  function handleSendFiles(fileList) {
    if (!state.connection) {
      pushToast({ text: 'No active paired connection found.' });
      return;
    }
    state.connection.enqueueBatch([...fileList]);
  }

  // --- WEBRTC CONNECTION WRAPPER ---
  class RTCConnWrapper {
    constructor(peerId, peerName, initiator) {
      this.peerId = peerId;
      this.peerName = peerName;
      this.pc = new RTCPeerConnection(RTC_CONFIG);
      this.channel = null;
      this.sendQueue = [];
      this.activeSend = null;
      this.incoming = null;

      this.pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('signal', { to: peerId, data: { type: 'ice', candidate: e.candidate } });
        }
      };

      if (initiator) {
        this.channel = this.pc.createDataChannel('files', { ordered: true });
        this.setupChannel();
        this.pc.onnegotiationneeded = async () => {
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          socket.emit('signal', { to: peerId, data: { type: 'offer', sdp: this.pc.localDescription } });
        };
      } else {
        this.pc.ondatachannel = (e) => {
          this.channel = e.channel;
          this.setupChannel();
        };
      }
    }

    setupChannel() {
      this.channel.binaryType = 'arraybuffer';
      this.channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;
      this.channel.onopen = () => this.pumpSendQueue();
      this.channel.onmessage = (e) => this.handleMessage(e.data);
      this.channel.onbufferedamountlow = () => this.pumpActiveSend();
    }

    async handleSignal(data) {
      if (data.type === 'offer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        socket.emit('signal', { to: this.peerId, data: { type: 'answer', sdp: this.pc.localDescription } });
      } else if (data.type === 'answer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.type === 'ice') {
        try { await this.pc.addIceCandidate(data.candidate); } catch (_) {}
      }
    }

    close() {
      try { this.channel?.close(); } catch (_) {}
      try { this.pc.close(); } catch (_) {}
    }

    enqueueBatch(files) {
      const batchId = uid();
      const jobs = files.map(file => ({ transferId: uid(), batchId, file, offset: 0 }));
      this.sendQueue.push(...jobs);

      jobs.forEach(job => {
        addTransferRow({
          id: job.transferId,
          dir: 'up',
          name: job.file.name,
          size: job.file.size,
          peerName: this.peerName,
          status: 'Sending…',
        });
      });

      this.pumpSendQueue();
    }

    pumpSendQueue() {
      if (this.activeSend || this.sendQueue.length === 0) return;
      if (!this.channel || this.channel.readyState !== 'open') return;
      const next = this.sendQueue.shift();
      this.startSend(next);
    }

    async startSend(job) {
      this.activeSend = job;
      job.startTime = performance.now();
      job.lastTick = job.startTime;
      job.lastBytes = 0;

      this.send(JSON.stringify({
        kind: 'file-start',
        transferId: job.transferId,
        name: job.file.name,
        size: job.file.size,
        type: job.file.type,
      }));

      job.reader = job.file.stream().getReader();
      this.pumpActiveSend();
    }

    async pumpActiveSend() {
      const job = this.activeSend;
      if (!job || this.channel.readyState !== 'open') return;

      while (this.channel.bufferedAmount < BUFFERED_AMOUNT_HIGH) {
        const result = await job.reader.read();
        if (result.done) {
          this.send(JSON.stringify({ kind: 'file-end', transferId: job.transferId }));
          updateTransferRow(job.transferId, {
            status: 'Sent',
            statusClass: 'status-done',
            progress: 1,
            metaText: fmtBytes(job.file.size),
          });
          this.activeSend = null;
          this.pumpSendQueue();
          return;
        }

        const chunk = result.value;
        for (let o = 0; o < chunk.byteLength; o += CHUNK_SIZE) {
          const piece = chunk.slice(o, Math.min(o + CHUNK_SIZE, chunk.byteLength));
          this.channel.send(piece.buffer.byteLength === piece.byteLength ? piece.buffer : piece);
          job.offset += piece.byteLength;
        }

        const now = performance.now();
        if (now - job.lastTick > 180) {
          const dt = (now - job.lastTick) / 1000;
          const speed = dt > 0 ? (job.offset - job.lastBytes) / dt : 0;
          updateTransferRow(job.transferId, {
            progress: job.file.size ? job.offset / job.file.size : 1,
            speedText: fmtSpeed(speed),
            etaText: fmtEta((job.file.size - job.offset) / (speed || 1)),
            metaText: `${fmtBytes(job.offset)} / ${fmtBytes(job.file.size)}`,
          });
          job.lastTick = now;
          job.lastBytes = job.offset;
        }
      }
    }

    send(data) {
      if (this.channel && this.channel.readyState === 'open') this.channel.send(data);
    }

    handleMessage(data) {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.kind === 'file-start') {
          this.incoming = {
            transferId: msg.transferId,
            name: msg.name,
            size: msg.size,
            type: msg.type || 'application/octet-stream',
            received: 0,
            chunks: [],
            lastTick: performance.now(),
            lastBytes: 0,
          };
          addTransferRow({
            id: msg.transferId,
            dir: 'down',
            name: msg.name,
            size: msg.size,
            peerName: this.peerName,
            status: 'Receiving…',
          });
        } else if (msg.kind === 'file-end' && this.incoming) {
          const blob = new Blob(this.incoming.chunks, { type: this.incoming.type });
          updateTransferRow(this.incoming.transferId, {
            status: 'Received',
            statusClass: 'status-done',
            progress: 1,
            metaText: fmtBytes(this.incoming.size),
            downloadUrl: URL.createObjectURL(blob),
            downloadName: this.incoming.name,
          });
          this.incoming = null;
        }
      } else if (this.incoming) {
        this.incoming.chunks.push(data);
        this.incoming.received += data.byteLength;
        const now = performance.now();
        if (now - this.incoming.lastTick > 180) {
          const dt = (now - this.incoming.lastTick) / 1000;
          const speed = dt > 0 ? (this.incoming.received - this.incoming.lastBytes) / dt : 0;
          updateTransferRow(this.incoming.transferId, {
            progress: this.incoming.size ? this.incoming.received / this.incoming.size : 1,
            speedText: fmtSpeed(speed),
            metaText: `${fmtBytes(this.incoming.received)} / ${fmtBytes(this.incoming.size)}`,
          });
          this.incoming.lastTick = now;
          this.incoming.lastBytes = this.incoming.received;
        }
      }
    }
  }

  // --- Signal Relay Handler ---
  socket.on('signal', ({ from, name, data }) => {
    // Re-instantiate incoming connection if paired device initiates signal
    if (!state.connection && state.pairedPeer && state.pairedPeer.id === from) {
      state.connection = new RTCConnWrapper(from, name || state.pairedPeer.name, false);
    }
    if (state.connection && state.pairedPeer?.id === from) {
      state.connection.handleSignal(data);
    }
  });

  // --- Transfer UI Helpers ---
  function addTransferRow({ id, dir, name, size, peerName, status }) {
    el.transfersZone.hidden = false;
    const card = document.createElement('div');
    card.className = 'transfer-card';
    card.dataset.id = id;
    card.innerHTML = `
      <div class="transfer-top">
        <div class="transfer-meta">
          <span class="transfer-name">${escapeHtml(name)}</span>
          <span class="transfer-peer">${dir === 'up' ? 'To' : 'From'} ${escapeHtml(peerName)}</span>
        </div>
        <span class="transfer-status">${escapeHtml(status)}</span>
      </div>
      <div class="transfer-bar-track"><div class="transfer-bar-fill"></div></div>
      <div class="transfer-stats">
        <span class="stat-meta">${fmtBytes(size)}</span>
        <span class="stat-speed"></span>
        <span class="stat-eta"></span>
      </div>
      <div class="transfer-actions" hidden></div>
    `;
    el.transfersList.prepend(card);
  }

  function updateTransferRow(id, patch) {
    const card = el.transfersList.querySelector(`.transfer-card[data-id="${id}"]`);
    if (!card) return;
    if (patch.status) {
      const statusEl = card.querySelector('.transfer-status');
      statusEl.textContent = patch.status;
      if (patch.statusClass) statusEl.className = `transfer-status ${patch.statusClass}`;
    }
    if (patch.progress !== undefined) {
      card.querySelector('.transfer-bar-fill').style.width = `${Math.min(100, Math.round(patch.progress * 100))}%`;
    }
    if (patch.metaText) card.querySelector('.stat-meta').textContent = patch.metaText;
    if (patch.speedText) card.querySelector('.stat-speed').textContent = patch.speedText;
    if (patch.etaText) card.querySelector('.stat-eta').textContent = patch.etaText;
    if (patch.downloadUrl) {
      const actions = card.querySelector('.transfer-actions');
      actions.hidden = false;
      actions.innerHTML = `<a class="transfer-btn primary" href="${patch.downloadUrl}" download="${escapeHtml(patch.downloadName)}">Save File</a>`;
    }
  }

  function pushToast({ text }) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<div class="toast-text">${text}</div>`;
    el.toastStack.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

})();