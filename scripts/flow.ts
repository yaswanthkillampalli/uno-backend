// Socket-side building blocks for the smoke test. No Supabase in here, so the same code is
// tested against a fake database in tests/flow.test.ts.
import { io, type Socket } from 'socket.io-client';
import type { GamePayload, RoomView, SessionPayload } from '../src/rooms/types.js';

export interface Player {
  name: string;
  userId: string;
  token: string;
}

export interface Client {
  name: string;
  userId: string;
  socket: Socket;
  room: RoomView | null;
  game: GamePayload | null;
  restores: SessionPayload[];
  updates: GamePayload[];
  connects: number;
}

export type Reply = { ok: true; data?: any } | { ok: false; code: string; message: string };

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitUntil<T>(fn: () => T | undefined | false | null, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
}

export function connectPlayer(url: string, player: Player): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      // Function form: runs again on every reconnect.
      auth: (cb) => cb({ token: player.token }),
      transports: ['websocket'],
      reconnectionDelay: 300,
      reconnectionDelayMax: 1000,
    });
    const client: Client = {
      name: player.name,
      userId: player.userId,
      socket,
      room: null,
      game: null,
      restores: [],
      updates: [],
      connects: 0,
    };
    socket.on('room:state', (r: RoomView) => (client.room = r));
    socket.on('game:update', (g: GamePayload) => {
      client.game = g;
      client.updates.push(g);
    });
    socket.on('session:restore', (s: SessionPayload) => {
      client.restores.push(s);
      client.room = s.room;
      client.game = s.game;
    });
    socket.on('connect', () => {
      client.connects++;
      if (client.connects === 1) resolve(client);
    });
    socket.on('connect_error', (e) => {
      if (client.connects === 0) {
        socket.close();
        reject(new Error(`${player.name} could not connect: ${e.message}`));
      }
    });
  });
}

