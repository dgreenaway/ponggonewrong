'use strict';

// ── Socket ────────────────────────────────────────────────────────────────────
const socket = io();

// ── State ─────────────────────────────────────────────────────────────────────
let myId = null;
let isHost = false;
let roomCode = null;
let players = [];
let config = {};
let boardConfig = null;
let playerAssignments = [];
let lastGameState = null;
let myPlayerIndex = -1;

// ── Audio Engine ──────────────────────────────────────────────────────────────
const Audio = (() => {
  let ctx = null;
  let musicGain, sfxGain;
  let musicMuted = false;
  let sfxMuted = false;
  let musicPlaying = false;
  let musicStep = 0;
  let musicOrigin = 0;
  let musicTimer = null;

  // A-minor pentatonic: A C D E G (across 3 octaves for arp + bass)
  const BPM = 128;
  const STEP = 60 / BPM / 4; // 16th note in seconds

  // 32-step pattern (2 bars of 4/4 in 16th notes)
  const ARP = [
    440, 523, 659, 523,  440, 392, 330, 392,
    440, 523, 659, 784,  880, 784, 659, 523,
    440, 523, 659, 523,  392, 330, 294, 330,
    392, 440, 523, 659,  523, 440, 392, 330,
  ];
  const BASS = [
    110,   0,   0,   0,  130,   0,   0,   0,
    165,   0,   0,   0,  110,   0,   0,   0,
    110,   0,   0,   0,  147,   0,   0,   0,
    196,   0,   0,   0,  165,   0,   0,   0,
  ];
  // 1 = kick, 2 = snare, 3 = both (unused), 0 = off
  const DRUM = [
    1, 0, 0, 0,  2, 0, 0, 0,  1, 0, 1, 0,  2, 0, 0, 0,
    1, 0, 0, 0,  2, 0, 0, 0,  1, 0, 1, 0,  2, 0, 1, 0,
  ];
  const HAT  = [
    1, 0, 1, 0,  1, 0, 1, 0,  1, 0, 1, 0,  1, 0, 1, 0,
    1, 0, 1, 0,  1, 0, 1, 0,  1, 0, 1, 0,  1, 0, 1, 0,
  ];

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Master chain: sfx and music into separate gains, both to destination
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.28;
    musicGain.connect(ctx.destination);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.9;
    sfxGain.connect(ctx.destination);
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  // ── Low-level synth helpers ─────────────────────────────────────────────────

  function osc(freq, type, startT, dur, peakGain, dest, freqEnd) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, startT);
    if (freqEnd !== undefined) o.frequency.exponentialRampToValueAtTime(freqEnd, startT + dur);
    g.gain.setValueAtTime(0.001, startT);
    g.gain.linearRampToValueAtTime(peakGain, startT + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, startT + dur);
    o.connect(g); g.connect(dest);
    o.start(startT); o.stop(startT + dur + 0.01);
  }

  function noise(startT, dur, peakGain, filterType, filterFreq, dest) {
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peakGain, startT);
    g.gain.exponentialRampToValueAtTime(0.001, startT + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(startT);
  }

  // ── Music sequencer ─────────────────────────────────────────────────────────

  function scheduleStep(step, t) {
    if (musicMuted) return;
    const arpFreq = ARP[step];
    const bassFreq = BASS[step];
    const drum = DRUM[step];
    const hat = HAT[step];

    // Arpeggio — square wave, short staccato
    if (arpFreq) osc(arpFreq, 'square', t, STEP * 0.7, 0.12, musicGain);

    // Bass — sawtooth, quarter-note length
    if (bassFreq) {
      osc(bassFreq, 'sawtooth', t, STEP * 3.6, 0.22, musicGain);
    }

    // Kick — sine sweep 150→30 Hz
    if (drum === 1 || drum === 3) {
      osc(150, 'sine', t, 0.18, 0.9, musicGain, 28);
    }

    // Snare — noise burst + mid tone
    if (drum === 2 || drum === 3) {
      noise(t, 0.12, 0.35, 'bandpass', 2200, musicGain);
      osc(220, 'triangle', t, 0.08, 0.2, musicGain);
    }

    // Hi-hat — high-pass noise, very short
    if (hat) noise(t, 0.04, 0.08, 'highpass', 8000, musicGain);
  }

  function scheduleBatch() {
    if (!musicPlaying || !ctx) return;
    const LOOKAHEAD = 0.25;
    const now = ctx.currentTime;
    const loopLen = ARP.length * STEP;

    while (true) {
      const stepTime = musicOrigin + musicStep * STEP;
      if (stepTime > now + LOOKAHEAD) break;
      scheduleStep(musicStep % ARP.length, stepTime);
      musicStep++;
    }

    musicTimer = setTimeout(scheduleBatch, 100);
  }

  function startMusic() {
    if (!ctx || musicPlaying) return;
    musicPlaying = true;
    musicStep = 0;
    musicOrigin = ctx.currentTime + 0.05;
    scheduleBatch();
  }

  function stopMusic() {
    musicPlaying = false;
    if (musicTimer) { clearTimeout(musicTimer); musicTimer = null; }
  }

  // ── Sound effects ───────────────────────────────────────────────────────────

  const PLAYER_FREQS = [440, 523, 659, 784, 587, 698];

  const sfx = {
    paddleHit(playerIndex = 0) {
      if (!ctx || sfxMuted) return;
      const freq = PLAYER_FREQS[playerIndex % PLAYER_FREQS.length];
      // Sharp transient square + noise burst = punchy thwack
      osc(freq * 2, 'square', ctx.currentTime, 0.07, 0.55, sfxGain);
      osc(freq, 'sawtooth', ctx.currentTime, 0.04, 0.25, sfxGain);
      noise(ctx.currentTime, 0.05, 0.18, 'bandpass', 1800, sfxGain);
    },

    wallBounce() {
      if (!ctx || sfxMuted) return;
      // Softer, higher sine — less intrusive than a paddle hit
      osc(900, 'sine', ctx.currentTime, 0.06, 0.25, sfxGain, 600);
    },

    pointScored() {
      if (!ctx || sfxMuted) return;
      // Three-note descending fall
      [440, 330, 220].forEach((freq, i) => {
        const t = ctx.currentTime + i * 0.11;
        osc(freq, 'sawtooth', t, 0.14, 0.45, sfxGain);
      });
      noise(ctx.currentTime, 0.08, 0.3, 'lowpass', 600, sfxGain);
    },

    modifierSpawned() {
      if (!ctx || sfxMuted) return;
      // Rising chime ping
      osc(800, 'sine', ctx.currentTime, 0.35, 0.28, sfxGain, 1600);
    },

    modifierActivated() {
      if (!ctx || sfxMuted) return;
      // Dramatic upward sweep then a punchy chord hit
      osc(200, 'sawtooth', ctx.currentTime, 0.18, 0.5, sfxGain, 900);
      [523, 659, 784].forEach((freq, i) => {
        const t = ctx.currentTime + 0.18 + i * 0.05;
        osc(freq, 'square', t, 0.2, 0.3, sfxGain);
      });
      noise(ctx.currentTime + 0.18, 0.12, 0.25, 'highpass', 2000, sfxGain);
    },

    gameOver(won) {
      if (!ctx || sfxMuted) return;
      if (won) {
        // Ascending victory fanfare
        [523, 659, 784, 1047].forEach((freq, i) => {
          const t = ctx.currentTime + i * 0.13;
          osc(freq, 'square', t, 0.28, 0.45, sfxGain);
        });
      } else {
        // Descending defeat sting
        [392, 311, 233].forEach((freq, i) => {
          const t = ctx.currentTime + i * 0.16;
          osc(freq, 'sawtooth', t, 0.28, 0.4, sfxGain);
        });
      }
    },
  };

  // ── Mute toggles ────────────────────────────────────────────────────────────

  function setMusicMuted(val) {
    musicMuted = val;
    // Fade rather than hard cut
    if (musicGain) {
      musicGain.gain.setTargetAtTime(val ? 0 : 0.28, ctx.currentTime, 0.08);
    }
    document.getElementById('btn-mute-music').classList.toggle('muted', val);
  }

  function setSfxMuted(val) {
    sfxMuted = val;
    document.getElementById('btn-mute-sfx').classList.toggle('muted', val);
  }

  return { init, resume, startMusic, stopMusic, setMusicMuted, setSfxMuted, sfx };
})();

