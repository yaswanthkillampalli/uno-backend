# UNO No Mercy: socket protocol (for the frontend)

## Connecting

```ts
import { io } from 'socket.io-client';

const socket = io('http://localhost:3001', {
  // Function form: runs again on every reconnect, so the token is always fresh.
  auth: async (cb) => {
    const { data } = await supabase.auth.getSession();
    cb({ token: data.session?.access_token });
  },
});

socket.on('connect_error', (e) => console.log(e.message)); // "UNAUTHORIZED" | "AUTH_UNAVAILABLE"
```

The token is checked once, when the socket connects. Use the **publishable** key in the browser, never the secret key.

## Answers (acknowledgements)

Every request below takes an ack callback and gets one of:

```ts
{ ok: true, data?: ... }
{ ok: false, code: string, message: string }
```

```ts
const res = await socket.emitWithAck('room:create', { settings: { turnSeconds: 20 } });
if (!res.ok) showError(res.message);
```

Error codes: `VALIDATION`, `RATE_LIMITED` (max 40 requests per 10 s), `INTERNAL`, plus the codes listed per request and the game-rule codes at the bottom.

## Requests (client -> server)

| Event | Payload | Notes / errors |
|---|---|---|
| `room:create` | `{ maxPlayers?: 2-6, settings?: { sevenZero?: boolean, turnSeconds?: 0 or 5-300, lifelines?: 0-10 } }` | `data` = RoomView. `ALREADY_IN_ROOM` |
| `room:join` | `{ code }` | `data` = RoomView. `ROOM_NOT_FOUND`, `ROOM_FULL`, `ROOM_IN_PROGRESS`, `ALREADY_IN_ROOM` |
| `room:leave` | none | In a game this is a forfeit. `NOT_IN_ROOM` |
| `room:ready` | `{ ready: boolean }` | The host is always ready. |
| `room:settings` | `{ maxPlayers?, settings? }` | Host only, lobby only. `NOT_HOST`, `ROOM_TOO_SMALL` |
| `room:start` | none | Host only. `NOT_HOST`, `NOT_ENOUGH_PLAYERS`, `PLAYERS_NOT_READY`, `PLAYER_OFFLINE`, `ROOM_IN_PROGRESS` |
| `session:sync` | none | `data` = `{ room, game }`, same as `session:restore`. |
| `game:play` | `{ cardId, color?, targetId? }` | `color` is **required** for Reverse +4, +6 and +10. `targetId` is **required** for a 7 (when `sevenZero` is on). |
| `game:draw` | none | Only when you have no playable card. Draws until a playable card; you must then play it. |
| `game:takePenalty` | none | Take the pending +N and lose your turn. |
| `game:chooseColor` | `{ color: 'R'\|'Y'\|'G'\|'B' }` | Only for the Color Roulette victim: `state.prompt.playerId === me`. |

There is no request for timeouts or forfeits: the server's timer and `room:leave` do that.

## Messages (server -> client)

| Event | When | Payload |
|---|---|---|
| `session:restore` | Right after every connect | `{ room: RoomView \| null, game: GamePayload \| null }`. Rebuild your whole UI from this. |
| `room:state` | Lobby changes, players joining/leaving, going online/offline, game start/end | `RoomView` |
| `game:update` | After every game action | `GamePayload` |
| `room:left` | You were removed from the room | `{ code, reason: 'left' \| 'disconnected' }` |

```ts
RoomView = {
  code, phase: 'lobby' | 'playing', hostId, maxPlayers,
  settings: { sevenZero, turnSeconds, lifelines },
  players: { userId, username, seat, isReady, connected }[],
  hasGame: boolean,            // true after a game ended too: its final state is still readable
}

GamePayload = {
  events: GameEvent[],         // what just happened (empty on a plain sync)
  state: GameView,
  deadlineAt: number | null,   // epoch ms when the player being waited on times out
  serverNow: number,           // server clock when sent
}
```

When a game ends, `game:update` carries `state.status === 'finished'` with `winnerId`, `endReason` and `standings`, then `room:state` follows with `phase: 'lobby'` (ready flags reset) so the host can start a rematch.

### Countdown

```ts
const offset = payload.serverNow - Date.now();            // measure on receipt
const msLeft = payload.deadlineAt - (Date.now() + offset);
```

## GameView

```ts
{
  version, status: 'playing' | 'finished',
  players: { userId, name, seat, cardCount, lifelines, eliminated, eliminatedBy: 'mercy'|'left'|'timeout'|null }[],
  turnPlayerId,                // whose action is awaited (the Roulette victim during a color choice)
  turnSeconds, direction: 1 | -1, activeColor: 'R'|'Y'|'G'|'B',
  topCard: Card, drawPileCount, discardPileCount,
  pendingDraw,                 // penalty waiting for the current player
  minStackValue,               // while pending: only a draw card worth at least this can be stacked
  prompt: { type: 'roulette_color', playerId } | null,
  winnerId, endReason, standings: { userId, name, placement, cardsLeft, eliminated }[],
  you: null | {                // null if you are not a player
    userId, seat, hand: Card[], isYourTurn,
    playableCardIds: string[], // grey out everything else
    canDraw, canTakePenalty, mustPlayCardId,
  },
}
Card = { id: 'c_0'..'c_167', color: 'R'|'Y'|'G'|'B'|'W', type: CardType }
```

Other players' hands are never sent, only `cardCount`.

**Card types:** `n0`-`n9` numbers, `d2` +2, `d4` +4, `sk` Skip, `se` Skip All, `rv` Reverse, `da` Discard All, `w4r` Reverse +4, `w6` +6, `w10` +10, `cr` Color Roulette.

`GET /cards` returns the fixed 168-card catalog `{ deckSize, cards: Card[] }`. A card's id never changes, so key your art by id.

## Game events

```
played {playerId, card}              color_chosen {playerId, color}
penalty_stacked {amount, total}      drew {playerId, count, reason, cards?}
discarded_all {playerId, color, cards}  direction_reversed {direction}
skipped {playerIds}                  hands_swapped {playerId, targetId}
hands_rotated                        roulette_started {playerId, by}
passed {playerId}                    reshuffled
timed_out {playerId}                 lifeline_used {playerId, remaining, dropped}
eliminated {playerId, reason, cardCount}   game_over {winnerId, reason}
```

`drew.cards` is only present for the player who drew; everyone else gets `count` only. `drew.reason` is `draw`, `penalty`, `roulette` or `timeout`.

## Rule error codes (`game:*`)

`NOT_IN_ROOM`, `NOT_PLAYING`, `GAME_OVER`, `NOT_IN_GAME`, `ELIMINATED`, `NOT_YOUR_TURN`, `PROMPT_PENDING`, `NO_PROMPT`, `NOT_YOUR_PROMPT`, `CARD_NOT_IN_HAND`, `MUST_PLAY_DRAWN_CARD`, `CANNOT_PLAY` (message explains why), `COLOR_REQUIRED`, `INVALID_TARGET`, `PENALTY_PENDING`, `NO_PENALTY`, `HAS_PLAYABLE_CARD`.

## Presence rules

- Closing the last tab marks you offline. After `DISCONNECT_GRACE_SECONDS` (default 60) you leave the lobby, or forfeit a running game.
- Reconnecting in time cancels that. You get `session:restore` with your hand.
- While you are away, your turns still time out and cost lifelines.
- One room per player. Several tabs of the same player all receive the same updates.
