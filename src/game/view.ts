import { checkPlay, playableCards } from './rules.js';
import { playContext, requirePlayer, topCard } from './engine.js';
import type { Card, Color, GameEvent, GameState } from './types.js';

export interface PublicPlayer {
  userId: string;
  name: string;
  seat: number;
  cardCount: number;
  lifelines: number;
  eliminated: boolean;
  eliminatedBy: 'mercy' | 'left' | 'timeout' | null;
}

export interface Standing {
  userId: string;
  name: string;
  placement: number;
  cardsLeft: number;
  eliminated: boolean;
}

/** Everything one player is allowed to know. Other players' hands are never included. */
export interface GameView {
  version: number;
  status: 'playing' | 'finished';
  players: PublicPlayer[];
  /** Whose action the game is waiting for (the Roulette victim while a color choice is open). */
  turnPlayerId: string | null;
  /** Seconds per turn (0 = no timer). The room layer adds the actual deadline. */
  turnSeconds: number;
  direction: 1 | -1;
  activeColor: Color;
  topCard: Card;
  drawPileCount: number;
  discardPileCount: number;
  pendingDraw: number;
  /** While a penalty is pending, only a draw card with at least this value can be stacked. */
  minStackValue: number;
  prompt: { type: 'roulette_color'; playerId: string } | null;
  winnerId: string | null;
  endReason: 'empty_hand' | 'last_standing' | null;
  standings: Standing[];
  /** null if the viewer is not a player (a spectator). */
  you: {
    userId: string;
    seat: number;
    hand: Card[];
    isYourTurn: boolean;
    /** Cards you may play right now. */
    playableCardIds: string[];
    canDraw: boolean;
    canTakePenalty: boolean;
    mustPlayCardId: string | null;
  } | null;
}

export function getStandings(state: GameState): Standing[] {
  if (state.status !== 'finished') return [];
  const entry = (i: number): Standing => {
    const p = requirePlayer(state, i);
    return { userId: p.userId, name: p.name, placement: 0, cardsLeft: p.hand.length, eliminated: p.eliminated };
  };
  const indexes = state.players.map((_, i) => i);
  const winner = indexes.filter((i) => state.players[i]?.userId === state.winnerId);
  const alive = indexes
    .filter((i) => !requirePlayer(state, i).eliminated && !winner.includes(i))
    .sort((a, b) => requirePlayer(state, a).hand.length - requirePlayer(state, b).hand.length || a - b);
  // Whoever was eliminated last ranks higher.
  const out = indexes
    .filter((i) => requirePlayer(state, i).eliminated)
    .sort((a, b) => (requirePlayer(state, b).eliminatedOrder ?? 0) - (requirePlayer(state, a).eliminatedOrder ?? 0));
  return [...winner, ...alive, ...out].map((i, rank) => ({ ...entry(i), placement: rank + 1 }));
}

export function viewFor(state: GameState, userId: string): GameView {
  const seat = state.players.findIndex((p) => p.userId === userId);
  const me = state.players[seat];

  const turnIndex = state.prompt ? state.prompt.by : state.currentIndex;
  const turnPlayer = state.status === 'playing' ? requirePlayer(state, turnIndex) : null;

  let you: GameView['you'] = null;
  if (me) {
    const isYourTurn = state.status === 'playing' && !me.eliminated && !state.prompt && seat === state.currentIndex;
    const ctx = playContext(state);
    let playable: Card[] = [];
    if (isYourTurn) {
      playable = state.mustPlayCardId
        ? me.hand.filter((c) => c.id === state.mustPlayCardId && checkPlay(c, ctx).ok)
        : playableCards(me.hand, ctx);
    }
    you = {
      userId: me.userId,
      seat,
      hand: [...me.hand],
      isYourTurn,
      playableCardIds: playable.map((c) => c.id),
      canDraw:
        isYourTurn && state.pendingDraw === 0 && state.mustPlayCardId === null && playableCards(me.hand, ctx).length === 0,
      canTakePenalty: isYourTurn && state.pendingDraw > 0,
      mustPlayCardId: isYourTurn ? state.mustPlayCardId : null,
    };
  }

  return {
    version: state.version,
    status: state.status,
    players: state.players.map((p, i) => ({
      userId: p.userId,
      name: p.name,
      seat: i,
      cardCount: p.hand.length,
      lifelines: p.lifelines,
      eliminated: p.eliminated,
      eliminatedBy: p.eliminatedBy,
    })),
    turnPlayerId: turnPlayer?.userId ?? null,
    turnSeconds: state.settings.turnSeconds,
    direction: state.direction,
    activeColor: state.activeColor,
    topCard: topCard(state),
    drawPileCount: state.drawPile.length,
    discardPileCount: state.discardPile.length,
    pendingDraw: state.pendingDraw,
    minStackValue: state.pendingDraw > 0 ? state.lastDrawValue : 0,
    prompt: state.prompt
      ? { type: state.prompt.type, playerId: requirePlayer(state, state.prompt.by).userId }
      : null,
    winnerId: state.winnerId,
    endReason: state.endReason,
    standings: getStandings(state),
    you,
  };
}

/** Removes private info (the identity of drawn cards) from an event for everyone except its owner. */
export function redactEvent(event: GameEvent, viewerId: string): GameEvent {
  if (event.type === 'drew' && event.playerId !== viewerId) {
    const { cards: _private, ...publicPart } = event;
    return publicPart;
  }
  return event;
}
