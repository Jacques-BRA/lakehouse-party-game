# LakeHouse Party Game — Design Spec

**Date:** 2026-06-14
**Goal:** A locally-hosted, phone-joined party game for a lake house crowd. Demo showcase — built fast, looks great, works offline on local wifi.

## Summary

Players join from their phones via the host's local IP (`http://<host-IP>:3000`) and enter a username. The game is a "best-worst" prompt party game: each round a **guesser** picks a prompt, the other players write responses, a **reader** privately judges, and the guesser tries to name who wrote each response. Everyone is the guesser exactly once; highest score wins.

## Constraints & Principles

- **Local only, no cloud, no database.** State lives in server memory.
- **Offline-capable.** No CDN dependencies — Socket.io serves its own client. Must work on flaky lake wifi with no internet.
- **Phone-first.** Big tap targets, no shared screen required; the reader sees private info on their own phone.
- **Lean MVP.** Full game loop end-to-end, themed and polished-looking, no non-essential extras.
- **Needs 3+ players** (4+ recommended — with 3, the guesser only sees 2 responses).

## Architecture

- **Single `server.js`** — Node + Express + Socket.io.
  - Serves the static frontend (`/public`).
  - Relays real-time game state over WebSockets.
  - Socket.io ships its own client at `/socket.io/socket.io.js` → zero CDN, fully offline.
- **Server is authoritative.** It owns all game state and broadcasts it. Phones are thin clients: they render a view from `(myRole, phase, state)` and emit actions. No client-side game logic that could desync or cheat.
- **Frontend:** vanilla JS + HTML/CSS, no build step. A single-page app that re-renders the whole view whenever server state changes.

## Identity & Reconnection

- On join, the phone generates/stores a `playerId` in `localStorage` and sends it on connect.
- If a phone sleeps, refreshes, or drops, it silently rejoins its same player slot using `playerId`.
- Players are tracked by `playerId`, not socket id (sockets change on reconnect).
- This is **demo-critical** — phones sleep constantly.

## Roles (per round)

- **Guesser** — rotates; every player is guesser exactly once. Picks the prompt, then guesses authors.
- **Reader** — auto-assigned to the next player in seating order after the guesser. Privately sees all responses *with* true authors and marks the guesser right/wrong.
- **Responders** — everyone except the guesser (this **includes the reader**). Each writes exactly one response.

## State Machine (server-driven phases)

1. **LOBBY**
   - Players enter a username. First player to join is **host**.
   - Host sees a **Start Game** button, enabled once ≥3 players have joined.
   - Round order = join order. `guesserIndex` starts at 0.

2. **PROMPT_SELECT**
   - Guesser is shown **3 random unused prompts**; picks one.
   - Selected prompt is locked for the round; the other two return to the pool.
   - Everyone else sees a "waiting for guesser to pick" screen.

3. **RESPOND**
   - The chosen prompt is shown to all **responders** (everyone except the guesser).
   - Each responder writes and submits **one** response.
   - Guesser sees a waiting screen with a live "X of Y submitted" indicator.
   - When all responders have submitted → advance.

4. **READ**
   - The **reader's** phone shows all responses **with true authors**, in shuffled display order.
   - **Pass 1 (read-through):** reader reads each response aloud; no buttons yet (just a "Start guessing" control).
   - **Pass 2 (guessing):** each response shows **Yes / No** buttons. Guesser says a name aloud; reader taps Yes (correct) or No (wrong). Only right/wrong is recorded — never the guessed name.
   - Non-reader, non-guesser players see a "reader is reading…" waiting screen. Guesser sees a "make your guesses aloud" screen.
   - When all responses are judged → advance.

5. **RESULTS (round)**
   - Reveal each response, its **true author**, and whether the guesser got it right.
   - **Guesser scores +1 per correct guess.** No one else scores this round.
   - Host (or guesser) taps **Next Round**.

6. **Loop / FINAL**
   - `guesserIndex++`; reader = next player after the new guesser.
   - Repeat from PROMPT_SELECT until every player has been guesser once.
   - Then show the **FINAL scoreboard** (ranked by total points) with a **Play Again** option.

## Scoring

- Only the guesser scores in a given round: **+1 per response whose author they correctly identified.**
- Each player is guesser exactly once → one scoring round each.
- Final leaderboard = total points, descending.

## Content

- **50 seeded "best-worst" prompts** in a server-side array, e.g.:
  - "The worst superpower to discover while in a job interview"
  - "A comment guaranteed to kill the mood"
  - "The best worst slogan for a funeral home"
- Prompts are drawn without repeats within a game (tracked by a used set).

## Theme

Lake house aesthetic:
- Warm cedar/wood tones, dusk-water teals and deep blues, sunset gold accents.
- Cabin/loon/canoe/pine motifs (subtle, via CSS/emoji/SVG — no heavy assets).
- Large, thumb-friendly tap targets; readable outdoors.

## Socket Events (sketch)

**Client → Server:**
- `join { playerId, username }`
- `startGame`
- `selectPrompt { promptId }`
- `submitResponse { text }`
- `judge { responseId, correct: boolean }`
- `nextRound`
- `playAgain`

**Server → Client:**
- `state { phase, players, scores, you: { role, ... }, round: {...} }` — full per-player view; the server tailors `you`/private data so only the reader receives authorship.

## Out of Scope (MVP)

- Sound effects, animations beyond simple CSS transitions, avatars.
- Persistence across server restart.
- Spectator mode, custom prompt entry, configurable scoring.

## Open Risks

- 3-player games are thin (guesser sees only 2 responses) — acceptable, flagged in lobby.
- Everyone must be on the same local network and able to reach the host IP (firewall may need to allow the port).
