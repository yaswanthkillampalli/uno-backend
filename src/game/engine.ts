import { newDeck, secureRng, shuffle, type Rng } from './deck.js';
import {
  checkPlay,
  drawValue,
  isNumberType,
  needsColorChoice,
  playableCards,
  type PlayContext,
} from './rules.js';
import {
  isColor,
  type Action,
  type ActionFailure,
  type ActionResult,
  type Card,
  type Color,
  type GameEvent,
  type GameSettings,
  type GameState,
  type PlayerState,
} from './types.js';

export const DEFAULT_SETTINGS: GameSettings = {
  sevenZero: true,
  mercyLimit: 25,
  handSize: 7,
  turnSeconds: 20,
  lifelines: 3,
};
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

const fail = (code: ActionFailure['code'], message: string): ActionFailure => ({ ok: false, code, message });

// ---------- small state helpers (exported for view.ts and tests) ------------
export function requirePlayer(state: GameState, index: number): PlayerState {
  const player = state.players[index];
  if (!player) throw new Error(`Invariant broken: no player at index ${index}`);
  return player;
}

export function topCard(state: GameState): Card {
  const card = state.discardPile[state.discardPile.length - 1];
  if (!card) throw new Error('Invariant broken: empty discard pile');
  return card;
}

export const playContext = (state: GameState): PlayContext => ({
  top: topCard(state),
  activeColor: state.activeColor,
  pendingDraw: state.pendingDraw,
  lastDrawValue: state.lastDrawValue,
});

export const aliveIndexes = (state: GameState): number[] =>
  state.players.flatMap((p, i) => (p.eliminated ? [] : [i]));

/** The next living player after `from`, in the current direction. `count` > 1 skips players. */
export function nextIndex(state: GameState, from: number, count = 1): number {
  const n = state.players.length;
  let i = from;
  for (let k = 0; k < count; k++) {
    do {
      i = (i + state.direction + n) % n;
    } while (requirePlayer(state, i).eliminated && i !== from);
  }
  return i;
}

// ---------- creating a game --------------------------------------------------
export interface NewPlayer {
  userId: string;
  name: string;
}

export function createGame(options: {
  players: NewPlayer[];
  settings?: Partial<GameSettings>;
  rng?: Rng;
  /** Index of the first player. Random if omitted. */
  startIndex?: number;
}): GameState {
  const rng = options.rng ?? secureRng;
  const settings: GameSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const { players } = options;

  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new Error(`A game needs ${MIN_PLAYERS}-${MAX_PLAYERS} players, got ${players.length}.`);
  }
  if (new Set(players.map((p) => p.userId)).size !== players.length) {
    throw new Error('Duplicate player ids.');
  }
  if (settings.mercyLimit <= settings.handSize) {
    throw new Error('mercyLimit must be larger than handSize.');
  }
  if (settings.turnSeconds !== 0 && !(Number.isInteger(settings.turnSeconds) && settings.turnSeconds >= 5 && settings.turnSeconds <= 300)) {
    throw new Error('turnSeconds must be 0 (no timer) or a whole number from 5 to 300.');
  }
  if (!Number.isInteger(settings.lifelines) || settings.lifelines < 0 || settings.lifelines > 10) {
    throw new Error('lifelines must be a whole number from 0 to 10.');
  }

  const drawPile = shuffle(newDeck(), rng);
  const states: PlayerState[] = players.map((p) => ({
    userId: p.userId,
    name: p.name,
    hand: [],
    lifelines: settings.lifelines,
    eliminated: false,
    eliminatedBy: null,
    eliminatedOrder: null,
  }));

  for (let round = 0; round < settings.handSize; round++) {
    for (const player of states) {
      const card = drawPile.pop();
      if (!card) throw new Error('Deck ran out while dealing.');
      player.hand.push(card);
    }
  }

  // The starting card must be a plain number card. Pick the one nearest the top of the pile.
  const startAt = drawPile.findLastIndex((c) => isNumberType(c.type));
  const [start] = drawPile.splice(startAt, 1);
  if (!start || start.color === 'W') throw new Error('Could not find a starting number card.');

  return {
    schemaVersion: 1,
    version: 0,
    status: 'playing',
    settings,
    players: states,
    drawPile,
    discardPile: [start],
    currentIndex: options.startIndex ?? rng(players.length),
    direction: 1,
    activeColor: start.color,
    pendingDraw: 0,
    lastDrawValue: 0,
    mustPlayCardId: null,
    prompt: null,
    eliminationCount: 0,
    winnerId: null,
    endReason: null,
  };
}