// ── Audio control buttons ─────────────────────────────────────────────────────
document.getElementById('btn-mute-music').addEventListener('click', () => {
  Audio.init();
  Audio.setMusicMuted(!document.getElementById('btn-mute-music').classList.contains('muted'));
});
document.getElementById('btn-mute-sfx').addEventListener('click', () => {
  Audio.init();
  Audio.setSfxMuted(!document.getElementById('btn-mute-sfx').classList.contains('muted'));
});

// ── View management ───────────────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), duration);
}

// ── Landing ───────────────────────────────────────────────────────────────────
document.getElementById('btn-create').onclick = () => { Audio.init(); showView('view-create'); };
document.getElementById('btn-join-open').onclick = () => { Audio.init(); showView('view-join'); };
document.getElementById('btn-create-back').onclick = () => showView('view-landing');
document.getElementById('btn-join-back').onclick = () => showView('view-landing');

document.getElementById('btn-create-confirm').onclick = () => {
  const name = document.getElementById('create-name').value.trim() || 'Player';
  socket.emit('create_room', { playerName: name });
};
document.getElementById('create-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-create-confirm').click(); });

document.getElementById('btn-join-confirm').onclick = () => {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  const name = document.getElementById('join-name').value.trim() || 'Player';
  if (!code) return showToast('Enter a room code');
  socket.emit('join_room', { roomCode: code, playerName: name });
};
document.getElementById('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-join-confirm').click(); });
document.getElementById('join-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-join-confirm').click(); });

