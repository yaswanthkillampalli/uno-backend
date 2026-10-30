import { randomUUID } from 'node:crypto';
import { customAlphabet } from 'nanoid';
import { secureRng, type Rng } from '../game/deck.js';
import { applyAction, createGame } from '../game/engine.js';
import type { GameEvent, GameState } from '../game/types.js';
import { getStandings, redactEvent, viewFor } from '../game/view.js';
import { KeyedMutex } from '../utils/mutex.js';
import { logger } from '../utils/logger.js';
import type { PersistedRoom, RoomRepo } from './roomRepo.js';
import {
  DEFAULT_MAX_PLAYERS,
  DEFAULT_ROOM_SETTINGS,
  err,
  ok,
  type AuthUser,
  type ClientAction,
  type GamePayload,
  type LiveGame,
  type LiveRoom,
  type Member,
  type Result,
  type RoomSettings,
  type RoomView,
  type SessionPayload,
} from './types.js';

/** Sends a message to every open connection of one user. */
export interface Notifier {
  toUser(userId: string, event: string, payload: unknown): void;
}

export interface ManagerOptions {
  repo: RoomRepo;
  notifier: Notifier;
  /** How long a disconnected player keeps their seat. */
  graceMs?: number;
  now?: () => number;
  rng?: Rng;
  codeGenerator?: () => string;
}

// No 0/O/1/I so codes are easy to read out loud.
const makeCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

export class RoomManager {
  private readonly repo: RoomRepo;
  private readonly notifier: Notifier;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly rng: Rng;
  private readonly codeGenerator: () => string;

  private readonly byCode = new Map<string, LiveRoom>();
  private readonly userRoom = new Map<string, LiveRoom>();
  private readonly connections = new Map<string, number>();
  private readonly mutex = new KeyedMutex();
  private readonly inflight = new Set<Promise<void>>();

  constructor(options: ManagerOptions) {
    this.repo = options.repo;
    this.notifier = options.notifier;
    this.graceMs = options.graceMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.rng = options.rng ?? secureRng;
    this.codeGenerator = options.codeGenerator ?? makeCode;
  }

  // =========================================================================
  // Connections
  // =========================================================================
  connect(userId: string): void {
    this.connections.set(userId, (this.connections.get(userId) ?? 0) + 1);
    const room = this.userRoom.get(userId);
    const member = room?.members.get(userId);
    if (room && member) {
      this.clearGrace(member);
      this.broadcastRoom(room); // shows the player as online again
    }
    this.notifier.toUser(userId, 'session:restore', this.sessionFor(userId));
  }

  disconnect(userId: string): void {
    const remaining = (this.connections.get(userId) ?? 1) - 1;
    if (remaining > 0) {
      this.connections.set(userId, remaining);
      return;
    }
    this.connections.delete(userId);
    const room = this.userRoom.get(userId);
    const member = room?.members.get(userId);
    if (room && member) {
      this.startGrace(room, member);
      this.broadcastRoom(room);
    }
  }

  private isConnected(userId: string): boolean {
    return (this.connections.get(userId) ?? 0) > 0;
  }

  private startGrace(room: LiveRoom, member: Member): void {
    this.clearGrace(member);
    member.graceTimer = setTimeout(() => {
      member.graceTimer = null;
      if (room.closed || !room.members.has(member.userId) || this.isConnected(member.userId)) return;
      logger.info(`Grace period over, removing ${member.username} from room ${room.code}`);
      this.removeMember(room, member.userId, 'disconnected');
    }, this.graceMs);
  }

  private clearGrace(member: Member): void {
    if (member.graceTimer) clearTimeout(member.graceTimer);
    member.graceTimer = null;
  }

