# LakeHouse Party Game Implementation Plan

> **For agentic workers:** Lean plan optimized for build speed (timed demo). Verification is by running the server and playing through phases in multiple browser tabs, not unit tests.

**Goal:** A locally-hosted, phone-joined "best-worst" party game that runs the full guesser/reader/responder loop offline on local wifi.

**Architecture:** Authoritative Node + Socket.io server holds all game state in memory and broadcasts per-player views; thin vanilla-JS phone clients render `(role, phase, state)` and emit actions. Socket.io serves its own client → no CDN, fully offline.

**Tech Stack:** Node, Express, Socket.io (server) · vanilla HTML/CSS/JS (client). No build step.

---

## File Structure

- `package.json` — deps (express, socket.io), `start` script.
- `server.js` — Express static serving + Socket.io + authoritative game engine + 50 prompts.
- `public/index.html` — single page shell, loads socket.io client + app.js.
- `public/style.css` — lake-house theme, phone-first layout.
- `public/app.js` — connection, localStorage playerId, per-phase render + action emitters.
- `README.md` — how to run + find your IP.

---

### Task 1: Project scaffold

- [ ] Create `package.json` with `express` + `socket.io` deps and `"start": "node server.js"`.
- [ ] Run `npm install`.
- [ ] Create minimal `server.js`: Express serving `public/`, Socket.io attached, listening on `0.0.0.0:3000` logging the URL.
- [ ] Create empty `public/index.html`, `public/style.css`, `public/app.js`.
- [ ] Verify: `npm start`, open `http://localhost:3000`, page loads with no console errors.

### Task 2: Game engine (server state machine)

In `server.js`. Single in-memory `game` object. No persistence.

- [ ] Define `PROMPTS` = array of 50 "best-worst" prompt strings.
- [ ] Define `game` state: `phase` (`LOBBY|PROMPT_SELECT|RESPOND|READ|RESULTS|FINAL`), `players` (array of `{playerId, username, socketId, connected, score}` in join order), `hostId`, `guesserIndex`, `usedPrompts` set, and round object `{prompt, promptChoices, readerId, responses:[{id,authorId,text}], judged:{responseId:bool}, order:[responseId]}`.
- [ ] Helper `currentGuesser()` = `players[guesserIndex]`; `currentReader()` = next *connected* player after guesser in order.
- [ ] Helper `buildStateFor(player)` → tailored view: public `{phase, players:[{username,score,connected,isHost}], you:{role, ...}, round:{prompt, submittedCount, totalResponders, ...}}`. **Only the reader's view includes `responses` with `authorId`/author username.** Guesser never receives authorship; responders never receive others' responses.
- [ ] Helper `broadcast()` → emit tailored `state` to each connected socket.
- [ ] Role for a player = `guesser` if currentGuesser, `reader` if currentReader, else `responder` (responders = everyone except guesser).

### Task 3: Lobby + join + reconnection

- [ ] On `connection`, wait for `join {playerId, username}`.
- [ ] If `playerId` matches an existing player → update `socketId`, mark `connected=true` (reconnect). Else push new player; first ever player becomes `hostId`.
- [ ] Reject new joins (not reconnects) once `phase !== LOBBY` with an error event; allow reconnects anytime.
- [ ] On `disconnect`, mark player `connected=false` (keep slot for reconnect). Recompute reader if the disconnected player was reader.
- [ ] `startGame` (host only, LOBBY, ≥3 connected) → set `guesserIndex=0`, enter PROMPT_SELECT, deal prompts (Task 4).
- [ ] `broadcast()` after every state change.

### Task 4: Prompt selection

- [ ] Entering PROMPT_SELECT: pick 3 random unused prompts → `round.promptChoices` (store as `[{id,text}]`), do **not** mark used yet.
- [ ] `selectPrompt {promptId}` (guesser only) → set `round.prompt`, mark it used, clear choices, init `round.responses=[]`, enter RESPOND, broadcast.

### Task 5: Responses

- [ ] Responders = all connected players except guesser (reader included). Compute `totalResponders`.
- [ ] `submitResponse {text}` (responder only, not yet submitted) → push `{id, authorId, text}` to `round.responses`, broadcast (guesser sees submitted count tick up).
- [ ] When `responses.length === totalResponders` → shuffle into `round.order`, enter READ, broadcast.

### Task 6: Read & judge

- [ ] Reader view (READ): list responses in `round.order` **with author usernames**; a `pass` flag (`read` → `guess`) toggled by reader via `beginGuessing` event.
- [ ] `judge {responseId, correct}` (reader only, pass=guess) → record `round.judged[responseId]=correct`, broadcast.
- [ ] When every response in `order` is judged → tally: guesser `score += count(correct)`; enter RESULTS, broadcast.
- [ ] Guesser view during READ: "say your guesses aloud" + remaining count. Others: "reader is reading…".

### Task 7: Results + round loop + final

- [ ] RESULTS view: every response with text, true author username, and ✓/✗; show updated scores.
- [ ] `nextRound` (host or guesser) → `guesserIndex++`. If `guesserIndex >= players.length` → enter FINAL. Else reset round, recompute reader, enter PROMPT_SELECT (deal new prompts), broadcast.
- [ ] FINAL view: players ranked by score; `playAgain` (host) → reset scores/usedPrompts/guesserIndex, back to LOBBY (keep players), broadcast.

### Task 8: Client app.js

- [ ] On load: get/create `playerId` in `localStorage`; if a stored `username` exists, auto-`join`; else show username form that emits `join` and stores username.
- [ ] `socket.on('state')` → stash state, call `render()`.
- [ ] `render()` switch on `state.phase` + `state.you.role`, building the right screen and wiring action buttons (`startGame`, `selectPrompt`, `submitResponse`, `beginGuessing`, `judge`, `nextRound`, `playAgain`).
- [ ] Show connection banner on disconnect/reconnect. Handle `errorMsg` events with a visible toast.

### Task 9: Theme + polish (style.css + index.html)

- [ ] Lake-house palette: cedar browns, dusk teal/deep blue, sunset gold accents; subtle pine/water motif via CSS gradients + emoji (🌲🛶🌅🪿).
- [ ] Phone-first: large tap targets (min 48px), readable type, single-column, sticky action buttons.
- [ ] Lobby player list with connection dots; scoreboard styling; smooth phase transitions.

### Task 10: README + run verification

- [ ] `README.md`: `npm install` → `npm start`; how to find host LAN IP (`ipconfig` on Windows); allow port 3000 through firewall; phones open `http://<IP>:3000`.
- [ ] End-to-end check: open 4 browser tabs, play a full 4-player round through to FINAL; verify only reader sees authors, scores tally, reconnect works (refresh a tab mid-round).

---

## Self-Review Notes

- Spec coverage: lobby, prompt select (3 choices), responders=all-but-guesser, private reader view, two-pass read with yes/no, guesser scoring +1, rotation until all guessed, final scoreboard, reconnection, offline socket.io client, 50 prompts, theme — all mapped to tasks 1–10.
- Naming locked: events `join/startGame/selectPrompt/submitResponse/beginGuessing/judge/nextRound/playAgain`; phases `LOBBY/PROMPT_SELECT/RESPOND/READ/RESULTS/FINAL`.
- Risk: 3-player thinness flagged in lobby UI (Task 9 scoreboard/lobby copy).
