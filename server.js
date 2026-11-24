// Word Bapple game server. No dependencies: run `node server.js` (Node 18+).
// Serves the game page, runs online rooms (Server-Sent Events + JSON POSTs),
// and checks words against a bundled word list, falling back to the Free Dictionary API.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const COLORS = ["#ffd23f", "#ff6f61", "#3ddc97", "#7cc6ff", "#c792ea", "#ff9f43", "#f78fb3", "#a3e635"];
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const OUT_MS = 5000;     // how long the "X is out" screen shows
const INTRO_MS = 3000;   // countdown before each letter
const MAX_PLAYERS = 8;

/* ---------------- dictionary ---------------- */
const WORDS = new Set(fs.readFileSync(path.join(ROOT, "words.txt"), "utf8").split("\n").filter(Boolean));
const apiCache = new Map(); // word -> boolean
const DICT_API = process.env.DICT_API || "https://api.dictionaryapi.dev/api/v2/entries/en/";
console.log(`Loaded ${WORDS.size.toLocaleString()} words.`);

async function isRealWord(w) {
  if (WORDS.has(w)) return { ok: true, source: "list" };
  if (apiCache.has(w)) return { ok: apiCache.get(w), source: "api" };
  if (DICT_API === "off") return { ok: false, source: "list" };
  try {
    const r = await fetch(DICT_API + encodeURIComponent(w), { signal: AbortSignal.timeout(2500) });
    if (r.status === 200 || r.status === 404) {
      const ok = r.status === 200;
      if (apiCache.size > 20000) apiCache.clear();
      apiCache.set(w, ok);
      return { ok, source: "api" };
    }
  } catch {}
  return { ok: false, source: "unavailable" }; // API down: trust the list only
}

function wordError(w, letter, used) {
  if (!w) return "Type a word first.";
  if (!/^[a-z]+$/.test(w)) return "Letters only, one word.";
  if (w[0] !== letter.toLowerCase()) return `It has to start with ${letter}.`;
  if (w.length < 2) return "Needs at least 2 letters.";
  if (used.some(u => u.word === w)) return `"${w}" was already said!`;
  return null;
}

/* ---------------- rooms ---------------- */
const rooms = new Map();
const letterList = skip => ALPHA.split("").filter(l => !(skip && "QXZ".includes(l)));
const nextAlive = (players, from) => {
  for (let k = 1; k <= players.length; k++) { const i = (from + k) % players.length; if (players[i].alive) return i; }
  return from;
};
const cleanName = n => String(n || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 16) || "Player";

function newCode() {
  const A = "BCDFGHJKLMNPQRSTVWXZ";
  for (;;) {
    const c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join("");
    if (!rooms.has(c)) return c;
  }
}

function createRoom(hostName) {
  const code = newCode();
  const room = {
    code, hostId: null, phase: "lobby", createdAt: Date.now(), touched: Date.now(),
    settings: { time: 8, speedUp: true, skipHard: false, startLetter: "A", everyWord: false },
    players: [], letterIdx: 0, round: 1, turn: 0, turnLen: 8, turnSeq: 0, deadline: 0,
    used: [], lastWord: null, out: null, winner: null, totalWords: 0,
    tokens: new Map(), streams: new Map(), timer: null, checking: false
  };
  rooms.set(code, room);
  const p = addPlayer(room, hostName);
  room.hostId = p.id;
  return { room, player: p };
}

