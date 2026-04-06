'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────
const CANVAS_SIZE = 800;
const CENTER = CANVAS_SIZE / 2;
const POLYGON_RADIUS = 352;
const BALL_RADIUS = 8;
const BASE_BALL_SPEED = 4.5;
const TICK_RATE = 60;

const PLAYER_COLORS = [
  '#00f0ff', // Electric Blue
  '#ff006e', // Hot Pink
  '#39ff14', // Acid Green
  '#ff8c00', // Solar Orange
  '#bf00ff', // Laser Purple
  '#fff200', // Cyber Yellow
];

const SHAPE_NAMES = { 2: 'Rectangle', 3: 'Triangle', 4: 'Square', 5: 'Pentagon', 6: 'Hexagon' };

// ─── Geometry helpers ────────────────────────────────────────────────────────
function getPolygonVertices(sides, radius, cx, cy) {
  // For 2-player (rectangle), use classic left/right layout
  if (sides === 2) {
    const hw = radius * 0.75;
    const hh = radius * 0.6;
    return [
      { x: cx - hw, y: cy - hh },
      { x: cx + hw, y: cy - hh },
      { x: cx + hw, y: cy + hh },
      { x: cx - hw, y: cy + hh },
    ];
  }
  const verts = [];
  const offset = -Math.PI / 2; // start from top
  for (let i = 0; i < sides; i++) {
    const angle = offset + (2 * Math.PI * i) / sides;
    verts.push({
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  }
  return verts;
}

// Returns array of sides: { p1, p2, normal (inward), playerIndex (-1 = wall), length, midpoint, angle }
function buildSides(playerCount) {
  let sides;
  let verts;

  if (playerCount === 2) {
    // Rectangle: sides 0=top(wall), 1=right(p1), 2=bottom(wall), 3=left(p0)
    verts = getPolygonVertices(2, POLYGON_RADIUS, CENTER, CENTER);
    sides = [];
    for (let i = 0; i < 4; i++) {
      const p1 = verts[i];
      const p2 = verts[(i + 1) % 4];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      // Inward normal points toward center
      const nx = (CENTER - mx) / Math.hypot(CENTER - mx, CENTER - my);
      const ny = (CENTER - my) / Math.hypot(CENTER - mx, CENTER - my);
      const angle = Math.atan2(dy, dx);
      // Player assignments for rectangle: 3=left=player0, 1=right=player1, 0&2=walls
      const playerIndex = i === 3 ? 0 : i === 1 ? 1 : -1;
      sides.push({ p1, p2, normal: { x: nx, y: ny }, playerIndex, length: len, midpoint: { x: mx, y: my }, angle });
    }
    return sides;
  }

  verts = getPolygonVertices(playerCount, POLYGON_RADIUS, CENTER, CENTER);
  sides = [];
  for (let i = 0; i < playerCount; i++) {
    const p1 = verts[i];
    const p2 = verts[(i + 1) % playerCount];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const nx = (CENTER - mx) / Math.hypot(CENTER - mx, CENTER - my);
    const ny = (CENTER - my) / Math.hypot(CENTER - mx, CENTER - my);
    const angle = Math.atan2(dy, dx);
    sides.push({ p1, p2, normal: { x: nx, y: ny }, playerIndex: i, length: len, midpoint: { x: mx, y: my }, angle });
  }
  return sides;
}

// ─── Paddle helpers ──────────────────────────────────────────────────────────
function getPaddleLength(config) {
  const sizes = { Small: 60, Normal: 90, Large: 130 };
  return sizes[config.paddleSize] || 90;
}

function getPaddleSpeed() {
  return 5;
}

// Paddle position stored as t ∈ [0,1] along the side
function createPaddle(sideIndex, playerIndex) {
  return {
    sideIndex,
    playerIndex,
    t: 0.5,
    input: 0, // -1, 0, 1
    boosted: false,
  };
}

// Returns the world-space endpoints of a paddle
function paddleEndpoints(paddle, side, paddleLen) {
  const { p1, p2, length } = side;
  const half = paddleLen / 2 / length;
  const tMin = half;
  const tMax = 1 - half;
  const tc = Math.max(tMin, Math.min(tMax, paddle.t));
  const t1 = tc - half;
  const t2 = tc + half;
  return {
    a: { x: p1.x + (p2.x - p1.x) * t1, y: p1.y + (p2.y - p1.y) * t1 },
    b: { x: p1.x + (p2.x - p1.x) * t2, y: p1.y + (p2.y - p1.y) * t2 },
    tc,
  };
}

// ─── Collision ───────────────────────────────────────────────────────────────
// Swept-circle vs wall segment.
// Finds the earliest time t ∈ [0,1] at which the moving ball surface touches
// the wall. Returns { t, tSeg } or null.
//   t    — fraction of velocity step at which collision occurs
//   tSeg — position along the wall segment [0,1] where contact is made
function sweepCircleVsSegment(bx, by, vx, vy, r, side) {
  const nx = side.normal.x;
  const ny = side.normal.y;

  // Signed distance from ball centre to the wall plane (positive = inside arena)
  const d0 = (bx - side.p1.x) * nx + (by - side.p1.y) * ny;

  // Component of velocity along the inward normal (negative = moving toward wall)
  const vn = vx * nx + vy * ny;
  if (vn >= 0) return null; // moving away from or parallel to wall

  // Time when ball surface reaches the wall: d0 + t*vn = r  =>  t = (r - d0) / vn
  const t = (r - d0) / vn;
  if (t < -0.001 || t > 1.001) return null;
  const tClamped = Math.max(0, t);

  // Ball centre position at collision
  const cx = bx + vx * tClamped;
  const cy = by + vy * tClamped;

  // Contact point on the wall surface (ball centre minus inward-normal offset)
  const wx = cx - r * nx;
  const wy = cy - r * ny;

  // Project contact point onto segment to confirm it lies within the wall.
  // Tolerance is BALL_RADIUS / side_length so corner vertices are never missed
  // regardless of polygon shape (fixed 0.02 was too small for hexagons/pentagons).
  const sdx = side.p2.x - side.p1.x;
  const sdy = side.p2.y - side.p1.y;
  const lenSq = sdx * sdx + sdy * sdy;
  const tSeg = ((wx - side.p1.x) * sdx + (wy - side.p1.y) * sdy) / lenSq;
  const cornerTol = r / Math.sqrt(lenSq);
  if (tSeg < -cornerTol || tSeg > 1 + cornerTol) return null;

  return { t: tClamped, tSeg: Math.max(0, Math.min(1, tSeg)) };
}

// Reflect velocity vector off a surface normal
function reflect(vx, vy, nx, ny) {
  const dot = vx * nx + vy * ny;
  return {
    x: vx - 2 * dot * nx,
    y: vy - 2 * dot * ny,
  };
}

// ─── Ball factory ─────────────────────────────────────────────────────────────
let ballIdCounter = 0;

// Returns an angle from CENTER aimed at a specific world-space point ± variance.
function spawnAngle(targetX, targetY, varianceRad) {
  const base = Math.atan2(targetY - CENTER, targetX - CENTER);
  return base + (Math.random() - 0.5) * varianceRad;
}

// Picks a random player side and returns its wall midpoint.
// Used at game-start when paddle positions haven't moved yet.
function randomPlayerMidpoint(sides) {
  const playerSides = sides.filter(s => s.playerIndex >= 0);
  const target = playerSides[Math.floor(Math.random() * playerSides.length)];
  return { x: target.midpoint.x, y: target.midpoint.y };
}

// Picks a random player side and returns that player's actual paddle centre.
// Used on respawn so the ball heads toward where the paddle currently is.
function randomPaddlePoint(sides, paddles, players) {
  const playerSides = sides.filter(s => s.playerIndex >= 0);
  const target = playerSides[Math.floor(Math.random() * playerSides.length)];
  const playerId = players[target.playerIndex]?.id;
  const paddle = paddles?.[playerId];
  if (paddle) {
    const t = paddle.t;
    return {
      x: target.p1.x + (target.p2.x - target.p1.x) * t,
      y: target.p1.y + (target.p2.y - target.p1.y) * t,
    };
  }
  return { x: target.midpoint.x, y: target.midpoint.y };
}

function createBall(speed, sides) {
  const pt = sides ? randomPlayerMidpoint(sides) : { x: CENTER, y: 0 };
  const angle = spawnAngle(pt.x, pt.y, Math.PI / 6); // ±30° around side midpoint
  return {
    id: ++ballIdCounter,
    x: CENTER,
    y: CENTER,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    lastHitPlayer: -1,
    trail: [],
    ghostTimer: 0,
    curveTurn: 0,  // radians/tick applied when curve_ball is active
    curveTicks: 0, // counter for randomising curve direction
  };
}

// ─── Modifier definitions ────────────────────────────────────────────────────
const MODIFIER_DEFS = [
  { type: 'speed_surge',      emoji: '🚀', label: 'Speed Surge',      duration: 8000  },
  { type: 'slow_mo',          emoji: '🐌', label: 'Slow Mo',          duration: 8000  },
  { type: 'tiny_paddles',     emoji: '🏓', label: 'Tiny Paddles',     duration: 10000 },
  { type: 'mega_paddles',     emoji: '💪', label: 'Mega Paddles',     duration: 10000 },
  { type: 'reverse_controls', emoji: '🔄', label: 'Reverse Controls', duration: 7000  },
  { type: 'multi_ball',       emoji: '🎱', label: 'Multi-Ball',       duration: 0     },
  { type: 'chaos_ball',       emoji: '🌀', label: 'Chaos Ball',       duration: 6000  },
  { type: 'ghost_ball',       emoji: '👻', label: 'Ghost Ball',       duration: 5000  },
  { type: 'random_boost',     emoji: '⚡', label: 'Random Boost',     duration: 10000 },
  { type: 'fireworks',        emoji: '🎆', label: 'Fireworks',        duration: 10000 },
  { type: 'rotary',           emoji: '🌪️', label: 'Rotary',           duration: 8000  },
  { type: 'nuclear',          emoji: '☢️',  label: 'Nuclear',          duration: 0     },
  { type: 'curve_ball',       emoji: '🪃', label: 'Curve Ball',       duration: 9000  },
];

// All modifier types in one place — exported so the client can build its picker
const ALL_MODIFIER_TYPES = MODIFIER_DEFS.map(d => d.type);

// ─── Game State ───────────────────────────────────────────────────────────────
function createGameState(players, config) {
  const playerCount = players.length;
  const sides = buildSides(playerCount);

  const speedMap = { Slow: BASE_BALL_SPEED * 0.7, Normal: BASE_BALL_SPEED, Fast: BASE_BALL_SPEED * 1.4 };
  const baseSpeed = speedMap[config.ballSpeed] || BASE_BALL_SPEED;

  const paddles = {};
  players.forEach((p, i) => {
    const sideIndex = playerCount === 2 ? (i === 0 ? 3 : 1) : i;
    paddles[p.id] = createPaddle(sideIndex, i, config);
  });

  const scores = {};
  players.forEach(p => { scores[p.id] = 0; });

  return {
    players,
    playerCount,
    sides,
    config,
    baseSpeed,
    currentSpeed: baseSpeed,
    balls: [createBall(baseSpeed, sides)],
    paddles,
    scores,
    activeModifiers: [],
    pendingModifier: null,     // spawned but not yet hit
    modifierSpawnTimer: 0,
    modifierSpawnInterval: getModifierInterval(config),
    running: true,
    tick: 0,
  };
}

function getModifierInterval(config) {
  if (!config.modifiers) return Infinity;
  const map = { Rare: 20000, Normal: 12000, Frequent: 6000 };
  return map[config.modifierFrequency] || 12000;
}

// ─── Main tick ────────────────────────────────────────────────────────────────
// Returns array of events: { type, ...data }
function tick(state, deltaMs) {
  if (!state.running) return [];
  state.tick++;
  const events = [];

  // Update modifiers
  updateModifiers(state, deltaMs, events);

  // Move paddles
  movePaddles(state);

  // Move & collide balls
  for (const ball of state.balls) {
    stepBall(ball, state, events);
  }

  // Spawn modifier pickup
  updateModifierSpawn(state, deltaMs, events);

  return events;
}

function movePaddles(state) {
  const { paddles, sides, config, activeModifiers } = state;
  const reverseActive = activeModifiers.some(m => m.type === 'reverse_controls');
  const paddleLen = getEffectivePaddleLen(state);
  const speed = getPaddleSpeed(config);

  for (const [, paddle] of Object.entries(paddles)) {
    let dir = paddle.input;
    if (reverseActive) dir = -dir;
    if (paddle.boosted) dir *= 1.6;

    if (dir === 0) continue;
    const side = sides[paddle.sideIndex];
    const half = (paddleLen / 2) / side.length;
    const tMin = half;
    const tMax = 1 - half;
    const dt = (dir * speed) / side.length;
    paddle.t = Math.max(tMin, Math.min(tMax, paddle.t + dt));
  }
}

function getEffectivePaddleLen(state) {
  const base = getPaddleLength(state.config);
  const hasTiny = state.activeModifiers.some(m => m.type === 'tiny_paddles');
  const hasMega = state.activeModifiers.some(m => m.type === 'mega_paddles');
  if (hasTiny) return base * 0.5;
  if (hasMega) return base * 1.75;
  return base;
}

function getEffectiveSpeed(state) {
  const hasSurge = state.activeModifiers.some(m => m.type === 'speed_surge');
  const hasSlow = state.activeModifiers.some(m => m.type === 'slow_mo');
  if (hasSurge) return state.currentSpeed * 2;
  if (hasSlow) return state.currentSpeed * 0.5;
  return state.currentSpeed;
}

function stepBall(ball, state, events) {
  const { sides, paddles } = state;
  const speed = getEffectiveSpeed(state);
  const chaosActive   = state.activeModifiers.some(m => m.type === 'chaos_ball');
  const curveBallActive = state.activeModifiers.some(m => m.type === 'curve_ball');

  // Normalise to current speed
  const mag = Math.hypot(ball.vx, ball.vy);
  if (mag === 0) { ball.vx = speed; ball.vy = 0; }
  else { ball.vx = (ball.vx / mag) * speed; ball.vy = (ball.vy / mag) * speed; }

  // Curve ball: rotate velocity direction by a small angle each tick.
  // The curve direction randomises every 40–70 ticks, creating unpredictable arcs.
  if (curveBallActive) {
    ball.curveTicks++;
    if (ball.curveTurn === 0 || ball.curveTicks >= ball._curveInterval) {
      const sign = Math.random() < 0.5 ? 1 : -1;
      ball.curveTurn = sign * (0.025 + Math.random() * 0.02); // ≈1.4–2.6°/tick
      ball._curveInterval = 40 + Math.floor(Math.random() * 30);
      ball.curveTicks = 0;
    }
    const c = Math.cos(ball.curveTurn), s = Math.sin(ball.curveTurn);
    const nvx = ball.vx * c - ball.vy * s;
    const nvy = ball.vx * s + ball.vy * c;
    ball.vx = nvx;
    ball.vy = nvy;
  }

  // Trail
  ball.trail.push({ x: ball.x, y: ball.y });
  if (ball.trail.length > 12) ball.trail.shift();

  // Modifier pickup (check against destination)
  if (state.pendingModifier) {
    const pm = state.pendingModifier;
    if (Math.hypot(ball.x + ball.vx - pm.x, ball.y + ball.vy - pm.y) < 28 + BALL_RADIUS) {
      activateModifier(state, pm.modDef, events);
      state.pendingModifier = null;
    }
  }

  // ── Multi-pass swept collision (up to 4 bounces per tick) ────────────────
  // Iterating prevents the ball from clipping through adjacent walls when it
  // hits near a corner: remaining motion after each reflection is re-checked
  // rather than applied blindly.
  let remainFrac = 1.0;

  for (let pass = 0; pass < 4 && remainFrac > 0.001; pass++) {
    const svx = ball.vx * remainFrac;
    const svy = ball.vy * remainFrac;

    let earliest = null;
    for (let si = 0; si < sides.length; si++) {
      const hit = sweepCircleVsSegment(ball.x, ball.y, svx, svy, BALL_RADIUS, sides[si]);
      if (hit !== null && (earliest === null || hit.t < earliest.t)) {
        earliest = { ...hit, si };
      }
    }

    if (earliest === null) {
      // No collision — consume remaining motion and exit
      ball.x += svx;
      ball.y += svy;
      remainFrac = 0;
      break;
    }

    const side = sides[earliest.si];

    // Advance ball to the exact contact point
    ball.x += svx * earliest.t;
    ball.y += svy * earliest.t;
    remainFrac *= (1 - earliest.t);

    if (side.playerIndex >= 0) {
      // ── Player wall ───────────────────────────────────────────────────────
      const playerId = state.players[side.playerIndex]?.id;
      const paddle = paddles[playerId];
      const paddleLen = getEffectivePaddleLen(state);

      if (paddle) {
        // Determine hit position along wall vs paddle extent
        const half = (paddleLen / 2) / side.length;
        const paddleOffset = (earliest.tSeg - paddle.t) / half; // −1..+1 if within paddle

        if (Math.abs(paddleOffset) <= 1.0) {
          // ── Paddle hit ────────────────────────────────────────────────────
          // Reflect off the wall normal (perfect angle-of-incidence)
          const ref = reflect(ball.vx, ball.vy, side.normal.x, side.normal.y);

          // Spin: hitting the edge deflects up to ±36°; centre is straight back
          const spinAngle = paddleOffset * (Math.PI / 5);
          const cosA = Math.cos(spinAngle), sinA = Math.sin(spinAngle);
          const spinVx = ref.x * cosA - ref.y * sinA;
          const spinVy = ref.x * sinA + ref.y * cosA;

          // Speed ramp
          state.currentSpeed = Math.min(state.baseSpeed * 2, state.currentSpeed * 1.05);
          const spinMag = Math.hypot(spinVx, spinVy);
          ball.vx = (spinVx / spinMag) * state.currentSpeed;
          ball.vy = (spinVy / spinMag) * state.currentSpeed;
          ball.lastHitPlayer = side.playerIndex;

          if (chaosActive) chaosDirection(ball, state.currentSpeed, side.normal.x, side.normal.y);

          events.push({ type: 'paddle_hit', playerIndex: side.playerIndex, playerId, ballId: ball.id });
        } else {
          // ── Miss ──────────────────────────────────────────────────────────
          handleMiss(ball, state, side.playerIndex, playerId, events);
          remainFrac = 0; // ball was reset — stop processing this step
          break;
        }
      }
    } else {
      // ── Solid wall — perfect reflection ───────────────────────────────────
      const ref = reflect(ball.vx, ball.vy, side.normal.x, side.normal.y);
      ball.vx = ref.x;
      ball.vy = ref.y;
      if (chaosActive) chaosDirection(ball, state.currentSpeed, side.normal.x, side.normal.y);

      events.push({ type: 'wall_bounce', ballId: ball.id });
    }
  }

  // Safety: if the ball somehow escaped the arena (no collision was caught),
  // reset it silently without awarding a point.
  const escapeDist = (ball.x - CENTER) ** 2 + (ball.y - CENTER) ** 2;
  if (escapeDist > (POLYGON_RADIUS + BALL_RADIUS * 4) ** 2) {
    resetBall(ball, state.baseSpeed, state.sides, state.paddles, state.players);
    state.currentSpeed = state.baseSpeed;
  }

  if (ball.ghostTimer > 0) ball.ghostTimer -= 1000 / TICK_RATE;
}


// Picks a random direction but guarantees the new direction faces INTO the
// arena from the wall that was just hit (dot product with inward normal > 0).
// Without this, chaos ball can fire the ball straight through a wall and off screen.
function chaosDirection(ball, speed, nx, ny) {
  const angle = Math.random() * Math.PI * 2;
  ball.vx = Math.cos(angle) * speed;
  ball.vy = Math.sin(angle) * speed;
  // If the random direction points outward, reflect it back across the wall normal
  const dot = ball.vx * nx + ball.vy * ny;
  if (dot < 0) {
    ball.vx -= 2 * dot * nx;
    ball.vy -= 2 * dot * ny;
  }
}

function handleMiss(ball, state, playerIndex, playerId, events) {
  // If ball last hit by same player — self miss, no point
  if (ball.lastHitPlayer === playerIndex) {
    resetBall(ball, state.currentSpeed = state.baseSpeed, state.sides, state.paddles, state.players);
    events.push({ type: 'self_miss', playerIndex, playerId });
    return;
  }

  // Award point to last hitter
  const scorerId = ball.lastHitPlayer >= 0 ? state.players[ball.lastHitPlayer]?.id : null;
  if (scorerId) {
    state.scores[scorerId] = (state.scores[scorerId] || 0) + 1;
  }

  events.push({
    type: 'point_scored',
    scorerId,
    scorerIndex: ball.lastHitPlayer,
    victimId: playerId,
    victimIndex: playerIndex,
    scores: { ...state.scores },
  });

  // Remove this ball (or reset if only one)
  resetBall(ball, state.baseSpeed, state.sides, state.paddles, state.players);
  state.currentSpeed = state.baseSpeed;

  // Check win condition
  const pointsToWin = parseInt(state.config.pointsToWin) || 5;
  if (scorerId && state.scores[scorerId] >= pointsToWin) {
    state.running = false;
    events.push({ type: 'game_over', winnerId: scorerId, finalScores: { ...state.scores } });
  }
}

function resetBall(ball, speed, sides, paddles, players) {
  ball.x = CENTER;
  ball.y = CENTER;
  const pt = sides ? randomPaddlePoint(sides, paddles, players) : { x: CENTER, y: 0 };
  const angle = spawnAngle(pt.x, pt.y, Math.PI / 6); // ±30° around the paddle
  ball.vx = Math.cos(angle) * speed;
  ball.vy = Math.sin(angle) * speed;
  ball.lastHitPlayer = -1;
  ball.trail = [];
  ball.curveTurn = 0;
  ball.curveTicks = 0;
}

// ─── Modifiers ────────────────────────────────────────────────────────────────
function updateModifiers(state, deltaMs, events) {
  state.activeModifiers = state.activeModifiers.filter(m => {
    if (m.duration === 0) return true; // permanent until cleared
    m.remaining -= deltaMs;
    if (m.remaining <= 0) {
      events.push({ type: 'modifier_expired', modType: m.type });
      // Undo multi-ball
      if (m.type === 'multi_ball' && state.balls.length > 1) {
        state.balls = [state.balls[0]];
      }
      return false;
    }
    return true;
  });
}

function updateModifierSpawn(state, deltaMs, events) {
  if (!state.config.modifiers || state.pendingModifier) return;
  state.modifierSpawnTimer += deltaMs;
  if (state.modifierSpawnTimer >= state.modifierSpawnInterval) {
    state.modifierSpawnTimer = 0;
    // Respect the host's enabled modifier list (null = all enabled)
    const enabled = state.config.enabledModifiers;
    const pool = enabled ? MODIFIER_DEFS.filter(d => enabled.includes(d.type)) : MODIFIER_DEFS;
    if (!pool.length) return;
    const def = pool[Math.floor(Math.random() * pool.length)];
    // Random position near centre
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * 80;
    state.pendingModifier = {
      modDef: def,
      x: CENTER + Math.cos(angle) * r,
      y: CENTER + Math.sin(angle) * r,
    };
    events.push({ type: 'modifier_spawned', modType: def.type, emoji: def.emoji, label: def.label, x: state.pendingModifier.x, y: state.pendingModifier.y });
  }
}

function fisherYates(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function activateModifier(state, def, events) {
  // ── Nuclear: fire 4 random modifiers simultaneously ──────────────────────
  if (def.type === 'nuclear') {
    const enabled = state.config.enabledModifiers;
    const pool = MODIFIER_DEFS.filter(d =>
      d.type !== 'nuclear' && (!enabled || enabled.includes(d.type))
    );
    fisherYates(pool).slice(0, 4).forEach(pick => activateModifier(state, pick, events));
    events.push({ type: 'modifier_activated', modType: def.type, emoji: def.emoji, label: def.label, duration: 0 });
    return;
  }

  const mod = { type: def.type, duration: def.duration, remaining: def.duration, emoji: def.emoji, label: def.label };

  if (def.type === 'multi_ball') {
    state.balls.push(createBall(state.currentSpeed, state.sides));
    state.balls.push(createBall(state.currentSpeed, state.sides));
  }

  if (def.type === 'random_boost') {
    const keys = Object.keys(state.paddles);
    const pid = keys[Math.floor(Math.random() * keys.length)];
    state.paddles[pid].boosted = true;
    mod.boostedPlayerId = pid;
    setTimeout(() => { if (state.paddles[pid]) state.paddles[pid].boosted = false; }, def.duration);
  }

  if (def.duration > 0) {
    state.activeModifiers = state.activeModifiers.filter(m => m.type !== def.type);
    state.activeModifiers.push(mod);
  }

  events.push({ type: 'modifier_activated', modType: def.type, emoji: def.emoji, label: def.label, duration: def.duration });
}

// ─── Serialise for network ────────────────────────────────────────────────────
function serialise(state) {
  const paddleLen = getEffectivePaddleLen(state);
  const paddleData = {};
  for (const [pid, paddle] of Object.entries(state.paddles)) {
    const side = state.sides[paddle.sideIndex];
    const { a, b, tc } = paddleEndpoints(paddle, side, paddleLen);
    paddleData[pid] = { sideIndex: paddle.sideIndex, t: tc, a, b, playerIndex: paddle.playerIndex };
  }

  const ghostActive = state.activeModifiers.some(m => m.type === 'ghost_ball');

  return {
    tick: state.tick,
    balls: state.balls.map(ball => ({
      id: ball.id,
      x: ball.x,
      y: ball.y,
      vx: ball.vx,
      vy: ball.vy,
      trail: ball.trail,
      ghost: ghostActive,
    })),
    paddles: paddleData,
    scores: state.scores,
    activeModifiers: state.activeModifiers.map(m => ({ type: m.type, remaining: m.remaining, duration: m.duration, emoji: m.emoji, label: m.label })),
    pendingModifier: state.pendingModifier ? { x: state.pendingModifier.x, y: state.pendingModifier.y, emoji: state.pendingModifier.modDef.emoji, label: state.pendingModifier.modDef.label } : null,
  };
}

module.exports = {
  createGameState,
  tick,
  serialise,
  buildSides,
  getPolygonVertices,
  CANVAS_SIZE,
  CENTER,
  POLYGON_RADIUS,
  BALL_RADIUS,
  PLAYER_COLORS,
  SHAPE_NAMES,
  TICK_RATE,
  ALL_MODIFIER_TYPES,
};
