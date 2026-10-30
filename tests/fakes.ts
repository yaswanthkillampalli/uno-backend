import type { GameState } from '../src/game/types.js';
import type { Standing } from '../src/game/view.js';
import type { Notifier } from '../src/rooms/roomManager.js';
import type { PersistedRoom, RoomRepo } from '../src/rooms/roomRepo.js';
import type { RoomSettings } from '../src/rooms/types.js';

interface RoomRow {
  id: string;
  code: string;
  hostId: string;
  maxPlayers: number;
  settings: RoomSettings;
  status: 'lobby' | 'playing' | 'closed';
}
interface GameRow {
  id: string;
  roomId: string;
  state: GameState;
  status: 'playing' | 'finished' | 'aborted';
  results: Standing[];
}

/** In-memory stand-in for Supabase. */
export class FakeRepo implements RoomRepo {
  profiles = new Map<string, string>();
  rooms = new Map<string, RoomRow>();
  players = new Map<string, Map<string, { seat: number; isReady: boolean }>>();
  games = new Map<string, GameRow>();
  failWrites = false;

  private guard(): void {
    if (this.failWrites) throw new Error('database down');
  }

  async getProfile(userId: string) {
    const username = this.profiles.get(userId);
    return username ? { username } : null;
  }

  async insertRoom(room: { id: string; code: string; hostId: string; maxPlayers: number; settings: RoomSettings }) {
    this.guard();
    if ([...this.rooms.values()].some((r) => r.code === room.code)) return 'code_taken' as const;
    this.rooms.set(room.id, { ...room, status: 'lobby' });
    this.players.set(room.id, new Map());
    return 'ok' as const;
  }

  async updateRoom(
    id: string,
    patch: { status?: 'lobby' | 'playing' | 'closed'; hostId?: string; maxPlayers?: number; settings?: RoomSettings },
  ) {
    this.guard();
    const row = this.rooms.get(id);
    if (!row) throw new Error('no such room');
    Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  }

  async upsertRoomPlayer(roomId: string, userId: string, seat: number, isReady: boolean) {
    this.guard();
    this.players.get(roomId)?.set(userId, { seat, isReady });
  }

  async deleteRoomPlayer(roomId: string, userId: string) {
    this.guard();
    this.players.get(roomId)?.delete(userId);
  }

  async insertGame(game: { id: string; roomId: string; state: GameState }) {
    this.guard();
    this.games.set(game.id, { id: game.id, roomId: game.roomId, state: structuredClone(game.state), status: 'playing', results: [] });
  }

  async saveGame(id: string, state: GameState) {
    this.guard();
    const row = this.games.get(id);
    if (row) row.state = structuredClone(state);
  }

  async finishGame(id: string, state: GameState, standings: Standing[]) {
    this.guard();
    const row = this.games.get(id);
    if (row) Object.assign(row, { state: structuredClone(state), status: 'finished', results: standings });
  }

  async abortGame(id: string) {
    this.guard();
    const row = this.games.get(id);
    if (row) row.status = 'aborted';
  }

  async loadActiveRooms(): Promise<PersistedRoom[]> {
    return [...this.rooms.values()]
      .filter((r): r is RoomRow & { status: 'lobby' | 'playing' } => r.status !== 'closed')
      .map((r) => {
        const game = [...this.games.values()].find((g) => g.roomId === r.id && g.status === 'playing');
        return {
          id: r.id,
          code: r.code,
          hostId: r.hostId,
          status: r.status,
          maxPlayers: r.maxPlayers,
          settings: { ...r.settings },
          players: [...(this.players.get(r.id) ?? new Map()).entries()].map(([userId, p]) => ({
            userId,
            username: this.profiles.get(userId) ?? 'player',
            seat: p.seat,
            isReady: p.isReady,
          })),
          game: game ? { id: game.id, state: JSON.parse(JSON.stringify(game.state)) as unknown } : null,
        };
      });
  }
}

export interface Sent {
  userId: string;
  event: string;
  payload: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export class RecordingNotifier implements Notifier {
  sent: Sent[] = [];
  toUser(userId: string, event: string, payload: unknown): void {
    this.sent.push({ userId, event, payload: JSON.parse(JSON.stringify(payload)) });
  }
  /** Most recent message of this kind for this user. */
  last(userId: string, event: string): Sent['payload'] | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const s = this.sent[i];
      if (s && s.userId === userId && s.event === event) return s.payload;
    }
    return undefined;
  }
  all(userId: string, event: string): Sent['payload'][] {
    return this.sent.filter((s) => s.userId === userId && s.event === event).map((s) => s.payload);
  }
}