// ---------- drawing, reshuffling, elimination ------------------------------
interface Ctx {
  state: GameState;
  index: number;
  rng: Rng;
  events: GameEvent[];
}

function reshuffleDiscard(state: GameState, rng: Rng, events: GameEvent[]): void {
  if (state.discardPile.length <= 1) return;
  const top = state.discardPile.pop();
  if (!top) return;
  state.drawPile.push(...state.discardPile);
  state.discardPile.length = 0;
  state.discardPile.push(top);
  shuffle(state.drawPile, rng);
  events.push({ type: 'reshuffled' });
}

function drawOne(state: GameState, rng: Rng, events: GameEvent[]): Card | null {
  if (state.drawPile.length === 0) reshuffleDiscard(state, rng, events);
  return state.drawPile.pop() ?? null;
}

/**
 * Give cards to a player until `done` says stop, the pile is empty, or the
 * player hits the mercy limit (they are eliminated anyway, so drawing more is pointless).
 */
function drawInto(
  { state, rng, events }: Pick<Ctx, 'state' | 'rng' | 'events'>,
  index: number,
  done: (card: Card, drawnSoFar: number) => boolean,
): { cards: Card[]; done: boolean } {
  const player = requirePlayer(state, index);
  const cards: Card[] = [];
  while (player.hand.length < state.settings.mercyLimit) {
    const card = drawOne(state, rng, events);
    if (!card) break;
    player.hand.push(card);
    cards.push(card);
    if (done(card, cards.length)) return { cards, done: true };
  }
  return { cards, done: false };
}

function drawCount(c: Pick<Ctx, 'state' | 'rng' | 'events'>, index: number, count: number): Card[] {
  if (count <= 0) return [];
  return drawInto(c, index, (_card, n) => n >= count).cards;
}

function eliminate(
  c: Pick<Ctx, 'state' | 'rng' | 'events'>,
  index: number,
  reason: 'mercy' | 'left' | 'timeout',
): void {
  const { state, rng, events } = c;
  const player = requirePlayer(state, index);
  if (player.eliminated) return;
  const cardCount = player.hand.length;
  // The eliminated player's cards go back into the draw pile.
  state.drawPile.push(...player.hand);
  player.hand = [];
  shuffle(state.drawPile, rng);
  player.eliminated = true;
  player.eliminatedBy = reason;
  player.eliminatedOrder = state.eliminationCount++;
  events.push({ type: 'eliminated', playerId: player.userId, reason, cardCount });
}

/** Put cards under the top of the discard pile, so the top card and active color stay the same. */
function dropUnderTop(state: GameState, cards: Card[]): void {
  const top = state.discardPile.pop();
  if (top) state.discardPile.push(...cards, top);
  else state.discardPile.push(...cards);
}

function addPenalty(state: GameState, amount: number, events: GameEvent[]): void {
  state.pendingDraw += amount;
  state.lastDrawValue = amount;
  events.push({ type: 'penalty_stacked', amount, total: state.pendingDraw });
}

/** Runs after every action that finishes a turn: Mercy rule, win check, turn repair. */
function finalize(c: Pick<Ctx, 'state' | 'rng' | 'events'>): void {
  const { state, events } = c;

  // Mercy rule.
  state.players.forEach((player, i) => {
    if (!player.eliminated && player.hand.length >= state.settings.mercyLimit) eliminate(c, i, 'mercy');
  });

  // A paused Roulette whose victim is gone just moves on to the next player.
  if (state.prompt && requirePlayer(state, state.prompt.by).eliminated) {
    const { origin } = state.prompt;
    state.prompt = null;
    state.currentIndex = nextIndex(state, origin);
  }

  // Win check. An empty hand wins (not while a Roulette is still resolving).
  const alive = aliveIndexes(state);
  const emptyHand = state.prompt ? undefined : alive.find((i) => requirePlayer(state, i).hand.length === 0);
  const winnerIndex = emptyHand ?? (alive.length === 1 ? alive[0] : undefined);
  if (winnerIndex !== undefined) {
    const winner = requirePlayer(state, winnerIndex);
    const reason = emptyHand !== undefined ? 'empty_hand' : 'last_standing';
    state.status = 'finished';
    state.winnerId = winner.userId;
    state.endReason = reason;
    state.prompt = null;
    state.pendingDraw = 0;
    state.lastDrawValue = 0;
    state.mustPlayCardId = null;
    events.push({ type: 'game_over', winnerId: winner.userId, reason });
    return;
  }

  // Turn repair.
  if (requirePlayer(state, state.currentIndex).eliminated) {
    state.currentIndex = nextIndex(state, state.currentIndex);
  }
  if (state.mustPlayCardId !== null) {
    const holder = requirePlayer(state, state.currentIndex);
    if (!holder.hand.some((card) => card.id === state.mustPlayCardId)) state.mustPlayCardId = null;
  }
}

