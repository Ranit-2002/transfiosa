(() => {
  'use strict';

  // ---------- Config ----------
  const CHUNK_SIZE = 64 * 1024; // 64KB per chunk over the DataChannel
  const BUFFERED_AMOUNT_LOW = 1 * 1024 * 1024; // resume sending below 1MB buffered
  const BUFFERED_AMOUNT_HIGH = 4 * 1024 * 1024; // pause sending above 4MB buffered
  const RTC_CONFIG = {
    iceServers: [
      // STUN only, for local candidate gathering. On a real LAN, host candidates
      // (direct local IPs) are typically used anyway — no external server ever
      // sees file data, only the browser's own address discovery.
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  };

  // ---------- State ----------
  const state = {
    selfId: null,
    selfName: '',
    peers: new Map(),       // id -> { id, name }
    connections: new Map(), // id -> RTCConnWrapper
    pendingFilesForPicker: null, // FileList captured before a device is chosen
    transfers: new Map(),   // transferId -> transfer record (for UI)
  };

  // --- NEW: Persistent Device ID ---
  let deviceId = localStorage.getItem('beam_device_id');
  if (!deviceId) {
    // Generate a random ID if this is the device's first time visiting
    deviceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('beam_device_id', deviceId);
  }

  // Pass the deviceId to the backend
  const socket = io('https://transfiosa-backend.onrender.com', { 
    query: { 
      name: localStorage.getItem('beam_name') || '',
      deviceId: deviceId
    } 
  });

  if (typeof RTCPeerConnection === 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      const el2 = document.getElementById('radarCaption');
      if (el2) el2.textContent = "This browser doesn't support the direct device-to-device connection Beam needs. Try a recent Chrome, Firefox, Edge, or Safari.";
      document.getElementById('dropzone')?.setAttribute('aria-disabled', 'true');
    });
  }

  // ---------- DOM ----------
  const el = {
    netDot: document.getElementById('netDot'),
    netLabel: document.getElementById('netLabel'),
    selfName: document.getElementById('selfName'),
    renameBtn: document.getElementById('renameBtn'),
    radar: document.getElementById('radar'),
    radarCaption: document.getElementById('radarCaption'),
    peersList: document.getElementById('peersList'),
    peersEmpty: document.getElementById('peersEmpty'),
    peerCount: document.getElementById('peerCount'),
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    dzSub: document.getElementById('dzSub'),
    transfersZone: document.getElementById('transfersZone'),
    transfersList: document.getElementById('transfersList'),
    sheetBackdrop: document.getElementById('sheetBackdrop'),
    sheetSub: document.getElementById('sheetSub'),
    sheetList: document.getElementById('sheetList'),
    sheetCancel: document.getElementById('sheetCancel'),
    toastStack: document.getElementById('toastStack'),
  };

  // ---------- Helpers ----------
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

  // ---------- Network status ----------
  socket.on('connect', () => {
    el.netDot.classList.add('online');
    el.netDot.classList.remove('offline');
    el.netLabel.textContent = 'On network';
  });
  socket.on('disconnect', () => {
    el.netDot.classList.remove('online');
    el.netDot.classList.add('offline');
    el.netLabel.textContent = 'Disconnected';
    state.peers.clear();
    renderPeers();
  });

  socket.on('self', ({ id, name }) => {
    state.selfId = id;
    state.selfName = name;
    el.selfName.textContent = name;
  });

  socket.on('peers', (list) => {
    const incomingIds = new Set(list.map(p => p.id));
    // drop connections for peers who left
    for (const id of [...state.connections.keys()]) {
      if (!incomingIds.has(id)) {
        state.connections.get(id)?.close();
        state.connections.delete(id);
      }
    }
    state.peers = new Map(list.map(p => [p.id, p]));
    renderPeers();
  });

  // ---------- Rename ----------
  el.renameBtn.addEventListener('click', () => {
    const next = prompt('Name this device', state.selfName);
    if (next && next.trim()) {
      const clean = next.trim().slice(0, 40);
      localStorage.setItem('beam_name', clean);
      socket.emit('rename', clean);
    }
  });

  // ---------- Render: radar + list ----------
  function renderPeers() {
    const list = [...state.peers.values()];

    // list view
    el.peerCount.textContent = `${list.length} found`;
    el.peersEmpty.hidden = list.length > 0;
    [...el.peersList.querySelectorAll('.peer-row')].forEach(n => n.remove());

    list.forEach(peer => {
      const row = document.createElement('div');
      row.className = 'peer-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Send files to ${peer.name}`);
      row.innerHTML = `
        <div class="peer-avatar">${initials(peer.name)}</div>
        <div class="peer-info">
          <span class="peer-name">${escapeHtml(peer.name)}</span>
          <span class="peer-sub">Ready to receive</span>
        </div>
        <svg class="peer-send-icon" viewBox="0 0 24 24" width="18" height="18"><path d="M4 12 h16 M14 6 l6 6 -6 6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      `;
      const trigger = () => openFilePickerFor(peer.id);
      row.addEventListener('click', trigger);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); } });
      el.peersList.appendChild(row);
    });

    // radar view
    [...el.radar.querySelectorAll('.peer-node')].forEach(n => n.remove());
    const radius = el.radar.clientWidth ? el.radar.clientWidth * 0.5 - 20 : 110;
    list.forEach((peer, i) => {
      const angle = (i / Math.max(list.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const jitterR = radius * (0.62 + (i % 3) * 0.13);
      const x = Math.cos(angle) * jitterR;
      const y = Math.sin(angle) * jitterR;
      const node = document.createElement('button');
      node.className = 'peer-node';
      node.style.left = `calc(50% + ${x}px - 20px)`;
      node.style.top = `calc(50% + ${y}px - 20px)`;
      node.style.animationDelay = `${i * 60}ms`;
      node.textContent = initials(peer.name);
      node.title = peer.name;
      node.dataset.peerId = peer.id;
      node.addEventListener('click', () => openFilePickerFor(peer.id));
      el.radar.appendChild(node);
    });

    el.radarCaption.textContent = list.length
      ? `${list.length} device${list.length === 1 ? '' : 's'} found on your Wi-Fi`
      : 'Searching your Wi-Fi network for other devices…';
  }

  function markNodeTransferring(peerId, on) {
    const node = el.radar.querySelector(`.peer-node[data-peer-id="${peerId}"]`);
    if (node) node.classList.toggle('transferring', on);
  }

  // ---------- Dropzone / file picker flow ----------
  el.dropzone.addEventListener('click', () => el.fileInput.click());
  el.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
  });
  el.fileInput.addEventListener('change', () => {
    if (el.fileInput.files.length) handleChosenFiles(el.fileInput.files);
    el.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(evt =>
    el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); el.dropzone.classList.add('drag-over'); })
  );
  ['dragleave', 'drop'].forEach(evt =>
    el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); el.dropzone.classList.remove('drag-over'); })
  );
  el.dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length) handleChosenFiles(files);
  });

  function handleChosenFiles(fileList) {
    const files = [...fileList];
    if (state.peers.size === 0) {
      pushToast({
        kind: 'info',
        text: `<strong>No devices found yet.</strong> Open Beam on another device on the same Wi-Fi, then try again.`,
      });
      return;
    }
    if (state.peers.size === 1) {
      const only = [...state.peers.values()][0];
      sendFilesToPeer(only.id, files);
      return;
    }
    state.pendingFilesForPicker = files;
    openDevicePickerSheet(files);
  }

  function openFilePickerFor(peerId) {
    state.pendingFilesForPicker = { targetPeerId: peerId };
    el.fileInput.onchange = null;
    const handler = () => {
      if (el.fileInput.files.length) sendFilesToPeer(peerId, [...el.fileInput.files]);
      el.fileInput.value = '';
      el.fileInput.removeEventListener('change', handler);
    };
    el.fileInput.addEventListener('change', handler);
    el.fileInput.click();
  }

  function openDevicePickerSheet(files) {
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    el.sheetSub.textContent = `${files.length} file${files.length === 1 ? '' : 's'} · ${fmtBytes(totalSize)}`;
    el.sheetList.innerHTML = '';
    [...state.peers.values()].forEach(peer => {
      const row = document.createElement('div');
      row.className = 'peer-row';
      row.tabIndex = 0;
      row.innerHTML = `
        <div class="peer-avatar">${initials(peer.name)}</div>
        <div class="peer-info"><span class="peer-name">${escapeHtml(peer.name)}</span></div>
        <svg class="peer-send-icon" viewBox="0 0 24 24" width="18" height="18"><path d="M4 12 h16 M14 6 l6 6 -6 6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      `;
      row.addEventListener('click', () => {
        closeSheet();
        sendFilesToPeer(peer.id, files);
      });
      el.sheetList.appendChild(row);
    });
    el.sheetBackdrop.hidden = false;
  }
  function closeSheet() { el.sheetBackdrop.hidden = true; }
  el.sheetCancel.addEventListener('click', closeSheet);
  el.sheetBackdrop.addEventListener('click', (e) => { if (e.target === el.sheetBackdrop) closeSheet(); });

  // ---------- Toasts ----------
  function pushToast({ kind, text, filesHtml, onAccept, onDecline, autoDismiss }) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `
      <div class="toast-head">
        <svg class="toast-icon" viewBox="0 0 24 24" width="20" height="20"><path d="M12 15 V4 M12 4 L7.5 8.5 M12 4 L16.5 8.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15 v3.5 a1.5 1.5 0 0 0 1.5 1.5 h13 a1.5 1.5 0 0 0 1.5 -1.5 V15" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <div class="toast-text">${text}</div>
      </div>
      ${filesHtml ? `<div class="toast-files">${filesHtml}</div>` : ''}
      ${(onAccept || onDecline) ? `<div class="toast-actions">
        ${onDecline ? `<button class="toast-btn decline">Decline</button>` : ''}
        ${onAccept ? `<button class="toast-btn accept">Accept</button>` : ''}
      </div>` : ''}
    `;
    el.toastStack.appendChild(t);
    if (onAccept) t.querySelector('.accept').addEventListener('click', () => { onAccept(); t.remove(); });
    if (onDecline) t.querySelector('.decline').addEventListener('click', () => { onDecline(); t.remove(); });
    if (autoDismiss) setTimeout(() => t.remove(), autoDismiss);
    return t;
  }

  // ============================================================
  // WebRTC P2P connection wrapper
  // One RTCConnWrapper per peer. Handles signaling via socket.io,
  // opens a reliable, ordered DataChannel for file transfer, and
  // implements a small framing protocol on top of it:
  //   - JSON control messages (string) for metadata/handshake
  //   - raw ArrayBuffer chunks for file bytes
  // ============================================================
  class RTCConnWrapper {
    constructor(peerId, peerName, initiator) {
      this.peerId = peerId;
      this.peerName = peerName;
      this.initiator = initiator;
      this.pc = new RTCPeerConnection(RTC_CONFIG);
      this.channel = null;
      this.sendQueue = [];        // queued outgoing file-send jobs
      this.activeSend = null;     // current send job
      this.incoming = null;       // current receive job
      this.acceptedBatches = new Map(); // batchId -> true, once user accepts

      this.pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('signal', { to: peerId, data: { type: 'ice', candidate: e.candidate } });
        }
      };

      this.pc.onconnectionstatechange = () => {
        if (['failed', 'closed', 'disconnected'].includes(this.pc.connectionState)) {
          markNodeTransferring(this.peerId, false);
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
      this.channel.onopen = () => {
        this._resolveReady?.();
        this.pumpSendQueue();
      };
      this.channel.onmessage = (e) => this.handleMessage(e.data);
      this.channel.onbufferedamountlow = () => this.pumpActiveSend();
      this.channel.onclose = () => this.handleChannelClosed();
      this.channel.onerror = () => this.handleChannelClosed();
    }

    handleChannelClosed() {
      markNodeTransferring(this.peerId, false);
      if (this.activeSend) {
        updateTransferRow(this.activeSend.transferId, {
          status: 'Connection lost', statusClass: 'status-error', barError: true,
        });
        this.activeSend = null;
      }
      if (this.incoming) {
        updateTransferRow(this.incoming.transferId, {
          status: 'Connection lost', statusClass: 'status-error', barError: true,
        });
        this.incoming = null;
      }
      // any still-queued sends for this peer can't proceed either
      this.sendQueue.forEach(j => updateTransferRow(j.transferId, {
        status: 'Connection lost', statusClass: 'status-error', barError: true,
      }));
      this.sendQueue = [];
    }

    ready() {
      if (this.channel && this.channel.readyState === 'open') return Promise.resolve();
      return new Promise(res => { this._resolveReady = res; });
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

    // ---- Sending ----
    enqueueBatch(files) {
      const batchId = uid();
      const jobs = files.map(file => ({
        transferId: uid(),
        batchId,
        file,
        offset: 0,
      }));
      this.sendQueue.push(...jobs);

      // register UI rows immediately (queued state)
      jobs.forEach(job => {
        addTransferRow({
          id: job.transferId,
          dir: 'up',
          name: job.file.name,
          size: job.file.size,
          peerName: this.peerName,
          status: 'Waiting for acceptance…',
        });
      });

      // send batch metadata; wait for accept before pumping bytes
      this.ready().then(() => {
        this.send(JSON.stringify({
          kind: 'batch-offer',
          batchId,
          files: jobs.map(j => ({ transferId: j.transferId, name: j.file.name, size: j.file.size, type: j.file.type })),
        }));
      });

      return batchId;
    }

    pumpSendQueue() {
      if (this.activeSend || this.sendQueue.length === 0) return;
      const next = this.sendQueue[0];
      if (!this.acceptedBatches.get(next.batchId)) return; // wait for receiver accept
      this.sendQueue.shift();
      this.startSend(next);
    }

    startSend(job) {
      this.activeSend = job;
      job.startTime = performance.now();
      job.lastTick = job.startTime;
      job.lastBytes = 0;
      markNodeTransferring(this.peerId, true);
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
      if (!job) return;
      if (this.channel.readyState !== 'open') return;

      while (this.channel.bufferedAmount < BUFFERED_AMOUNT_HIGH) {
        let result;
        try {
          result = await job.reader.read();
        } catch (err) {
          this.failSend(job, 'Read error');
          return;
        }
        if (result.done) {
          this.send(JSON.stringify({ kind: 'file-end', transferId: job.transferId }));
          updateTransferRow(job.transferId, {
            status: 'Sent',
            statusClass: 'status-done',
            progress: 1,
            speedText: '',
            metaText: fmtBytes(job.file.size),
          });
          this.activeSend = null;
          markNodeTransferring(this.peerId, false);
          this.pumpSendQueue();
          return;
        }
        // result.value is a Uint8Array chunk (already reasonably sized by the stream)
        let chunk = result.value;
        // Further split to our fixed CHUNK_SIZE for consistent backpressure granularity.
        // Copy each piece into its own ArrayBuffer (rather than sending a subarray view)
        // for consistent behavior across DataChannel implementations.
        for (let o = 0; o < chunk.byteLength; o += CHUNK_SIZE) {
          const end = Math.min(o + CHUNK_SIZE, chunk.byteLength);
          const piece = chunk.slice(o, end); // Uint8Array.slice -> new underlying buffer
          try {
            this.channel.send(piece.buffer.byteLength === piece.byteLength ? piece.buffer : piece);
          } catch (err) {
            this.failSend(job, 'Send error');
            return;
          }
          job.offset += piece.byteLength;
        }

        const now = performance.now();
        if (now - job.lastTick > 180) {
          const dt = (now - job.lastTick) / 1000;
          const db = job.offset - job.lastBytes;
          const speed = dt > 0 ? db / dt : 0;
          const remaining = job.file.size - job.offset;
          updateTransferRow(job.transferId, {
            progress: job.file.size ? job.offset / job.file.size : 1,
            speedText: fmtSpeed(speed),
            etaText: fmtEta(remaining / (speed || 1)),
            metaText: `${fmtBytes(job.offset)} / ${fmtBytes(job.file.size)}`,
          });
          job.lastTick = now;
          job.lastBytes = job.offset;
        }

        if (this.channel.bufferedAmount >= BUFFERED_AMOUNT_HIGH) return; // wait for onbufferedamountlow
      }
    }

    failSend(job, reason) {
      this.activeSend = null;
      markNodeTransferring(this.peerId, false);
      updateTransferRow(job.transferId, { status: reason, statusClass: 'status-error', barError: true });
      this.pumpSendQueue();
    }

    send(data) {
      if (this.channel && this.channel.readyState === 'open') this.channel.send(data);
    }

    // ---- Receiving ----
    handleMessage(data) {
      if (typeof data === 'string') {
        let msg;
        try { msg = JSON.parse(data); } catch (_) { return; }
        this.handleControlMessage(msg);
      } else {
        this.handleBinaryChunk(data);
      }
    }

    handleControlMessage(msg) {
      switch (msg.kind) {
        case 'batch-offer': {
          const totalSize = msg.files.reduce((s, f) => s + f.size, 0);
          const filesHtml = msg.files.map(f => `${escapeHtml(f.name)} · ${fmtBytes(f.size)}`).join('<br>');
          pushToast({
            text: `<strong>${escapeHtml(this.peerName)}</strong> wants to send ${msg.files.length} file${msg.files.length === 1 ? '' : 's'} (${fmtBytes(totalSize)})`,
            filesHtml,
            onAccept: () => {
              this.send(JSON.stringify({ kind: 'batch-accept', batchId: msg.batchId }));
            },
            onDecline: () => {
              this.send(JSON.stringify({ kind: 'batch-decline', batchId: msg.batchId }));
            },
          });
          break;
        }
        case 'batch-accept': {
          this.acceptedBatches.set(msg.batchId, true);
          this.pumpSendQueue();
          break;
        }
        case 'batch-decline': {
          // remove queued jobs for this batch + mark UI declined
          this.sendQueue = this.sendQueue.filter(j => {
            if (j.batchId === msg.batchId) {
              updateTransferRow(j.transferId, { status: 'Declined', statusClass: 'status-error', barError: true });
              return false;
            }
            return true;
          });
          break;
        }
        case 'file-start': {
          if (this.incoming) {
            // Previous transfer never got a matching file-end (peer disconnect mid-file, etc).
            // Surface it as failed rather than silently dropping its bytes.
            updateTransferRow(this.incoming.transferId, {
              status: 'Interrupted', statusClass: 'status-error', barError: true,
            });
          }
          this.incoming = {
            transferId: msg.transferId,
            name: msg.name,
            size: msg.size,
            type: msg.type || 'application/octet-stream',
            received: 0,
            chunks: [],
            startTime: performance.now(),
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
          markNodeTransferring(this.peerId, true);
          break;
        }
        case 'file-end': {
          const job = this.incoming;
          if (!job || job.transferId !== msg.transferId) return;
          const blob = new Blob(job.chunks, { type: job.type });
          const url = URL.createObjectURL(blob);
          updateTransferRow(job.transferId, {
            status: 'Received',
            statusClass: 'status-done',
            progress: 1,
            speedText: '',
            metaText: fmtBytes(job.size),
            downloadUrl: url,
            downloadName: job.name,
          });
          this.incoming = null;
          markNodeTransferring(this.peerId, false);
          break;
        }
      }
    }

    handleBinaryChunk(buf) {
      const job = this.incoming;
      if (!job) return;
      job.chunks.push(buf);
      job.received += buf.byteLength;

      const now = performance.now();
      if (now - job.lastTick > 180 || job.received === job.size) {
        const dt = (now - job.lastTick) / 1000;
        const db = job.received - job.lastBytes;
        const speed = dt > 0 ? db / dt : 0;
        const remaining = job.size - job.received;
        updateTransferRow(job.transferId, {
          progress: job.size ? job.received / job.size : 1,
          speedText: fmtSpeed(speed),
          etaText: fmtEta(remaining / (speed || 1)),
          metaText: `${fmtBytes(job.received)} / ${fmtBytes(job.size)}`,
        });
        job.lastTick = now;
        job.lastBytes = job.received;
      }
    }
  }

  // ---------- Signaling wiring ----------
  socket.on('signal', ({ from, name, data }) => {
    let conn = state.connections.get(from);
    if (!conn) {
      conn = new RTCConnWrapper(from, name || state.peers.get(from)?.name || 'Device', false);
      state.connections.set(from, conn);
    }
    conn.handleSignal(data);
  });

  function getOrCreateConn(peerId) {
    let conn = state.connections.get(peerId);
    if (!conn) {
      const peer = state.peers.get(peerId);
      conn = new RTCConnWrapper(peerId, peer?.name || 'Device', true);
      state.connections.set(peerId, conn);
    }
    return conn;
  }

  function sendFilesToPeer(peerId, files) {
    const conn = getOrCreateConn(peerId);
    conn.enqueueBatch(files);
    el.transfersZone.hidden = false;
  }

  // ---------- Transfer rows UI ----------
  function addTransferRow({ id, dir, name, size, peerName, status }) {
    el.transfersZone.hidden = false;
    const card = document.createElement('div');
    card.className = 'transfer-card';
    card.dataset.id = id;
    card.innerHTML = `
      <div class="transfer-top">
        <div class="transfer-icon dir-${dir}">
          ${dir === 'up'
            ? '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 19 V6 M12 6 l-5 5 M12 6 l5 5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5 V18 M12 18 l-5 -5 M12 18 l5 -5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
        </div>
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
      statusEl.className = 'transfer-status' + (patch.statusClass ? ` ${patch.statusClass}` : '');
    }
    if (patch.progress !== undefined) {
      const fill = card.querySelector('.transfer-bar-fill');
      fill.style.width = `${Math.min(100, Math.round(patch.progress * 100))}%`;
      if (patch.barError) fill.classList.add('error');
    }
    if (patch.metaText !== undefined) card.querySelector('.stat-meta').textContent = patch.metaText;
    if (patch.speedText !== undefined) card.querySelector('.stat-speed').textContent = patch.speedText;
    if (patch.etaText !== undefined) card.querySelector('.stat-eta').textContent = patch.etaText;

    if (patch.downloadUrl) {
      const actions = card.querySelector('.transfer-actions');
      actions.hidden = false;
      actions.innerHTML = `<a class="transfer-btn primary" href="${patch.downloadUrl}" download="${escapeHtml(patch.downloadName)}">Save file</a>`;
    }
  }

  // ---------- Resize: reposition radar nodes ----------
  let resizeRaf = null;
  window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(renderPeers);
  });

})();
