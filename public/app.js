// LakeHouse Party Game — thin client. Renders per (role, phase) and emits actions.
(function () {
  const socket = io();
  const app = document.getElementById('app');
  const banner = document.getElementById('banner');
  const toast = document.getElementById('toast');

  // --- identity (survives refresh / phone sleep) ---
  let playerId = localStorage.getItem('lh_playerId');
  if (!playerId) {
    playerId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('lh_playerId', playerId);
  }
  let username = localStorage.getItem('lh_username') || '';
  let code = localStorage.getItem('lh_code') || ''; // current session code
  let state = null;
  let toastTimer = null;
  let mountedKey = null; // tracks which view is currently in the DOM

  function createSession() {
    socket.emit('createSession', { playerId, username });
  }
  function joinSession() {
    socket.emit('joinSession', { code, playerId, username });
  }

  socket.on('connect', () => {
    banner.classList.add('hidden');
    // Auto-rejoin only if we already belong to a session.
    if (username && code) joinSession();
  });
  socket.on('disconnect', () => {
    banner.textContent = '🔌 Reconnecting…';
    banner.classList.remove('hidden');
  });
  socket.on('errorMsg', (msg) => showToast(msg));
  // The session we tried to (re)join no longer exists — fall back to landing.
  socket.on('noSession', () => {
    code = '';
    localStorage.removeItem('lh_code');
    state = null;
    mountedKey = null;
    renderLanding();
  });
  socket.on('state', (s) => {
    state = s;
    // Persist the code the server assigned us (e.g. from createSession).
    if (s.code && s.code !== code) {
      code = s.code;
      localStorage.setItem('lh_code', code);
    }
    render();
  });

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
  }

  // ---------------------------------------------------------------- helpers
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function esc(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function clear() {
    app.innerHTML = '';
  }
  function mount(node) {
    clear();
    app.appendChild(node);
  }

  function playerChips(players) {
    return players
      .map((p) => {
        const dot = p.connected ? 'on' : 'off';
        const tags = [];
        if (p.isHost) tags.push('host');
        if (p.isGuesser) tags.push('🎯');
        if (p.isReader) tags.push('📖');
        return `<div class="chip"><span class="dot ${dot}"></span>${esc(p.username)}<span class="chip-score">${p.score}</span>${
          tags.length ? `<span class="chip-tags">${tags.join(' ')}</span>` : ''
        }</div>`;
      })
      .join('');
  }

  function header() {
    if (!state) return '';
    return `<div class="topbar">
      <div class="logo">🏕️ LakeHouse</div>
      ${state.phase !== 'LOBBY' && state.phase !== 'FINAL'
        ? `<div class="round-pill">Round ${state.roundNumber}/${state.totalRounds}</div>`
        : ''}
    </div>`;
  }

  // ---------------------------------------------------------------- screens
  // A stable key for "which screen am I looking at". When only background
  // data changes (e.g. someone else submits), the key stays the same and we
  // can skip rebuilding the response input so typed text + focus survive.
  function viewKey(s) {
    if (!s) return 'join';
    let key = s.phase + '|' + s.you.role;
    if (s.phase === 'RESPOND') key += '|sub:' + !!(s.round && s.round.youSubmitted);
    if (s.phase === 'READ') key += '|pass:' + (s.round && s.round.pass);
    return key;
  }

  function render() {
    if (!state) return renderLanding();
    const key = viewKey(state);
    // Don't tear down a responder's input screen on every broadcast — that's
    // what was wiping everyone's half-typed answers when one person submitted.
    if (
      key === mountedKey &&
      state.phase === 'RESPOND' &&
      state.you.role !== 'guesser' &&
      state.round &&
      !state.round.youSubmitted
    ) {
      return;
    }
    mountedKey = key;
    switch (state.phase) {
      case 'LOBBY': return renderLobby();
      case 'PROMPT_SELECT': return renderPromptSelect();
      case 'RESPOND': return renderRespond();
      case 'READ': return renderRead();
      case 'RESULTS': return renderResults();
      case 'FINAL': return renderFinal();
      default: return renderLanding();
    }
  }

  function renderLanding() {
    const node = el(`<section class="card join">
      <div class="hero">🌅</div>
      <h1>LakeHouse<br/>Party Game</h1>
      <p class="sub">Best worst answers win. Grab a name, then start or join a game.</p>
      <input id="name" class="input" maxlength="24" placeholder="Your name" value="${esc(username)}" />
      <button id="create" class="btn primary big">Create a game 🔥</button>
      <div class="or-divider"><span>or join with a code</span></div>
      <input id="code" class="input code-input" inputmode="numeric" maxlength="4" placeholder="4-digit code" value="${esc(code)}" />
      <button id="join" class="btn big">Join game →</button>
    </section>`);
    mount(node);
    const name = node.querySelector('#name');
    const codeInput = node.querySelector('#code');
    name.focus();

    const ensureName = () => {
      const v = name.value.trim();
      if (!v) { showToast('Enter a name first 🙂'); return null; }
      username = v.slice(0, 24);
      localStorage.setItem('lh_username', username);
      return username;
    };

    node.querySelector('#create').onclick = () => {
      if (!ensureName()) return;
      createSession();
    };
    node.querySelector('#join').onclick = () => {
      if (!ensureName()) return;
      const c = codeInput.value.trim();
      if (!/^\d{4}$/.test(c)) return showToast('Enter the 4-digit code 🔢');
      code = c;
      joinSession();
    };
    codeInput.onkeydown = (e) => { if (e.key === 'Enter') node.querySelector('#join').click(); };
  }

  function renderLobby() {
    const me = state.you;
    const enough = state.connectedCount >= 3;
    const node = el(`<section class="card">
      ${header()}
      <div class="code-banner">
        <div class="code-label">Game code — share it</div>
        <div class="code-big">${esc(state.code)}</div>
      </div>
      <h2>The lobby 🛶</h2>
      <p class="sub">${state.connectedCount} ${state.connectedCount === 1 ? 'player' : 'players'} around the fire${
        enough ? '' : ' — need 3+ to start'}</p>
      <div class="chips">${playerChips(state.players)}</div>
      ${me.isHost
        ? `<button id="start" class="btn primary big" ${enough ? '' : 'disabled'}>Start game 🔥</button>
           <p class="hint">${enough ? 'Best with 4+ players.' : 'Waiting for more phones to join…'}</p>`
        : `<p class="hint">Waiting for the host to start…</p>`}
    </section>`);
    mount(node);
    if (me.isHost) node.querySelector('#start').onclick = () => socket.emit('startGame');
  }

  function renderPromptSelect() {
    const me = state.you;
    if (me.role === 'guesser') {
      const choices = (state.round.promptChoices || [])
        .map((c) => `<button class="btn choice" data-id="${c.id}">${esc(c.text)}</button>`)
        .join('');
      const node = el(`<section class="card">
        ${header()}
        <div class="role-tag guesser">🎯 You're the guesser</div>
        <h2>Pick a prompt</h2>
        <p class="sub">Everyone else answers it. You'll guess who wrote what.</p>
        <div class="choices">${choices}</div>
      </section>`);
      mount(node);
      node.querySelectorAll('.choice').forEach((b) => {
        b.onclick = () => socket.emit('selectPrompt', { promptId: Number(b.dataset.id) });
      });
    } else {
      mount(waitCard(`🎯 ${esc(state.guesserName)} is picking a prompt…`, 'Get your wit ready.'));
    }
  }

  function renderRespond() {
    const me = state.you;
    const r = state.round;
    if (me.role === 'guesser') {
      mount(waitCard(`✍️ Everyone's writing answers`, `${r.submittedCount}/${r.totalResponders} submitted to your prompt`, true));
      return;
    }
    if (r.youSubmitted) {
      mount(waitCard('✅ Answer locked in', `Waiting for the rest… ${r.submittedCount}/${r.totalResponders}`, true));
      return;
    }
    const roleTag = me.role === 'reader'
      ? `<div class="role-tag reader">📖 You're the reader — write one too, then read them aloud</div>`
      : '';
    const node = el(`<section class="card">
      ${header()}
      ${roleTag}
      <div class="prompt-box">${esc(r.prompt)}</div>
      <textarea id="resp" class="input area" maxlength="240" placeholder="Your best worst answer…"></textarea>
      <button id="send" class="btn primary big">Submit answer →</button>
    </section>`);
    mount(node);
    const ta = node.querySelector('#resp');
    ta.focus();
    node.querySelector('#send').onclick = () => {
      const v = ta.value.trim();
      if (!v) return showToast('Type something first ✍️');
      socket.emit('submitResponse', { text: v });
    };
  }

  function renderRead() {
    const me = state.you;
    const r = state.round;
    if (me.role === 'reader') return renderReader();
    if (me.role === 'guesser') {
      mount(waitCard('🗣️ Make your guesses out loud', 'The reader reads each answer — say who you think wrote it. They\'ll mark you right or wrong.'));
      return;
    }
    mount(waitCard('📖 The reader is reading…', 'Listen in and enjoy the chaos.'));
  }

  function renderReader() {
    const r = state.round;
    const list = (r.responses || [])
      .map((resp, i) => {
        if (r.pass === 'read') {
          return `<div class="resp-card"><div class="resp-num">${i + 1}</div>
            <div class="resp-text">${esc(resp.text)}</div>
            <div class="resp-author">— ${esc(resp.authorName)}</div></div>`;
        }
        const done = resp.judged !== null;
        const cls = done ? (resp.judged ? 'judged-yes' : 'judged-no') : '';
        return `<div class="resp-card ${cls}"><div class="resp-num">${i + 1}</div>
          <div class="resp-text">${esc(resp.text)}</div>
          <div class="resp-author">— ${esc(resp.authorName)}</div>
          <div class="judge-row">
            <button class="btn yes" data-id="${resp.id}" data-correct="1" ${done ? 'disabled' : ''}>✓ Right</button>
            <button class="btn no" data-id="${resp.id}" data-correct="0" ${done ? 'disabled' : ''}>✗ Wrong</button>
          </div></div>`;
      })
      .join('');

    const node = el(`<section class="card">
      ${header()}
      <div class="role-tag reader">📖 You're the reader (only you see who wrote what)</div>
      ${r.pass === 'read'
        ? `<h2>Read all answers aloud</h2><p class="sub">Go through the list once so everyone hears the options.</p>`
        : `<h2>Now ${esc(state.guesserName)} guesses</h2><p class="sub">Read each again — tap Right/Wrong on their guess. ${r.judgedCount}/${r.responses.length} done</p>`}
      <div class="resp-list">${list}</div>
      ${r.pass === 'read'
        ? `<button id="begin" class="btn primary big">Done reading — start guessing 🎯</button>`
        : ''}
    </section>`);
    mount(node);
    if (r.pass === 'read') {
      node.querySelector('#begin').onclick = () => socket.emit('beginGuessing');
    } else {
      node.querySelectorAll('.judge-row .btn').forEach((b) => {
        b.onclick = () => socket.emit('judge', { responseId: b.dataset.id, correct: b.dataset.correct === '1' });
      });
    }
  }

  function renderResults() {
    const r = state.round;
    const reveal = (r.reveal || [])
      .map((x) => `<div class="resp-card ${x.correct ? 'judged-yes' : 'judged-no'}">
        <div class="resp-text">${esc(x.text)}</div>
        <div class="resp-author">— ${esc(x.authorName)} ${x.correct ? '✓ guessed!' : '✗ missed'}</div>
      </div>`)
      .join('');
    const isLastRound = state.roundNumber >= state.totalRounds;
    const node = el(`<section class="card">
      ${header()}
      <h2>${esc(state.guesserName)} scored ${r.correctCount}/${(r.reveal || []).length} 🎯</h2>
      <p class="sub">Here's who wrote what:</p>
      <div class="resp-list">${reveal}</div>
      <div class="chips small">${playerChips(state.players)}</div>
      <button id="next" class="btn primary big">${isLastRound ? 'See final results 🏆' : 'Next round →'}</button>
    </section>`);
    mount(node);
    node.querySelector('#next').onclick = () => socket.emit('nextRound');
  }

  function renderFinal() {
    const ranking = state.finalRanking || [];
    const medals = ['🥇', '🥈', '🥉'];
    const rows = ranking
      .map((p, i) => `<div class="rank-row ${i === 0 ? 'winner' : ''}">
        <span class="rank-medal">${medals[i] || i + 1}</span>
        <span class="rank-name">${esc(p.username)}</span>
        <span class="rank-score">${p.score}</span>
      </div>`)
      .join('');
    const node = el(`<section class="card">
      ${header()}
      <div class="hero">🏆</div>
      <h1>${esc((ranking[0] || {}).username || 'Nobody')} wins!</h1>
      <div class="ranking">${rows}</div>
      <button id="again" class="btn primary big">Play again 🔄</button>
      <p class="hint">Anyone can start a new game — sends everyone back to the lobby.</p>
    </section>`);
    mount(node);
    node.querySelector('#again').onclick = () => socket.emit('playAgain');
  }

  function waitCard(title, sub, showHeader) {
    return el(`<section class="card center">
      ${showHeader ? header() : ''}
      <div class="spinner">🌊</div>
      <h2>${title}</h2>
      <p class="sub">${sub}</p>
    </section>`);
  }

  // initial paint — if we already have a session, the connect handler rejoins
  // it and a state event will paint. Otherwise show the landing screen now.
  if (!(username && code)) {
    renderLanding();
  }
})();
