(() => {
  'use strict';

  // ---------- Configuration ----------
  const CHUNK_SIZE = 64 * 1024;                 // 64 KB per chunk
  const BUFFERED_AMOUNT_LOW = 256 * 1024;       // Resume sending below 256 KB
  const BUFFERED_AMOUNT_HIGH = 1024 * 1024;     // Pause sending above 1 MB
  const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB maximum file size limit
  
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  };

  // ---------- IndexedDB Chunk Store ----------
  // Backing store for incoming files on browsers without showSaveFilePicker
  // (Firefox, Safari, and every mobile browser). Chunks are written to disk-backed
  // IndexedDB as they arrive rather than held in a growing JS array, so the JS heap
  // never has to hold more than one chunk at a time regardless of file size. This
  // matters specifically on mobile, where tabs are reclaimed by the OS well before
  // desktop-level memory limits are hit — accumulating megabytes of chunk objects
  // in memory for the whole transfer is what was causing the mobile tab to reload
  // near completion (when the final in-memory Blob assembly happened).
  const ChunkStore = {
    dbPromise: null,

    _openDb() {
      if (this.dbPromise) return this.dbPromise;
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('beam-transfer-store', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('chunks')) {
            // Keyed by [transferId, chunkIndex] so chunks stay in order per transfer
            db.createObjectStore('chunks', { keyPath: ['transferId', 'index'] });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return this.dbPromise;
    },

    async putChunk(transferId, index, data) {
      const db = await this._openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', 'readwrite');
        tx.objectStore('chunks').put({ transferId, index, data });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    // Reads all chunks for a transfer back out in order and assembles a Blob.
    // Reading happens one chunk at a time via a cursor, so this doesn't require
    // holding the full chunk list in memory either — only the running Blob parts
    // array, which holds references, not copies, until Blob construction.
    async assembleBlob(transferId, mimeType) {
      const db = await this._openDb();
      const parts = [];
      await new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', 'readonly');
        const store = tx.objectStore('chunks');
        const range = IDBKeyRange.bound([transferId, 0], [transferId, Infinity]);
        const cursorReq = store.openCursor(range);
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            parts.push(cursor.value.data);
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
      return new Blob(parts, { type: mimeType });
    },

    async clearTransfer(transferId) {
      const db = await this._openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', 'readwrite');
        const store = tx.objectStore('chunks');
        const range = IDBKeyRange.bound([transferId, 0], [transferId, Infinity]);
        const cursorReq = store.openCursor(range);
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    },

    // Cheap existence check: stops at the first matching record instead of
    // walking every chunk, since the caller only needs a yes/no.
    async hasTransfer(transferId) {
      const db = await this._openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', 'readonly');
        const store = tx.objectStore('chunks');
        const range = IDBKeyRange.bound([transferId, 0], [transferId, Infinity]);
        const cursorReq = store.openCursor(range);
        cursorReq.onsuccess = (e) => resolve(!!e.target.result);
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    },
  };

  const HAS_INDEXEDDB = typeof indexedDB !== 'undefined';

  // Service worker enables streaming large files straight from IndexedDB to
  // disk on download, without ever holding the full file as one resident
  // Blob in the tab. Requires a secure context (HTTPS or localhost) — same
  // requirement as showSaveFilePicker. If registration fails (insecure
  // context, browser doesn't support service workers at all, etc.) this
  // stays a rejected promise and the finalization step below falls back to
  // the old Blob-based approach, which is fine for smaller files and is the
  // best available option when the service worker genuinely can't run.
  const swReady = ('serviceWorker' in navigator)
    ? navigator.serviceWorker.register('sw.js').then((reg) => {
        console.log('Beam: service worker registered', reg.scope);
        return navigator.serviceWorker.ready;
      }).then((reg) => {
        // A worker reaching 'active' does not mean THIS page is controlled —
        // per spec, a page is only controlled by a worker that was already
        // active before the page loaded. On this browser's very first ever
        // visit, that's never true yet, so navigator.serviceWorker.controller
        // is null even though registration and activation both succeeded.
        // The standard fix is a one-time reload right after first
        // activation, so the *next* load is genuinely controlled. Guarded
        // with localStorage so this can only ever happen once per browser —
        // never on a page that already has an active pairing or transfer,
        // where a surprise reload would tear down the live WebRTC
        // connection.
        const alreadyReloaded = localStorage.getItem('beam-sw-first-reload-done');
        const hasActiveSession = !!(state.pairedPeer || state.connection);
        if (!navigator.serviceWorker.controller && !alreadyReloaded && !hasActiveSession) {
          localStorage.setItem('beam-sw-first-reload-done', '1');
          console.log('Beam: reloading once so this page becomes controlled by the newly-activated service worker.');
          window.location.reload();
        }
        return reg;
      }).catch((err) => {
        console.warn('Beam: service worker registration failed, large downloads will fall back to in-memory assembly.', err);
        throw err;
      })
    : Promise.reject(new Error('Service workers not supported in this browser'));
  swReady.catch(() => {}); // prevent an unhandled rejection warning; callers check this themselves

  // Fires once the service worker has confirmed it read every chunk for a
  // transfer out of IndexedDB and closed the response stream successfully —
  // i.e. the download genuinely completed, not just "some time has passed
  // since a click." This is what cleanup should be conditioned on.
  //
  // A natural extra click on "Save File" — a habit, a "did that work?"
  // re-click, the browser's own download-manager retry affordance — is
  // completely normal user behavior. Once cleanup below has run, though,
  // the chunks are genuinely gone, so a second click can only ever hit
  // ChunkStore.hasTransfer's pre-flight check and fail. Previously that
  // failure surfaced with a message written for the "this expired from
  // disuse, ask the sender to resend" case, which is misleading here — the
  // file didn't expire, it was deleted moments earlier because the person
  // successfully got it. The fix in both directions: mark the row as
  // downloaded (disabling the button) as soon as we know cleanup is about
  // to happen, so a second click is prevented rather than silently
  // defeated; and make the fallback message honest for whichever case
  // actually occurs.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'beam-download-complete' && msg.transferId) {
        updateTransferRow(msg.transferId, { downloadConsumed: true });
        ChunkStore.clearTransfer(msg.transferId).catch(() => {});
      }
    });
  }

  // ---------- Application State ----------
  const state = {
    selfId: null,
    selfName: '',
    peers: new Map(),        
    activePairingId: null,   
    pairedPeer: null,        
    connection: null,        
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
    const filtered = list.filter(p => !p.pairedWith);
    state.peers = new Map(filtered.map(p => [p.id, p]));
    if (!state.pairedPeer) {
      renderPeers();
    }
  });

  el.renameBtn.addEventListener('click', () => {
    const next = prompt('Name this device', state.selfName);
    if (next && next.trim()) {
      const clean = next.trim().slice(0, 40);
      localStorage.setItem('beam_name', clean);
      socket.emit('rename', clean);
    }
  });

  // ---------- Render Device Discovery ----------
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

  // ---------- Pairing Workflow ----------
  function initiatePairing(peerId) {
    socket.emit('request-pair', { targetId: peerId });
  }

  socket.on('pair-verify', ({ pairingId, peerName, code }) => {
    state.activePairingId = pairingId;
    el.pairPeerName.textContent = peerName;
    el.verifyCodeDisplay.textContent = code;
    el.pairingModalBackdrop.hidden = false;
  });

  el.pairCancelBtn.addEventListener('click', () => {
    if (state.activePairingId) {
      socket.emit('pair-response', { pairingId: state.activePairingId, action: 'cancel' });
    }
    closePairingModal();
  });

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

  socket.on('pair-success', ({ peerId, peerName, initiator }) => {
    closePairingModal();
    state.pairedPeer = { id: peerId, name: peerName };

    el.discoverySection.hidden = true;
    el.pairedSection.hidden = false;
    el.pairedDeviceName.textContent = peerName;
    el.dzSub.textContent = `Connecting P2P channel with ${peerName}…`;

    state.connection = new RTCConnWrapper(peerId, peerName, initiator);
  });

  function closePairingModal() {
    el.pairingModalBackdrop.hidden = true;
    el.pairConfirmBtn.disabled = false;
    el.pairConfirmBtn.textContent = 'Pair';
    state.activePairingId = null;
  }

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

  // ---------- File Dropzone ----------
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
      this.channel.onclose = () => this.handleChannelClosed('channel closed');
      this.channel.onerror = (err) => {
        // RTCErrorEvent carries a structured .error with more detail than a
        // generic 'error' — surface it if present so the real cause (e.g.
        // ICE failure, SCTP failure, DTLS failure) is visible instead of a
        // single undifferentiated message covering every possible cause.
        const detail = err?.error ? `${err.error.errorDetail || err.error.message || err.error}` : String(err);
        console.error('DataChannel error:', detail, err);
        this.handleChannelClosed(`channel error: ${detail}`);
      };

      // Connection-level (not just data-channel-level) state changes. On a
      // direction-dependent failure like "works A→B, fails B→A", the ICE
      // connection state at the moment of failure is the single most useful
      // piece of information for narrowing down whether this is NAT
      // traversal, a firewall difference between the two devices, or
      // something else — and it's currently not logged anywhere.
      this.pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', this.pc.iceConnectionState);
        if (this.pc.iceConnectionState === 'failed' || this.pc.iceConnectionState === 'disconnected') {
          this.handleChannelClosed(`ICE connection ${this.pc.iceConnectionState}`);
        }
      };
      this.pc.onconnectionstatechange = () => {
        console.log('Peer connection state:', this.pc.connectionState);
      };
    }

    handleChannelClosed(reason) {
      console.warn('P2P connection lost. Reason:', reason || '(unknown)');
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
            chunkIndex: 0,
            receiveMode: null,   // 'disk' | 'indexeddb' | 'memory'
            memoryChunks: null,  // only used for receiveMode === 'memory'
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

          // Preference order for where incoming bytes go, strongest guarantee first:
          //
          // 1. 'disk'      — File System Access API (showSaveFilePicker). Writes
          //                  straight to the OS filesystem via the browser, no
          //                  meaningful memory ceiling. Desktop Chrome/Edge only,
          //                  and only when the save dialog is completed.
          // 2. 'indexeddb' — IndexedDB-backed chunk store (see ChunkStore above).
          //                  Persists each chunk to disk-backed storage as it
          //                  arrives, so the JS heap never holds more than one
          //                  chunk at a time. Supported on every mobile browser
          //                  and every desktop browser without (1). This is the
          //                  fix for the mobile crash: previously mobile always
          //                  fell through to holding the whole file in a JS
          //                  array/Blob, which is what the OS was reclaiming the
          //                  tab over near completion.
          // 3. 'memory'    — Last resort, only if IndexedDB itself is unavailable
          //                  (very old/locked-down browsers, private-mode
          //                  restrictions in some browsers). Capped separately
          //                  below since it carries the same risk (1) and (2) do
          //                  not.
          if ('showSaveFilePicker' in window && msg.size > 100 * 1024 * 1024) {
            try {
              const handle = await window.showSaveFilePicker({ suggestedName: msg.name });
              this.incoming.fileHandle = handle;
              this.incoming.writableStream = await handle.createWritable();
              this.incoming.receiveMode = 'disk';
            } catch (err) {
              // Picker was cancelled/dismissed, or unavailable in this context
              // (e.g. not a top-level secure-context tab, or no File System
              // Access support at all — expected on every mobile browser).
              console.warn('Disk stream picker skipped/cancelled/unsupported, falling back.', err);
            }
          }

          if (!this.incoming.receiveMode) {
            if (HAS_INDEXEDDB) {
              this.incoming.receiveMode = 'indexeddb';
              // Clear any stale chunks from a previous failed attempt with the
              // same transferId before writing fresh ones.
              try { await ChunkStore.clearTransfer(msg.transferId); } catch (_) {}
            } else {
              this.incoming.receiveMode = 'memory';
              this.incoming.memoryChunks = [];
              if (msg.size > 500 * 1024 * 1024) {
                pushToast({
                  text: `"${msg.name}" is large (${fmtBytes(msg.size)}) and this browser doesn't support disk streaming or IndexedDB, so it will be held in memory. This is more likely to crash the tab.`,
                });
              }
            }
          }

        } else if (msg.kind === 'file-end' && this.incoming) {
          const job = this.incoming;
          let downloadUrl = null;

          if (job.receiveMode === 'disk') {
            await job.writableStream.close();
            updateTransferRow(job.transferId, {
              status: 'Saved to Disk',
              statusClass: 'status-done',
              progress: 1,
              metaText: fmtBytes(job.size),
            });
          } else if (job.receiveMode === 'indexeddb') {
            try {
              // Wait for every queued chunk write to actually land before
              // reading anything back — file-end can otherwise arrive and
              // start assembling while the last few writes are still in
              // flight, silently producing a truncated file.
              if (job.writeQueue) await job.writeQueue;
              if (job.writeFailed) {
                throw new Error('One or more chunks failed to write to IndexedDB');
              }

              // swReady resolving only means the worker reached the
              // 'active' state — it does NOT mean this specific already-open
              // page is controlled by it. Per the service worker spec, a
              // page only becomes controlled after the worker was active
              // *before* that page loaded (or via clients.claim(), which
              // this worker's activate handler calls, but that still races
              // against exactly when activation finishes relative to when
              // this page loaded). navigator.serviceWorker.controller is the
              // actual documented signal for "is this page controlled right
              // now" — checking swReady alone let this fall through on a
              // genuine first attempt: the download URL would be constructed
              // assuming interception, the fetch would go straight to the
              // network with nothing there to serve /beam-download/..., and
              // the browser would report it as unavailable — no retry or
              // stale timer needed to reach that state.
              let swAvailable = false;
              try {
                await swReady;
                swAvailable = !!navigator.serviceWorker.controller;
                if (!swAvailable) {
                  console.warn('Beam: service worker is active but not controlling this page yet (likely first load since registration). Falling back to Blob assembly for this download.');
                }
              } catch (_) {
                swAvailable = false;
              }

              if (swAvailable) {
                // Streaming path: point the save link at the service worker's
                // route instead of building a Blob. The service worker reads
                // chunks out of IndexedDB and streams them into the response
                // as the browser writes the download to disk — the full file
                // is never held as one resident object in this tab. This is
                // what avoids the OS killing the tab once the file gets large
                // (the actual cause of the 100%-then-refresh crash).
                downloadUrl = `/beam-download/${encodeURIComponent(job.transferId)}`
                  + `?name=${encodeURIComponent(job.name)}`
                  + `&type=${encodeURIComponent(job.type)}`
                  + `&size=${encodeURIComponent(job.size)}`;
                // Don't clear the chunk store yet — the service worker still
                // needs to read from it when the user taps Save. It's cleared
                // by the 'beam-download-complete' message listener once the
                // service worker confirms it actually finished reading every
                // chunk (see near the swReady declaration above).

                updateTransferRow(job.transferId, {
                  status: 'Received',
                  statusClass: 'status-done',
                  progress: 1,
                  metaText: fmtBytes(job.size),
                  downloadUrl: downloadUrl,
                  downloadName: job.name,
                  streamingDownload: true,
                  transferIdForCleanup: job.transferId,
                });
              } else {
                // No service worker (insecure context, unsupported browser).
                // Falling back to the previous Blob-based approach — this is
                // the same risk profile as before for large files on mobile,
                // but there's no safer option available without HTTPS.
                console.warn('Service worker unavailable; falling back to in-memory Blob assembly for', job.name);
                const blob = await ChunkStore.assembleBlob(job.transferId, job.type);
                downloadUrl = URL.createObjectURL(blob);
                ChunkStore.clearTransfer(job.transferId).catch(() => {});

                updateTransferRow(job.transferId, {
                  status: 'Received',
                  statusClass: 'status-done',
                  progress: 1,
                  metaText: fmtBytes(job.size),
                  downloadUrl: downloadUrl,
                  downloadName: job.name,
                });
              }
            } catch (err) {
              console.error('Failed to finalize received file from IndexedDB:', err);
              pushToast({ text: `Failed to finalize "${job.name}" after receiving. Please try again.` });
              updateTransferRow(job.transferId, { status: 'Assembly failed', statusClass: 'status-error' });
              ChunkStore.clearTransfer(job.transferId).catch(() => {});
            }
          } else if (job.receiveMode === 'memory' && job.memoryChunks) {
            try {
              const blob = new Blob(job.memoryChunks, { type: job.type });
              job.memoryChunks = null;
              downloadUrl = URL.createObjectURL(blob);

              updateTransferRow(job.transferId, {
                status: 'Received',
                statusClass: 'status-done',
                progress: 1,
                metaText: fmtBytes(job.size),
                downloadUrl: downloadUrl,
                downloadName: job.name,
              });
            } catch (err) {
              console.error('Failed to assemble received file:', err);
              pushToast({ text: `Ran out of memory assembling "${job.name}".` });
              updateTransferRow(job.transferId, { status: 'Out of memory', statusClass: 'status-error' });
            }
          }

          this.incoming = null;
        }
      } else if (this.incoming) {
        const job = this.incoming;

        if (job.receiveMode === 'disk') {
          job.writableStream.write(data);
        } else if (job.receiveMode === 'indexeddb') {
          // Chunks are numbered in arrival order and written to IndexedDB. The
          // data channel is ordered (created with `ordered: true`), so arrival
          // order is guaranteed to match send order — chunkIndex just needs to
          // increment monotonically here, which it does.
          //
          // Writes are chained onto job.writeQueue rather than awaited directly:
          // onmessage must stay synchronous-ish so it doesn't fall behind the
          // channel, but IndexedDB writes are async. Chaining preserves write
          // order (each write starts only after the previous one settles) without
          // blocking the message handler itself.
          const index = job.chunkIndex++;
          const dataCopy = new Uint8Array(data); // copy out before the underlying buffer is reused
          job.writeQueue = (job.writeQueue || Promise.resolve()).then(
            () => ChunkStore.putChunk(job.transferId, index, dataCopy)
          ).catch((err) => {
            console.error('Failed to write chunk to IndexedDB:', err);
            job.writeFailed = true;
          });
        } else if (job.receiveMode === 'memory' && job.memoryChunks) {
          // `data` is an ArrayBuffer per message; store a copy as Uint8Array.
          // Each piece stays small (CHUNK_SIZE, 64 KB) — Blob assembles the
          // full file from these later. Only reached when IndexedDB itself is
          // unavailable, which is rare.
          job.memoryChunks.push(new Uint8Array(data));
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

    if (patch.downloadConsumed) {
      // A confirmed-complete download already happened for this transfer
      // (see the 'beam-download-complete' listener above) and its chunks
      // have been or are about to be cleared. Replace the live Save button
      // with a disabled, clearly-labeled one so a natural second click
      // can't reach a fetch that's now guaranteed to fail — and so it's
      // visually obvious why, instead of the button looking unchanged while
      // silently broken underneath.
      const actions = card.querySelector('.transfer-actions');
      if (actions) {
        actions.innerHTML = '';
        const doneBtn = document.createElement('span');
        doneBtn.className = 'transfer-btn primary disabled';
        doneBtn.textContent = 'Downloaded ✓';
        doneBtn.setAttribute('aria-disabled', 'true');
        actions.appendChild(doneBtn);
      }
      const state = card._downloadState || (card._downloadState = {});
      state.consumed = true;
    }

    if (patch.downloadUrl) {
      const actions = card.querySelector('.transfer-actions');
      actions.hidden = false;
      
      const saveBtn = document.createElement('a');
      saveBtn.className = 'transfer-btn primary';
      saveBtn.href = patch.downloadUrl;
      saveBtn.download = patch.downloadName;
      saveBtn.textContent = 'Save File';

      if (patch.streamingDownload) {
        // Streaming download (service-worker route): this is a same-origin
        // request the browser handles as a normal download, so it does not
        // need target="_blank" or object-URL revocation. IndexedDB cleanup
        // for this transfer happens in the 'beam-download-complete' listener
        // registered once at startup (see below) — triggered by the service
        // worker confirming it actually finished reading every chunk, not by
        // a fixed delay after the click. A timer here had no way to know
        // whether the download had really finished, so a retry or a second
        // click after the timer elapsed could hit already-deleted chunks —
        // which is what produced Chrome's generic "file wasn't available on
        // site" error for a transfer that had genuinely succeeded moments
        // earlier.
        //
        // Two distinct legitimate cases can make chunks missing by the time
        // of a click: (a) this same tab already confirmed a full download
        // for this transfer — tracked via card._downloadState.consumed,
        // set by the downloadConsumed patch handler above — in which case
        // the honest message is "you already got this"; or (b) the data is
        // gone for some other reason (browser storage pressure, a stale
        // link from an earlier session) and the person may never have
        // received it, where "ask the sender to resend" is the accurate
        // message. Checking card._downloadState first distinguishes them
        // instead of guessing one message for both.
        saveBtn.addEventListener('click', async (clickEvent) => {
          if (card._downloadState && card._downloadState.consumed) {
            clickEvent.preventDefault();
            pushToast({ text: `You've already downloaded "${patch.downloadName}" — no need to save it again.` });
            return;
          }
          const exists = await ChunkStore.hasTransfer(patch.transferIdForCleanup).catch(() => true);
          // On a check failure, default to letting the download attempt
          // proceed rather than blocking a possibly-fine download.
          if (!exists) {
            clickEvent.preventDefault();
            pushToast({ text: `"${patch.downloadName}" is no longer available to download. Ask the sender to send it again if you need a copy.` });
          }
        });
      } else {
        // Object-URL case (fallback path, or the small-file / disk-stream
        // paths elsewhere in this file that still use it): prevents iOS
        // Safari specifically from navigating the main frame on click.
        saveBtn.target = '_blank';
        saveBtn.rel = 'noopener noreferrer';

        // Revoke Object URL after a long timeout (3 minutes) to ensure mobile saving completes safely
        saveBtn.addEventListener('click', () => {
          setTimeout(() => {
            URL.revokeObjectURL(patch.downloadUrl);
          }, 3 * 60 * 1000); 
        });
      }

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