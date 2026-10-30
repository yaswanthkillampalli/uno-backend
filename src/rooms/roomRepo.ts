import type { Standing } from '../game/view.js';
import type { GameState } from '../game/types.js';
import type { RoomSettings } from './types.js';

export interface PersistedRoom {
  id: string;
  code: string;
  hostId: string;
  status: 'lobby' | 'playing';
  maxPlayers: number;
  settings: RoomSettings;
  players: { userId: string; username: string; seat: number; isReady: boolean }[];
  /** The running game's snapshot, if any. `state` is untrusted JSON until validated. */
  game: { id: string; state: unknown } | null;
}

/** Everything the room manager needs from storage. Implemented by Supabase (and by a fake in tests). */
export interface RoomRepo {
  getProfile(userId: string): Promise<{ username: string } | null>;
  /** Resolves 'code_taken' if the room code already exists; throws on any other failure. */
  insertRoom(room: {
    id: string;
    code: string;
    hostId: string;
    maxPlayers: number;
    settings: RoomSettings;
  }): Promise<'ok' | 'code_taken'>;
  updateRoom(
    id: string,
    patch: { status?: 'lobby' | 'playing' | 'closed'; hostId?: string; maxPlayers?: number; settings?: RoomSettings },
  ): Promise<void>;
  upsertRoomPlayer(roomId: string, userId: string, seat: number, isReady: boolean): Promise<void>;
  deleteRoomPlayer(roomId: string, userId: string): Promise<void>;
  insertGame(game: { id: string; roomId: string; state: GameState }): Promise<void>;
  saveGame(id: string, state: GameState): Promise<void>;
  finishGame(id: string, state: GameState, standings: Standing[]): Promise<void>;
  abortGame(id: string): Promise<void>;
  loadActiveRooms(): Promise<PersistedRoom[]>;
}