// ── Lobby helpers ─────────────────────────────────────────────────────────────
function renderPlayerList(playerArr) {
  const list = document.getElementById('player-list');
  list.innerHTML = '';
  playerArr.forEach(p => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.background = p.color;
    li.appendChild(dot);
    const name = document.createElement('span');
    name.textContent = p.name;
    li.appendChild(name);
    if (isHost && p.id !== myId) {
      const btn = document.createElement('button');
      btn.className = 'kick-btn';
      btn.textContent = 'Kick';
      btn.onclick = () => socket.emit('kick_player', { playerId: p.id });
      li.appendChild(btn);
    }
    li.dataset.pid = p.id;
    list.appendChild(li);
  });
  document.getElementById('player-count').textContent = `(${playerArr.length}/6)`;
}

function renderConfig(cfg) {
  const text = document.getElementById('config-display-text');
  if (text) {
    text.innerHTML = `
      Points to win: <b>${cfg.pointsToWin}</b><br>
      Ball speed: <b>${cfg.ballSpeed}</b><br>
      Paddle size: <b>${cfg.paddleSize}</b><br>
      Modifiers: <b>${cfg.modifiers ? 'On' : 'Off'}</b><br>
      Modifier frequency: <b>${cfg.modifierFrequency}</b><br>
      Multi-ball: <b>${cfg.multiBall ? 'On' : 'Off'}</b>
    `;
  }
}

function setupLobby(code, pid, playerArr, cfg, host) {
  roomCode = code;
  myId = pid;
  isHost = host;
  players = playerArr;
  config = cfg;

  document.getElementById('lobby-code').textContent = code;

  if (isHost) {
    document.getElementById('config-panel').classList.remove('lobby-section--hidden');
    document.getElementById('config-display').classList.add('lobby-section--hidden');
    document.getElementById('btn-start').classList.remove('lobby-section--hidden');
  } else {
    document.getElementById('config-panel').classList.add('lobby-section--hidden');
    document.getElementById('config-display').classList.remove('lobby-section--hidden');
    document.getElementById('btn-start').classList.add('lobby-section--hidden');
    renderConfig(cfg);
  }

  renderPlayerList(playerArr);
  updateStartButton(playerArr);
  buildModifierPicker(cfg.enabledModifiers ?? null);
  // Hide picker controls for non-hosts
  const pickerSection = document.getElementById('modifier-picker-section');
  if (pickerSection) pickerSection.style.opacity = isHost ? '1' : '0.5';
  showView('view-lobby');
}

function updateStartButton(playerArr) {
  const btn = document.getElementById('btn-start');
  btn.disabled = playerArr.length < 2;
  document.getElementById('waiting-msg').textContent =
    playerArr.length < 2 ? 'Waiting for at least 2 players...' : `${playerArr.length} player${playerArr.length > 1 ? 's' : ''} ready`;
}

document.getElementById('btn-copy-code').onclick = () => {
  navigator.clipboard?.writeText(roomCode).then(() => showToast('Room code copied!'));
};

document.getElementById('btn-start').onclick = () => {
  socket.emit('start_game');
};

// ── Config helpers ────────────────────────────────────────────────────────────
function readEnabledModifiers() {
  const btns = document.querySelectorAll('#modifier-picker-grid .modifier-toggle');
  if (!btns.length) return null; // picker not built yet
  const enabled = [];
  let allOn = true;
  btns.forEach(btn => {
    if (btn.classList.contains('on')) enabled.push(btn.dataset.type);
    else allOn = false;
  });
  return allOn ? null : enabled; // null = all enabled (compact wire format)
}

function emitConfig() {
  socket.emit('update_config', {
    pointsToWin:       document.getElementById('cfg-points').value,
    ballSpeed:         document.getElementById('cfg-speed').value,
    paddleSize:        document.getElementById('cfg-paddle').value,
    modifiers:         document.getElementById('cfg-modifiers').value === 'true',
    modifierFrequency: document.getElementById('cfg-freq').value,
    multiBall:         document.getElementById('cfg-multiball').value === 'true',
    enabledModifiers:  readEnabledModifiers(),
  });
}

