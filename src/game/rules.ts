import {
  ACTION_TYPES,
  NUMBER_TYPES,
  WILD_TYPES,
  type Card,
  type CardType,
  type Color,
} from './types.js';

export const isNumberType = (t: CardType): boolean => (NUMBER_TYPES as readonly string[]).includes(t);
export const isWildType = (t: CardType): boolean => (WILD_TYPES as readonly string[]).includes(t);
/** "Power" cards: every action card and every wild card (not plain numbers). */
export const isPowerType = (t: CardType): boolean =>
  (ACTION_TYPES as readonly string[]).includes(t) || isWildType(t);

const DRAW_VALUE: Partial<Record<CardType, number>> = { d2: 2, d4: 4, w4r: 4, w6: 6, w10: 10 };
/** Penalty value of a draw card, 0 for everything else. */
export const drawValue = (t: CardType): number => DRAW_VALUE[t] ?? 0;

/** Wilds where the player who plays the card picks the color. (Roulette is chosen by the victim.) */
export const needsColorChoice = (t: CardType): boolean => t === 'w4r' || t === 'w6' || t === 'w10';

export interface PlayContext {
  top: Card;
  activeColor: Color;
  pendingDraw: number;
  lastDrawValue: number;
}

export type PlayCheck = { ok: true } | { ok: false; message: string };
const OK: PlayCheck = { ok: true };
const no = (message: string): PlayCheck => ({ ok: false, message });

const COLOR_NAME: Record<Color, string> = { R: 'Red', Y: 'Yellow', G: 'Green', B: 'Blue' };

/** Can `card` be played right now? Official rule: match the top card's color, number or symbol. */
export function checkPlay(card: Card, ctx: PlayContext): PlayCheck {
  // 1. A penalty is pending: only a draw card of equal or higher value (any color) may be stacked.
  if (ctx.pendingDraw > 0) {
    const value = drawValue(card.type);
    return value > 0 && value >= ctx.lastDrawValue
      ? OK
      : no(
          `A penalty of ${ctx.pendingDraw} is pending. Only a draw card with value ${ctx.lastDrawValue} or higher (any color) can be stacked, or take the penalty.`,
        );
  }
  // 2. Wilds are always playable.
  if (card.color === 'W') return OK;
  // 3. Numbers: match the active color, or the same number as the top card.
  if (isNumberType(card.type)) {
    return card.color === ctx.activeColor || (isNumberType(ctx.top.type) && card.type === ctx.top.type)
      ? OK
      : no(`Number card must match the active color (${COLOR_NAME[ctx.activeColor]}) or the top number.`);
  }
  // 4. Colored action cards: match the active color, or the same symbol as the top card
  //    (Skip on Skip, Reverse on Reverse, ... in any color). After a wild, only the chosen color counts.
  return card.color === ctx.activeColor || card.type === ctx.top.type
    ? OK
    : no(
        `Action cards need the active color (${COLOR_NAME[ctx.activeColor]}) or the same symbol as the top card.`,
      );
}

export const playableCards = (hand: readonly Card[], ctx: PlayContext): Card[] =>
  hand.filter((card) => checkPlay(card, ctx).ok);
