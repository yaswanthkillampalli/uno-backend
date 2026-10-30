import { DEFAULT_SETTINGS } from '../src/game/engine.js';
import type { Rng } from '../src/game/deck.js';
import type { Card, CardColor, CardType, Color, GameSettings, GameState } from '../src/game/types.js';

let seq = 0;
/** A card with a unique test id. */
export const card = (color: CardColor, type: CardType): Card => ({ id: `t_${++seq}`, color, type });

/** Deterministic RNG (mulberry32). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return (max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

export const filler = (n: number): Card[] => Array.from({ length: n }, () => card('Y', 'n1'));

export interface MakeOptions {
  hands: Card[][];
  top?: Card;
  active?: Color;
  current?: number;
  direction?: 1 | -1;
  pending?: number;
  last?: number;
  /** The LAST element is the top of the pile. */
  drawPile?: Card[];
  discardBelow?: Card[];
  settings?: Partial<GameSettings>;
}

/** Builds an exact game state for a rule test. Players are u0, u1, ... */
export function makeState(o: MakeOptions): GameState {
  const top = o.top ?? card('R', 'n5');
  return {
    schemaVersion: 1,
    version: 0,
    status: 'playing',
    settings: { ...DEFAULT_SETTINGS, ...o.settings },
    players: o.hands.map((hand, i) => ({
      userId: `u${i}`,
      name: `P${i}`,
      hand: [...hand],
      lifelines: o.settings?.lifelines ?? DEFAULT_SETTINGS.lifelines,
      eliminated: false,
      eliminatedBy: null,
      eliminatedOrder: null,
    })),
    drawPile: o.drawPile ?? filler(60),
    discardPile: [...(o.discardBelow ?? []), top],
    currentIndex: o.current ?? 0,
    direction: o.direction ?? 1,
    activeColor: o.active ?? (top.color === 'W' ? 'R' : top.color),
    pendingDraw: o.pending ?? 0,
    lastDrawValue: o.last ?? 0,
    mustPlayCardId: null,
    prompt: null,
    eliminationCount: 0,
    winnerId: null,
    endReason: null,
  };
}
