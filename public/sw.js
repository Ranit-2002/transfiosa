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

    let bytesEnqueued = 0;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          let sawAnyChunk = false;
          await forEachChunkInOrder(db, transferId, (data) => {
            sawAnyChunk = true;
            bytesEnqueued += data.byteLength;
            controller.enqueue(data);
          });

          if (!sawAnyChunk) {
            // The chunks are gone. Distinguish this from a transient failure
            // in the response body so the page can tell the user plainly
            // "this needs re-sending" instead of a bare network-style error.
            // (Previously chunks were deleted on a fixed 3-minute timer after
            // the first click, with no confirmation the download had actually
            // finished — a second click or retry after that window silently
            // hit this exact case. Cleanup now happens only after a
            // confirmed full read, via the 'beam-download-complete' message
            // below, so a legitimate re-download attempt won't be defeated
            // by a stale timer.)
            controller.error(new Error('EXPIRED_OR_MISSING'));
            return;
          }

          controller.close();

          // Tell every controlled page that this transfer was fully read out
          // of storage, so app.js can clear it now — based on a confirmed
          // successful read, not a guess about how long that should take.
          // includeUncontrolled: true matters here specifically — on a cold
          // load right after this service worker first registers/activates,
          // the page that issued this very fetch might not yet count as a
          // "controlled" client in the strict sense, and would otherwise be
          // silently excluded from this list, never receiving the completion
          // message the app depends on for cleanup timing.
          const clients = await self.clients.matchAll({ includeUncontrolled: true });
          for (const client of clients) {
            client.postMessage({ type: 'beam-download-complete', transferId, bytesEnqueued });
          }
        } catch (err) {
          controller.error(err);
        }
      },
    });

    const headers = new Headers({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
    });

    return new Response(stream, { headers });
  })());
});