// Config select controls
['cfg-points','cfg-speed','cfg-paddle','cfg-modifiers','cfg-freq','cfg-multiball'].forEach(id => {
  document.getElementById(id).addEventListener('change', emitConfig);
});

// ── Modifier picker ───────────────────────────────────────────────────────────
function buildModifierPicker(enabledModifiers) {
  const grid = document.getElementById('modifier-picker-grid');
  grid.innerHTML = '';
  ALL_MODIFIERS.forEach(mod => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.type = mod.type;
    // null = all on; array = only listed types are on
    const isOn = enabledModifiers === null || enabledModifiers.includes(mod.type);
    btn.className = 'modifier-toggle' + (isOn ? ' on' : '');
    btn.textContent = `${mod.emoji} ${mod.label}`;
    btn.addEventListener('click', () => {
      if (!isHost) return;
      btn.classList.toggle('on');
      emitConfig();
    });
    grid.appendChild(btn);
  });
}

function setAllModifierToggles(on) {
  document.querySelectorAll('#modifier-picker-grid .modifier-toggle').forEach(btn => {
    btn.classList.toggle('on', on);
  });
  emitConfig();
}

document.getElementById('btn-mod-all').addEventListener('click',  () => setAllModifierToggles(true));
document.getElementById('btn-mod-none').addEventListener('click', () => setAllModifierToggles(false));

// ── Socket events — lobby ─────────────────────────────────────────────────────
socket.on('room_created', ({ roomCode: code, playerId, config: cfg }) => {
  setupLobby(code, playerId, [{ id: playerId, name: document.getElementById('create-name').value.trim() || 'Player', color: '#00f0ff', index: 0 }], cfg, true);
});

socket.on('room_joined', ({ roomCode: code, playerId, players: pl, config: cfg }) => {
  setupLobby(code, playerId, pl, cfg, false);
});

socket.on('player_joined', ({ players: pl }) => {
  players = pl;
  renderPlayerList(pl);
  updateStartButton(pl);
});

socket.on('player_left', ({ players: pl, newHostId }) => {
  players = pl;
  if (newHostId === myId && !isHost) {
    isHost = true;
    document.getElementById('config-panel').classList.remove('lobby-section--hidden');
    document.getElementById('config-display').classList.add('lobby-section--hidden');
    document.getElementById('btn-start').classList.remove('lobby-section--hidden');
    showToast('You are now the host');
  }
  renderPlayerList(pl);
  updateStartButton(pl);
});

socket.on('config_updated', ({ config: cfg }) => {
  config = cfg;
  if (!isHost) {
    renderConfig(cfg);
    buildModifierPicker(cfg.enabledModifiers ?? null);
  }
});

socket.on('error', ({ message }) => showToast(message));

// ── Game start ────────────────────────────────────────────────────────────────
socket.on('game_started', ({ boardConfig: bc, playerAssignments: pa, config: cfg }) => {
  boardConfig = bc;
  playerAssignments = pa;
  config = cfg;
  myPlayerIndex = pa.findIndex(p => p.id === myId);
  initCanvas();
  showView('view-game');
  canvas.focus();
  Audio.init();
  Audio.resume();
  Audio.startMusic();
  startCountdown();
  startInputPoll();
});

function startCountdown() {
  const overlay = document.getElementById('countdown-overlay');
  const numEl   = document.getElementById('countdown-number');
  const steps   = ['3', '2', '1', 'GO!'];
  let i = 0;
  overlay.classList.remove('hidden');
  function showStep() {
    numEl.textContent = steps[i];
    // Force animation restart
    numEl.style.animation = 'none';
    void numEl.offsetWidth;
    numEl.style.animation = '';
    i++;
    if (i < steps.length) {
      setTimeout(showStep, 900);
    } else {
      setTimeout(() => overlay.classList.add('hidden'), 900);
    }
  }
  showStep();
}

// ── Canvas & Renderer ─────────────────────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

const PLAYER_COLORS = ['#00f0ff','#ff006e','#39ff14','#ff8c00','#bf00ff','#fff200'];

// Full modifier catalogue — mirrors MODIFIER_DEFS in game-logic.js
const ALL_MODIFIERS = [
  { type: 'speed_surge',      emoji: '🚀', label: 'Speed Surge'      },
  { type: 'slow_mo',          emoji: '🐌', label: 'Slow Mo'          },
  { type: 'tiny_paddles',     emoji: '🏓', label: 'Tiny Paddles'     },
  { type: 'mega_paddles',     emoji: '💪', label: 'Mega Paddles'     },
  { type: 'reverse_controls', emoji: '🔄', label: 'Reverse Controls' },
  { type: 'multi_ball',       emoji: '🎱', label: 'Multi-Ball'       },
  { type: 'chaos_ball',       emoji: '🌀', label: 'Chaos Ball'       },
  { type: 'ghost_ball',       emoji: '👻', label: 'Ghost Ball'       },
  { type: 'random_boost',     emoji: '⚡', label: 'Random Boost'     },
  { type: 'fireworks',        emoji: '🎆', label: 'Fireworks'        },
  { type: 'rotary',           emoji: '🌪️', label: 'Rotary'           },
  { type: 'nuclear',          emoji: '☢️',  label: 'Nuclear'          },
  { type: 'curve_ball',       emoji: '🪃', label: 'Curve Ball'       },
];

