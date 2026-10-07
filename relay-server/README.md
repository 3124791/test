# Browser peer signaling relay

This service coordinates browser-to-browser WebRTC connections. It forwards
only signaling JSON (such as SDP offers/answers and ICE candidates); gameplay
traffic travels over the WebRTC data channel between clients, not through this
server. For clients that need a TURN server because direct connectivity is
blocked, configure TURN separately; this service does not relay media or game
data.

## Run

Requires Node.js 20 or newer.

```sh
npm install
npm test
npm start
```

The server listens on `0.0.0.0:8787` by default. Set `HOST` and `PORT` to
override this. `GET /health` returns `ok`; WebSocket signaling uses `/signal`.
Deploy behind HTTPS/WSS when used from a public website.

## Free hosting on Render

The repository includes a Render Blueprint at `render.yaml`.

1. Push this project to a GitHub repository.
2. In Render, choose **New → Blueprint**, connect that repository, and deploy
   the `browser-peer-signaling-relay` service from `render.yaml`.
3. Copy the service's public `https://...onrender.com` address. Use
   `wss://...onrender.com/signal` for WebSocket signaling and
   `https://...onrender.com/health` to check service health.

The free web service may spin down when idle. Its first request after idle can
take a while, and an active WebSocket connection can be interrupted when the
instance stops or restarts. Rooms are in memory, so the host must create a new
room after a restart. This is a signaling-only relay; it does not make the
existing compiled game client use this service or relay gameplay traffic.

## WebSocket message protocol

Connect to `ws(s)://<relay-host>/signal`.

1. A host sends `{"type":"create"}` and receives
   `{"type":"created","roomCode":"...","clientId":"..."}`.
2. Each guest sends `{"type":"join","roomCode":"..."}` and receives
   `{"type":"joined","clientId":"...","hostId":"..."}`. The host receives
   `{"type":"peer-joined","peerId":"..."}`.
3. To exchange WebRTC signaling, send
   `{"type":"signal","to":"<peer-id>","data":{...}}`. The other participant
   receives `{"type":"signal","from":"<sender-id>","data":{...}}`.
   `data` is application-defined; use it for SDP and ICE messages.
4. When a guest disconnects, the host receives `peer-left`. When the host
   disconnects, guests receive `host-left` and their connections close.

Rooms are in-memory and disappear when the host disconnects or the relay
restarts. Room codes are generated randomly; share them only with intended
participants. Each room allows one host and up to 32 guests. The server rejects
messages over 64 KiB and clients sending more than 30 messages per second.