  // =========================================================================
  // Lobby
  // =========================================================================
  createRoom(
    user: AuthUser,
    input: { maxPlayers?: number | undefined; settings?: Partial<RoomSettings> | undefined } = {},
  ): Promise<Result<RoomView>> {
    return this.mutex.run(`user:${user.id}`, async () => {
      if (this.userRoom.has(user.id)) return err('ALREADY_IN_ROOM', 'Leave your current room first.');

      const settings: RoomSettings = { ...DEFAULT_ROOM_SETTINGS, ...stripUndefined(input.settings) };
      const maxPlayers = input.maxPlayers ?? DEFAULT_MAX_PLAYERS;
      const id = randomUUID();

      let code: string | null = null;
      for (let attempt = 0; attempt < 8 && code === null; attempt++) {
        const candidate = this.codeGenerator();
        if (this.byCode.has(candidate)) continue;
        const inserted = await this.repo.insertRoom({ id, code: candidate, hostId: user.id, maxPlayers, settings });
        if (inserted === 'ok') code = candidate;
      }
      if (code === null) return err('INTERNAL', 'Could not create a room code. Try again.');

      const room: LiveRoom = {
        id,
        code,
        hostId: user.id,
        maxPlayers,
        settings,
        members: new Map(),
        game: null,
        queue: Promise.resolve(),
        closed: false,
      };
      this.byCode.set(code, room);
      this.addMember(room, user, 0, true);
      this.broadcastRoom(room);
      return ok(this.roomView(room));
    });
  }

  joinRoom(user: AuthUser, rawCode: string): Result<RoomView> {
    const code = rawCode.trim().toUpperCase();
    const current = this.userRoom.get(user.id);
    if (current) {
      return current.code === code ? ok(this.roomView(current)) : err('ALREADY_IN_ROOM', 'Leave your current room first.');
    }
    const room = this.byCode.get(code);
    if (!room) return err('ROOM_NOT_FOUND', 'No room with that code.');
    if (this.phase(room) === 'playing') return err('ROOM_IN_PROGRESS', 'That game has already started.');
    if (room.members.size >= room.maxPlayers) return err('ROOM_FULL', 'That room is full.');

    const taken = new Set([...room.members.values()].map((m) => m.seat));
    let seat = 0;
    while (taken.has(seat)) seat++;
    this.addMember(room, user, seat, false);
    this.broadcastRoom(room);
    return ok(this.roomView(room));
  }

  leaveRoom(userId: string): Result {
    const room = this.userRoom.get(userId);
    if (!room) return err('NOT_IN_ROOM', 'You are not in a room.');
    this.removeMember(room, userId, 'left');
    return ok();
  }

  setReady(userId: string, ready: boolean): Result<RoomView> {
    const room = this.userRoom.get(userId);
    const member = room?.members.get(userId);
    if (!room || !member) return err('NOT_IN_ROOM', 'You are not in a room.');
    if (this.phase(room) === 'playing') return err('ROOM_IN_PROGRESS', 'The game has already started.');
    member.isReady = userId === room.hostId ? true : ready;
    this.persist(room, () => this.repo.upsertRoomPlayer(room.id, userId, member.seat, member.isReady));
    this.broadcastRoom(room);
    return ok(this.roomView(room));
  }

  updateSettings(
    userId: string,
    patch: { maxPlayers?: number | undefined; settings?: Partial<RoomSettings> | undefined },
  ): Result<RoomView> {
    const room = this.userRoom.get(userId);
    if (!room) return err('NOT_IN_ROOM', 'You are not in a room.');
    if (room.hostId !== userId) return err('NOT_HOST', 'Only the host can change settings.');
    if (this.phase(room) === 'playing') return err('ROOM_IN_PROGRESS', 'The game has already started.');
    if (patch.maxPlayers !== undefined && patch.maxPlayers < room.members.size) {
      return err('ROOM_TOO_SMALL', 'There are already more players than that in the room.');
    }
    if (patch.maxPlayers !== undefined) room.maxPlayers = patch.maxPlayers;
    room.settings = { ...room.settings, ...stripUndefined(patch.settings) };
    this.persist(room, () =>
      this.repo.updateRoom(room.id, { maxPlayers: room.maxPlayers, settings: { ...room.settings } }),
    );
    this.broadcastRoom(room);
    return ok(this.roomView(room));
  }

  private addMember(room: LiveRoom, user: AuthUser, seat: number, isReady: boolean): void {
    const member: Member = { userId: user.id, username: user.username, seat, isReady, graceTimer: null };
    room.members.set(user.id, member);
    this.userRoom.set(user.id, room);
    this.persist(room, () => this.repo.upsertRoomPlayer(room.id, user.id, seat, isReady));
  }