function addPlayer(room, name) {
  const id = crypto.randomBytes(6).toString("hex");
  const token = crypto.randomBytes(16).toString("hex");
  const p = { id, name: cleanName(name), color: COLORS[0], alive: true, words: 0, connected: false, token };
  room.players.push(p);
  room.tokens.set(token, id);
  recolor(room);
  return p;
}
function recolor(room) { room.players.forEach((p, i) => { p.color = COLORS[i % COLORS.length]; }); }
const playerByToken = (room, token) => room.players.find(p => p.id === room.tokens.get(token));
function startIndex(s) {
  const ls = letterList(s.skipHard);
  if (s.startLetter === "random") return crypto.randomInt(ls.length);
  const i = ls.findIndex(l => l >= s.startLetter); // a skipped letter starts on the next one
  return i < 0 ? 0 : i;
}
// A random letter that isn't the current one.
function randomOtherIndex(room) {
  const n = letterList(room.settings.skipHard).length;
  const cur = room.letterIdx % n;
  return (cur + 1 + crypto.randomInt(n - 1)) % n;
}
const letter = room => { const ls = letterList(room.settings.skipHard); return ls[room.letterIdx % ls.length]; };

function publicState(room) {
  return {
    code: room.code, hostId: room.hostId, phase: room.phase, settings: room.settings,
    players: room.players.map(({ token, ...p }) => p),
    letter: letter(room),
    round: room.round, turn: room.turn, turnLen: room.turnLen, turnSeq: room.turnSeq, deadline: room.deadline,
    used: room.used, lastWord: room.lastWord, out: room.out, winner: room.winner, totalWords: room.totalWords,
    serverNow: Date.now()
  };
}
function broadcast(room) {
  room.touched = Date.now();
  const data = `data: ${JSON.stringify(publicState(room))}\n\n`;
  for (const set of room.streams.values()) for (const res of set) res.write(data);
}

function setTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => { room.timer = null; fn(); }, ms);
}

function startIntro(room) {
  room.phase = "intro";
  room.used = []; room.lastWord = null; room.turnLen = room.settings.time;
  room.deadline = Date.now() + INTRO_MS;
  setTimer(room, INTRO_MS, () => startTurn(room, true));
  broadcast(room);
}

function startTurn(room, fresh) {
  room.phase = "play";
  room.turnSeq++;
  const p = room.players[room.turn];
  // A player who has left gets a short grace period instead of the full clock.
  const ms = p.connected ? room.turnLen * 1000 : Math.min(room.turnLen * 1000, 3000);
  room.deadline = Date.now() + ms;
  const seq = room.turnSeq;
  setTimer(room, ms + 250, () => { if (room.turnSeq === seq && room.phase === "play") eliminate(room, room.turn, p.connected ? "Time ran out." : "Left the game."); });
  if (!fresh) {} // turn change is broadcast by caller
  broadcast(room);
}

function eliminate(room, i, reason) {
  clearTimeout(room.timer);
  const p = room.players[i];
  p.alive = false;
  const left = room.players.filter(x => x.alive);
  if (left.length <= 1) {
    room.phase = "win";
    room.winner = left[0] ? left[0].id : null;
    broadcast(room);
    return;
  }
  room.out = { id: p.id, name: p.name, reason, letter: letter(room), used: room.used };
  room.turn = nextAlive(room.players, i);
  room.letterIdx = room.settings.everyWord ? randomOtherIndex(room) : room.letterIdx + 1;
  room.round++;
  room.phase = "out";
  room.deadline = Date.now() + OUT_MS;
  setTimer(room, OUT_MS, () => startIntro(room));
  broadcast(room);
}

function removePlayer(room, id) {
  const i = room.players.findIndex(p => p.id === id);
  if (i < 0) return;
  const [p] = room.players.splice(i, 1);
  room.tokens.delete(p.token);
  const streams = room.streams.get(id);
  if (streams) for (const res of streams) { res.write(`event: kicked\ndata: {}\n\n`); res.end(); }
  room.streams.delete(id);
  recolor(room);
  if (room.hostId === id) room.hostId = (room.players.find(x => x.connected) || room.players[0] || {}).id || null;
  if (!room.players.length) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  broadcast(room);
}

function newHostIfNeeded(room) {
  const host = room.players.find(p => p.id === room.hostId);
  if (!host || !host.connected) {
    const next = room.players.find(p => p.connected);
    if (next) room.hostId = next.id;
  }
}

