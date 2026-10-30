# Backend routes and request contract

This document describes the backend's HTTP routes and Socket.IO request events. The HTTP API is intentionally small; room and game operations use authenticated Socket.IO events rather than REST endpoints.

## Base server behavior

- The server listens on `PORT` (default `3001`).
- `GET /health`, `GET /health/db`, and `GET /cards` are the HTTP routes.
- HTTP middleware runs in this order: CORS, JSON body parser (10 KB limit), route handlers, JSON 404 handler, then JSON error handler.
- CORS allows origins configured in `CLIENT_ORIGIN` (one or comma-separated URLs). For allowed origins it permits `GET`, `OPTIONS`, and the `Content-Type` and `Authorization` headers. `OPTIONS` requests return `204`. Requests without an allowed origin are still processed, but do not receive allow-origin headers.
- Unknown HTTP paths return `404 { "error": "not_found" }`. Unhandled HTTP errors return `500 { "error": "internal_error" }` and are logged.
- HTTP routes accept no request body or query parameters unless stated below.

## HTTP routes

### `GET /health`

Liveness check. No authentication or inputs required.

Success (`200`):

```json
{ "status": "ok", "uptimeSeconds": 123, "time": "2026-10-30T12:00:00.000Z" }
```

`uptimeSeconds` is rounded process uptime; `time` is the server's current ISO timestamp. This checks that the process responds, not database availability.

### `GET /health/db`

Database readiness check. No authentication or inputs required. It queries Supabase for the `rooms` table (head/count query) using the server secret key.

Success (`200`): `{ "status": "ok", "db": "ok" }`.

Failure (`503`): `{ "status": "error", "db": "unavailable" }`. In non-production, the response also includes Supabase `code` and `message`; in production these details are omitted. The failure is logged.

### `GET /cards`

Returns the fixed card catalog; no authentication or inputs required.

Success (`200`): `{ "deckSize": 168, "cards": [...] }`, where each card is `{ "id": "c_0", "color": "R", "type": "n0" }`. IDs are stable (`c_0` through `c_167`). Colors are `R`, `Y`, `G`, `B`, or `W`; types are the catalog's game card types. Response cache header is `Cache-Control: public, max-age=86400`.

## Socket.IO connection and shared request middleware

Connect to the same server using Socket.IO. Provide a Supabase access token in the handshake auth object:

```ts
io(serverUrl, { auth: { token: session.access_token } });
```

The browser should use a Supabase publishable key to obtain its session; the backend secret key must never be sent to clients.

### Connection middleware

Before a connection is accepted, Socket.IO middleware:

1. Reads `socket.handshake.auth.token`; it must be a non-empty string of at most 4096 characters.
2. Verifies the token with Supabase Auth (`auth.getUser`).
3. Loads the user's profile and username. Missing/invalid token or profile rejects the connection with `UNAUTHORIZED`; an authentication service exception rejects it with `AUTH_UNAVAILABLE`.
4. Stores the authenticated user on `socket.data.user` for handlers.

Socket.IO also has its own CORS origin list (`CLIENT_ORIGIN`), a 100 KB maximum message buffer, and 10 second ping interval/timeout. On connection, the user's sockets join `user:<userId>` and the room manager marks that user connected and sends a `session:restore` update.

### Middleware applied to every request event

Each registered request event passes through `createHandler` in this order:

1. **Per-socket rate limit:** sliding window allows at most 40 events per 10 seconds. Exceeding it returns `RATE_LIMITED`.
2. **Payload validation:** Zod schemas reject malformed payloads and unknown fields on strict schemas with `VALIDATION` and a readable message. Events declared with `z.unknown()` accept any payload, including no payload.
3. **Handler:** invokes the room manager with the authenticated user's ID. Thrown errors are logged and returned as `INTERNAL`.

Every request should use a Socket.IO acknowledgement callback. Result shape is `{ "ok": true, "data": ... }` on success (data may be omitted), or `{ "ok": false, "code": "...", "message": "..." }` on failure. Without an acknowledgement callback the server still handles the event, but the client cannot read its result.

## Socket.IO request events

All listed events are sent client-to-server. The data shape is the first argument before the acknowledgement callback. A “no payload” event may be emitted with only the callback.

### `room:create`

Creates a lobby for the authenticated user.

Payload (optional):

```ts
{
  maxPlayers?: number; // integer 2..6
  settings?: {
    sevenZero?: boolean;
    turnSeconds?: 0 | 5..300; // integer; 0 disables turn timer
    lifelines?: number; // integer 0..10
  };
}
```

The settings object rejects extra keys. Success data is a `RoomView`. Defaults are `maxPlayers: 4`, `sevenZero: true`, `turnSeconds: 20`, and `lifelines: 3`; supplied settings override those defaults. Expected room error: `ALREADY_IN_ROOM` if the user already occupies a room.