  /** Removes a player. Mid-game this is a forfeit (their cards go back to the draw pile). */
  private removeMember(room: LiveRoom, userId: string, reason: 'left' | 'disconnected'): void {
    const member = room.members.get(userId);
    if (!member) return;
    this.clearGrace(member);

    let forfeitEvents: GameEvent[] | null = null;
    const game = room.game;
    if (game && game.state.status === 'playing') {
      const result = applyAction(game.state, { type: 'forfeit', playerId: userId }, this.rng);
      if (result.ok) forfeitEvents = result.events;
    }

    room.members.delete(userId);
    this.userRoom.delete(userId);
    this.persist(room, () => this.repo.deleteRoomPlayer(room.id, userId));
    this.notifier.toUser(userId, 'room:left', { code: room.code, reason });

    if (room.members.size > 0 && room.hostId === userId) {
      const next = [...room.members.values()].sort((a, b) => a.seat - b.seat)[0];
      if (next) {
        room.hostId = next.userId;
        next.isReady = true;
        this.persist(room, () => this.repo.updateRoom(room.id, { hostId: next.userId }));
      }
    }

    if (forfeitEvents) this.afterAction(room, forfeitEvents);

    if (room.members.size === 0) {
      this.closeRoom(room);
      return;
    }
    this.broadcastRoom(room);
  }

  private closeRoom(room: LiveRoom): void {
    room.closed = true;
    this.clearTurnTimer(room);
    for (const member of room.members.values()) {
      this.clearGrace(member);
      this.userRoom.delete(member.userId);
    }
    room.members.clear();
    this.byCode.delete(room.code);
    const game = room.game;
    if (game && game.state.status === 'playing') this.persist(room, () => this.repo.abortGame(game.id));
    this.persist(room, () => this.repo.updateRoom(room.id, { status: 'closed' }));
  }

  // =========================================================================
  // Game
  // =========================================================================
  startGame(userId: string): Result<RoomView> {
    const room = this.userRoom.get(userId);
    if (!room) return err('NOT_IN_ROOM', 'You are not in a room.');
    if (room.hostId !== userId) return err('NOT_HOST', 'Only the host can start the game.');
    if (this.phase(room) === 'playing') return err('ROOM_IN_PROGRESS', 'The game has already started.');

    const members = this.sortedMembers(room);
    if (members.length < 2) return err('NOT_ENOUGH_PLAYERS', 'You need at least 2 players.');
    if (members.some((m) => m.userId !== room.hostId && !m.isReady)) {
      return err('PLAYERS_NOT_READY', 'Everyone has to be ready.');
    }
    if (members.some((m) => !this.isConnected(m.userId))) {
      return err('PLAYER_OFFLINE', 'A player is disconnected. Wait for them to come back or remove them.');
    }

    const state = createGame({
      players: members.map((m) => ({ userId: m.userId, name: m.username })),
      settings: { ...room.settings },
      rng: this.rng,
    });
    const game: LiveGame = { id: randomUUID(), state, deadlineAt: null, turnTimer: null, snapshotQueued: false };
    room.game = game;
    this.persist(room, () => this.repo.insertGame({ id: game.id, roomId: room.id, state }));
    this.persist(room, () => this.repo.updateRoom(room.id, { status: 'playing' }));

    this.armTimer(room);
    this.broadcastRoom(room);
    this.broadcastGame(room, []);
    return ok(this.roomView(room));
  }

  /** Apply a player's request. The player is whoever the authenticated socket belongs to. */
  gameAction(userId: string, action: ClientAction): Result {
    const room = this.userRoom.get(userId);
    if (!room) return err('NOT_IN_ROOM', 'You are not in a room.');
    const game = room.game;
    if (!game || game.state.status !== 'playing') return err('NOT_PLAYING', 'There is no game running.');

    const result = applyAction(game.state, { ...action, playerId: userId }, this.rng);
    if (!result.ok) return err(result.code, result.message);
    this.afterAction(room, result.events);
    return ok();
  }

