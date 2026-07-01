// ─────────────────────────────────────────────────────────────
//  NERD REICH: METROPOLIS  —  multiplayer server
//  Node.js + Socket.io   |   up to 8 live players + queue
// ─────────────────────────────────────────────────────────────
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── CONSTANTS ────────────────────────────────────────────────
const W   = 1280, H = 720;
const MAX = 8;        // live player slots
const WIN = 10;       // deliveries to win a round
const FPS = 30;

const COLORS = [
  '#00d4ff', // 0 cyan
  '#ff7700', // 1 orange
  '#00ff66', // 2 green
  '#ff44cc', // 3 pink
  '#ffcc00', // 4 gold
  '#ff2244', // 5 red
  '#cc44ff', // 6 purple
  '#aaddff', // 7 ice-blue
];

// Machine (delivery target) position per slot
const MPOS = [
  { mx:55,    my:190    }, // 0 top-left
  { mx:W-55,  my:190    }, // 1 top-right
  { mx:55,    my:H-190  }, // 2 bot-left
  { mx:W-55,  my:H-190  }, // 3 bot-right
  { mx:55,    my:H/2    }, // 4 mid-left
  { mx:W-55,  my:H/2    }, // 5 mid-right
  { mx:W/2,   my:48     }, // 6 top-center
  { mx:W/2,   my:H-48   }, // 7 bot-center
];

// Starting position per slot (away from machines, toward centre)
const SPOS = [
  { x:220,   y:220    },
  { x:W-220, y:220    },
  { x:220,   y:H-220  },
  { x:W-220, y:H-220  },
  { x:220,   y:H/2    },
  { x:W-220, y:H/2    },
  { x:W/2,   y:190    },
  { x:W/2,   y:H-190  },
];

const GEARS = [
  { x:W/2,     y:H/2,    r:78, n:14, a:0, spd: .013 },
  { x:W/2-180, y:H/2-95, r:42, n:9,  a:0, spd:-.022 },
  { x:W/2+180, y:H/2-95, r:42, n:9,  a:0, spd:-.022 },
  { x:W/2-180, y:H/2+95, r:42, n:9,  a:0, spd:-.022 },
  { x:W/2+180, y:H/2+95, r:42, n:9,  a:0, spd:-.022 },
];

// ── GAME STATE ───────────────────────────────────────────────
let players = {};          // socketId → player object
let queue   = [];          // [socketId, …]  waiting line
let workers = [];
let slots   = new Array(MAX).fill(null);  // slot index → socketId | null
let tick    = 0;

function mkWorker () {
  return {
    id:    Math.random().toString(36).slice(2),
    x:     W/2 + (Math.random() - .5) * 420,
    y:     160  + Math.random() * (H - 320),
    vx:    (Math.random() - .5) * .6,
    vy:    (Math.random() - .5) * .6,
    owned: null,   // socketId or null
    scd:   0,      // steal-cooldown frames
    t:     Math.random() * 99,
  };
}
for (let i = 0; i < 10; i++) workers.push(mkWorker());

// ── HELPERS ──────────────────────────────────────────────────
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function freeSlot () {
  for (let i = 0; i < MAX; i++) if (!slots[i]) return i;
  return -1;
}

function addToGame (socket) {
  const s = freeSlot();
  if (s < 0) return false;
  slots[s] = socket.id;
  players[socket.id] = {
    id:    socket.id,
    slot:  s,
    x:     SPOS[s].x,
    y:     SPOS[s].y,
    vx: 0, vy: 0,
    color: COLORS[s],
    mx:    MPOS[s].mx,
    my:    MPOS[s].my,
    score: 0,
    keys:  { u:0, d:0, l:0, r:0 },
  };
  socket.emit('joined', {
    myId:  socket.id,
    slot:  s,
    color: COLORS[s],
    mx:    MPOS[s].mx,
    my:    MPOS[s].my,
  });
  return true;
}

function removeFromGame (socketId) {
  const p = players[socketId];
  if (!p) return;
  slots[p.slot] = null;
  workers.forEach(w => { if (w.owned === socketId) { w.owned = null; w.scd = 0; } });
  delete players[socketId];
  io.emit('playerGone', { id: socketId, slot: p.slot });
}

function promoteQueue () {
  while (queue.length > 0 && freeSlot() >= 0) {
    const nid   = queue.shift();
    const nsock = io.sockets.sockets.get(nid);
    if (nsock) {
      addToGame(nsock);
      nsock.emit('promoted');
    }
  }
  broadcastQueuePos();
}

function broadcastQueuePos () {
  queue.forEach((id, i) =>
    io.to(id).emit('queued', { pos: i + 1, total: queue.length })
  );
}

function resetRound () {
  Object.values(players).forEach(p => p.score = 0);
  workers = [];
  for (let i = 0; i < 10; i++) workers.push(mkWorker());
}

// ── SOCKET EVENTS ────────────────────────────────────────────
const lobby = new Set();   // connected but not yet pressed SPACE

