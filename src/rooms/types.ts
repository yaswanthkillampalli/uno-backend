import type { GameEvent, GameState } from '../game/types.js';
import type { GameView } from '../game/view.js';

export interface RoomSettings {
  sevenZero: boolean;
  /** Seconds per turn. 0 = no timer. */
  turnSeconds: number;
  lifelines: number;
}
export const DEFAULT_ROOM_SETTINGS: RoomSettings = { sevenZero: true, turnSeconds: 20, lifelines: 3 };
export const DEFAULT_MAX_PLAYERS = 4;

export interface AuthUser {
  id: string;
  username: string;
}

// ---------- results returned to socket acks ---------------------------------
export interface Failure {
  ok: false;
  code: string;
  message: string;
}
export type Result<T = undefined> = { ok: true; data?: T } | Failure;
export const ok = <T = undefined>(data?: T): Result<T> => (data === undefined ? { ok: true } : { ok: true, data });
export const err = (code: string, message: string): Failure => ({ ok: false, code, message });

// ---------- what clients receive --------------------------------------------
export interface RoomPlayerView {
  userId: string;
  username: string;
  seat: number;
  isReady: boolean;
  connected: boolean;
}
export interface RoomView {
  code: string;
  phase: 'lobby' | 'playing';
  hostId: string;
  maxPlayers: number;
  settings: RoomSettings;
  players: RoomPlayerView[];
  /** True once a game has been started in this room (the last one stays readable after it ends). */
  hasGame: boolean;
}
export interface GamePayload {
  /** What just happened, with other players' drawn cards removed. Empty on a plain sync. */
  events: GameEvent[];
  state: GameView;
  /** Epoch ms when the player being waited on runs out of time. null if no timer. */
  deadlineAt: number | null;
  /** Server clock at send time, so the client can correct for clock differences. */
  serverNow: number;
}
export interface SessionPayload {
  room: RoomView | null;
  game: GamePayload | null;
}

// ---------- server-side live objects ----------------------------------------
export type Timer = ReturnType<typeof setTimeout>;

export interface Member {
  userId: string;
  username: string;
  seat: number;
  isReady: boolean;
  /** Running while the player has no open connection. When it fires they leave / forfeit. */
  graceTimer: Timer | null;
}

export interface LiveGame {
  id: string;
  state: GameState;
  deadlineAt: number | null;
  turnTimer: Timer | null;
  snapshotQueued: boolean;
}

export interface LiveRoom {
  id: string;
  code: string;
  hostId: string;
  maxPlayers: number;
  settings: RoomSettings;
  members: Map<string, Member>;
  game: LiveGame | null;
  /** Database writes for this room run one after another through this chain. */
  queue: Promise<void>;
  closed: boolean;
}

/** What a client may ask the game to do. The player is always the authenticated socket's user. */
export type ClientAction =
  | { type: 'play'; cardId: string; color?: 'R' | 'Y' | 'G' | 'B' | undefined; targetId?: string | undefined }
  | { type: 'draw' }
  | { type: 'takePenalty' }
  | { type: 'chooseRouletteColor'; color: 'R' | 'Y' | 'G' | 'B' };