// ---------- the single entry point ------------------------------------------
export function applyAction(state: GameState, action: Action, rng: Rng = secureRng): ActionResult {
  if (state.status !== 'playing') return fail('GAME_OVER', 'The game is over.');

  const index = state.players.findIndex((p) => p.userId === action.playerId);
  const player = state.players[index];
  if (!player) return fail('NOT_IN_GAME', 'You are not in this game.');
  if (player.eliminated) return fail('ELIMINATED', 'You have been eliminated.');

  const events: GameEvent[] = [];
  const c: Ctx = { state, index, rng, events };

  let failure: ActionFailure | null;
  switch (action.type) {
    case 'play':
      failure = handlePlay(c, action);
      break;
    case 'draw':
      failure = handleDraw(c);
      break;
    case 'takePenalty':
      failure = handleTakePenalty(c);
      break;
    case 'chooseRouletteColor':
      failure = handleRouletteColor(c, action.color);
      break;
    case 'forfeit':
      failure = handleForfeit(c);
      break;
    case 'timeout':
      failure = handleTimeout(c);
      break;
  }

  if (failure) return failure;
  state.version += 1;
  return { ok: true, events };
}

/** Shared turn gate: nobody acts while a prompt is open, and only the current player acts. */
function turnGate({ state, index }: Ctx): ActionFailure | null {
  if (state.prompt) return fail('PROMPT_PENDING', 'Waiting for a color choice before the game can continue.');
  if (index !== state.currentIndex) {
    return fail('NOT_YOUR_TURN', `It is ${requirePlayer(state, state.currentIndex).name}'s turn.`);
  }
  return null;
}

