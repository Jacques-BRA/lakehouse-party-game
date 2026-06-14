// Headless end-to-end test: 4 players play one full round, then we check rotation.
// Run: node test-playthrough.js   (server must NOT already be running on 3000)
const { io } = require('socket.io-client');
const { spawn } = require('child_process');

// Use an isolated port so real phones (on :3000) can't wander into the test.
const TEST_PORT = 3199;
const URL = 'http://localhost:' + TEST_PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + msg);
  if (!cond) failures++;
}

// mode: 'create' makes a new session; 'join' joins SESSION_CODE once it's known.
function makePlayer(name, mode) {
  const playerId = 'pid_' + name;
  const socket = io(URL, { forceNew: true });
  const p = { name, playerId, socket, state: null, mode };
  socket.on('state', (s) => { p.state = s; });
  socket.on('errorMsg', (m) => console.log(`  [errorMsg → ${name}] ${m}`));
  socket.on('connect', () => {
    if (mode === 'create') socket.emit('createSession', { playerId, username: name });
  });
  return p;
}

(async () => {
  const server = spawn('node', ['server.js'], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(TEST_PORT) },
  });
  await sleep(1600);

  // Ann creates the session; the others join with the code she gets back.
  const host = makePlayer('Ann', 'create');
  for (let i = 0; i < 40 && !(host.state && host.state.code); i++) await sleep(100);
  const CODE = host.state && host.state.code;
  check(!!CODE && /^\d{4}$/.test(CODE), `host created session, got 4-digit code (${CODE})`);

  const joiners = ['Ben', 'Cal', 'Dee'].map((n) => makePlayer(n, 'join'));
  await sleep(300);
  joiners.forEach((p) => p.socket.emit('joinSession', { code: CODE, playerId: p.playerId, username: p.name }));
  const players = [host, ...joiners];

  // wait until all four are in the session
  for (let i = 0; i < 40; i++) {
    if (players.every((p) => p.state && p.state.connectedCount === 4)) break;
    await sleep(100);
  }

  check(host.state && host.state.phase === 'LOBBY', 'all in LOBBY');
  check(host.state.connectedCount === 4, '4 players connected');
  check(host.state.you.isHost, 'creator is host');
  check(players.every((p) => p.state.code === CODE), 'all four share the same code');

  host.socket.emit('startGame');
  await sleep(300);
  check(host.state.phase === 'PROMPT_SELECT', 'started → PROMPT_SELECT');

  const guesser = players.find((p) => p.state.you.role === 'guesser');
  const reader = players.find((p) => p.state.you.role === 'reader');
  check(!!guesser && !!reader && guesser !== reader, 'distinct guesser + reader assigned');
  check(guesser.name === 'Ann', 'round 1 guesser is first player (Ann)');
  check(reader.name === 'Ben', 'round 1 reader is next player (Ben)');
  check(Array.isArray(guesser.state.round.promptChoices) && guesser.state.round.promptChoices.length === 3, 'guesser got 3 prompt choices');
  check(players.filter((p) => p.role !== 'guesser' && p.state.round && p.state.round.promptChoices).length === 0 ? true : !players.some(p => p !== guesser && p.state.round && p.state.round.promptChoices), 'non-guessers do NOT see prompt choices');

  guesser.socket.emit('selectPrompt', { promptId: guesser.state.round.promptChoices[1].id });
  await sleep(300);
  check(guesser.state.phase === 'RESPOND', 'prompt picked → RESPOND');
  const responders = players.filter((p) => p.state.you.role !== 'guesser');
  check(responders.length === 3, '3 responders (incl. reader)');
  check(responders[0].state.round.totalResponders === 3, 'totalResponders = 3');

  // responders submit
  for (const r of responders) {
    r.socket.emit('submitResponse', { text: `${r.name}'s spicy answer` });
    await sleep(120);
  }
  await sleep(300);
  check(reader.state.phase === 'READ', 'all submitted → READ');
  check(Array.isArray(reader.state.round.responses) && reader.state.round.responses.length === 3, 'reader sees 3 responses with authors');
  check(reader.state.round.responses.every((x) => x.authorName), 'reader sees author names');
  check(guesser.state.round.responses === undefined, 'guesser does NOT see responses/authors');

  // reader: read pass → guessing pass
  check(reader.state.round.pass === 'read', 'starts in read pass');
  reader.socket.emit('beginGuessing');
  await sleep(250);
  check(reader.state.round.pass === 'guess', 'reader advanced to guess pass');

  // judge: 2 correct, 1 wrong
  const resp = reader.state.round.responses;
  reader.socket.emit('judge', { responseId: resp[0].id, correct: true });
  await sleep(120);
  reader.socket.emit('judge', { responseId: resp[1].id, correct: true });
  await sleep(120);
  reader.socket.emit('judge', { responseId: resp[2].id, correct: false });
  await sleep(300);

  check(reader.state.phase === 'RESULTS', 'all judged → RESULTS');
  check(guesser.state.round.correctCount === 2, 'results show 2 correct');
  const annScore = guesser.state.players.find((p) => p.username === 'Ann').score;
  check(annScore === 2, 'guesser (Ann) scored 2 points');
  check(Array.isArray(guesser.state.round.reveal) && guesser.state.round.reveal.length === 3, 'everyone sees reveal in RESULTS');

  // next round — advanced by a NON-host responder (anyone can advance now)
  const nonHost = players.find((p) => !p.state.you.isHost);
  check(!nonHost.state.you.isHost, 'using a non-host to advance');
  nonHost.socket.emit('nextRound');
  await sleep(300);
  check(host.state.phase === 'PROMPT_SELECT', 'non-host advanced → PROMPT_SELECT');
  const guesser2 = players.find((p) => p.state.you.role === 'guesser');
  check(guesser2.name === 'Ben', 'round 2 guesser rotated to Ben');
  check(host.state.roundNumber === 2, 'round number is 2');

  // fast-forward rounds 2,3,4 to reach FINAL
  for (let round = 2; round <= 4; round++) {
    const g = players.find((p) => p.state.you.role === 'guesser');
    g.socket.emit('selectPrompt', { promptId: g.state.round.promptChoices[0].id });
    await sleep(200);
    const resps = players.filter((p) => p.state.you.role !== 'guesser');
    for (const r of resps) { r.socket.emit('submitResponse', { text: `${r.name} r${round}` }); await sleep(80); }
    await sleep(200);
    const rd = players.find((p) => p.state.you.role === 'reader');
    rd.socket.emit('beginGuessing');
    await sleep(150);
    rd.state.round.responses.forEach((x, i) => rd.socket.emit('judge', { responseId: x.id, correct: i === 0 }));
    await sleep(250);
    host.socket.emit('nextRound');
    await sleep(250);
  }

  check(host.state.phase === 'FINAL', 'after 4 rounds → FINAL');
  check(Array.isArray(host.state.finalRanking) && host.state.finalRanking.length === 4, 'final ranking has 4 players');
  const sorted = host.state.finalRanking.every((p, i, a) => i === 0 || a[i - 1].score >= p.score);
  check(sorted, 'final ranking sorted by score desc');

  // play again — triggered by a NON-host (anyone can restart now)
  const restarter = players.find((p) => !p.state.you.isHost);
  restarter.socket.emit('playAgain');
  await sleep(300);
  check(host.state.phase === 'LOBBY', 'non-host playAgain → LOBBY');
  check(host.state.players.every((p) => p.score === 0), 'scores reset on playAgain');
  check(host.state.players.length === 4, 'everyone still signed in after playAgain');
  check(host.state.you.isHost, 'original host preserved after playAgain');

  // reconnection: drop Cal and rejoin
  const cal = players.find((p) => p.name === 'Cal');
  cal.socket.disconnect();
  await sleep(300);
  check(host.state.players.find((p) => p.username === 'Cal').connected === false, 'disconnect marks player offline (slot kept)');
  const cal2 = makePlayer('Cal', 'join'); // same playerId, rejoin by code
  await sleep(300);
  cal2.socket.emit('joinSession', { code: CODE, playerId: cal2.playerId, username: 'Cal' });
  await sleep(400);
  check(host.state.connectedCount === 4, 'reconnect (by code) restores player (same slot)');

  // ---- second session is fully isolated ----
  const eve = makePlayer('Eve', 'create');
  for (let i = 0; i < 30 && !(eve.state && eve.state.code); i++) await sleep(100);
  check(!!eve.state.code && eve.state.code !== CODE, `second session got a different code (${eve.state.code})`);
  check(eve.state.connectedCount === 1, 'second session has only its own player');
  check(host.state.connectedCount === 4, 'first session unaffected by second session');
  let badCode = '0000';
  while (badCode === CODE || badCode === eve.state.code) {
    badCode = String((Number(badCode) + 1) % 10000).padStart(4, '0');
  }
  const badJoin = makePlayer('Zed', 'join');
  await sleep(300);
  badJoin.socket.emit('joinSession', { code: badCode, playerId: 'pid_Zed', username: 'Zed' });
  await sleep(300);
  check(!badJoin.state, 'joining a non-existent code yields no state (rejected)');

  // ============ RENAME + LEAVE (fresh session) ============
  const lh = makePlayer('Lee', 'create');
  for (let i = 0; i < 30 && !(lh.state && lh.state.code); i++) await sleep(100);
  const LCODE = lh.state.code;
  const lj = ['Mia', 'Ned', 'Oji'].map((n) => makePlayer(n, 'join'));
  await sleep(300);
  lj.forEach((p) => p.socket.emit('joinSession', { code: LCODE, playerId: p.playerId, username: p.name }));
  const lparty = [lh, ...lj];
  for (let i = 0; i < 40; i++) { if (lparty.every((p) => p.state && p.state.connectedCount === 4)) break; await sleep(100); }
  check(lh.state.connectedCount === 4, 'leave-test: 4 joined a fresh session');

  // rename in the lobby is visible to everyone
  lj[0].socket.emit('rename', { username: 'Mia2' });
  await sleep(250);
  check(lh.state.players.some((p) => p.username === 'Mia2'), 'rename updates name for everyone in lobby');

  // non-host leaves the lobby → removed for everyone
  lj[2].socket.emit('leaveSession'); // Oji
  await sleep(300);
  check(lh.state.connectedCount === 3, 'non-host leave removes player (4 → 3)');
  check(!lh.state.players.some((p) => p.username === 'Oji'), 'left player no longer listed');

  // host leaves the lobby → host reassigned to someone else
  check(lh.state.you.isHost, 'Lee is host before leaving');
  lh.socket.emit('leaveSession');
  await sleep(300);
  check(lj[0].state.connectedCount === 2, 'host leave removes host (3 → 2)');
  const newHost = lj[0].state.players.find((p) => p.isHost);
  check(!!newHost && newHost.username !== 'Lee', 'host reassigned to a remaining player');

  // add a 3rd back, start, then the current guesser bails mid-round
  const pat = makePlayer('Pat', 'join');
  await sleep(200);
  pat.socket.emit('joinSession', { code: LCODE, playerId: pat.playerId, username: 'Pat' });
  await sleep(300);
  const active = [lj[0], lj[1], pat];
  check(lj[0].state.connectedCount === 3, 'back to 3 players to start');
  active.find((p) => p.state.you.isHost).socket.emit('startGame');
  await sleep(300);
  check(lj[0].state.phase === 'PROMPT_SELECT', 'leave-test game started');
  const g1 = active.find((p) => p.state.you.role === 'guesser');
  const g1name = g1.state.you.username;
  g1.socket.emit('leaveSession'); // guesser abandons mid prompt-select
  await sleep(350);
  const remaining = active.filter((p) => p !== g1);
  check(remaining[0].state.phase === 'PROMPT_SELECT', 'round survives the guesser leaving');
  const g2 = remaining.find((p) => p.state.you.role === 'guesser');
  check(!!g2 && g2.state.you.username !== g1name, 'a new guesser took over the abandoned round');
  check(remaining[0].state.connectedCount === 2, 'player count dropped after guesser left');

  console.log('\n' + (failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`));
  [...players, ...lparty, pat, eve, cal2, badJoin].forEach((p) => p.socket.disconnect());
  server.kill();
  await sleep(200);
  process.exit(failures === 0 ? 0 : 1);
})();
