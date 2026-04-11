'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const {
  createGameState, tick, serialise,
  buildSides, getPolygonVertices,
  CANVAS_SIZE, PLAYER_COLORS, SHAPE_NAMES, TICK_RATE,
} = require('./game-logic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Room storage ─────────────────────────────────────────────────────────────
const rooms = new Map(); // roomCode → room

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function makeRoom(hostSocket, playerName) {
  let code;
  do { code = generateCode(); } while (rooms.has(code));

  const room = {
    code,
    hostId: hostSocket.id,
    players: [{
      id: hostSocket.id,
      name: playerName,
      color: PLAYER_COLORS[0],
      index: 0,
    }],
    config: {
      pointsToWin: 5,
      ballSpeed: 'Normal',
      paddleSize: 'Normal',
      modifiers: true,
      modifierFrequency: 'Normal',
      multiBall: false,
      enabledModifiers: null, // null = all enabled
    },
    gameState: null,
    gameLoop: null,
    spectators: [],
  };
  rooms.set(code, room);
  return room;
}

function findRoomByPlayer(socketId) {
  for (const room of rooms.values()) {
    if (room.players.find(p => p.id === socketId)) return room;
    if (room.spectators.includes(socketId)) return room;
  }
  return null;
}

function startGameLoop(room) {
  const INTERVAL_MS = 1000 / TICK_RATE;
  room.gameState = createGameState(room.players, room.config);
  room.gameLoop = setInterval(() => {
    const events = tick(room.gameState, INTERVAL_MS);
    const state = serialise(room.gameState);

    io.to(room.code).emit('game_state', state);

    for (const ev of events) {
      switch (ev.type) {
        case 'point_scored':
          io.to(room.code).emit('point_scored', { scorerId: ev.scorerId, victimId: ev.victimId, scores: ev.scores });
          break;
        case 'modifier_spawned':
          io.to(room.code).emit('modifier_spawned', { type: ev.modType, emoji: ev.emoji, label: ev.label, x: ev.x, y: ev.y });
          break;
        case 'modifier_activated':
          io.to(room.code).emit('modifier_activated', { type: ev.modType, emoji: ev.emoji, label: ev.label, duration: ev.duration });
          break;
        case 'game_over':
          io.to(room.code).emit('game_over', { winnerId: ev.winnerId, finalScores: ev.finalScores });
          clearInterval(room.gameLoop);
          room.gameLoop = null;
          break;
        case 'paddle_hit':
          io.to(room.code).emit('paddle_hit', { playerIndex: ev.playerIndex, ballId: ev.ballId });
          break;
        case 'wall_bounce':
          io.to(room.code).emit('wall_bounce', { ballId: ev.ballId });
          break;
      }
    }
  }, INTERVAL_MS);
}

// ─── Socket handlers ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('connect', socket.id);

  socket.on('create_room', ({ playerName }) => {
    const name = (playerName || 'Player').slice(0, 20);
    const room = makeRoom(socket, name);
    socket.join(room.code);
    socket.emit('room_created', { roomCode: room.code, playerId: socket.id, config: room.config, players: room.players });
    console.log(`Room ${room.code} created by ${name}`);
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const name = (playerName || 'Player').slice(0, 20);
    const room = rooms.get(code);

    if (!room) return socket.emit('error', { message: 'Room not found.' });
    if (room.gameState && room.gameState.running) {
      // Join as spectator
      room.spectators.push(socket.id);
      socket.join(code);
      return socket.emit('spectating', { roomCode: code, players: room.players });
    }
    if (room.players.length >= 6) return socket.emit('error', { message: 'Room is full (max 6 players).' });

    const color = PLAYER_COLORS[room.players.length];
    const player = { id: socket.id, name, color, index: room.players.length };
    room.players.push(player);
    socket.join(code);

    socket.emit('room_joined', { roomCode: code, playerId: socket.id, players: room.players, config: room.config });
    socket.to(code).emit('player_joined', { players: room.players });
    console.log(`${name} joined ${code}`);
  });

  socket.on('kick_player', ({ playerId }) => {
    const room = findRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (playerId === socket.id) return; // can't kick yourself
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx < 0) return;
    room.players.splice(idx, 1);
    io.to(playerId).emit('kicked');
    io.to(room.code).emit('player_joined', { players: room.players });
    console.log(`Player ${playerId} kicked from ${room.code}`);
  });

  socket.on('update_config', (config) => {
    const room = findRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id) return;
    room.config = { ...room.config, ...config };
    io.to(room.code).emit('config_updated', { config: room.config });
  });

  socket.on('start_game', () => {
    const room = findRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) return socket.emit('error', { message: 'Need at least 2 players.' });

    const sides = buildSides(room.players.length);
    const boardConfig = {
      canvasSize: CANVAS_SIZE,
      sides: sides.map(s => ({ p1: s.p1, p2: s.p2, playerIndex: s.playerIndex })),
      shapeName: SHAPE_NAMES[room.players.length] || 'Polygon',
    };
    const playerAssignments = room.players.map(p => ({ ...p }));

    io.to(room.code).emit('game_started', { boardConfig, playerAssignments, config: room.config });
    setTimeout(() => startGameLoop(room), 3000);
  });

  socket.on('paddle_move', ({ direction }) => {
    const room = findRoomByPlayer(socket.id);
    if (!room || !room.gameState) return;
    const paddle = room.gameState.paddles[socket.id];
    if (paddle) paddle.input = direction;
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    const room = findRoomByPlayer(socket.id);
    if (!room) return;

    // Remove spectator
    room.spectators = room.spectators.filter(id => id !== socket.id);

    // Remove player
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx >= 0) room.players.splice(idx, 1);

    if (room.players.length === 0) {
      // Clean up room
      if (room.gameLoop) clearInterval(room.gameLoop);
      rooms.delete(room.code);
      console.log(`Room ${room.code} cleaned up`);
      return;
    }

    // Reassign host if needed
    if (room.hostId === socket.id) room.hostId = room.players[0].id;

    io.to(room.code).emit('player_left', { players: room.players, newHostId: room.hostId });

    // End game if too few players
    if (room.gameState && room.gameState.running && room.players.length < 2) {
      if (room.gameLoop) clearInterval(room.gameLoop);
      room.gameLoop = null;
      io.to(room.code).emit('game_over', { winnerId: room.players[0]?.id, finalScores: room.gameState?.scores || {} });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pong Gone Wrong running on http://localhost:${PORT}`));