// ---------- play -------------------------------------------------------------
function handlePlay(c: Ctx, action: Extract<Action, { type: 'play' }>): ActionFailure | null {
  const { state, index, events } = c;
  const gate = turnGate(c);
  if (gate) return gate;

  const player = requirePlayer(state, index);
  const cardIndex = player.hand.findIndex((card) => card.id === action.cardId);
  const card = player.hand[cardIndex];
  if (!card) return fail('CARD_NOT_IN_HAND', 'That card is not in your hand.');

  if (state.mustPlayCardId !== null && card.id !== state.mustPlayCardId) {
    return fail('MUST_PLAY_DRAWN_CARD', 'You must play the card you just drew.');
  }

  const check = checkPlay(card, playContext(state));
  if (!check.ok) return fail('CANNOT_PLAY', check.message);

  // Validate the extra choices that come with some cards BEFORE changing anything.
  let chosenColor: Color | undefined;
  if (needsColorChoice(card.type)) {
    if (!isColor(action.color)) return fail('COLOR_REQUIRED', 'Choose a color (R, Y, G or B) for this card.');
    chosenColor = action.color;
  }
  let swapWith = -1;
  if (card.type === 'n7' && state.settings.sevenZero) {
    swapWith = state.players.findIndex((p) => p.userId === action.targetId);
    const target = state.players[swapWith];
    if (!target || swapWith === index || target.eliminated) {
      return fail('INVALID_TARGET', 'Choose another player who is still in the game to swap hands with.');
    }
  }

  // ---- all checks passed: apply ----
  player.hand.splice(cardIndex, 1);
  state.discardPile.push(card);
  state.mustPlayCardId = null;
  if (card.color !== 'W') state.activeColor = card.color;
  events.push({ type: 'played', playerId: player.userId, card });

  const chooseColor = (): void => {
    if (!chosenColor) return;
    state.activeColor = chosenColor;
    events.push({ type: 'color_chosen', playerId: player.userId, color: chosenColor });
  };
  const idOf = (i: number): string => requirePlayer(state, i).userId;

  switch (card.type) {
    case 'da': {
      // Discard All: dump every other card of this color, under the played card.
      const dumped = player.hand.filter((h) => h.color === card.color);
      player.hand = player.hand.filter((h) => h.color !== card.color);
      state.discardPile.pop();
      state.discardPile.push(...dumped, card);
      if (card.color !== 'W') {
        events.push({ type: 'discarded_all', playerId: player.userId, color: card.color, cards: dumped });
      }
      state.currentIndex = nextIndex(state, index);
      break;
    }
    case 'd2':
    case 'd4':
      addPenalty(state, drawValue(card.type), events);
      state.currentIndex = nextIndex(state, index);
      break;
    case 'w6':
    case 'w10':
      chooseColor();
      addPenalty(state, drawValue(card.type), events);
      state.currentIndex = nextIndex(state, index);
      break;
    case 'w4r':
      chooseColor();
      state.direction = state.direction === 1 ? -1 : 1;
      events.push({ type: 'direction_reversed', direction: state.direction });
      addPenalty(state, 4, events);
      // The penalty goes to the next player in the NEW direction (with 2 players: the opponent).
      state.currentIndex = nextIndex(state, index);
      break;
    case 'sk': {
      events.push({ type: 'skipped', playerIds: [idOf(nextIndex(state, index))] });
      state.currentIndex = nextIndex(state, index, 2);
      break;
    }
    case 'se': {
      const others = aliveIndexes(state).filter((i) => i !== index);
      events.push({ type: 'skipped', playerIds: others.map(idOf) });
      state.currentIndex = index; // everyone else is skipped: same player goes again
      break;
    }
    case 'rv':
      state.direction = state.direction === 1 ? -1 : 1;
      events.push({ type: 'direction_reversed', direction: state.direction });
      // With 2 players, Reverse acts like Skip.
      state.currentIndex = aliveIndexes(state).length === 2 ? index : nextIndex(state, index);
      break;
    case 'cr': {
      // Color Roulette: the next player picks a color and draws until they get it.
      const victim = nextIndex(state, index);
      state.prompt = { type: 'roulette_color', by: victim, origin: index };
      events.push({ type: 'roulette_started', playerId: idOf(index), by: idOf(victim) });
      return null; // paused: finalize() runs once the victim has chosen
    }
    case 'n7':
      if (state.settings.sevenZero) {
        const target = requirePlayer(state, swapWith);
        [player.hand, target.hand] = [target.hand, player.hand];
        events.push({ type: 'hands_swapped', playerId: player.userId, targetId: target.userId });
      }
      state.currentIndex = nextIndex(state, index);
      break;
    case 'n0':
      if (state.settings.sevenZero) {
        // Every hand moves one seat in the direction of play.
        const alive = aliveIndexes(state);
        const moved = alive.map((i) => ({ to: nextIndex(state, i), hand: requirePlayer(state, i).hand }));
        for (const { to, hand } of moved) requirePlayer(state, to).hand = hand;
        events.push({ type: 'hands_rotated' });
      }
      state.currentIndex = nextIndex(state, index);
      break;
    default:
      state.currentIndex = nextIndex(state, index);
  }

  finalize(c);
  return null;
}

// ---------- draw / penalty / roulette / forfeit -----------------------------
function handleDraw(c: Ctx): ActionFailure | null {
  const { state, index, events } = c;
  const gate = turnGate(c);
  if (gate) return gate;
  if (state.pendingDraw > 0) {
    return fail('PENALTY_PENDING', 'A penalty is pending: stack a draw card or take the penalty.');
  }
  if (state.mustPlayCardId !== null) {
    return fail('MUST_PLAY_DRAWN_CARD', 'You already drew. Play the card you drew.');
  }
  const player = requirePlayer(state, index);
  const ctx = playContext(state);
  if (playableCards(player.hand, ctx).length > 0) {
    return fail('HAS_PLAYABLE_CARD', 'You have a playable card, so you cannot draw.');
  }

  // Draw until a playable card shows up. That card must then be played.
  const result = drawInto(c, index, (card) => checkPlay(card, ctx).ok);
  const last = result.cards[result.cards.length - 1];
  events.push({ type: 'drew', playerId: player.userId, count: result.cards.length, reason: 'draw', cards: result.cards });

  if (player.hand.length >= state.settings.mercyLimit) {
    // Hit the card limit while drawing: the Mercy rule in finalize() eliminates the player.
    state.currentIndex = nextIndex(state, index);
  } else if (result.done && last) {
    state.mustPlayCardId = last.id;
  } else {
    // No playable card could be found anywhere: the turn passes.
    events.push({ type: 'passed', playerId: player.userId });
    state.currentIndex = nextIndex(state, index);
  }
  finalize(c);
  return null;
}