io.on('connection', sock => {
  console.log(`+ ${sock.id}`);
  lobby.add(sock.id);
  sock.emit('lobby');  // tell client to show title screen first

  // player presses SPACE on title screen → join the game
  sock.on('ready', () => {
    if (!lobby.has(sock.id)) return;
    lobby.delete(sock.id);
    if (!addToGame(sock)) {
      queue.push(sock.id);
      broadcastQueuePos();
      sock.emit('queued', { pos: queue.length, total: queue.length });
    }
  });

  sock.on('input', keys => {
    if (players[sock.id]) players[sock.id].keys = keys;
  });

  sock.on('disconnect', () => {
    console.log(`- ${sock.id}`);
    lobby.delete(sock.id);
    if (players[sock.id]) {
      removeFromGame(sock.id);
      promoteQueue();
    } else {
      queue = queue.filter(id => id !== sock.id);
      broadcastQueuePos();
    }
  });
});

// ── GAME LOOP ────────────────────────────────────────────────
setInterval(() => {
  tick++;
  GEARS.forEach(g => g.a += g.spd);

  // trickle-spawn workers
  if (tick % 90 === 0 && workers.length < 14) workers.push(mkWorker());

  // ── player movement + capture + steal ──
  const toKill = [];
  Object.values(players).forEach(p => {
    const spd = 4.5;
    p.vx = p.keys.l ? -spd : p.keys.r ? spd : p.vx * .72;
    p.vy = p.keys.u ? -spd : p.keys.d ? spd : p.vy * .72;
    p.x  = Math.max(28,   Math.min(W - 28,  p.x + p.vx));
    p.y  = Math.max(70,   Math.min(H - 45,  p.y + p.vy));

    // gear death
    for (const g of GEARS) {
      if (dist(p, g) < g.r + 22) { toKill.push(p.id); break; }
    }

    // capture free workers
    workers.forEach(w => {
      if (!w.owned && dist(p, w) < 38) {
        w.owned = p.id; w.scd = 0;
      } else if (w.owned && w.owned !== p.id && w.scd === 0 && dist(p, w) < 42) {
        // steal escorted worker
        w.owned = p.id; w.scd = 28;
      }
    });
  });

  // ── process deaths ──
  toKill.forEach(id => {
    const sock = io.sockets.sockets.get(id);
    if (sock) sock.emit('youDied');
    removeFromGame(id);
    if (!queue.includes(id)) queue.push(id);   // back of the line
    promoteQueue();
  });

  // ── worker movement + delivery ──
  const dead = new Set();
  workers.forEach((w, wi) => {
    w.t  += .15;
    if (w.scd > 0) w.scd--;

    if (w.owned) {
      const p = players[w.owned];
      if (!p) { w.owned = null; return; }

      const grp = workers.filter(x => x.owned === w.owned);
      const fi  = grp.indexOf(w);
      const dirX = p.mx < W / 2 ? 1 : -1;

      w.x += (p.x + dirX * (fi + 1) * 18 - w.x) * .11;
      w.y += (p.y + (fi % 3 - 1)  * 20  - w.y) * .11;

      // delivery
      if (Math.hypot(w.x - p.mx, w.y - p.my) < 65) {
        p.score++;
        dead.add(wi);
        if (p.score >= WIN) {
          io.emit('roundWin', { id: p.id, color: p.color, slot: p.slot });
          resetRound();
        }
      }
    } else {
      // free wander
      w.vx += (Math.random() - .5) * .07;
      w.vy += (Math.random() - .5) * .07;
      w.vx  = Math.max(-.9, Math.min(.9, w.vx));
      w.vy  = Math.max(-.9, Math.min(.9, w.vy));
      w.x  += w.vx;  w.y += w.vy;
      w.x   = Math.max(155, Math.min(W - 155, w.x));
      w.y   = Math.max(110, Math.min(H - 75,  w.y));
    }

    // gear scatter
    GEARS.forEach(g => {
      if (dist(w, g) < g.r + 18) {
        w.owned = null; w.scd = 0;
        const a = Math.atan2(w.y - g.y, w.x - g.x);
        w.x  = g.x + Math.cos(a) * (g.r + 30);
        w.y  = g.y + Math.sin(a) * (g.r + 30);
        w.vx = Math.cos(a) * 4;
        w.vy = Math.sin(a) * 4;
      }
    });
  });
  workers = workers.filter((_, i) => !dead.has(i));

  // ── broadcast ──
  io.emit('state', {
    players: Object.values(players).map(p => ({
      id: p.id, slot: p.slot, x: p.x, y: p.y,
      color: p.color, score: p.score, mx: p.mx, my: p.my,
    })),
    workers: workers.map(w => ({
      id: w.id, x: w.x, y: w.y, owned: w.owned, scd: w.scd,
    })),
    gears: GEARS.map(g => ({ x: g.x, y: g.y, r: g.r, n: g.n, a: g.a })),
    queueLen: queue.length,
    tick,
  });

}, 1000 / FPS);

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`NERD REICH: METROPOLIS  →  http://localhost:${PORT}`)
);
