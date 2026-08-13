# Beam — local Wi-Fi file transfer

Send files directly between devices on the same Wi-Fi network. No cloud storage, no account, no internet dependency for the transfer itself.

## Run it

```
npm install
npm start
```

The terminal prints a LAN address like `http://192.168.1.23:3000`. Open that exact address on every device you want to connect — not `localhost`, since other devices can't reach your machine's localhost.

All devices must be on the same Wi-Fi network (same router / same subnet).

## How it works, and why files never touch the server

- A small Node/Express + Socket.IO server does exactly two things: (1) tells devices on the same subnet about each other ("discovery"), and (2) relays the short WebRTC handshake messages (SDP offers/answers, ICE candidates) two browsers need to open a direct connection to each other.
- Once that handshake completes, the browsers open a **WebRTC DataChannel directly to each other**. All file bytes flow over that direct connection. The server is never in that path and never sees, stores, or proxies file content — it only carries the initial handshake, which is a few KB of connection metadata.
- Discovery groups devices by IP into `/24` subnets, so a device on a different Wi-Fi network never sees your device, even if both happen to reach the same signaling server.
- On a typical home/office LAN, the WebRTC connection uses each browser's local IP directly (an ICE "host candidate"), so the data path is genuinely local-network-only. A public STUN server is used only to help the browsers discover their own reachable addresses — it doesn't see file data either.

## Using it

1. Open the address above on two (or more) devices on the same Wi-Fi.
2. Each device shows up on the others' radar / device list within a couple of seconds.
3. Click a device, or drag files onto the drop zone (if only one other device is present, it's picked automatically; with several, you'll be asked which one).
4. The receiving device gets a prompt to accept or decline before any bytes are sent.
5. Both sides see live progress: file name, size, transfer speed, and time remaining.
6. On the receiving side, each finished file gets a **Save file** button to download it.

You can queue multiple files in one send — they transfer one at a time in order, each with its own progress row.

## Notes on the local environment

- Works over plain HTTP for LAN use. Some browsers restrict certain APIs to secure contexts (HTTPS/localhost); WebRTC DataChannels used here work over HTTP for private-network peer connections in current major browsers, but if you hit connection issues on a locked-down browser/OS combination, serving over HTTPS (e.g. via a reverse proxy with a self-signed cert) resolves it.
- If a device's firewall blocks the port (default `3000`), other devices won't be able to reach it — allow inbound connections on that port for the app.
- Refreshing the page ends any in-progress transfers and drops the device from others' lists; they'll rediscover it if it reconnects.

## Project layout

```
server.js          Discovery + WebRTC signaling relay (Express + Socket.IO)
public/
  index.html       App shell
  styles.css       Design system + responsive layout
  app.js           Device discovery UI, WebRTC connection handling, chunked
                    file send/receive with backpressure, progress tracking
```
