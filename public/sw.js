'use strict';

// Intercepts GET /beam-download/<transferId>?name=<filename>&type=<mimeType>
// and responds with a ReadableStream that pulls chunks out of IndexedDB one
// at a time, in order, and enqueues them as they're read.
//
// Why this exists: for large files on mobile, materializing the full file as
// a single in-page Blob (via `new Blob(parts)` + `URL.createObjectURL`) keeps
// that many bytes resident in the tab's process. iOS Safari (and Chrome/Edge
// on iOS, which are WebKit under the hood) enforces a per-tab memory budget;
// crossing it gets the tab silently killed and reloaded by the OS — no JS
// error, because the process itself is terminated from outside JS's control.
// That's what "reaches 100%, then refreshes, with no console output, across
// every mobile browser" means: the download link itself was never clicked,
// but constructing and holding the Blob live was already enough.
//
// Streaming the response instead means the browser writes bytes to disk as
// they're read from IndexedDB, without ever holding the whole file as one
// object in the tab's memory.

const DB_NAME = 'beam-transfer-store';
const STORE_NAME = 'chunks';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: ['transferId', 'index'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Opens a cursor over all chunks for a transfer, in index order, and calls
// onChunk(data) for each one as it's read — never holds more than one
// chunk's data plus cursor bookkeeping in memory at a time.
function forEachChunkInOrder(db, transferId, onChunk) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const range = IDBKeyRange.bound([transferId, 0], [transferId, Infinity]);
    const cursorReq = store.openCursor(range);
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        onChunk(cursor.value.data);
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/beam-download\/([^/]+)$/);
  if (!match) return; // not our route, let it pass through normally

  const transferId = decodeURIComponent(match[1]);
  const filename = url.searchParams.get('name') || 'download';
  const mimeType = url.searchParams.get('type') || 'application/octet-stream';

  event.respondWith((async () => {
    let db;
    try {
      db = await openDb();
    } catch (err) {
      return new Response('Failed to open storage: ' + err.message, { status: 500 });
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          let sawAnyChunk = false;
          await forEachChunkInOrder(db, transferId, (data) => {
            sawAnyChunk = true;
            // data is a Uint8Array as stored by putChunk in app.js
            controller.enqueue(data);
          });
          if (!sawAnyChunk) {
            controller.error(new Error('No chunks found for this transfer — it may have already been cleared or never existed.'));
            return;
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    // Content-Disposition with a filename triggers a real download (saved to
    // the device's Downloads/Files area) rather than an in-page navigation,
    // on every browser tested here.
    const headers = new Headers({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
    });

    return new Response(stream, { headers });
  })());
});
