'use strict';

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

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/beam-download\/([^/]+)$/);
  if (!match) return; 

  const transferId = decodeURIComponent(match[1]);
  const filename = url.searchParams.get('name') || 'download';
  const mimeType = url.searchParams.get('type') || 'application/octet-stream';
  const size = url.searchParams.get('size'); 

  event.respondWith((async () => {
    let db;
    try {
      db = await openDb();
    } catch (err) {
      return new Response('Failed to open storage: ' + err.message, { status: 500 });
    }

    let bytesEnqueued = 0;
    let currentIndex = 0;
    let sawAnyChunk = false;

    const stream = new ReadableStream({
      async pull(controller) {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.get([transferId, currentIndex]);
          
          req.onsuccess = async (e) => {
            const record = e.target.result;
            if (record) {
              sawAnyChunk = true;
              controller.enqueue(record.data);
              bytesEnqueued += record.data.byteLength;
              currentIndex++;
              resolve();
            } else {
              if (!sawAnyChunk && currentIndex === 0) {
                controller.error(new Error('EXPIRED_OR_MISSING'));
                return resolve();
              }
              
              controller.close();
              
              const clients = await self.clients.matchAll({ includeUncontrolled: true });
              for (const client of clients) {
                client.postMessage({ type: 'beam-download-complete', transferId, bytesEnqueued });
              }
              resolve();
            }
          };
          req.onerror = () => reject(req.error);
        });
      }
    });

    const headers = new Headers({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });

    if (size) headers.set('Content-Length', size);

    return new Response(stream, { status: 200, headers });
  })());
});