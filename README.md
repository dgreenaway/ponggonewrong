# Pong Gone Wrong

Multiplayer pong for 2 to 6 players where the arena shape changes depending on how many people are playing. Two players get a rectangle, three get a triangle, and so on up to a hexagon. Every player defends one wall and tries to let the ball through everyone else's.

## How it works

One person creates a room and shares the invite link. Everyone else clicks it and lands straight on the join screen with the code already filled in. The host picks the settings and starts the game when everyone is ready.

The ball speeds up every time it hits a paddle and resets after each point. Modifier pickups spawn in the middle of the arena and activate when the ball hits them. There are 13 modifiers in total, including multi-ball, reversed controls, tiny paddles, curve ball, and nuclear (which fires four random modifiers at once).

## Controls

Left and right arrow keys, or A and D. The direction is calculated relative to the way your paddle faces into the arena, so it should feel consistent regardless of which wall you are on.

## Running locally

Requires Node.js.

```
npm install
npm start
```

Then open `http://localhost:3000` in a browser.

For development with auto-restart on file changes:

```
npm run dev
```

## Stack

- Node.js with Express and Socket.io for the server
- Vanilla JS canvas for rendering
- All physics run server-side at 60 ticks per second
- No database, no build step, all game state lives in memory

## Game settings

The host can configure these before starting:

| Setting | Options |
|---|---|
| Points to win | 3, 5, 7, 10 |
| Ball speed | Slow, Normal, Fast |
| Paddle size | Small, Normal, Large |
| Modifiers | On / Off |
| Modifier frequency | Rare, Normal, Frequent |

The host can also enable or disable individual modifiers from the lobby, and kick players before the game starts.

## Modifiers

| Name | Effect |
|---|---|
| Speed Surge | Ball moves at double speed |
| Slow Mo | Ball slows to half speed |
| Tiny Paddles | All paddles shrink by 50% |
| Mega Paddles | All paddles grow by 75% |
| Reverse Controls | All controls are flipped |
| Multi-Ball | Two extra balls added |
| Chaos Ball | Ball fires in a random direction on each hit |
| Ghost Ball | Ball becomes semi-transparent |
| Random Boost | One random player gets a speed boost on their paddle |
| Fireworks | Visual effect only |
| Rotary | Visual effect only |
| Nuclear | Activates four random modifiers simultaneously |
| Curve Ball | Ball curves in arcs that shift direction unpredictably |

## Deployment

The server is stateless with no external dependencies, so it runs anywhere Node is supported. All rooms and game state are in-process memory, which means state is lost on restart.