async function act(room, p, body) {
  const isHost = p.id === room.hostId;
  switch (body.type) {
    case "settings": {
      if (!isHost || room.phase !== "lobby") return "Only the host can change settings.";
      const s = body.settings || {};
      if ([5, 8, 12, 20].includes(s.time)) room.settings.time = s.time;
      if (typeof s.speedUp === "boolean") room.settings.speedUp = s.speedUp;
      if (typeof s.skipHard === "boolean") room.settings.skipHard = s.skipHard;
      if (s.startLetter === "random" || /^[A-Z]$/.test(s.startLetter)) room.settings.startLetter = s.startLetter;
      if (typeof s.everyWord === "boolean") room.settings.everyWord = s.everyWord;
      broadcast(room); return null;
    }
    case "kick": {
      if (!isHost || room.phase !== "lobby" || body.id === p.id) return "Only the host can remove players.";
      removePlayer(room, body.id); return null;
    }
    case "start": {
      if (!isHost || room.phase !== "lobby") return "Only the host can start.";
      // Drop anyone who closed the page, keep the first 8.
      for (const x of room.players.filter(x => !x.connected)) removePlayer(room, x.id);
      if (room.players.length < 2) return "You need at least 2 players.";
      for (const x of room.players.slice(MAX_PLAYERS)) removePlayer(room, x.id);
      room.players.forEach(x => { x.alive = true; x.words = 0; });
      Object.assign(room, { letterIdx: startIndex(room.settings), round: 1, turn: 0, used: [], lastWord: null, out: null, winner: null, totalWords: 0 });
      startIntro(room); return null;
    }
    case "word": {
      if (room.phase !== "play" || room.players[room.turn].id !== p.id) return "It's not your turn.";
      if (room.checking) return "Checking your last word…";
      const w = String(body.word || "").trim().toLowerCase();
      const err = wordError(w, letter(room), room.used);
      if (err) return err;
      const seq = room.turnSeq;
      room.checking = true;
      let res;
      try { res = await isRealWord(w); } finally { room.checking = false; }
      if (room.turnSeq !== seq || room.phase !== "play") return "Too slow!";
      if (!res.ok) return res.source === "unavailable" ? `"${w}" isn't in the word list.` : `"${w}" isn't in the dictionary.`;
      if (room.used.some(u => u.word === w)) return `"${w}" was already said!`;
      room.used.push({ word: w, id: p.id });
      room.lastWord = { word: w, id: p.id };
      p.words++; room.totalWords++;
      if (room.settings.everyWord) room.letterIdx = randomOtherIndex(room);
      if (room.settings.speedUp) room.turnLen = Math.max(3, +(room.turnLen - 0.4).toFixed(1));
      room.turn = nextAlive(room.players, room.turn);
      startTurn(room);
      return null;
    }
    case "stuck": {
      if (room.phase !== "play" || room.players[room.turn].id !== p.id) return "It's not your turn.";
      eliminate(room, room.turn, "Couldn't think of one."); return null;
    }
    case "again": {
      if (!isHost || room.phase !== "win") return "Only the host can start a new game.";
      clearTimeout(room.timer);
      for (const x of room.players.filter(x => !x.connected)) removePlayer(room, x.id);
      room.players.forEach(x => { x.alive = true; x.words = 0; });
      Object.assign(room, { phase: "lobby", used: [], lastWord: null, out: null, winner: null, createdAt: Date.now() });
      broadcast(room); return null;
    }
    case "leave": {
      if (room.phase === "lobby" || room.phase === "win") removePlayer(room, p.id);
      else {
        p.connected = false; p.left = true;
        newHostIfNeeded(room);
        if (room.phase === "play" && room.players[room.turn].id === p.id) eliminate(room, room.turn, "Left the game.");
        else broadcast(room);
      }
      return null;
    }
  }
  return "Unknown action.";
}

