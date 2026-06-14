// LakeHouse Party Game — authoritative server with multi-session (room-code) support.
// Node + Express + Socket.io. Each 4-digit code maps to an isolated in-memory game.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname + '/public'));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ---------------------------------------------------------------------------
// 50 seeded "best-worst" prompts
// ---------------------------------------------------------------------------
const PROMPTS = [
  'The worst superpower to discover while in a job interview',
  'A comment guaranteed to kill the mood',
  'The best worst slogan for a funeral home',
  "The worst thing to hear your surgeon say mid-operation",
  'A terrible name for a cruise ship',
  'The worst fortune to find in a fortune cookie',
  'A bad reason to call in sick to work',
  'The worst superhero catchphrase',
  'A terrible motivational poster for an office',
  'The worst thing to say on a first date',
  'A bad name for a daycare',
  'The worst Wi-Fi network name to see at a hospital',
  'A terrible theme for a wedding',
  'The worst thing to whisper to a sleeping bear',
  'A bad slogan for a dating app',
  'The worst item to bring to a knife fight',
  'A terrible name for a perfume',
  'The worst thing to say during a moment of silence',
  'A bad opening line for a eulogy',
  'The worst flavor for a birthday cake',
  'A terrible thing to find in your hotel room',
  'The worst superpower for a lifeguard to have',
  'A bad name for a roller coaster',
  'The worst thing to yell in a crowded elevator',
  'A terrible slogan for an airline',
  'The worst thing to find in your salad',
  'A bad theme song for a wedding entrance',
  'The worst thing a GPS could say',
  'A terrible name for a guard dog',
  'The worst advice to give a new parent',
  'A bad reason to evacuate a building',
  'The worst thing to be allergic to',
  'A terrible mascot for a gym',
  'The worst thing to say to a police officer',
  'A bad name for a yacht owned by a pirate',
  'The worst thing to keep in your glovebox',
  'A terrible slogan for a tattoo parlor',
  'The worst thing to hear from the cockpit',
  'A bad name for a band that only plays funerals',
  'The worst topping for ice cream',
  'A terrible thing to be famous for',
  'The worst thing to say at a job promotion',
  'A bad name for a self-help book',
  'The worst thing to find in your pocket after a wild night',
  'A terrible new feature for a smartphone',
  'The worst thing to teach a parrot',
  'A bad slogan for a retirement home',
  'The worst thing to bring to a potluck',
  'A terrible name for a cat that judges you',
  'The worst thing to say while skydiving',
];

// ---------------------------------------------------------------------------
// Sessions: code -> game. Each game is fully isolated.
// ---------------------------------------------------------------------------
const sessions = new Map();

function freshGame(code) {
  return {
    code,
    phase: 'LOBBY', // LOBBY | PROMPT_SELECT | RESPOND | READ | RESULTS | FINAL
    players: [], // { playerId, username, socketId, connected, score }
    hostId: null,
    guesserIndex: 0,
    usedPrompts: new Set(),
    round: null,
    lastActive: Date.now(),
  };
}

function freshRound() {
  return {
    prompt: null,
    promptChoices: [], // [{id, text}]
    readerId: null,
    responses: [], // [{id, authorId, text}]
    order: [], // [responseId] shuffled
    judged: {}, // responseId -> bool
    pass: 'read', // 'read' | 'guess'
  };
}

function genCode() {
  let code;
  do {
    code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  } while (sessions.has(code));
  return code;
}

function touch(game) {
  if (game) game.lastActive = Date.now();
}

// ---------------------------------------------------------------------------
// Helpers (all scoped to a given game)
// ---------------------------------------------------------------------------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rid() {
  return Math.random().toString(36).slice(2, 10);
}

function connectedPlayers(game) {
  return game.players.filter((p) => p.connected);
}

function currentGuesser(game) {
  return game.players[game.guesserIndex] || null;
}

// Reader = next connected player after the guesser, in seating order.
function computeReader(game) {
  const n = game.players.length;
  if (n === 0) return null;
  for (let step = 1; step <= n; step++) {
    const p = game.players[(game.guesserIndex + step) % n];
    if (p && p.connected) return p;
  }
  return null;
}

function findPlayer(game, playerId) {
  return game.players.find((p) => p.playerId === playerId) || null;
}

function playerById(game, id) {
  return game.players.find((p) => p.playerId === id) || null;
}

// Responders = all connected players except the guesser (reader is included).
function responders(game) {
  const g = currentGuesser(game);
  return connectedPlayers(game).filter((p) => !g || p.playerId !== g.playerId);
}

function roleOf(game, player) {
  const g = currentGuesser(game);
  if (g && player.playerId === g.playerId) return 'guesser';
  if (game.round && game.round.readerId === player.playerId) return 'reader';
  return 'responder';
}

