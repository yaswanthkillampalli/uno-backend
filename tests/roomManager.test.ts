import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rng } from '../src/game/deck.js';
import { RoomManager } from '../src/rooms/roomManager.js';
import type { AuthUser, RoomSettings } from '../src/rooms/types.js';
import { COLORS } from '../src/game/types.js';
import { FakeRepo, RecordingNotifier } from './fakes.js';
import { seeded } from './helpers.js';

const user = (name: string): AuthUser => ({ id: name, username: name.toUpperCase() });
const alice = user('alice');
const bob = user('bob');
const cara = user('cara');

function setup(opts: { codes?: string[]; rng?: Rng } = {}) {
  const repo = new FakeRepo();
  for (const u of [alice, bob, cara]) repo.profiles.set(u.id, u.username);
  const notifier = new RecordingNotifier();
  const codes = [...(opts.codes ?? ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD'])];
  const manager = new RoomManager({
    repo,
    notifier,
    graceMs: 60_000,
    rng: opts.rng ?? seeded(5),
    codeGenerator: () => codes.shift() ?? 'ZZZZZZ',
  });
  return { repo, notifier, manager, codes };
}

/** alice hosts a room that bob (and cara) join; everyone is connected and ready. */
async function lobby(extra: { settings?: Partial<RoomSettings>; withCara?: boolean } = {}) {
  const ctx = setup();
  const { manager } = ctx;
  for (const u of [alice, bob, cara]) manager.connect(u.id);
  const created = await manager.createRoom(alice, { settings: extra.settings });
  if (!created.ok || !created.data) throw new Error('create failed');
  const code = created.data.code;
  manager.joinRoom(bob, code);
  manager.setReady(bob.id, true);
  if (extra.withCara) {
    manager.joinRoom(cara, code);
    manager.setReady(cara.id, true);
  }
  return { ...ctx, code };
}

const latestGame = (n: RecordingNotifier, id: string) => n.last(id, 'game:update');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('rooms', () => {
  it('creates a room, makes the creator host and saves it', async () => {
    const { manager, repo, notifier } = setup();
    manager.connect(alice.id);
    const r = await manager.createRoom(alice, {});
    expect(r.ok && r.data?.code).toBe('AAAAAA');
    expect(r.ok && r.data?.players).toEqual([
      { userId: 'alice', username: 'ALICE', seat: 0, isReady: true, connected: true },
    ]);
    expect(notifier.last('alice', 'room:state')?.hostId).toBe('alice');
    await manager.flush();
    expect([...repo.rooms.values()][0]).toMatchObject({ code: 'AAAAAA', hostId: 'alice', status: 'lobby', maxPlayers: 4 });
    expect([...repo.players.values()][0]?.get('alice')).toEqual({ seat: 0, isReady: true });
  });

  it('retries when a generated code is already taken', async () => {
    const { manager } = setup({ codes: ['AAAAAA', 'AAAAAA', 'BBBBBB'] });
    expect((await manager.createRoom(alice, {})).ok).toBe(true);
    const second = await manager.createRoom(bob, {});
    expect(second.ok && second.data?.code).toBe('BBBBBB');
  });

  it('one room per player', async () => {
    const { manager } = setup();
    await manager.createRoom(alice, {});
    const again = await manager.createRoom(alice, {});
    expect(!again.ok && again.code).toBe('ALREADY_IN_ROOM');
    const other = await manager.createRoom(bob, {});
    const join = manager.joinRoom(alice, other.ok && other.data ? other.data.code : '');
    expect(!join.ok && join.code).toBe('ALREADY_IN_ROOM');
  });

  it('two simultaneous creates by the same user make only one room', async () => {
    const { manager } = setup();
    const [a, b] = await Promise.all([manager.createRoom(alice, {}), manager.createRoom(alice, {})]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('join: codes are case-insensitive; unknown and full rooms are refused; joining twice is harmless', async () => {
    const { manager } = setup();
    await manager.createRoom(alice, { maxPlayers: 2 });
    expect(manager.joinRoom(bob, 'nope12').ok).toBe(false);
    const joined = manager.joinRoom(bob, 'aaaaaa');
    expect(joined.ok && joined.data?.players.map((p) => p.seat)).toEqual([0, 1]);
    expect(manager.joinRoom(bob, 'AAAAAA').ok).toBe(true);
    const full = manager.joinRoom(cara, 'AAAAAA');
    expect(!full.ok && full.code).toBe('ROOM_FULL');
  });

  it('a freed seat is reused and the host passes to the next player', async () => {
    const { manager, notifier } = setup();
    await manager.createRoom(alice, {});
    manager.joinRoom(bob, 'AAAAAA');
    manager.leaveRoom(alice.id);
    expect(notifier.last('bob', 'room:state')?.hostId).toBe('bob');
    expect(notifier.last('alice', 'room:left')).toMatchObject({ reason: 'left' });
    const joined = manager.joinRoom(cara, 'AAAAAA');
    expect(joined.ok && joined.data?.players.find((p) => p.userId === 'cara')?.seat).toBe(0);
  });

  it('the room closes when the last player leaves', async () => {
    const { manager, repo } = setup();
    await manager.createRoom(alice, {});
    manager.leaveRoom(alice.id);
    expect(manager.joinRoom(bob, 'AAAAAA').ok).toBe(false);
    await manager.flush();
    expect([...repo.rooms.values()][0]?.status).toBe('closed');
  });

  it('only the host changes settings, and not below the current player count', async () => {
    const { manager } = setup();
    await manager.createRoom(alice, {});
    manager.joinRoom(bob, 'AAAAAA');
    manager.joinRoom(cara, 'AAAAAA');
    const notHost = manager.updateSettings(bob.id, { settings: { turnSeconds: 10 } });
    expect(!notHost.ok && notHost.code).toBe('NOT_HOST');
    const tooSmall = manager.updateSettings(alice.id, { maxPlayers: 2 });
    expect(!tooSmall.ok && tooSmall.code).toBe('ROOM_TOO_SMALL');
    const good = manager.updateSettings(alice.id, { settings: { turnSeconds: 10, lifelines: 1 } });
    expect(good.ok && good.data?.settings).toEqual({ sevenZero: true, turnSeconds: 10, lifelines: 1 });
  });
});

describe('starting a game', () => {
  it('needs the host, 2+ players, everyone ready and everyone online', async () => {
    const { manager } = setup();
    manager.connect(alice.id);
    manager.connect(bob.id);
    await manager.createRoom(alice, {});
    expect((manager.startGame(alice.id) as { code: string }).code).toBe('NOT_ENOUGH_PLAYERS');
    manager.joinRoom(bob, 'AAAAAA');
    expect((manager.startGame(bob.id) as { code: string }).code).toBe('NOT_HOST');
    expect((manager.startGame(alice.id) as { code: string }).code).toBe('PLAYERS_NOT_READY');
    manager.setReady(bob.id, true);
    manager.disconnect(bob.id);
    expect((manager.startGame(alice.id) as { code: string }).code).toBe('PLAYER_OFFLINE');
    manager.connect(bob.id);
    expect(manager.startGame(alice.id).ok).toBe(true);
    expect((manager.startGame(alice.id) as { code: string }).code).toBe('ROOM_IN_PROGRESS');
    expect(manager.joinRoom(cara, 'AAAAAA').ok).toBe(false);
  });

  it('sends each player their own hand and only card COUNTS for the others', async () => {
    const { manager, notifier, repo } = await lobby({ withCara: true });
    manager.startGame(alice.id);
    await manager.flush();
    const full = [...repo.games.values()][0]!.state;

    for (const [i, id] of ['alice', 'bob', 'cara'].entries()) {
      const payload = latestGame(notifier, id);
      expect(payload.state.you.hand).toHaveLength(7);
      expect(payload.state.players.map((p: { cardCount: number }) => p.cardCount)).toEqual([7, 7, 7]);
      const json = JSON.stringify(payload);
      full.players.forEach((p, j) => {
        if (j === i) return;
        for (const c of p.hand) expect(json).not.toContain(`"${c.id}"`);
      });
      for (const c of full.drawPile) expect(json).not.toContain(`"${c.id}"`);
    }
  });

  it('saves the game and marks the room as playing', async () => {
    const { manager, repo } = await lobby();
    manager.startGame(alice.id);
    await manager.flush();
    expect([...repo.rooms.values()][0]?.status).toBe('playing');
    expect([...repo.games.values()]).toHaveLength(1);
    expect([...repo.games.values()][0]?.status).toBe('playing');
  });
});

describe('playing', () => {
  it('refuses a move from the wrong player and passes the engine error code through', async () => {
    const { manager, notifier } = await lobby();
    manager.startGame(alice.id);
    const waiting = latestGame(notifier, 'alice').state.turnPlayerId as string;
    const other = waiting === 'alice' ? 'bob' : 'alice';
    const r = manager.gameAction(other, { type: 'draw' });
    expect(!r.ok && r.code).toBe('NOT_YOUR_TURN');
  });

  it('refuses game actions outside a game', async () => {
    const { manager } = await lobby();
    const r = manager.gameAction(alice.id, { type: 'draw' });
    expect(!r.ok && r.code).toBe('NOT_PLAYING');
  });

  it('keeps the database snapshot in step with the live game', async () => {
    const { manager, notifier, repo } = await lobby();
    manager.startGame(alice.id);
    for (let i = 0; i < 6; i++) botMove(manager, notifier, ['alice', 'bob'], seeded(10 + i));
    await manager.flush();
    const live = latestGame(notifier, 'alice').state.version as number;
    expect([...repo.games.values()][0]?.state.version).toBe(live);
    expect(live).toBeGreaterThan(0);
  });
});

describe('turn timer and lifelines', () => {
  it('sends a deadline with every update', async () => {
    const { manager, notifier } = await lobby({ settings: { turnSeconds: 10 } });
    const t0 = Date.now();
    manager.startGame(alice.id);
    const p = latestGame(notifier, 'alice');
    expect(p.deadlineAt).toBe(t0 + 10_000);
    expect(p.serverNow).toBe(t0);
    expect(p.state.turnSeconds).toBe(10);
  });

  it('costs the waiting player a lifeline when the time runs out', async () => {
    const { manager, notifier } = await lobby({ settings: { turnSeconds: 10 } });
    manager.startGame(alice.id);
    const first = latestGame(notifier, 'alice').state.turnPlayerId as string;
    vi.advanceTimersByTime(10_000);
    const p = latestGame(notifier, 'alice');
    expect(p.events.map((e: { type: string }) => e.type)).toEqual(['timed_out', 'drew', 'lifeline_used']);
    const loser = p.state.players.find((x: { userId: string }) => x.userId === first);
    expect(loser.lifelines).toBe(2);
    expect(loser.cardCount).toBe(24);
    expect(p.state.turnPlayerId).not.toBe(first);
    expect(p.deadlineAt).toBe(Date.now() + 10_000); // a fresh timer for the next player
  });

  it("only the player who timed out sees which cards they were dealt", async () => {
    const { manager, notifier } = await lobby({ settings: { turnSeconds: 10 } });
    manager.startGame(alice.id);
    const first = latestGame(notifier, 'alice').state.turnPlayerId as string;
    const other = first === 'alice' ? 'bob' : 'alice';
    vi.advanceTimersByTime(10_000);
    const drewFor = (id: string) => latestGame(notifier, id).events.find((e: { type: string }) => e.type === 'drew');
    expect(drewFor(first).cards).toHaveLength(18);
    expect(drewFor(other)).not.toHaveProperty('cards');
    expect(drewFor(other).count).toBe(18);
  });

  it('acting in time cancels the old timer (no double penalty)', async () => {
    const { manager, notifier } = await lobby({ settings: { turnSeconds: 10 } });
    manager.startGame(alice.id);
    vi.advanceTimersByTime(5_000);
    botMove(manager, notifier, ['alice', 'bob'], seeded(3)); // someone acts at t=5s
    const versionAfterMove = latestGame(notifier, 'alice').state.version as number;
    vi.advanceTimersByTime(5_000); // t=10s: the ORIGINAL timer would have fired now
    expect(latestGame(notifier, 'alice').state.version).toBe(versionAfterMove);
    vi.advanceTimersByTime(5_001); // t=15s: the new timer fires
    expect(latestGame(notifier, 'alice').events.some((e: { type: string }) => e.type === 'timed_out')).toBe(true);
  });

  it('no timer when turnSeconds is 0', async () => {
    const { manager, notifier } = await lobby({ settings: { turnSeconds: 0 } });
    manager.startGame(alice.id);
    expect(latestGame(notifier, 'alice').deadlineAt).toBeNull();
    const v = latestGame(notifier, 'alice').state.version as number;
    vi.advanceTimersByTime(10 * 60_000);
    expect(latestGame(notifier, 'alice').state.version).toBe(v);
  });

  it('four timeouts in a row eliminate the player and the other one wins', async () => {
    const { manager, notifier, repo } = await lobby({ settings: { turnSeconds: 5, lifelines: 1 } });
    manager.startGame(alice.id);
    // Both players keep timing out; whoever runs out of lifelines first loses.
    for (let i = 0; i < 6 && latestGame(notifier, 'alice').state.status === 'playing'; i++) vi.advanceTimersByTime(5_000);
    const end = latestGame(notifier, 'alice').state;
    expect(end.status).toBe('finished');
    expect(end.endReason).toBe('last_standing');
    expect(end.deadlineAt).toBeUndefined();
    expect(latestGame(notifier, 'alice').deadlineAt).toBeNull();
    await manager.flush();
    expect([...repo.games.values()][0]?.status).toBe('finished');
  });
});

describe('disconnects', () => {
  it('a player who comes back within the grace period keeps their seat', async () => {
    const { manager, notifier } = await lobby();
    manager.disconnect(bob.id);
    expect(notifier.last('alice', 'room:state').players.find((p: { userId: string }) => p.userId === 'bob').connected).toBe(false);
    vi.advanceTimersByTime(59_000);
    manager.connect(bob.id);
    vi.advanceTimersByTime(120_000);
    expect(notifier.last('alice', 'room:state').players.map((p: { userId: string }) => p.userId)).toEqual(['alice', 'bob']);
    expect(notifier.last('bob', 'room:state').players.find((p: { userId: string }) => p.userId === 'bob').connected).toBe(true);
  });

  it('several open tabs: the player only counts as gone when the last one closes', async () => {
    const { manager } = await lobby();
    manager.connect(bob.id); // second tab
    manager.disconnect(bob.id); // one tab closes
    vi.advanceTimersByTime(120_000);
    const r = manager.joinRoom(bob, 'AAAAAA');
    expect(r.ok && r.data?.players.map((p) => p.userId)).toContain('bob');
  });

  it('in the lobby, a player who stays away is removed after the grace period', async () => {
    const { manager, notifier } = await lobby();
    manager.disconnect(bob.id);
    vi.advanceTimersByTime(60_001);
    expect(notifier.last('alice', 'room:state').players.map((p: { userId: string }) => p.userId)).toEqual(['alice']);
    expect(notifier.last('bob', 'room:left')).toMatchObject({ reason: 'disconnected' });
  });

  it('in a game, a player who stays away forfeits and the game goes on without them', async () => {
    const { manager, notifier } = await lobby({ withCara: true, settings: { turnSeconds: 0 } });
    manager.startGame(alice.id);
    manager.disconnect(cara.id);
    vi.advanceTimersByTime(60_001);
    const s = latestGame(notifier, 'alice').state;
    expect(s.status).toBe('playing');
    expect(s.players.find((p: { userId: string }) => p.userId === 'cara')).toMatchObject({ eliminated: true, eliminatedBy: 'left' });
    expect(notifier.last('alice', 'room:state').players.map((p: { userId: string }) => p.userId)).toEqual(['alice', 'bob']);
  });

  it('leaving a 2-player game hands the win to the other player, saves the result and reopens the lobby', async () => {
    const { manager, notifier, repo } = await lobby({ settings: { turnSeconds: 0 } });
    manager.startGame(alice.id);
    manager.leaveRoom(bob.id);
    const end = latestGame(notifier, 'alice');
    expect(end.state.status).toBe('finished');
    expect(end.state.winnerId).toBe('alice');
    expect(end.state.standings.map((s: { userId: string }) => s.userId)).toEqual(['alice', 'bob']);
    const room = notifier.last('alice', 'room:state');
    expect(room.phase).toBe('lobby');
    expect(room.hasGame).toBe(true);
    await manager.flush();
    const saved = [...repo.games.values()][0]!;
    expect(saved.status).toBe('finished');
    expect(saved.results.map((r) => [r.userId, r.placement])).toEqual([['alice', 1], ['bob', 2]]);
    expect([...repo.rooms.values()][0]?.status).toBe('lobby');
  });

  it('the host can start another game after one ends, and a new game replaces the old one', async () => {
    const { manager, notifier } = await lobby({ settings: { turnSeconds: 0 } });
    manager.startGame(alice.id);
    manager.leaveRoom(bob.id);
    manager.joinRoom(bob, 'AAAAAA');
    expect((manager.startGame(alice.id) as { code: string }).code).toBe('PLAYERS_NOT_READY'); // ready flags were reset
    manager.setReady(bob.id, true);
    expect(manager.startGame(alice.id).ok).toBe(true);
    expect(latestGame(notifier, 'alice').state.status).toBe('playing');
  });
});

describe('restart recovery', () => {
  it('restores rooms and the running game from the database', async () => {
    const { manager, repo } = await lobby({ settings: { turnSeconds: 10 } });
    manager.startGame(alice.id);
    await manager.flush();

    // ---- "server restarts": a brand-new manager reads the same database ----
    const notifier2 = new RecordingNotifier();
    const manager2 = new RoomManager({ repo, notifier: notifier2, graceMs: 60_000, rng: seeded(9) });
    expect(await manager2.restore()).toEqual({ rooms: 1, games: 1 });

    manager2.connect(alice.id);
    const session = notifier2.last('alice', 'session:restore');
    expect(session.room.code).toBe('AAAAAA');
    expect(session.room.phase).toBe('playing');
    expect(session.game.state.you.hand).toHaveLength(7);
    expect(session.game.deadlineAt).toBe(Date.now() + 10_000);

    // the turn timer works again after a restore
    vi.advanceTimersByTime(10_000);
    expect(notifier2.last('alice', 'game:update').events.some((e: { type: string }) => e.type === 'timed_out')).toBe(true);
  });

  it('players who never come back after a restart are removed', async () => {
    const { manager, repo } = await lobby({ settings: { turnSeconds: 0 } });
    manager.startGame(alice.id);
    await manager.flush();
    const manager2 = new RoomManager({ repo, notifier: new RecordingNotifier(), graceMs: 60_000 });
    await manager2.restore();
    vi.advanceTimersByTime(60_001);
    await manager2.flush();
    expect([...repo.rooms.values()][0]?.status).toBe('closed');
  });

  it('aborts a saved game that cannot be read', async () => {
    const { manager, repo } = await lobby();
    manager.startGame(alice.id);
    await manager.flush();
    [...repo.games.values()][0]!.state = { garbage: true } as never;
    const manager2 = new RoomManager({ repo, notifier: new RecordingNotifier(), graceMs: 60_000 });
    expect(await manager2.restore()).toEqual({ rooms: 1, games: 0 });
    await manager2.flush();
    expect([...repo.games.values()][0]?.status).toBe('aborted');
    expect([...repo.rooms.values()][0]?.status).toBe('lobby');
  });
});

describe('database trouble', () => {
  it('the game keeps running in memory if a database write fails', async () => {
    const { manager, notifier, repo } = await lobby({ settings: { turnSeconds: 0 } });
    manager.startGame(alice.id);
    await manager.flush();
    repo.failWrites = true;
    botMove(manager, notifier, ['alice', 'bob'], seeded(1));
    await manager.flush();
    expect(latestGame(notifier, 'alice').state.version).toBe(1);
    expect([...repo.games.values()][0]?.state.version).toBe(0); // not saved, but nobody noticed
  });
});

describe('whole games through the manager', () => {
  it('bots play 2-4 player games to the end (with real rules, lifelines and timers off)', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const repo = new FakeRepo();
      const notifier = new RecordingNotifier();
      const manager = new RoomManager({ repo, notifier, graceMs: 60_000, rng: seeded(seed), codeGenerator: () => 'GAMEAA' });
      const ids = ['p0', 'p1', 'p2', 'p3'].slice(0, 2 + (seed % 3));
      for (const id of ids) {
        repo.profiles.set(id, id);
        manager.connect(id);
      }
      await manager.createRoom({ id: ids[0]!, username: 'p0' }, { settings: { turnSeconds: 0 } });
      for (const id of ids.slice(1)) {
        manager.joinRoom({ id, username: id }, 'GAMEAA');
        manager.setReady(id, true);
      }
      expect(manager.startGame(ids[0]!).ok).toBe(true);

      const r = seeded(seed * 77);
      let moves = 0;
      while (notifier.last(ids[0]!, 'game:update').state.status === 'playing') {
        if (++moves > 4000) throw new Error(`seed ${seed}: did not finish`);
        botMove(manager, notifier, ids, r);
      }
      await manager.flush();
      const saved = [...repo.games.values()][0]!;
      expect(saved.status).toBe('finished');
      expect(saved.results).toHaveLength(ids.length);
      expect(saved.results[0]?.placement).toBe(1);
      expect(notifier.last(ids[0]!, 'room:state').phase).toBe('lobby');
    }
  });
});

/** Make whoever is waited on take a legal action, using only what that player is shown. */
function botMove(manager: RoomManager, notifier: RecordingNotifier, ids: string[], r: Rng): void {
  for (const id of ids) {
    const payload = notifier.last(id, 'game:update');
    if (!payload) continue;
    const s = payload.state;
    if (s.status !== 'playing' || s.turnPlayerId !== id) continue;
    const you = s.you;
    const others = s.players.filter((p: { userId: string; eliminated: boolean }) => p.userId !== id && !p.eliminated);
    let result;
    if (s.prompt) {
      result = manager.gameAction(id, { type: 'chooseRouletteColor', color: COLORS[r(4)] ?? 'R' });
    } else if (you.playableCardIds.length > 0 && !(you.canTakePenalty && r(5) === 0)) {
      result = manager.gameAction(id, {
        type: 'play',
        cardId: you.playableCardIds[r(you.playableCardIds.length)],
        color: COLORS[r(4)] ?? 'R',
        targetId: others[r(others.length)]?.userId,
      });
    } else if (you.canTakePenalty) {
      result = manager.gameAction(id, { type: 'takePenalty' });
    } else {
      result = manager.gameAction(id, { type: 'draw' });
    }
    if (!result.ok) throw new Error(`bot move rejected: ${result.code} ${result.message}`);
    return;
  }
  throw new Error('nobody is waiting to act');
}
