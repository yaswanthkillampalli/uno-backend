import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { RoomManager } from '../src/rooms/roomManager.js';
import { createSocketServer } from '../src/sockets/index.js';
import { SocketNotifier } from '../src/sockets/notifier.js';
import {
  connectPlayer,
  disconnectAll,
  playToEnd,
  restartScenario,
  setupGame,
  sleep,
  waitUntil,
  type Player,
} from '../scripts/flow.js';
import { FakeRepo } from './fakes.js';

interface Stack {
  http: HttpServer;
  io: Server;
  manager: RoomManager;
  url: string;
}

async function startStack(repo: FakeRepo, port = 0): Promise<Stack> {
  const notifier = new SocketNotifier();
  const manager = new RoomManager({ repo, notifier, graceMs: 60_000 });
  const http = createServer();
  const io = createSocketServer(http, {
    manager,
    notifier,
    corsOrigin: ['http://localhost:5173'],
    authenticate: async (token) => (token.startsWith('tok-') ? { id: token.slice(4), username: token.slice(4).toUpperCase() } : null),
  });
  await new Promise<void>((resolve) => http.listen(port, resolve));
  await manager.restore();
  return { http, io, manager, url: `http://localhost:${(http.address() as AddressInfo).port}` };
}

const stopStack = async (s: Stack): Promise<void> => {
  await s.manager.shutdown();
  await new Promise<void>((resolve) => s.io.close(() => resolve()));
};

const players = (n: number): Player[] =>
  ['ann', 'ben', 'cy', 'di'].slice(0, n).map((name) => ({ name, userId: name, token: `tok-${name}` }));

describe('smoke-test building blocks (against the fake database)', () => {
  it('plays full games to the end over real sockets, with 2, 3 and 4 players', async () => {
    for (const n of [2, 3, 4]) {
      const repo = new FakeRepo();
      for (const p of players(n)) repo.profiles.set(p.userId, p.name);
      const stack = await startStack(repo);
      const clients = await Promise.all(players(n).map((p) => connectPlayer(stack.url, p)));
      try {
        await setupGame(clients, { turnSeconds: 0 }, () => undefined);
        const moves = await playToEnd(clients, 3000, () => undefined);
        expect(moves).toBeGreaterThan(0);
        expect(clients.every((c) => c.game?.state.status === 'finished')).toBe(true);
        expect(new Set(clients.map((c) => c.game?.state.winnerId)).size).toBe(1);
        await stack.manager.flush();
        const game = [...repo.games.values()][0]!;
        expect(game.status).toBe('finished');
        expect(game.results).toHaveLength(n);
      } finally {
        disconnectAll(clients);
        await stopStack(stack);
      }
    }
  }, 60_000);

  it('survives a server restart: same room, same hand, and the game can be finished afterwards', async () => {
    const repo = new FakeRepo();
    for (const p of players(2)) repo.profiles.set(p.userId, p.name);
    let stack = await startStack(repo);
    const port = Number(new URL(stack.url).port);
    const clients = await Promise.all(players(2).map((p) => connectPlayer(stack.url, p)));
    try {
      await setupGame(clients, { turnSeconds: 0 }, () => undefined);
      const checks = await restartScenario(clients, () => undefined, async () => {
        await stopStack(stack);
        await sleep(200);
        stack = await startStack(repo, port); // same database, same port: a brand-new process in real life
      });
      const failed = checks.filter((c) => !c.ok);
      expect(failed).toEqual([]);
      expect(checks.length).toBe(8);

      await waitUntil(() => clients.every((c) => c.socket.connected), 5000, 'reconnected');
      await playToEnd(clients, 3000, () => undefined);
      await stack.manager.flush();
      expect([...repo.games.values()][0]?.status).toBe('finished');
    } finally {
      disconnectAll(clients);
      await stopStack(stack);
    }
  }, 60_000);
});