let particles = [];
let screenShake = { x: 0, y: 0, dur: 0 };
let flashAlpha = 0;
let flashColor = '#ffffff';
let scorePopups = [];
let renderState = null;
let fireworksWheelAngle = 0; // catherine wheel rotation accumulator

function initCanvas() {
  const size = Math.min(window.innerWidth, window.innerHeight, 820);
  canvas.width = size;
  canvas.height = size;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  scaleFactor = size / 800;
}

let scaleFactor = 1;
window.addEventListener('resize', () => { if (document.getElementById('view-game').classList.contains('active')) initCanvas(); });

// ── Input ─────────────────────────────────────────────────────────────────────
const keysDown = new Set();

window.addEventListener('keydown', e => {
  keysDown.add(e.key);
  sendPaddleInput();
  // Prevent arrow key scrolling
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' '].includes(e.key)) e.preventDefault();
});
window.addEventListener('keyup', e => {
  keysDown.delete(e.key);
  sendPaddleInput();
});
window.addEventListener('blur', () => {
  keysDown.clear();
  sendPaddleInput();
});

// Re-send input on a fixed interval so a dropped event or focus loss
// never permanently silences a player's controls.
let inputPollInterval = null;
function startInputPoll() {
  if (inputPollInterval) return;
  inputPollInterval = setInterval(sendPaddleInput, 100);
}
function stopInputPoll() {
  clearInterval(inputPollInterval);
  inputPollInterval = null;
}

function sendPaddleInput() {
  const left  = keysDown.has('ArrowLeft')  || keysDown.has('a') || keysDown.has('A');
  const right = keysDown.has('ArrowRight') || keysDown.has('d') || keysDown.has('D');

  let dir = 0;
  if (boardConfig && myPlayerIndex >= 0) {
    const mySide = boardConfig.sides.find(s => s.playerIndex === myPlayerIndex);
    if (mySide) {
      // Inward normal: vector from wall midpoint toward arena centre
      const cx = boardConfig.canvasSize / 2;
      const cy = boardConfig.canvasSize / 2;
      const mx = (mySide.p1.x + mySide.p2.x) / 2;
      const my = (mySide.p1.y + mySide.p2.y) / 2;
      const nd = Math.hypot(cx - mx, cy - my);
      const nx = (cx - mx) / nd;
      const ny = (cy - my) / nd;

      // Player's "right" = 90° clockwise from their facing direction (inward normal)
      // In screen coords (y-down): CW rotation of (nx,ny) = (-ny, nx)
      const prx = -ny, pry = nx;

      // Wall tangent (direction of increasing t)
      const dx = mySide.p2.x - mySide.p1.x;
      const dy = mySide.p2.y - mySide.p1.y;
      const tlen = Math.hypot(dx, dy);
      const tx = dx / tlen, ty = dy / tlen;

      // If tangent aligns with player-right, increasing t is rightward; otherwise flip
      const rightDir = (tx * prx + ty * pry) > 0 ? 1 : -1;
      dir = right ? rightDir : left ? -rightDir : 0;
    }
  }

  socket.emit('paddle_move', { direction: dir });
}

// ── Particles ─────────────────────────────────────────────────────────────────
function spawnParticles(x, y, color, count = 16) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 5;
    particles.push({
      x: x * scaleFactor, y: y * scaleFactor,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: 1, decay: 0.025 + Math.random() * 0.03,
      size: 2 + Math.random() * 4,
      color,
    });
  }
}

function spawnRingBurst(x, y, color, count = 28) {
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const speed = 3 + Math.random() * 6;
    particles.push({
      x: x * scaleFactor, y: y * scaleFactor,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: 1, decay: 0.018 + Math.random() * 0.02,
      size: 3 + Math.random() * 4,
      color,
    });
  }
}

function updateParticles() {
  particles = particles.filter(p => {
    p.x += p.vx; p.y += p.vy;
    p.vy += 0.08; // gravity
    p.life -= p.decay;
    return p.life > 0;
  });
}