/* ---------------- http ---------------- */
function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 10000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return fs.createReadStream(path.join(ROOT, "index.html")).pipe(res);
    }
    if (p === "/api/health") return json(res, 200, { ok: true, words: WORDS.size });

    if (p === "/api/check") {
      const w = String(url.searchParams.get("w") || "").trim().toLowerCase();
      if (!/^[a-z]+$/.test(w)) return json(res, 200, { ok: false, source: "format" });
      return json(res, 200, await isRealWord(w));
    }

    if (p === "/api/games" && req.method === "GET") {
      const list = [...rooms.values()].filter(r => r.phase === "lobby" && r.players.some(x => x.connected))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 10)
        .map(r => ({ code: r.code, host: (r.players.find(x => x.id === r.hostId) || {}).name, players: r.players.length }));
      return json(res, 200, { games: list });
    }

    if (p === "/api/create" && req.method === "POST") {
      const b = await readBody(req);
      const { room, player } = createRoom(b.name);
      return json(res, 200, { code: room.code, id: player.id, token: player.token });
    }

    if (p === "/api/join" && req.method === "POST") {
      const b = await readBody(req);
      const room = rooms.get(String(b.code || "").toUpperCase());
      if (!room) return json(res, 404, { error: "No game with that code." });
      if (b.token && playerByToken(room, b.token)) { const me = playerByToken(room, b.token); return json(res, 200, { code: room.code, id: me.id, token: me.token }); }
      if (room.phase !== "lobby") return json(res, 409, { error: "That game already started. Wait for the next one!" });
      if (room.players.length >= 12) return json(res, 409, { error: "That game is full." });
      const player = addPlayer(room, b.name);
      broadcast(room);
      return json(res, 200, { code: room.code, id: player.id, token: player.token });
    }

    if (p === "/api/events" && req.method === "GET") {
      const room = rooms.get(String(url.searchParams.get("code") || "").toUpperCase());
      const me = room && playerByToken(room, url.searchParams.get("token"));
      if (!room || !me) return json(res, 404, { error: "Game not found." });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(`retry: 2000\n\n`);
      if (!room.streams.has(me.id)) room.streams.set(me.id, new Set());
      room.streams.get(me.id).add(res);
      me.connected = true; delete me.left;
      newHostIfNeeded(room);
      broadcast(room);
      const ping = setInterval(() => res.write(`: ping\n\n`), 15000);
      req.on("close", () => {
        clearInterval(ping);
        const set = room.streams.get(me.id);
        if (set) { set.delete(res); if (!set.size) room.streams.delete(me.id); }
        if (!room.streams.has(me.id) && rooms.has(room.code)) {
          // give them a moment to reconnect (page refresh, flaky wifi)
          setTimeout(() => {
            if (room.streams.has(me.id) || !room.players.includes(me)) return;
            me.connected = false;
            newHostIfNeeded(room);
            if (room.phase === "lobby") removePlayer(room, me.id); else broadcast(room);
          }, 8000);
        }
      });
      return;
    }

    if (p === "/api/action" && req.method === "POST") {
      const b = await readBody(req);
      const room = rooms.get(String(b.code || "").toUpperCase());
      const me = room && playerByToken(room, b.token);
      if (!room || !me) return json(res, 404, { error: "Game not found." });
      const err = await act(room, me, b);
      return err ? json(res, 400, { error: err }) : json(res, 200, { ok: true });
    }

    json(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "Server error" });
  }
});

// Forget rooms nobody has touched for 3 hours.
setInterval(() => {
  for (const [code, r] of rooms) if (Date.now() - r.touched > 3 * 3600e3 && !r.streams.size) { clearTimeout(r.timer); rooms.delete(code); }
}, 600e3).unref();

server.listen(PORT, () => console.log(`Word Bapple running on http://localhost:${PORT}`));