function handleTakePenalty(c: Ctx): ActionFailure | null {
  const { state, index, events } = c;
  const gate = turnGate(c);
  if (gate) return gate;
  if (state.pendingDraw <= 0) return fail('NO_PENALTY', 'There is no penalty to take.');

  const player = requirePlayer(state, index);
  const cards = drawCount(c, index, state.pendingDraw);
  events.push({ type: 'drew', playerId: player.userId, count: cards.length, reason: 'penalty', cards });
  state.pendingDraw = 0;
  state.lastDrawValue = 0;
  state.mustPlayCardId = null;
  state.currentIndex = nextIndex(state, index);
  finalize(c);
  return null;
}

function handleRouletteColor(c: Ctx, color: Color): ActionFailure | null {
  const { state, index, events } = c;
  if (!state.prompt) return fail('NO_PROMPT', 'Nothing is waiting for a choice.');
  if (state.prompt.by !== index) return fail('NOT_YOUR_PROMPT', 'Another player has to choose.');
  if (!isColor(color)) return fail('COLOR_REQUIRED', 'Choose a color (R, Y, G or B).');

  const victim = requirePlayer(state, index);
  state.activeColor = color;
  events.push({ type: 'color_chosen', playerId: victim.userId, color });
  // Wilds have no color, so they never stop the draw.
  const result = drawInto(c, index, (card) => card.color === color);
  events.push({ type: 'drew', playerId: victim.userId, count: result.cards.length, reason: 'roulette', cards: result.cards });

  state.prompt = null;
  state.currentIndex = nextIndex(state, index); // the victim loses their turn
  finalize(c);
  return null;
}

/**
 * The turn timer ran out. The player loses a lifeline and is auto-dealt cards until they reach the
 * card limit (even if they hold playable cards), then the last card picked up is dropped, leaving
 * them at (limit - 1). Anything pending (penalty, drawn card, color choice) is cancelled and the
 * turn passes. With no lifelines left, the player is out.
 */
function handleTimeout(c: Ctx): ActionFailure | null {
  const { state, index, events } = c;
  const waitingOn = state.prompt ? state.prompt.by : state.currentIndex;
  if (index !== waitingOn) return fail('NOT_YOUR_TURN', 'That player is not the one being waited on.');

  const player = requirePlayer(state, index);
  events.push({ type: 'timed_out', playerId: player.userId });

  state.pendingDraw = 0;
  state.lastDrawValue = 0;
  state.mustPlayCardId = null;
  state.prompt = null;

  if (player.lifelines > 0) {
    player.lifelines -= 1;
    const result = drawInto(c, index, () => false); // never stops early: draws to the limit
    events.push({ type: 'drew', playerId: player.userId, count: result.cards.length, reason: 'timeout', cards: result.cards });
    let dropped: Card[] = [];
    if (player.hand.length >= state.settings.mercyLimit) {
      dropped = player.hand.splice(state.settings.mercyLimit - 1);
      dropUnderTop(state, dropped);
    }
    events.push({ type: 'lifeline_used', playerId: player.userId, remaining: player.lifelines, dropped });
  } else {
    eliminate(c, index, 'timeout');
  }

  state.currentIndex = nextIndex(state, index);
  finalize(c);
  return null;
}

function handleForfeit(c: Ctx): ActionFailure | null {
  const { state, index } = c;
  const wasCurrent = index === state.currentIndex && !state.prompt;
  eliminate(c, index, 'left');
  if (wasCurrent) {
    // The penalty was meant for the player who left; the next player doesn't inherit it.
    state.pendingDraw = 0;
    state.lastDrawValue = 0;
    state.mustPlayCardId = null;
  }
  finalize(c);
  return null;
}
