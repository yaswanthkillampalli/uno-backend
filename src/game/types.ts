// Pure game types. This folder must never import sockets, Express or Supabase.

export const COLORS = ['R', 'Y', 'G', 'B'] as const;
export const NUMBER_TYPES = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'] as const;
export const ACTION_TYPES = ['d2', 'd4', 'sk', 'se', 'rv', 'da'] as const;
export const WILD_TYPES = ['w4r', 'w6', 'w10', 'cr'] as const;

export type Color = (typeof COLORS)[number];
export type CardColor = Color | 'W';
export type NumberType = (typeof NUMBER_TYPES)[number];
export type ActionType = (typeof ACTION_TYPES)[number];
export type WildType = (typeof WILD_TYPES)[number];
/**
 * n0..n9 numbers | d2 +2 | d4 +4 | sk Skip | se Skip All | rv Reverse |
 * da Discard All | w4r Reverse +4 | w6 +6 | w10 +10 | cr Color Roulette
 */
export type CardType = NumberType | ActionType | WildType;

export const isColor = (value: unknown): value is Color =>
  typeof value === 'string' && (COLORS as readonly string[]).includes(value);

export interface Card {
  /** Stable catalog id, "c_0" .. "c_167". Same card = same id in every game. */
  readonly id: string;
  readonly color: CardColor;
  readonly type: CardType;
}

export interface GameSettings {
  /** 7 = swap hands with a player of your choice, 0 = every hand moves one seat. */
  sevenZero: boolean;
  /** A player holding this many cards (or more) is eliminated (Mercy rule). */
  mercyLimit: number;
  handSize: number;
  /** Seconds a player has to act. 0 = no timer. The timer itself runs in the room layer. */
  turnSeconds: number;
  /** Timeouts a player can survive. Each one auto-draws them to the card limit (see 'timeout'). */
  lifelines: number;
}

export interface PlayerState {
  userId: string;
  name: string;
  hand: Card[];
  /** Timeouts this player can still survive. */
  lifelines: number;
  eliminated: boolean;
  eliminatedBy: 'mercy' | 'left' | 'timeout' | null;
  /** 0 for the first player eliminated, 1 for the next, and so on. */
  eliminatedOrder: number | null;
}

/** The game is paused waiting for this player to choose a color (Color Roulette). */
export interface RoulettePrompt {
  type: 'roulette_color';
  /** Index of the player who must choose (the victim). */
  by: number;
  /** Index of the player who played the Roulette card. */
  origin: number;
}
export type Prompt = RoulettePrompt;

export interface GameState {
  schemaVersion: 1;
  /** Incremented after every successful action. */
  version: number;
  status: 'playing' | 'finished';
  settings: GameSettings;
  /** Seat order. players[i] sits at seat i; direction 1 = increasing index. */
  players: PlayerState[];
  /** The TOP of the draw pile is the LAST element. */
  drawPile: Card[];
  /** The top card is the LAST element. */
  discardPile: Card[];
  currentIndex: number;
  direction: 1 | -1;
  activeColor: Color;
  pendingDraw: number;
  /** Value of the last draw card played. Stacking needs a card >= this. 0 if none pending. */
  lastDrawValue: number;
  /** After drawing, the one card the player must play. */
  mustPlayCardId: string | null;
  prompt: Prompt | null;
  eliminationCount: number;
  winnerId: string | null;
  endReason: 'empty_hand' | 'last_standing' | null;
}

// ---------- actions (what a client may ask for) -----------------------------
export type Action =
  | { type: 'play'; playerId: string; cardId: string; color?: Color; targetId?: string }
  | { type: 'draw'; playerId: string }
  | { type: 'takePenalty'; playerId: string }
  | { type: 'chooseRouletteColor'; playerId: string; color: Color }
  | { type: 'forfeit'; playerId: string }
  /**
   * SERVER ONLY. Sent by the room's turn timer when a player runs out of time. Never accept
   * this action from a socket: a client could otherwise time out other players.
   */
  | { type: 'timeout'; playerId: string };

export type ErrorCode =
  | 'GAME_OVER'
  | 'NOT_IN_GAME'
  | 'ELIMINATED'
  | 'NOT_YOUR_TURN'
  | 'PROMPT_PENDING'
  | 'NO_PROMPT'
  | 'NOT_YOUR_PROMPT'
  | 'CARD_NOT_IN_HAND'
  | 'MUST_PLAY_DRAWN_CARD'
  | 'CANNOT_PLAY'
  | 'COLOR_REQUIRED'
  | 'INVALID_TARGET'
  | 'PENALTY_PENDING'
  | 'NO_PENALTY'
  | 'HAS_PLAYABLE_CARD';

// ---------- events (what happened; broadcast to the room) -------------------
export type GameEvent =
  | { type: 'played'; playerId: string; card: Card }
  | { type: 'color_chosen'; playerId: string; color: Color }
  | { type: 'penalty_stacked'; amount: number; total: number }
  /** `cards` is PRIVATE to playerId. Use redactEvent() before sending to others. */
  | { type: 'drew'; playerId: string; count: number; reason: 'draw' | 'penalty' | 'roulette' | 'timeout'; cards?: Card[] }
  | { type: 'discarded_all'; playerId: string; color: Color; cards: Card[] }
  | { type: 'direction_reversed'; direction: 1 | -1 }
  | { type: 'skipped'; playerIds: string[] }
  | { type: 'hands_swapped'; playerId: string; targetId: string }
  | { type: 'hands_rotated' }
  | { type: 'roulette_started'; playerId: string; by: string }
  | { type: 'passed'; playerId: string }
  | { type: 'reshuffled' }
  | { type: 'timed_out'; playerId: string }
  /** A timeout cost one lifeline. The last card picked up was dropped to the discard pile (public). */
  | { type: 'lifeline_used'; playerId: string; remaining: number; dropped: Card[] }
  | { type: 'eliminated'; playerId: string; reason: 'mercy' | 'left' | 'timeout'; cardCount: number }
  | { type: 'game_over'; winnerId: string | null; reason: 'empty_hand' | 'last_standing' };

export interface ActionSuccess {
  ok: true;
  events: GameEvent[];
}
export interface ActionFailure {
  ok: false;
  code: ErrorCode;
  message: string;
}
export type ActionResult = ActionSuccess | ActionFailure;
