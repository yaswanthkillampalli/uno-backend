import { randomInt } from 'node:crypto';
import {
  ACTION_TYPES,
  COLORS,
  NUMBER_TYPES,
  WILD_TYPES,
  type Card,
  type CardColor,
  type CardType,
} from './types.js';

/** Returns a uniform integer in [0, maxExclusive). Inject a seeded one in tests. */
export type Rng = (maxExclusive: number) => number;
export const secureRng: Rng = (maxExclusive) => randomInt(maxExclusive);

/** Copies of each action card per color. */
const ACTION_COPIES: Record<(typeof ACTION_TYPES)[number], number> = {
  d2: 3,
  d4: 2,
  sk: 3,
  se: 2,
  rv: 3,
  da: 3,
};
/** Copies of each wild card. */
const WILD_COPIES: Record<(typeof WILD_TYPES)[number], number> = {
  w6: 4,
  w4r: 8,
  w10: 4,
  cr: 8,
};

function buildCatalog(): readonly Card[] {
  const cards: Card[] = [];
  const add = (color: CardColor, type: CardType, copies: number): void => {
    for (let i = 0; i < copies; i++) cards.push(Object.freeze({ id: `c_${cards.length}`, color, type }));
  };
  for (const color of COLORS) {
    for (const type of NUMBER_TYPES) add(color, type, 2);
    for (const type of ACTION_TYPES) add(color, type, ACTION_COPIES[type]);
  }
  for (const type of WILD_TYPES) add('W', type, WILD_COPIES[type]);
  return Object.freeze(cards);
}

/**
 * The fixed 168-card catalog. Order is stable: red (36), yellow (36),
 * green (36), blue (36), then wilds (24). A card's id never changes, so the
 * frontend can key its art/UI by id.
 */
export const CATALOG: readonly Card[] = buildCatalog();
export const DECK_SIZE = CATALOG.length; // 168

/** A fresh, unshuffled copy of the deck. */
export const newDeck = (): Card[] => [...CATALOG];

/** Fisher-Yates, in place. Returns the same array. */
export function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    const a = items[i] as T;
    const b = items[j] as T;
    items[i] = b;
    items[j] = a;
  }
  return items;
}
