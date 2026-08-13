(() => {
  'use strict';

  // ---------- Configuration ----------
  const CHUNK_SIZE = 64 * 1024;                 // 64 KB per chunk
  const BUFFERED_AMOUNT_LOW = 256 * 1024;       // Resume sending below 256 KB
  const BUFFERED_AMOUNT_HIGH = 1024 * 1024;     // Pause sending above 1 MB
  const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB maximum file size limit
  
  // Multi-STUN configuration for cross-network (Wi-Fi / Cellular) P2P candidate resolution
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  };

  // ---------- Application State ----------
  const state = {
    selfId: null,
    selfName: '',
    peers: new Map(),        // id -> peer object
    activePairingId: null,   // Active pairing session ID
    pairedPeer: null,        // { id, name } once successfully paired
    connection: null,        // Active RTCConnWrapper instance
    transfers: new Map(),    // transferId -> transfer metadata
  };

  // ---------- Persistent Device Identity ----------
  let deviceId = localStorage.getItem('beam_device_id');
  if (!deviceId) {
    deviceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('beam_device_id', deviceId);
  }

  // Connect to signaling backend with unique device persistent ID
  const socket = io('https://transfiosa-backend.onrender.com', { 
    query: { 
      name: localStorage.getItem('beam_name') || '',
      deviceId: deviceId
    } 
  });

  // ---------- DOM Element References ----------
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

  // ---------- Formatting & Helper Utilities ----------
  function fmtBytes(n) {
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }
  function fmtSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '—';
    return fmtBytes(bytesPerSec) + '/s';
  }
  function fmtEta(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '—';
    if (seconds < 60) return `${Math.ceil(seconds)}s left`;
    const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
    return `${m}m ${s}s left`;
  }
  function initials(name) {
    return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  }
  function uid() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ---------- Socket Network Events ----------
  socket.on('connect', () => {
    console.log('Connected with Device ID:', deviceId, 'and Socket ID:', socket.id);
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
    // Filter and display unpaired devices
    const filtered = list.filter(p => !p.pairedWith);
    state.peers = new Map(filtered.map(p => [p.id, p]));
    if (!state.pairedPeer) {
      renderPeers();
    }
  });

  // ---------- Device Rename Listener ----------
  el.renameBtn.addEventListener('click', () => {
    const next = prompt('Name this device', state.selfName);
    if (next && next.trim()) {
      const clean = next.trim().slice(0, 40);
      localStorage.setItem('beam_name', clean);
      socket.emit('rename', clean);
    }
  });

  // ---------- Render Device Discovery (List + Radar) ----------
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

  // ---------- Pairing Workflow & Modal Events ----------
  function initiatePairing(peerId) {
    socket.emit('request-pair', { targetId: peerId });
  }

  // Receive Verification Code Popup
  socket.on('pair-verify', ({ pairingId, peerName, code }) => {
    state.activePairingId = pairingId;
    el.pairPeerName.textContent = peerName;
    el.verifyCodeDisplay.textContent = code;
    el.pairingModalBackdrop.hidden = false;
  });

  // Handle Cancel Button Click
  el.pairCancelBtn.addEventListener('click', () => {
    if (state.activePairingId) {
      socket.emit('pair-response', { pairingId: state.activePairingId, action: 'cancel' });
    }
    closePairingModal();
  });

  // Handle Confirm "Pair" Button Click
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

  // Successful Pairing Event
  socket.on('pair-success', ({ peerId, peerName, initiator }) => {
    closePairingModal();
    state.pairedPeer = { id: peerId, name: peerName };

    el.discoverySection.hidden = true;
    el.pairedSection.hidden = false;
    el.pairedDeviceName.textContent = peerName;
    el.dzSub.textContent = `Connecting P2P channel with ${peerName}…`;

    // Initialize WebRTC connection with explicit initiator role
    state.connection = new RTCConnWrapper(peerId, peerName, initiator);
  });

  function closePairingModal() {
    el.pairingModalBackdrop.hidden = true;
    el.pairConfirmBtn.disabled = false;
    el.pairConfirmBtn.textContent = 'Pair';
    state.activePairingId = null;
  }

  // ---------- Unpair / Connection Disconnection ----------
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

  // ---------- File Dropzone & Selection Handling ----------
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

  // ============================================================
  // WebRTC Peer-to-Peer Data Channel Wrapper
  // ============================================================
  class RTCConnWrapper {
    constructor(peerId, peerName, initiator) {
      this.peerId = peerId;
      this.peerName = peerName;
      this.initiator = initiator;
      this.pc = new RTCPeerConnection(RTC_CONFIG);
      this.channel = null;
      this.sendQueue = [];
      this.activeSend = null;
      this.incoming = null;

      // ICE Candidate Gathering
      this.pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('signal', { to: peerId, data: { type: 'ice', candidate: e.candidate } });
        }
      };

      if (initiator) {
        this.channel = this.pc.createDataChannel('files', { ordered: true });
        this.setupChannel();
        this.pc.onnegotiationneeded = async () => {
          try {
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);
            socket.emit('signal', { to: peerId, data: { type: 'offer', sdp: this.pc.localDescription } });
          } catch (err) {
            console.error('Failed to create offer:', err);
          }
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

      this.channel.onopen = () => {
        console.log('P2P DataChannel successfully OPEN');
        if (el.dzSub) el.dzSub.textContent = `Ready to send files exclusively to ${this.peerName}`;
        this.pumpSendQueue();
      };

      this.channel.onmessage = (e) => this.handleMessage(e.data);
      this.channel.onbufferedamountlow = () => this.pumpActiveSend();
      this.channel.onclose = () => this.handleChannelClosed();
      this.channel.onerror = (err) => {
        console.error('DataChannel error:', err);
        this.handleChannelClosed();
      };
    }

    handleChannelClosed() {
      if (el.dzSub) el.dzSub.textContent = `P2P Connection lost with ${this.peerName}`;
      if (this.activeSend) {
        updateTransferRow(this.activeSend.transferId, {
          status: 'Connection lost', statusClass: 'status-error'
        });
        this.activeSend = null;
      }
    }

    async handleSignal(data) {
      if (data.type === 'offer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        socket.emit('signal', { to: this.peerId, data: { type: 'answer', sdp: this.pc.localDescription } });
      } else if (data.type === 'answer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.type === 'ice' && data.candidate) {
        try { await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (_) {}
      }
    }

    close() {
      try { this.channel?.close(); } catch (_) {}
      try { this.pc.close(); } catch (_) {}
    }

    // Queue outgoing files for transmission (with 5 GB size validation)
    enqueueBatch(files) {
      const oversized = files.filter(f => f.size > MAX_FILE_SIZE);
      if (oversized.length > 0) {
        const names = oversized.map(f => f.name).join(', ');
        pushToast({ text: `File(s) exceed the 5 GB maximum limit: ${names}` });
      }

      const validFiles = files.filter(f => f.size <= MAX_FILE_SIZE);
      if (validFiles.length === 0) return;

      const batchId = uid();
      const jobs = validFiles.map(file => ({ transferId: uid(), batchId, file, offset: 0 }));
      this.sendQueue.push(...jobs);

      const isChannelOpen = this.channel && this.channel.readyState === 'open';

      jobs.forEach(job => {
        addTransferRow({
          id: job.transferId,
          dir: 'up',
          name: job.file.name,
          size: job.file.size,
          peerName: this.peerName,
          status: isChannelOpen ? 'Sending…' : 'Connecting P2P channel…',
        });
      });

      if (isChannelOpen) {
        this.pumpSendQueue();
      }
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
      job.currentChunk = null;
      job.chunkOffset = 0;
      job.isSending = false;

      updateTransferRow(job.transferId, { status: 'Sending…' });

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
      if (!job || !this.channel || this.channel.readyState !== 'open') return;

      if (job.isSending) return;
      job.isSending = true;

      try {
        while (this.channel.bufferedAmount < BUFFERED_AMOUNT_HIGH) {
          if (!job.currentChunk) {
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
              job.isSending = false;
              this.pumpSendQueue();
              return;
            }
            job.currentChunk = result.value;
            job.chunkOffset = 0;
          }

          while (job.chunkOffset < job.currentChunk.byteLength) {
            if (this.channel.bufferedAmount >= BUFFERED_AMOUNT_HIGH) {
              job.isSending = false;
              return;
            }

            const end = Math.min(job.chunkOffset + CHUNK_SIZE, job.currentChunk.byteLength);
            const piece = job.currentChunk.subarray(job.chunkOffset, end);
            const bufferToSend = piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.byteLength);
            
            this.channel.send(bufferToSend);

            job.chunkOffset = end;
            job.offset += piece.byteLength;
          }

          job.currentChunk = null;

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
      } catch (err) {
        console.error('File send error:', err);
        updateTransferRow(job.transferId, { status: 'Transfer error', statusClass: 'status-error' });
        this.activeSend = null;
      } finally {
        job.isSending = false;
      }
    }

    send(data) {
      if (this.channel && this.channel.readyState === 'open') {
        this.channel.send(data);
      }
    }

    async handleMessage(data) {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.kind === 'file-start') {
          // Verify incoming file size does not exceed the 5 GB maximum limit
          if (msg.size > MAX_FILE_SIZE) {
            pushToast({ text: `Rejected incoming file "${msg.name}": exceeds 5 GB limit.` });
            this.incoming = null;
            addTransferRow({
              id: msg.transferId,
              dir: 'down',
              name: msg.name,
              size: msg.size,
              peerName: this.peerName,
              status: 'Exceeds 5 GB limit',
            });
            updateTransferRow(msg.transferId, { statusClass: 'status-error' });
            return;
          }

          this.incoming = {
            transferId: msg.transferId,
            name: msg.name,
            size: msg.size,
            type: msg.type || 'application/octet-stream',
            received: 0,
            chunks: [],
            fileHandle: null,
            writableStream: null,
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

          // Stream directly to disk for files > 100 MB on supported desktop browsers
          if ('showSaveFilePicker' in window && msg.size > 100 * 1024 * 1024) {
            try {
              const handle = await window.showSaveFilePicker({ suggestedName: msg.name });
              this.incoming.fileHandle = handle;
              this.incoming.writableStream = await handle.createWritable();
            } catch (err) {
              console.warn('Disk stream picker skipped/cancelled, buffering in memory.');
            }
          }
        } else if (msg.kind === 'file-end' && this.incoming) {
          const job = this.incoming;
          let downloadUrl = null;

          if (job.writableStream) {
            await job.writableStream.close();
            updateTransferRow(job.transferId, {
              status: 'Saved to Disk',
              statusClass: 'status-done',
              progress: 1,
              metaText: fmtBytes(job.size),
            });
          } else {
            const blob = new Blob(job.chunks, { type: job.type });
            job.chunks = []; // Immediately free RAM
            downloadUrl = URL.createObjectURL(blob);

            updateTransferRow(job.transferId, {
              status: 'Received',
              statusClass: 'status-done',
              progress: 1,
              metaText: fmtBytes(job.size),
              downloadUrl: downloadUrl,
              downloadName: job.name,
            });
          }

          this.incoming = null;
        }
      } else if (this.incoming) {
        const job = this.incoming;

        if (job.writableStream) {
          job.writableStream.write(data);
        } else {
          job.chunks.push(data);
        }

        job.received += data.byteLength;
        const now = performance.now();
        if (now - job.lastTick > 180 || job.received === job.size) {
          const dt = (now - job.lastTick) / 1000;
          const speed = dt > 0 ? (job.received - job.lastBytes) / dt : 0;
          updateTransferRow(job.transferId, {
            progress: job.size ? job.received / job.size : 1,
            speedText: fmtSpeed(speed),
            etaText: fmtEta((job.size - job.received) / (speed || 1)),
            metaText: `${fmtBytes(job.received)} / ${fmtBytes(job.size)}`,
          });
          job.lastTick = now;
          job.lastBytes = job.received;
        }
      }
    }
  }

  // ---------- WebRTC Signal Router Listener ----------
  socket.on('signal', ({ from, name, data }) => {
    if (state.pairedPeer && state.pairedPeer.id === from) {
      if (!state.connection) {
        state.connection = new RTCConnWrapper(from, name || state.pairedPeer.name, false);
      }
      state.connection.handleSignal(data);
    }
  });

  // ---------- UI Component Helpers ----------
  function addTransferRow({ id, dir, name, size, peerName, status }) {
    el.transfersZone.hidden = false;
    const card = document.createElement('div');
    card.className = 'transfer-card';
    card.dataset.id = id;
    card.innerHTML = `
      <div class="transfer-top">
        <div class="transfer-meta">
          <span class="transfer-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
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
    state.transfers.set(id, { size });
  }

  function updateTransferRow(id, patch) {
    const card = el.transfersList.querySelector(`.transfer-card[data-id="${id}"]`);
    if (!card) return;
    if (patch.status !== undefined) {
      const statusEl = card.querySelector('.transfer-status');
      statusEl.textContent = patch.status;
      if (patch.statusClass) statusEl.className = `transfer-status ${patch.statusClass}`;
    }
    if (patch.progress !== undefined) {
      card.querySelector('.transfer-bar-fill').style.width = `${Math.min(100, Math.round(patch.progress * 100))}%`;
    }
    if (patch.metaText !== undefined) card.querySelector('.stat-meta').textContent = patch.metaText;
    if (patch.speedText !== undefined) card.querySelector('.stat-speed').textContent = patch.speedText;
    if (patch.etaText !== undefined) card.querySelector('.stat-eta').textContent = patch.etaText;

    if (patch.downloadUrl) {
      const actions = card.querySelector('.transfer-actions');
      actions.hidden = false;
      
      const saveBtn = document.createElement('a');
      saveBtn.className = 'transfer-btn primary';
      saveBtn.href = patch.downloadUrl;
      saveBtn.download = patch.downloadName;
      saveBtn.textContent = 'Save File';

      // Revoke Object URL 10 seconds after clicking to free browser RAM
      saveBtn.addEventListener('click', () => {
        setTimeout(() => {
          URL.revokeObjectURL(patch.downloadUrl);
        }, 10000);
      });

      actions.innerHTML = '';
      actions.appendChild(saveBtn);
    }
  }

  function pushToast({ text }) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<div class="toast-text">${text}</div>`;
    el.toastStack.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ---------- Page Unload Guard ----------
  window.addEventListener('beforeunload', (e) => {
    if (state.connection && (state.connection.activeSend || state.connection.incoming)) {
      e.preventDefault();
      e.returnValue = 'A file transfer is in progress. Leaving will cancel the transfer.';
    }
  });

  // ---------- Window Resize Handler ----------
  let resizeRaf = null;
  window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (!state.pairedPeer) renderPeers();
    });
  });

})();