### `room:join`

Joins an existing lobby.

Payload: `{ code: string }`. The code is trimmed, uppercased, and must be exactly six letters or digits (`^[A-Z0-9]{6}$`).

Success data is a `RoomView`. Expected errors: `ROOM_NOT_FOUND`, `ROOM_FULL`, `ROOM_IN_PROGRESS`, `ALREADY_IN_ROOM`. Joining the same room while already a member returns that room's view.

### `room:leave`

Leaves the current room. No payload. During a running game this is a forfeit. Expected error: `NOT_IN_ROOM`.

### `room:ready`

Sets the caller's lobby readiness.

Payload: `{ ready: boolean }`. The host is always ready regardless of the submitted value. Emits updated room state to room members. Expected errors: `NOT_IN_ROOM`, `ROOM_IN_PROGRESS`.

### `room:settings`

Updates lobby settings/capacity.

Payload (at least one field may be omitted): `{ maxPlayers?: 2..6 integer, settings?: { sevenZero?: boolean, turnSeconds?: 0 or 5..300 integer, lifelines?: 0..10 integer } }`. Extra keys are rejected. Host-only and lobby-only operation.

Expected errors: `NOT_IN_ROOM`, `NOT_HOST`, `ROOM_IN_PROGRESS`, and `ROOM_TOO_SMALL` (for a capacity change that would be too small for the current room).

### `room:start`

Starts a game from the caller's lobby. No payload. Host-only.

Expected errors: `NOT_HOST`, `NOT_ENOUGH_PLAYERS`, `PLAYERS_NOT_READY`, `PLAYER_OFFLINE`, `ROOM_IN_PROGRESS`.

### `session:sync`

Requests the caller's current room and game snapshot again (for example after restoring a backgrounded app). No payload. Success data has shape `{ room, game }`, equivalent to reconnect restoration. A user outside a room receives null room/game values.

### `game:play`

Plays a card from the caller's hand.

Payload:

```ts
{
  cardId: string; // 1..32 characters
  color?: 'R' | 'Y' | 'G' | 'B';
  targetId?: string; // 1..64 characters
}
```

`color` is required by the game rules for Reverse +4, +6, and +10 cards. `targetId` is required for a 7 when the seven-zero rule is enabled. Those conditional requirements and card ownership/playability are checked by game logic, not the shape schema. Success results in game updates to room members.

Game-state/rule errors include `NOT_IN_ROOM`, `NOT_PLAYING`, `GAME_OVER`, `NOT_IN_GAME`, `ELIMINATED`, `NOT_YOUR_TURN`, `PROMPT_PENDING`, `NO_PROMPT`, `NOT_YOUR_PROMPT`, `CARD_NOT_IN_HAND`, `MUST_PLAY_DRAWN_CARD`, `CANNOT_PLAY`, `COLOR_REQUIRED`, `INVALID_TARGET`, and `PENALTY_PENDING`.

### `game:draw`

Draws when allowed. No payload. The player may draw only when they have no playable card; the game draws until a playable card is found, after which the player must play that drawn card. Rule errors include `HAS_PLAYABLE_CARD`, `NOT_YOUR_TURN`, and other shared game-state errors listed for `game:play`.

### `game:takePenalty`

Accepts the pending draw penalty and loses the turn. No payload. Requires a pending penalty. Rule error: `NO_PENALTY`; shared game-state errors may also apply.

### `game:chooseColor`

Answers a Color Roulette color prompt. Only the targeted victim may call this while their prompt is active.

Payload: `{ color: 'R' | 'Y' | 'G' | 'B' }`.

Rule errors include `NO_PROMPT` and `NOT_YOUR_PROMPT`, plus shared game-state errors.

There are no client events for timeout or direct forfeit. Turn timeouts are server-managed; leaving with `room:leave` is the player-initiated forfeit path.

## Server-to-client events

These are notifications, not request routes; clients listen for them and do not acknowledge them.

| Event | Payload / when |
|---|---|
| `session:restore` | `{ room: RoomView \| null, game: GamePayload \| null }`, sent after connecting. |
| `room:state` | `RoomView`, sent for lobby/player/presence/game phase changes. |
| `game:update` | `GamePayload`, sent after game actions and state changes. |
| `room:left` | `{ code, reason: 'left' \| 'disconnected' }`, when removed from a room. |

`RoomView` contains room code, phase, host, capacity, settings, player presence/readiness, and `hasGame`. `GamePayload` contains the caller-filtered game view, events, server clock, and optional turn deadline. Other players' hands are never included. See [PROTOCOL.md](./PROTOCOL.md) for complete game view, card/event definitions, countdown handling, and presence behavior.