function drawParticles() {
  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = p.life;
    ctx.shadowBlur = 8;
    ctx.shadowColor = p.color;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ── Score popups ──────────────────────────────────────────────────────────────
function addScorePopup(x, y, text, color) {
  scorePopups.push({ x: x * scaleFactor, y: y * scaleFactor, text, color, life: 1, vy: -2 });
}

function updateScorePopups() {
  scorePopups = scorePopups.filter(p => {
    p.y += p.vy; p.life -= 0.018;
    return p.life > 0;
  });
}

function drawScorePopups() {
  for (const p of scorePopups) {
    ctx.save();
    ctx.globalAlpha = p.life;
    ctx.font = `bold ${Math.round(36 * scaleFactor)}px 'Courier New', monospace`;
    ctx.fillStyle = p.color;
    ctx.shadowBlur = 16; ctx.shadowColor = p.color;
    ctx.textAlign = 'center';
    ctx.fillText(p.text, p.x, p.y);
    ctx.restore();
  }
}

// ── Screen shake ──────────────────────────────────────────────────────────────
function triggerShake(intensity = 8, duration = 300) {
  screenShake.dur = duration;
  screenShake._intensity = intensity;
  screenShake._start = performance.now();
}

function updateShake(now) {
  if (screenShake.dur <= 0) { screenShake.x = 0; screenShake.y = 0; return; }
  const elapsed = now - (screenShake._start || now);
  const progress = elapsed / (screenShake._start ? screenShake.dur : 1);
  const intensity = (screenShake._intensity || 8) * (1 - Math.min(1, progress));
  screenShake.x = (Math.random() - 0.5) * intensity;
  screenShake.y = (Math.random() - 0.5) * intensity;
  if (elapsed > screenShake.dur) { screenShake.dur = 0; screenShake.x = 0; screenShake.y = 0; }
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(now) {
  requestAnimationFrame(render);
  if (!boardConfig || !renderState) return;

  updateShake(now);
  updateParticles();
  updateScorePopups();

  ctx.save();
  ctx.translate(screenShake.x, screenShake.y);

  const s = scaleFactor;
  const mods = renderState?.activeModifiers ?? [];
  const rotaryActive = mods.some(m => m.type === 'rotary');
  const fireworksActive = mods.some(m => m.type === 'fireworks');

  // Background
  ctx.fillStyle = '#050510';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Flash effect
  if (flashAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = flashAlpha;
    ctx.fillStyle = flashColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    flashAlpha = Math.max(0, flashAlpha - 0.04);
  }

  // Rotary: rotate the entire board around canvas centre
  if (rotaryActive) {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const rotMod = mods.find(m => m.type === 'rotary');
    const elapsed = rotMod ? (rotMod.duration - rotMod.remaining) / 1000 : 0;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(elapsed * Math.PI * 0.5); // 90°/sec
    ctx.translate(-cx, -cy);
  }

  drawPolygon(s);
  drawPendingModifier(s);
  drawModifierCountdown(s);
  drawBalls(s);
  drawHUD(s);

  if (rotaryActive) ctx.restore();

  // Fireworks: catherine wheel particles from each ball
  if (fireworksActive && renderState?.balls) {
    fireworksWheelAngle += 0.22;
    const ARMS = 7;
    const COLORS = ['#00f0ff','#ff006e','#39ff14','#fff200','#bf00ff','#ff8c00'];
    renderState.balls.forEach(ball => {
      for (let arm = 0; arm < ARMS; arm++) {
        const angle = fireworksWheelAngle + (arm / ARMS) * Math.PI * 2;
        const speed = 2.5 + Math.random() * 3.5;
        particles.push({
          x: ball.x * s, y: ball.y * s,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          decay: 0.022 + Math.random() * 0.018,
          size: 2.5 + Math.random() * 2.5,
          color: COLORS[arm % COLORS.length],
        });
      }
    });
  }

  drawParticles();
  drawScorePopups();

  ctx.restore();
}

function scalePoint(p) {
  return { x: p.x * scaleFactor, y: p.y * scaleFactor };
}

// ── Draw polygon walls & paddles ──────────────────────────────────────────────
function drawPolygon(s) {
  if (!renderState || !boardConfig) return;
  const sides = boardConfig.sides;
  const paddles = renderState.paddles;

  sides.forEach((side, si) => {
    const p1 = scalePoint(side.p1);
    const p2 = scalePoint(side.p2);
    const pi = side.playerIndex;
    const color = pi >= 0 ? PLAYER_COLORS[pi] : '#334455';

    // Wall glow
    ctx.save();
    ctx.shadowBlur = pi >= 0 ? 18 : 8;
    ctx.shadowColor = color;
    ctx.strokeStyle = pi >= 0 ? color + '55' : '#223344';
    ctx.lineWidth = pi >= 0 ? 2 : 3;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.restore();
  });

  // Draw paddles
  for (const [pid, paddle] of Object.entries(paddles)) {
    const pi = paddle.playerIndex;
    const color = PLAYER_COLORS[pi] || '#ffffff';
    const a = scalePoint(paddle.a);
    const b = scalePoint(paddle.b);

    ctx.save();
    ctx.shadowBlur = 28;
    ctx.shadowColor = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 5 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    // Bright centre highlight
    ctx.shadowBlur = 6;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * s;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }
}

// ── Draw balls ────────────────────────────────────────────────────────────────
function drawBalls(s) {
  if (!renderState) return;
  renderState.balls.forEach(ball => {
    if (ball.ghost && Math.floor(Date.now() / 150) % 2 === 0) return;

    // Trail
    ball.trail.forEach((pt, i) => {
      const alpha = (i / ball.trail.length) * 0.5;
      const r = (2 + (i / ball.trail.length) * 5) * s;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.shadowBlur = 12;
      ctx.shadowColor = '#aaddff';
      ctx.beginPath();
      ctx.arc(pt.x * s, pt.y * s, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    // Ball
    ctx.save();
    ctx.shadowBlur = 24;
    ctx.shadowColor = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ball.x * s, ball.y * s, 8 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

// ── Draw HUD (names + scores around polygon) ──────────────────────────────────
function drawHUD(s) {
  if (!renderState || !playerAssignments.length) return;
  const sides = boardConfig.sides;
  const scores = renderState.scores;

  playerAssignments.forEach((player, i) => {
    // Find player's side
    let sideIndex = i;
    if (playerAssignments.length === 2) sideIndex = i === 0 ? 3 : 1;

    const side = sides[sideIndex];
    if (!side) return;

    const mx = (side.p1.x + side.p2.x) / 2 * s;
    const my = (side.p1.y + side.p2.y) / 2 * s;

    // Direction away from center
    const cx = 400 * s, cy = 400 * s;
    const dx = mx - cx, dy = my - cy;
    const len = Math.hypot(dx, dy);
    const outX = mx + (dx / len) * 38 * s;
    const outY = my + (dy / len) * 38 * s;

    const color = PLAYER_COLORS[i];
    const score = scores[player.id] || 0;
    const isMine = player.id === myId;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;

    // Score
    ctx.shadowBlur = 20;
    ctx.font = `bold ${Math.round(28 * s)}px 'Courier New', monospace`;
    ctx.fillStyle = color;
    ctx.fillText(score, outX, outY - 14 * s);

    // Name
    ctx.shadowBlur = 10;
    ctx.font = `${Math.round(11 * s)}px 'Courier New', monospace`;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = isMine ? '#ffffff' : color;
    ctx.fillText(isMine ? `[${player.name}]` : player.name, outX, outY + 14 * s);

    ctx.restore();
  });
}

// ── Draw pending modifier pickup ───────────────────────────────────────────────
function drawPendingModifier(s) {
  if (!renderState || !renderState.pendingModifier) return;
  const pm = renderState.pendingModifier;
  const x = pm.x * s, y = pm.y * s;
  const t = Date.now() / 1000;
  const pulse = 1 + 0.15 * Math.sin(t * 4);

  ctx.save();
  ctx.shadowBlur = 30 * pulse;
  ctx.shadowColor = var_yellow;

  // Ring
  ctx.strokeStyle = var_yellow;
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(x, y, 22 * s * pulse, 0, Math.PI * 2);
  ctx.stroke();

  // Emoji
  ctx.font = `${Math.round(22 * s)}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(pm.emoji, x, y);
  ctx.restore();
}

const var_yellow = '#fff200';

// ── Draw active modifier countdown ────────────────────────────────────────────
function drawModifierCountdown(s) {
  if (!renderState || !renderState.activeModifiers?.length) return;

  const cx = 400 * s, cy = 400 * s;
  renderState.activeModifiers.forEach((mod, idx) => {
    if (mod.duration === 0) return; // multi-ball no countdown

    const radius = (30 + idx * 8) * s;
    const progress = mod.remaining / mod.duration;

    ctx.save();
    // Background arc
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 4 * s;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Progress arc
    ctx.strokeStyle = var_yellow;
    ctx.shadowBlur = 12;
    ctx.shadowColor = var_yellow;
    ctx.lineWidth = 4 * s;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();

    // Emoji
    ctx.font = `${Math.round(18 * s)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(mod.emoji, cx, cy - radius);
    ctx.restore();
  });
}

// ── Socket events — game ──────────────────────────────────────────────────────
socket.on('game_state', (state) => {
  renderState = state;
});

socket.on('paddle_hit', ({ playerIndex, ballId }) => {
  Audio.sfx.paddleHit(playerIndex);
  if (!renderState) return;
  const ball = renderState.balls?.find(b => b.id === ballId);
  const color = PLAYER_COLORS[playerIndex] || '#ffffff';
  if (ball) spawnParticles(ball.x, ball.y, color, 12);
});

socket.on('wall_bounce', () => {
  Audio.sfx.wallBounce();
});

socket.on('point_scored', ({ scorerId, victimId, scores }) => {
  Audio.sfx.pointScored();
  triggerShake(10, 400);
  flashAlpha = 0.25;
  flashColor = '#ff004455';

  if (renderState) {
    // Find victim's side midpoint for explosion
    const victimIndex = playerAssignments.findIndex(p => p.id === victimId);
    const scorerIndex = playerAssignments.findIndex(p => p.id === scorerId);
    if (victimIndex >= 0) {
      let sideIndex = victimIndex;
      if (playerAssignments.length === 2) sideIndex = victimIndex === 0 ? 3 : 1;
      const side = boardConfig.sides[sideIndex];
      if (side) {
        const mx = (side.p1.x + side.p2.x) / 2;
        const my = (side.p1.y + side.p2.y) / 2;
        spawnParticles(mx, my, PLAYER_COLORS[victimIndex] || '#ff006e', 30);
      }
    }
    // Score popup for scorer
    if (scorerIndex >= 0) {
      let sideIndex = scorerIndex;
      if (playerAssignments.length === 2) sideIndex = scorerIndex === 0 ? 3 : 1;
      const side = boardConfig.sides[sideIndex];
      if (side) {
        const mx = (side.p1.x + side.p2.x) / 2;
        const my = (side.p1.y + side.p2.y) / 2;
        const newScore = scores[scorerId] || 0;
        addScorePopup(mx, my, '+1', PLAYER_COLORS[scorerIndex]);
      }
    }
  }
});

socket.on('modifier_spawned', () => {
  Audio.sfx.modifierSpawned();
});

socket.on('modifier_activated', ({ type, emoji, label, duration }) => {
  Audio.sfx.modifierActivated();
  flashAlpha = 0.4;
  flashColor = '#ffee0033';

  // Spawn ring burst at center
  spawnRingBurst(400, 400, var_yellow, 32);

  // Show banner
  const banner = document.getElementById('modifier-banner');
  banner.textContent = `${emoji}  ${label.toUpperCase()}`;
  banner.classList.remove('hidden');
  clearTimeout(modifier_banner_timer);
  modifier_banner_timer = setTimeout(() => banner.classList.add('hidden'), 2200);
});
let modifier_banner_timer = null;

socket.on('game_over', ({ winnerId, finalScores }) => {
  stopInputPoll();
  Audio.stopMusic();
  Audio.sfx.gameOver(winnerId === myId);
  clearTimeout(modifier_banner_timer);
  document.getElementById('modifier-banner').classList.add('hidden');

  const winner = playerAssignments.find(p => p.id === winnerId);
  const winColor = winner ? (PLAYER_COLORS[winner.index] || '#ffffff') : '#ffffff';

  const goName = document.getElementById('go-winner-name');
  goName.textContent = winner ? winner.name.toUpperCase() : 'DRAW';
  goName.style.color = winColor;
  goName.style.textShadow = `0 0 24px ${winColor}`;

  // Scores table
  const scoresEl = document.getElementById('go-scores');
  const sorted = playerAssignments.slice().sort((a, b) => (finalScores[b.id] || 0) - (finalScores[a.id] || 0));
  scoresEl.innerHTML = sorted.map(p =>
    `<div style="color:${PLAYER_COLORS[p.index] || '#fff'}">${p.name}: <b>${finalScores[p.id] || 0}</b></div>`
  ).join('');

  // Win celebration
  flashAlpha = 0.7;
  flashColor = winColor + '55';
  spawnRingBurst(400, 400, winColor, 60);

  showView('view-gameover');
});

socket.on('kicked', () => {
  roomCode = null;
  myId = null;
  isHost = false;
  players = [];
  showView('view-home');
  showToast('You were kicked from the lobby.');
});

socket.on('spectating', ({ roomCode: code, players: pl }) => {
  showToast('Joining as spectator — game in progress');
});

document.getElementById('btn-play-again').onclick = () => {
  particles = [];
  scorePopups = [];
  renderState = null;
  if (isHost) {
    showView('view-lobby');
  } else {
    showView('view-lobby');
  }
};

// ── Start render loop ─────────────────────────────────────────────────────────
requestAnimationFrame(render);

// ── Initial view ──────────────────────────────────────────────────────────────
showView('view-landing');
