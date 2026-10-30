import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'socket.io';
import { io as connectClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoomManager } from '../src/rooms/roomManager.js';
import { createSocketServer } from '../src/sockets/index.js';
import { SocketNotifier } from '../src/sockets/notifier.js';
import { FakeRepo } from './fakes.js';

let http: HttpServer;
let io: Server;
let url: string;
let manager: RoomManager;
const clients: Socket[] = [];

beforeAll(async () => {
  const repo = new FakeRepo();
  const notifier = new SocketNotifier();
  manager = new RoomManager({ repo, notifier, graceMs: 60_000 });
  http = createServer();
  io = createSocketServer(http, {
    manager,
    notifier,
    corsOrigin: ['http://localhost:5173'],
    // Stand-in for Supabase: the token "tok-<name>" is the user <name>.
    authenticate: async (token) => (token.startsWith('tok-') ? { id: token.slice(4), username: token.slice(4).toUpperCase() } : null),
  });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  url = `http://localhost:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await manager.shutdown();
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

interface Client {
  socket: Socket;
  inbox: Map<string, unknown[]>;
}

function connect(token: string | undefined): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = connectClient(url, { auth: token === undefined ? {} : { token }, transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(socket);
    const inbox = new Map<string, unknown[]>();
    socket.onAny((event: string, payload: unknown) => inbox.set(event, [...(inbox.get(event) ?? []), payload]));
    socket.on('connect', () => resolve({ socket, inbox }));
    socket.on('connect_error', (e) => reject(e));
  });
}

const ask = (c: Client, event: string, payload?: unknown): Promise<any> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${event}`)), 2000);
    const done = (r: unknown) => {
      clearTimeout(timer);
      resolve(r);
    };
    if (payload === undefined) c.socket.emit(event, done);
    else c.socket.emit(event, payload, done);
  });

async function waitFor<T>(fn: () => T | undefined | false, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting');
}
const lastOf = (c: Client, event: string): any => c.inbox.get(event)?.at(-1);

describe('socket layer', () => {
  it('rejects connections without a valid token', async () => {
    await expect(connect(undefined)).rejects.toThrow('UNAUTHORIZED');
    await expect(connect('garbage')).rejects.toThrow('UNAUTHORIZED');
    await expect(connect('x'.repeat(5000))).rejects.toThrow('UNAUTHORIZED');
  });

  it('tells a new connection it is not in a room', async () => {
    const c = await connect('tok-zed');
    const restore = await waitFor(() => lastOf(c, 'session:restore'));
    expect(restore).toEqual({ room: null, game: null });
  });

  it('runs a whole lobby-to-game flow over real WebSockets', async () => {
    const alice = await connect('tok-alice');
    const bob = await connect('tok-bob');

    // validation + payload-less calls
    expect((await ask(alice, 'room:join', { code: 'x' })).code).toBe('VALIDATION');
    expect((await ask(alice, 'room:create', { maxPlayers: 9 })).code).toBe('VALIDATION');
    expect((await ask(alice, 'room:create', { hacker: true })).code).toBe('VALIDATION');
    expect((await ask(alice, 'room:leave')).code).toBe('NOT_IN_ROOM');

    const created = await ask(alice, 'room:create', { settings: { turnSeconds: 0 } });
    expect(created.ok).toBe(true);
    const code = created.data.code as string;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);

    expect((await ask(bob, 'room:join', { code: 'QQQQQQ' })).code).toBe('ROOM_NOT_FOUND');
    expect((await ask(bob, 'room:join', { code: code.toLowerCase() })).ok).toBe(true);
    await waitFor(() => lastOf(alice, 'room:state')?.players.length === 2);

    expect((await ask(alice, 'room:start')).code).toBe('PLAYERS_NOT_READY');
    expect((await ask(bob, 'room:start')).code).toBe('NOT_HOST');
    expect((await ask(bob, 'room:ready', { ready: true })).ok).toBe(true);
    expect((await ask(alice, 'room:start')).ok).toBe(true);

    const a = await waitFor(() => lastOf(alice, 'game:update'));
    const b = await waitFor(() => lastOf(bob, 'game:update'));
    expect(a.state.you.hand).toHaveLength(7);
    expect(b.state.you.hand).toHaveLength(7);
    const aIds = new Set(a.state.you.hand.map((c: { id: string }) => c.id));
    for (const c of b.state.you.hand) expect(aIds.has(c.id)).toBe(false);
    expect(JSON.stringify(a)).not.toContain(b.state.you.hand[0].id);

    // the one whose turn it is acts; the other is refused
    const turn = a.state.turnPlayerId as string;
    const [actor, waiter, actorView] = turn === 'alice' ? [alice, bob, a] : [bob, alice, b];
    expect((await ask(waiter, 'game:draw')).code).toBe('NOT_YOUR_TURN');
    expect((await ask(actor, 'game:play', { cardId: 'c_9999' })).code).toBe('CARD_NOT_IN_HAND');
    expect((await ask(actor, 'game:play', { nope: 1 })).code).toBe('VALIDATION');

    const playable = actorView.state.you.playableCardIds as string[];
    const move = playable.length > 0
      ? await ask(actor, 'game:play', { cardId: playable[0], color: 'R', targetId: turn === 'alice' ? 'bob' : 'alice' })
      : await ask(actor, 'game:draw');
    expect(move.ok).toBe(true);
    const updated = await waitFor(() => (lastOf(waiter, 'game:update')?.state.version > a.state.version ? lastOf(waiter, 'game:update') : undefined));
    expect(updated.events.length).toBeGreaterThan(0);

    // there is no socket event that can force a timeout or a forfeit on someone
    const noAck = await Promise.race([ask(alice, 'game:timeout', { playerId: 'bob' }), new Promise((r) => setTimeout(() => r('ignored'), 300))]);
    expect(noAck).toBe('ignored');
  });

  it('a reconnecting player gets their room and their own hand back', async () => {
    const carol = await connect('tok-carol');
    const dave = await connect('tok-dave');
    const created = await ask(carol, 'room:create', { settings: { turnSeconds: 0 } });
    await ask(dave, 'room:join', { code: created.data.code });
    await ask(dave, 'room:ready', { ready: true });
    await ask(carol, 'room:start');
    const before = await waitFor(() => lastOf(dave, 'game:update'));

    dave.socket.close();
    await waitFor(() => lastOf(carol, 'room:state')?.players.find((p: { userId: string }) => p.userId === 'dave')?.connected === false);

    const dave2 = await connect('tok-dave');
    const restore = await waitFor(() => lastOf(dave2, 'session:restore'));
    expect(restore.room.code).toBe(created.data.code);
    expect(restore.game.state.you.hand).toEqual(before.state.you.hand);
    await waitFor(() => lastOf(carol, 'room:state')?.players.find((p: { userId: string }) => p.userId === 'dave')?.connected === true);
    expect((await ask(dave2, 'session:sync')).data.room.code).toBe(created.data.code);
  });

  it('rate-limits a flood of requests', async () => {
    const c = await connect('tok-spam');
    const answers = await Promise.all(Array.from({ length: 80 }, () => ask(c, 'session:sync')));
    expect(answers.some((a) => a.code === 'RATE_LIMITED')).toBe(true);
    expect(answers.filter((a) => a.ok).length).toBeLessThanOrEqual(40);
  });
});
