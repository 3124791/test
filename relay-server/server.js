"use strict";

const { createServer } = require("node:http");
const { randomBytes } = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");

const MAX_PEERS_PER_ROOM = 32;
const MAX_MESSAGES_PER_SECOND = 30;
const ROOM_CODE_BYTES = 16;

function createRelayServer({ host = "0.0.0.0", port = 8787 } = {}) {
  const rooms = new Map();
  const clients = new Map();
  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("ok\n");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false
  });

  function send(client, message) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }

  function removeClient(socket) {
    const client = clients.get(socket);
    if (!client) return;
    clients.delete(socket);

    const room = rooms.get(client.roomCode);
    if (!room) return;
    if (client.role === "host") {
      for (const peer of room.peers.values()) {
        send(peer.socket, { type: "host-left" });
        clients.delete(peer.socket);
        peer.socket.close(1000, "Host disconnected");
      }
      rooms.delete(client.roomCode);
      return;
    }

    room.peers.delete(client.id);
    send(room.host.socket, { type: "peer-left", peerId: client.id });
  }

  httpServer.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path !== "/signal") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (webSocket) => {
      wsServer.emit("connection", webSocket, request);
    });
  });

  wsServer.on("connection", (socket) => {
    const rate = { start: Date.now(), count: 0 };
    socket.on("message", (raw) => {
      const now = Date.now();
      if (now - rate.start >= 1000) {
        rate.start = now;
        rate.count = 0;
      }
      if (++rate.count > MAX_MESSAGES_PER_SECOND) {
        socket.close(1008, "Message rate exceeded");
        return;
      }

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.close(1007, "Invalid JSON");
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        socket.close(1008, "Invalid message");
        return;
      }

      const client = clients.get(socket);
      if (!client) {
        if (message.type === "create") {
          let roomCode;
          do {
            roomCode = randomBytes(ROOM_CODE_BYTES).toString("base64url");
          } while (rooms.has(roomCode));
          const id = randomBytes(8).toString("base64url");
          const hostClient = { socket, id, role: "host", roomCode };
          clients.set(socket, hostClient);
          rooms.set(roomCode, { host: hostClient, peers: new Map() });
          send(hostClient, { type: "created", roomCode, clientId: id });
          return;
        }

        if (message.type === "join" && typeof message.roomCode === "string") {
          const room = rooms.get(message.roomCode);
          if (!room) {
            send(socket, { type: "error", code: "ROOM_NOT_FOUND" });
            return;
          }
          if (room.peers.size >= MAX_PEERS_PER_ROOM) {
            send(socket, { type: "error", code: "ROOM_FULL" });
            return;
          }
          const id = randomBytes(8).toString("base64url");
          const peer = { socket, id, role: "peer", roomCode: message.roomCode };
          clients.set(socket, peer);
          room.peers.set(id, peer);
          send(peer, { type: "joined", clientId: id, hostId: room.host.id });
          send(room.host, { type: "peer-joined", peerId: id });
          return;
        }

        send(socket, { type: "error", code: "EXPECTED_CREATE_OR_JOIN" });
        return;
      }

      if (
        message.type !== "signal" ||
        typeof message.to !== "string" ||
        !message.data ||
        typeof message.data !== "object" ||
        Array.isArray(message.data)
      ) {
        send(socket, { type: "error", code: "INVALID_SIGNAL" });
        return;
      }

      const room = rooms.get(client.roomCode);
      const target = client.role === "host"
        ? room?.peers.get(message.to)
        : room?.host.id === message.to ? room.host : undefined;
      if (!target) {
        send(socket, { type: "error", code: "PEER_NOT_FOUND" });
        return;
      }
      send(target, { type: "signal", from: client.id, data: message.data });
    });

    socket.on("close", () => removeClient(socket));
    socket.on("error", () => removeClient(socket));
  });

  return {
    rooms,
    listen() {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolve(httpServer.address());
        });
      });
    },
    close() {
      for (const socket of wsServer.clients) socket.terminate();
      return new Promise((resolve, reject) => {
        wsServer.close((wsError) => {
          httpServer.close((httpError) => {
            const error = wsError || httpError;
            if (error) reject(error);
            else resolve();
          });
        });
      });
    }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  const relay = createRelayServer({ host: process.env.HOST || "0.0.0.0", port });
  relay.listen().then((address) => {
    console.log(`Signaling relay listening on ${address.address}:${address.port}`);
  }).catch((error) => {
    console.error("Could not start signaling relay:", error);
    process.exitCode = 1;
  });
}

module.exports = { createRelayServer };