// ---------------------------------------------------------------------------
// Per-player tailored state view
// ---------------------------------------------------------------------------
function buildStateFor(game, player) {
  const g = currentGuesser(game);
  const reader = game.round ? playerById(game, game.round.readerId) : null;
  const role = roleOf(game, player);

  const publicPlayers = game.players.map((p) => ({
    username: p.username,
    score: p.score,
    connected: p.connected,
    isHost: p.playerId === game.hostId,
    isGuesser: g ? p.playerId === g.playerId : false,
    isReader: game.round ? p.playerId === game.round.readerId : false,
  }));

  const you = {
    playerId: player.playerId,
    username: player.username,
    role,
    isHost: player.playerId === game.hostId,
    score: player.score,
  };

  const view = {
    code: game.code,
    phase: game.phase,
    players: publicPlayers,
    connectedCount: connectedPlayers(game).length,
    totalRounds: game.players.length,
    roundNumber: game.guesserIndex + 1,
    you,
    guesserName: g ? g.username : null,
    readerName: reader ? reader.username : null,
  };

  if (game.round) {
    const r = game.round;
    const totalResponders = responders(game).length;
    const submittedIds = new Set(r.responses.map((x) => x.authorId));

    view.round = {
      prompt: r.prompt,
      submittedCount: r.responses.length,
      totalResponders,
      youSubmitted: submittedIds.has(player.playerId),
      pass: r.pass,
      judgedCount: Object.keys(r.judged).length,
    };

    if (role === 'guesser' && game.phase === 'PROMPT_SELECT') {
      view.round.promptChoices = r.promptChoices;
    }

    // READER ONLY: responses with true authorship.
    if (role === 'reader' && (game.phase === 'READ' || game.phase === 'RESULTS')) {
      view.round.responses = r.order.map((id) => {
        const resp = r.responses.find((x) => x.id === id);
        const author = playerById(game, resp.authorId);
        return {
          id: resp.id,
          text: resp.text,
          authorName: author ? author.username : '???',
          judged: id in r.judged ? r.judged[id] : null,
        };
      });
    }

    // RESULTS: everyone sees the full reveal.
    if (game.phase === 'RESULTS') {
      view.round.reveal = r.order.map((id) => {
        const resp = r.responses.find((x) => x.id === id);
        const author = playerById(game, resp.authorId);
        return {
          text: resp.text,
          authorName: author ? author.username : '???',
          correct: id in r.judged ? r.judged[id] : false,
        };
      });
      view.round.correctCount = Object.values(r.judged).filter(Boolean).length;
    }
  }

  if (game.phase === 'FINAL') {
    view.finalRanking = game.players
      .map((p) => ({ username: p.username, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }

  return view;
}

function broadcast(game) {
  for (const p of game.players) {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit('state', buildStateFor(game, p));
    }
  }
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------
function dealPrompts(game) {
  const available = PROMPTS.map((text, i) => ({ id: i, text })).filter(
    (p) => !game.usedPrompts.has(p.id)
  );
  game.round.promptChoices = shuffle(available).slice(0, 3);
}

function startRound(game) {
  game.round = freshRound();
  const reader = computeReader(game);
  game.round.readerId = reader ? reader.playerId : null;
  game.phase = 'PROMPT_SELECT';
  dealPrompts(game);
}

function maybeAdvanceFromRespond(game) {
  const total = responders(game).length;
  if (total > 0 && game.round.responses.length >= total) {
    game.round.order = shuffle(game.round.responses.map((r) => r.id));
    game.round.pass = 'read';
    game.phase = 'READ';
  }
}

function maybeFinishJudging(game) {
  const r = game.round;
  if (r.order.length > 0 && Object.keys(r.judged).length >= r.order.length) {
    const correct = Object.values(r.judged).filter(Boolean).length;
    const guesser = currentGuesser(game);
    if (guesser) guesser.score += correct;
    game.phase = 'RESULTS';
  }
}

function advanceRoundOrFinish(game) {
  game.guesserIndex += 1;
  if (game.guesserIndex >= game.players.length) {
    game.phase = 'FINAL';
    game.round = null;
  } else {
    startRound(game);
  }
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------
function attach(socket, game, playerId) {
  socket.data.playerId = playerId;
  socket.data.code = game.code;
}

function gameOf(socket) {
  return sessions.get(socket.data.code) || null;
}

io.on('connection', (socket) => {
  // Create a brand-new session; creator becomes host.
  socket.on('createSession', ({ playerId, username }) => {
    if (!playerId) return;
    const code = genCode();
    const game = freshGame(code);
    const player = {
      playerId,
      username: (username || 'Player').trim().slice(0, 24) || 'Player',
      socketId: socket.id,
      connected: true,
      score: 0,
    };
    game.players.push(player);
    game.hostId = playerId;
    sessions.set(code, game);
    attach(socket, game, playerId);
    touch(game);
    broadcast(game);
  });

  // Join (or reconnect to) an existing session by code.
  socket.on('joinSession', ({ code, playerId, username }) => {
    if (!playerId || !code) return;
    code = String(code).trim();
    const game = sessions.get(code);
    if (!game) {
      socket.emit('errorMsg', `No game with code ${code}.`);
      socket.emit('noSession', code);
      return;
    }
    let player = findPlayer(game, playerId);
    if (player) {
      // Reconnect.
      player.socketId = socket.id;
      player.connected = true;
      if (username && username.trim()) player.username = username.trim().slice(0, 24);
    } else {
      if (game.phase !== 'LOBBY') {
        socket.emit('errorMsg', 'That game already started — ask them to Play Again or start a new one.');
        return;
      }
      player = {
        playerId,
        username: (username || 'Player').trim().slice(0, 24) || 'Player',
        socketId: socket.id,
        connected: true,
        score: 0,
      };
      game.players.push(player);
      if (!game.hostId) game.hostId = playerId;
    }
    attach(socket, game, playerId);

    // If the reader had dropped, recompute it.
    if (game.round && game.phase !== 'LOBBY' && !playerById(game, game.round.readerId)?.connected) {
      const reader = computeReader(game);
      game.round.readerId = reader ? reader.playerId : game.round.readerId;
    }
    touch(game);
    broadcast(game);
  });

  socket.on('startGame', () => {
    const game = gameOf(socket);
    if (!game) return;
    if (socket.data.playerId !== game.hostId) return;
    if (game.phase !== 'LOBBY') return;
    if (connectedPlayers(game).length < 3) {
      socket.emit('errorMsg', 'Need at least 3 players to start.');
      return;
    }
    game.guesserIndex = 0;
    startRound(game);
    touch(game);
    broadcast(game);
  });

  socket.on('selectPrompt', ({ promptId }) => {
    const game = gameOf(socket);
    if (!game) return;
    const g = currentGuesser(game);
    if (!g || socket.data.playerId !== g.playerId) return;
    if (game.phase !== 'PROMPT_SELECT') return;
    const choice = game.round.promptChoices.find((c) => c.id === promptId);
    if (!choice) return;
    game.round.prompt = choice.text;
    game.usedPrompts.add(choice.id);
    game.round.promptChoices = [];
    game.round.responses = [];
    game.phase = 'RESPOND';
    touch(game);
    broadcast(game);
  });

  socket.on('submitResponse', ({ text }) => {
    const game = gameOf(socket);
    if (!game) return;
    const pid = socket.data.playerId;
    if (game.phase !== 'RESPOND') return;
    const isResponder = responders(game).some((p) => p.playerId === pid);
    if (!isResponder) return;
    if (game.round.responses.some((r) => r.authorId === pid)) return; // one each
    const clean = (text || '').toString().trim().slice(0, 240);
    if (!clean) return;
    game.round.responses.push({ id: rid(), authorId: pid, text: clean });
    maybeAdvanceFromRespond(game);
    touch(game);
    broadcast(game);
  });

  socket.on('beginGuessing', () => {
    const game = gameOf(socket);
    if (!game) return;
    if (game.phase !== 'READ') return;
    if (!game.round || socket.data.playerId !== game.round.readerId) return;
    game.round.pass = 'guess';
    touch(game);
    broadcast(game);
  });

  socket.on('judge', ({ responseId, correct }) => {
    const game = gameOf(socket);
    if (!game) return;
    if (game.phase !== 'READ') return;
    if (!game.round || socket.data.playerId !== game.round.readerId) return;
    if (game.round.pass !== 'guess') return;
    if (!game.round.order.includes(responseId)) return;
    game.round.judged[responseId] = !!correct;
    maybeFinishJudging(game);
    touch(game);
    broadcast(game);
  });

  socket.on('nextRound', () => {
    const game = gameOf(socket);
    if (!game) return;
    if (game.phase !== 'RESULTS') return; // phase guard makes double-taps no-ops
    advanceRoundOrFinish(game);
    touch(game);
    broadcast(game);
  });

  socket.on('playAgain', () => {
    const game = gameOf(socket);
    if (!game) return;
    if (game.phase !== 'FINAL') return;
    const prevHost = game.hostId;
    const code = game.code;
    const keep = game.players.map((p) => ({ ...p, score: 0 }));
    const fresh = freshGame(code);
    fresh.players = keep;
    fresh.hostId = keep.some((p) => p.playerId === prevHost)
      ? prevHost
      : keep[0] && keep[0].playerId;
    sessions.set(code, fresh);
    touch(fresh);
    broadcast(fresh);
  });

  socket.on('disconnect', () => {
    const game = gameOf(socket);
    if (!game) return;
    const player = findPlayer(game, socket.data.playerId);
    if (player) {
      player.connected = false;
      player.socketId = null;
      if (game.round && game.round.readerId === socket.data.playerId) {
        const reader = computeReader(game);
        game.round.readerId = reader ? reader.playerId : null;
      }
      touch(game);
      broadcast(game);
    }
  });
});

// ---------------------------------------------------------------------------
// Reaper: drop sessions that have been empty (nobody connected) for 30+ min.
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, game] of sessions) {
    const anyoneHere = game.players.some((p) => p.connected);
    if (!anyoneHere && now - game.lastActive > SESSION_TTL_MS) {
      sessions.delete(code);
    }
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function localIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  🏕️  LakeHouse Party Game is live!\n');
  console.log(`     On this machine:  http://localhost:${PORT}`);
  for (const ip of localIPs()) {
    console.log(`     On phones (wifi): http://${ip}:${PORT}`);
  }
  console.log('\n  Create a game to get a 4-digit code, then share it.\n');
});