export function ask(c: Client, event: string, payload?: unknown, timeoutMs = 5000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer to ${event} from ${c.name}`)), timeoutMs);
    const done = (reply: Reply): void => {
      clearTimeout(timer);
      resolve(reply);
    };
    if (payload === undefined) c.socket.emit(event, done);
    else c.socket.emit(event, payload, done);
  });
}

/** Like ask(), but throws if the server said no. Returns the `data` part. */
export async function must(reply: Promise<Reply>, what: string): Promise<any> {
  const r = await reply;
  if (!r.ok) throw new Error(`${what} failed: ${r.code}: ${r.message}`);
  return r.data;
}

export function disconnectAll(clients: Client[]): void {
  for (const c of clients) c.socket.close();
}

// ---------- scenarios ----------------------------------------------------------
/** Host creates a room, the others join and get ready, host starts. Returns the room code. */
export async function setupGame(
  clients: Client[],
  settings: { turnSeconds: number; lifelines?: number },
  log: (msg: string) => void,
): Promise<string> {
  const [host, ...others] = clients;
  if (!host) throw new Error('need at least one client');
  const room = await must(ask(host, 'room:create', { maxPlayers: Math.max(2, clients.length), settings }), 'room:create');
  const code = room.code as string;
  log(`${host.name} created room ${code}`);
  for (const c of others) {
    await must(ask(c, 'room:join', { code }), 'room:join');
    await must(ask(c, 'room:ready', { ready: true }), 'room:ready');
    log(`${c.name} joined and is ready`);
  }
  await must(ask(host, 'room:start'), 'room:start');
  await waitUntil(() => clients.every((c) => c.game?.state.status === 'playing'), 5000, 'the game to start');
  log('game started');
  return code;
}

/** Waits for whoever has to act, and makes them do something legal. Returns what was done. */
export async function playOneMove(clients: Client[]): Promise<string> {
  const actor = await waitUntil(
    () => {
      const newest = Math.max(...clients.map((c) => c.game?.state.version ?? -1));
      return clients.find(
        (c) =>
          c.game?.state.version === newest &&
          c.game.state.status === 'playing' &&
          c.game.state.turnPlayerId === c.userId,
      );
    },
    15_000,
    'a player to be asked to act',
  );
  const state = actor.game!.state;
  const you = state.you!;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)] as T;
  const colors = ['R', 'Y', 'G', 'B'] as const;

  let event: string;
  let payload: unknown;
  if (state.prompt) {
    event = 'game:chooseColor';
    payload = { color: pick(colors) };
  } else if (you.playableCardIds.length > 0 && !(you.canTakePenalty && Math.random() < 0.2)) {
    const others = state.players.filter((p) => p.userId !== actor.userId && !p.eliminated);
    event = 'game:play';
    payload = { cardId: pick(you.playableCardIds), color: pick(colors), targetId: pick(others).userId };
  } else if (you.canTakePenalty) {
    event = 'game:takePenalty';
  } else {
    event = 'game:draw';
  }
  // A bot is far faster than a person, so it can hit the server's rate limit. Back off and retry,
  // which is what a real client should do too (a rejected request changes nothing on the server).
  for (let attempt = 0; ; attempt++) {
    const reply = await ask(actor, event, payload);
    if (reply.ok) break;
    if (reply.code !== 'RATE_LIMITED' || attempt >= 40) {
      throw new Error(`${actor.name} ${event} failed: ${reply.code}: ${reply.message}`);
    }
    await sleep(250);
  }
  return `${actor.name}: ${event}`;
}

export async function playMoves(clients: Client[], count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    if (clients[0]?.game?.state.status === 'finished') return;
    await playOneMove(clients);
  }
}

/** Plays until the game is over. */
export async function playToEnd(clients: Client[], maxMoves: number, log: (msg: string) => void): Promise<number> {
  let moves = 0;
  while (clients.some((c) => c.game?.state.status !== 'finished')) {
    if (clients.every((c) => c.game?.state.status === 'finished')) break;
    if (++moves > maxMoves) throw new Error(`The game did not finish within ${maxMoves} moves`);
    // If one client already shows 'finished', the rest are about to.
    if (clients.some((c) => c.game?.state.status === 'finished')) {
      await waitUntil(() => clients.every((c) => c.game?.state.status === 'finished'), 5000, 'everyone to see the game end');
      break;
    }
    await playOneMove(clients);
    if (moves % 50 === 0) log(`... ${moves} moves played`);
  }
  return moves;
}

export const handIds = (c: Client): string[] => (c.game?.state.you?.hand ?? []).map((card) => card.id).sort();

/**
 * Starts a game, plays a few moves, then waits for the SERVER to be restarted (the sockets drop and
 * reconnect on their own) and checks that everybody got their room and their exact hand back.
 * `triggerRestart` lets a test do the restart itself; the real script just asks a human.
 */
export async function restartScenario(
  clients: Client[],
  log: (msg: string) => void,
  triggerRestart?: () => Promise<void>,
): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  };
  await playMoves(clients, 4);
  await waitUntil(() => new Set(clients.map((c) => c.game?.state.version)).size === 1, 5000, 'everyone to be up to date');

  const before = clients.map((c) => ({ hand: handIds(c), version: c.game!.state.version, code: c.room!.code, restores: c.restores.length }));
  log('>>> Now stop the server (Ctrl+C in its terminal) and start it again with `npm run dev`. Waiting...');
  if (triggerRestart) void triggerRestart();

  await waitUntil(() => clients.every((c) => !c.socket.connected), 120_000, 'the server to go down');
  log('server went down, waiting for it to come back...');
  await waitUntil(
    () => clients.every((c, i) => c.socket.connected && c.restores.length > (before[i]?.restores ?? 0)),
    120_000,
    'the server to come back and restore the session',
  );
  log('server is back');

  clients.forEach((c, i) => {
    const b = before[i]!;
    const restore = c.restores.at(-1)!;
    check(`${c.name}: gets the same room back after the restart`, restore.room?.code === b.code);
    check(`${c.name}: the game is still running`, restore.room?.phase === 'playing' && restore.game?.state.status === 'playing');
    check(`${c.name}: gets the exact same hand back`, JSON.stringify(handIds(c)) === JSON.stringify(b.hand));
    check(
      `${c.name}: game state is as of the last move`,
      restore.game?.state.version === b.version,
      `before=${b.version} after=${restore.game?.state.version}`,
    );
  });
  return checks;
}