  /** Runs after every successful change to the game state. */
  private afterAction(room: LiveRoom, events: GameEvent[]): void {
    const game = room.game;
    if (!game) return;
    if (game.state.status === 'finished') {
      this.clearTurnTimer(room);
      this.broadcastGame(room, events);
      this.onGameFinished(room, game);
      return;
    }
    this.armTimer(room); // sets the new deadline BEFORE we broadcast it
    this.broadcastGame(room, events);
    this.scheduleSnapshot(room, game);
  }

  private onGameFinished(room: LiveRoom, game: LiveGame): void {
    const standings = getStandings(game.state);
    this.persist(room, () => this.repo.finishGame(game.id, game.state, standings));
    if (!room.closed) {
      // Back to the lobby so the same group can play again.
      this.persist(room, () => this.repo.updateRoom(room.id, { status: 'lobby' }));
      for (const member of room.members.values()) {
        if (member.userId !== room.hostId) member.isReady = false;
        this.persist(room, () => this.repo.upsertRoomPlayer(room.id, member.userId, member.seat, member.isReady));
      }
      this.broadcastRoom(room);
    }
  }

  // ---------- turn timer ----------------------------------------------------
  private armTimer(room: LiveRoom): void {
    const game = room.game;
    if (!game) return;
    this.clearTurnTimer(room);
    const { state } = game;
    if (state.status !== 'playing' || state.settings.turnSeconds <= 0) return;

    const waitingIndex = state.prompt ? state.prompt.by : state.currentIndex;
    const waiting = state.players[waitingIndex];
    if (!waiting) return;

    const ms = state.settings.turnSeconds * 1000;
    const version = state.version;
    game.deadlineAt = this.now() + ms;
    game.turnTimer = setTimeout(() => this.onTurnTimeout(room, version, waiting.userId), ms);
  }

  private clearTurnTimer(room: LiveRoom): void {
    const game = room.game;
    if (!game) return;
    if (game.turnTimer) clearTimeout(game.turnTimer);
    game.turnTimer = null;
    game.deadlineAt = null;
  }

  private onTurnTimeout(room: LiveRoom, version: number, userId: string): void {
    const game = room.game;
    if (room.closed || !game || game.state.status !== 'playing') return;
    if (game.state.version !== version) return; // something happened since: this timer is stale
    game.turnTimer = null;

    const result = applyAction(game.state, { type: 'timeout', playerId: userId }, this.rng);
    if (!result.ok) {
      logger.error(`Timeout action failed in room ${room.code}: ${result.code}`);
      this.armTimer(room);
      return;
    }
    this.afterAction(room, result.events);
  }

  // ---------- snapshots -----------------------------------------------------
  /** Saves the latest state. If a save is already waiting in line, it will pick up the newest state. */
  private scheduleSnapshot(room: LiveRoom, game: LiveGame): void {
    if (game.snapshotQueued) return;
    game.snapshotQueued = true;
    this.persist(room, async () => {
      game.snapshotQueued = false;
      await this.repo.saveGame(game.id, game.state);
    });
  }

  // =========================================================================
  // Views and sending
  // =========================================================================
  private phase(room: LiveRoom): 'lobby' | 'playing' {
    return room.game?.state.status === 'playing' ? 'playing' : 'lobby';
  }

  private sortedMembers(room: LiveRoom): Member[] {
    return [...room.members.values()].sort((a, b) => a.seat - b.seat);
  }

  private roomView(room: LiveRoom): RoomView {
    return {
      code: room.code,
      phase: this.phase(room),
      hostId: room.hostId,
      maxPlayers: room.maxPlayers,
      settings: { ...room.settings },
      hasGame: room.game !== null,
      players: this.sortedMembers(room).map((m) => ({
        userId: m.userId,
        username: m.username,
        seat: m.seat,
        isReady: m.isReady,
        connected: this.isConnected(m.userId),
      })),
    };
  }

  private gamePayload(room: LiveRoom, userId: string, events: GameEvent[]): GamePayload | null {
    const game = room.game;
    if (!game) return null;
    return {
      events: events.map((e) => redactEvent(e, userId)),
      state: viewFor(game.state, userId),
      deadlineAt: game.deadlineAt,
      serverNow: this.now(),
    };
  }

