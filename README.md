# 🏕️ LakeHouse Party Game

A locally-hosted party game everyone joins from their phones. Best worst answers win.
No cloud, no database — runs entirely on your laptop over the local wifi (works offline).

## How to play

1. Everyone joins from their phone and picks a name.
2. Each round one player is the **guesser** — they pick a prompt; everyone else writes a funny answer.
3. The **reader** (their phone privately shows who wrote what) reads all answers aloud.
4. On the second read-through, the guesser says who they think wrote each answer; the reader taps ✓/✗.
5. The guesser scores 1 point per correct guess. Everyone is the guesser once. Highest score wins. 🏆

Best with **4+ players** (works with 3).

## Run it

```bash
npm install
npm start
```

The server prints URLs, e.g.:

```
On this machine:  http://localhost:3000
On phones (wifi): http://192.168.1.23:3000
```

Share the **phone URL** with everyone on the same wifi.

### Find your IP manually (Windows)

```powershell
ipconfig
```

Look for the `IPv4 Address` under your active wifi adapter, then use `http://<that-ip>:3000`.

### If phones can't connect

Allow Node through the Windows firewall for port **3000** (Windows usually prompts on first run — click *Allow access* on Private networks). Make sure every phone is on the **same wifi** as the laptop.

## Tech

- `server.js` — Node + Express + Socket.io. Authoritative game state in memory; Socket.io serves its own client locally (no CDN).
- `public/` — vanilla HTML/CSS/JS thin client, no build step.
