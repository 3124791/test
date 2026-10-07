"use strict";

const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { createRelayServer } = require("./server");

let relay;
let address;

before(async () => {
  relay = createRelayServer({ host: "127.0.0.1", port: 0 });
  address = await relay.listen();
});

after(async () => {
  await relay.close();
});

function connect() {
  return new WebSocket(`ws://127.0.0.1:${address.port}/signal`);
}

function receive(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (message) => resolve(JSON.parse(message.toString())));
    socket.once("error", reject);
  });
}

function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

test("host can create a room and exchange signaling with multiple peers", async (t) => {
  const host = connect();
  await opened(host);
  t.after(() => host.close());

  host.send(JSON.stringify({ type: "create" }));
  const created = await receive(host);
  assert.equal(created.type, "created");
  assert.match(created.roomCode, /^[A-Za-z0-9_-]{22}$/);

  const peer = connect();
  await opened(peer);
  t.after(() => peer.close());
  peer.send(JSON.stringify({ type: "join", roomCode: created.roomCode }));
  const joined = await receive(peer);
  assert.equal(joined.type, "joined");
  assert.equal(joined.hostId, created.clientId);
  assert.deepEqual(await receive(host), { type: "peer-joined", peerId: joined.clientId });

  const offer = { description: { type: "offer", sdp: "example" } };
  host.send(JSON.stringify({ type: "signal", to: joined.clientId, data: offer }));
  assert.deepEqual(await receive(peer), { type: "signal", from: created.clientId, data: offer });

  const answer = { description: { type: "answer", sdp: "example" } };
  peer.send(JSON.stringify({ type: "signal", to: created.clientId, data: answer }));
  assert.deepEqual(await receive(host), { type: "signal", from: joined.clientId, data: answer });
});

test("unknown rooms are not created by join attempts", async (t) => {
  const peer = connect();
  await opened(peer);
  t.after(() => peer.close());

  peer.send(JSON.stringify({ type: "join", roomCode: "not-a-room" }));
  assert.deepEqual(await receive(peer), { type: "error", code: "ROOM_NOT_FOUND" });
  assert.equal(relay.rooms.size, 0);
});