  private sessionFor(userId: string): SessionPayload {
    const room = this.userRoom.get(userId);
    if (!room) return { room: null, game: null };
    return { room: this.roomView(room), game: this.gamePayload(room, userId, []) };
  }

  /** The caller's own room and game, for clients that lost track of them. */
  sync(userId: string): Result<SessionPayload> {
    return ok(this.sessionFor(userId));
  }

  private broadcastRoom(room: LiveRoom): void {
    const view = this.roomView(room);
    for (const member of room.members.values()) this.notifier.toUser(member.userId, 'room:state', view);
  }

  private broadcastGame(room: LiveRoom, events: GameEvent[]): void {
    for (const member of room.members.values()) {
      const payload = this.gamePayload(room, member.userId, events);
      if (payload) this.notifier.toUser(member.userId, 'game:update', payload);
    }
  }

  // =========================================================================
  // Persistence (write-behind: memory is the truth, the database follows)
  // =========================================================================
  private persist(room: LiveRoom, task: () => Promise<void>): void {
    const run = room.queue.then(task).catch((error: unknown) => {
      logger.error(`Database write failed for room ${room.code}`, error);
    });
    room.queue = run;
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }

  /** Resolves when every queued database write has finished. */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  // =========================================================================
  // Boot and shutdown
  // =========================================================================
  /** Rebuild rooms and running games after a server restart. Everyone starts offline with a grace period. */
  async restore(): Promise<{ rooms: number; games: number }> {
    const persisted = await this.repo.loadActiveRooms();
    let games = 0;
    for (const p of persisted) {
      const room = this.rebuildRoom(p);
      if (room.members.size === 0) {
        this.closeRoom(room);
        continue;
      }
      this.byCode.set(room.code, room);
      for (const member of room.members.values()) {
        this.userRoom.set(member.userId, room);
        this.startGrace(room, member);
      }
      if (room.game) {
        games++;
        this.armTimer(room);
      }
    }
    return { rooms: this.byCode.size, games };
  }

  private rebuildRoom(p: PersistedRoom): LiveRoom {
    const room: LiveRoom = {
      id: p.id,
      code: p.code,
      hostId: p.hostId,
      maxPlayers: p.maxPlayers,
      settings: p.settings,
      members: new Map(),
      game: null,
      queue: Promise.resolve(),
      closed: false,
    };
    for (const player of p.players) {
      room.members.set(player.userId, {
        userId: player.userId,
        username: player.username,
        seat: player.seat,
        isReady: player.isReady,
        graceTimer: null,
      });
    }
    if (!room.members.has(room.hostId)) {
      const first = [...room.members.values()].sort((a, b) => a.seat - b.seat)[0];
      if (first) room.hostId = first.userId;
    }

    if (p.game) {
      const state = parseGameState(p.game.state);
      if (state) {
        room.game = { id: p.game.id, state, deadlineAt: null, turnTimer: null, snapshotQueued: false };
      } else {
        logger.error(`Room ${p.code}: saved game ${p.game.id} is unreadable, aborting it`);
        const gameId = p.game.id;
        this.persist(room, () => this.repo.abortGame(gameId));
      }
    }
    if (p.status === 'playing' && !room.game) {
      this.persist(room, () => this.repo.updateRoom(room.id, { status: 'lobby' }));
    }
    return room;
  }

  /** Stop all timers. Rooms and games stay in the database and are restored on the next boot. */
  async shutdown(): Promise<void> {
    for (const room of this.byCode.values()) {
      this.clearTurnTimer(room);
      for (const member of room.members.values()) this.clearGrace(member);
    }
    await this.flush();
  }
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Minimal sanity check on a snapshot loaded from the database. */
function parseGameState(value: unknown): GameState | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Partial<GameState>;
  const valid =
    s.schemaVersion === 1 &&
    s.status === 'playing' &&
    Array.isArray(s.players) &&
    s.players.length >= 2 &&
    Array.isArray(s.drawPile) &&
    Array.isArray(s.discardPile) &&
    s.discardPile.length > 0 &&
    typeof s.currentIndex === 'number' &&
    typeof s.version === 'number';
  return valid ? (value as GameState) : null;
}
