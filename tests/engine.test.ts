import { describe, expect, it } from 'vitest';
import { CATALOG, DECK_SIZE } from '../src/game/deck.js';
import { applyAction, createGame, nextIndex } from '../src/game/engine.js';
import { checkPlay, type PlayContext } from '../src/game/rules.js';
import { redactEvent, viewFor } from '../src/game/view.js';
import { COLORS, type Action, type Card, type GameEvent, type GameState } from '../src/game/types.js';
import { card, filler, makeState, seeded } from './helpers.js';

const rng = seeded(1);
const play = (s: GameState, who: number, c: Card, extra: Partial<Extract<Action, { type: 'play' }>> = {}) =>
  applyAction(s, { type: 'play', playerId: `u${who}`, cardId: c.id, ...extra }, rng);
const draw = (s: GameState, who: number) => applyAction(s, { type: 'draw', playerId: `u${who}` }, rng);
const take = (s: GameState, who: number) => applyAction(s, { type: 'takePenalty', playerId: `u${who}` }, rng);
const roulette = (s: GameState, who: number, color: 'R' | 'Y' | 'G' | 'B') =>
  applyAction(s, { type: 'chooseRouletteColor', playerId: `u${who}`, color }, rng);
const ctx = (top: Card, activeColor: PlayContext['activeColor'], pendingDraw = 0, lastDrawValue = 0): PlayContext => ({
  top,
  activeColor,
  pendingDraw,
  lastDrawValue,
});
const rest = () => [card('G', 'n9'), card('G', 'n8')]; // filler cards so a hand never empties by accident

describe('deck', () => {
  it('has the 168 official No Mercy cards with unique stable ids', () => {
    expect(DECK_SIZE).toBe(168);
    expect(new Set(CATALOG.map((c) => c.id)).size).toBe(168);
    expect(CATALOG[0]?.id).toBe('c_0');
    expect(CATALOG[167]?.id).toBe('c_167');
  });

  it('has the right counts per type', () => {
    const count = (type: string, color?: string) =>
      CATALOG.filter((c) => c.type === type && (color === undefined || c.color === color)).length;
    for (const color of COLORS) {
      expect(count('n0', color)).toBe(2);
      expect(count('n9', color)).toBe(2);
      expect(count('d2', color)).toBe(3);
      expect(count('d4', color)).toBe(2);
      expect(count('sk', color)).toBe(3);
      expect(count('se', color)).toBe(2);
      expect(count('rv', color)).toBe(3);
      expect(count('da', color)).toBe(3);
    }
    expect(count('w6')).toBe(4);
    expect(count('w4r')).toBe(8);
    expect(count('w10')).toBe(4);
    expect(count('cr')).toBe(8);
  });
});

describe('createGame', () => {
  const players = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, name: `P${i}` }));

  it('deals 7 cards each and starts on a number card', () => {
    const s = createGame({ players: players(4), rng: seeded(7), startIndex: 0 });
    expect(s.players.every((p) => p.hand.length === 7)).toBe(true);
    expect(s.drawPile.length).toBe(168 - 28 - 1);
    const top = s.discardPile[0];
    expect(top?.type.startsWith('n')).toBe(true);
    expect(s.activeColor).toBe(top?.color);
  });

  it('rejects bad player counts and duplicate ids', () => {
    expect(() => createGame({ players: players(1) })).toThrow();
    expect(() => createGame({ players: players(7) })).toThrow();
    expect(() => createGame({ players: [{ userId: 'a', name: 'A' }, { userId: 'a', name: 'B' }] })).toThrow();
  });
});

describe('checkPlay (ported from the rule tester)', () => {
  it('numbers: same color or same number', () => {
    const top = card('R', 'n5');
    expect(checkPlay(card('R', 'n2'), ctx(top, 'R')).ok).toBe(true);
    expect(checkPlay(card('B', 'n5'), ctx(top, 'R')).ok).toBe(true);
    expect(checkPlay(card('B', 'n2'), ctx(top, 'R')).ok).toBe(false);
  });

  it('colored action cards need the active color unless the top card is a power card', () => {
    expect(checkPlay(card('B', 'sk'), ctx(card('R', 'n5'), 'R')).ok).toBe(false);
    expect(checkPlay(card('R', 'sk'), ctx(card('R', 'n5'), 'R')).ok).toBe(true);
    expect(checkPlay(card('B', 'sk'), ctx(card('R', 'rv'), 'R')).ok).toBe(true);
    expect(checkPlay(card('B', 'd2'), ctx(card('W', 'w6'), 'R')).ok).toBe(true);
  });

  it('a number card cannot be played on a power card of another color', () => {
    expect(checkPlay(card('B', 'n3'), ctx(card('R', 'rv'), 'R')).ok).toBe(false);
  });

  it('wilds are always playable (when no penalty is pending)', () => {
    for (const t of ['w4r', 'w6', 'w10', 'cr'] as const) {
      expect(checkPlay(card('W', t), ctx(card('R', 'n5'), 'R')).ok).toBe(true);
    }
  });

  it('with a penalty pending only equal-or-higher draw cards stack', () => {
    const top = card('R', 'd4');
    const c = (t: Card) => checkPlay(t, ctx(top, 'R', 4, 4)).ok;
    expect(c(card('R', 'n1'))).toBe(false);
    expect(c(card('R', 'sk'))).toBe(false);
    expect(c(card('W', 'cr'))).toBe(false);
    expect(c(card('R', 'd2'))).toBe(false);
    expect(c(card('B', 'd4'))).toBe(true);
    expect(c(card('W', 'w4r'))).toBe(true);
    expect(c(card('W', 'w6'))).toBe(true);
    expect(c(card('W', 'w10'))).toBe(true);
    expect(checkPlay(card('W', 'w6'), ctx(card('W', 'w10'), 'R', 10, 10)).ok).toBe(false);
  });
});

describe('turn order and validation', () => {
  it('rejects a play out of turn and leaves the state untouched', () => {
    const c = card('R', 'n2');
    const s = makeState({ hands: [[card('R', 'n1')], [c, ...rest()]] });
    const before = structuredClone(s);
    const r = play(s, 1, c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_TURN');
    expect(s).toEqual(before);
  });

  it('rejects cards that are not in your hand, unplayable cards and unknown players', () => {
    const bad = card('B', 'n2');
    const s = makeState({ hands: [[bad, ...rest()], [card('R', 'n1')]] });
    const stranger = card('R', 'n1');
    const a = play(s, 0, stranger);
    expect(!a.ok && a.code).toBe('CARD_NOT_IN_HAND');
    const b = play(s, 0, bad);
    expect(!b.ok && b.code).toBe('CANNOT_PLAY');
    const c = applyAction(s, { type: 'draw', playerId: 'nobody' }, rng);
    expect(!c.ok && c.code).toBe('NOT_IN_GAME');
  });

  it('a normal play moves the top card and the turn', () => {
    const c = card('R', 'n2');
    const s = makeState({ hands: [[c, ...rest()], [card('R', 'n1'), ...rest()]] });
    const r = play(s, 0, c);
    expect(r.ok).toBe(true);
    expect(s.currentIndex).toBe(1);
    expect(s.discardPile.at(-1)).toBe(c);
    expect(s.version).toBe(1);
  });

  it('playing a colored card changes the active color', () => {
    const c = card('B', 'n5'); // same number, different color
    const s = makeState({ hands: [[c, ...rest()], [card('R', 'n1'), ...rest()]] });
    play(s, 0, c);
    expect(s.activeColor).toBe('B');
  });
});

describe('draw cards, stacking and penalties', () => {
  it('+2 puts a penalty on the next player, who can take it', () => {
    const d2 = card('R', 'd2');
    const s = makeState({ hands: [[d2, ...rest()], [card('B', 'n1'), ...rest()]], drawPile: filler(10) });
    play(s, 0, d2);
    expect(s.pendingDraw).toBe(2);
    expect(s.lastDrawValue).toBe(2);
    expect(s.currentIndex).toBe(1);

    const t = take(s, 1);
    expect(t.ok).toBe(true);
    expect(s.players[1]?.hand.length).toBe(5);
    expect(s.pendingDraw).toBe(0);
    expect(s.currentIndex).toBe(0); // the taker loses their turn (2 players: back to p0)
  });

  it('stacks +2, +4, +6 and the last victim draws everything', () => {
    const d2 = card('R', 'd2');
    const d4 = card('B', 'd4');
    const w6 = card('W', 'w6');
    const s = makeState({
      hands: [[d2, ...rest()], [d4, ...rest()], [w6, ...rest()], [...rest()]],
      drawPile: filler(30),
    });
    play(s, 0, d2);
    play(s, 1, d4);
    play(s, 2, w6, { color: 'G' });
    expect(s.pendingDraw).toBe(12);
    expect(s.activeColor).toBe('G');
    expect(s.currentIndex).toBe(3);
    take(s, 3);
    expect(s.players[3]?.hand.length).toBe(14);
  });

  it('cannot stack a lower draw card, play a normal card, or draw while a penalty is pending', () => {
    const lowD2 = card('R', 'd2');
    const num = card('R', 'n1');
    const s = makeState({ hands: [[card('R', 'd4'), ...rest()], [lowD2, num, ...rest()]], top: card('R', 'd4'), pending: 4, last: 4, current: 1 });
    const a = play(s, 1, lowD2);
    expect(!a.ok && a.code).toBe('CANNOT_PLAY');
    const b = play(s, 1, num);
    expect(!b.ok && b.code).toBe('CANNOT_PLAY');
    const c = draw(s, 1);
    expect(!c.ok && c.code).toBe('PENALTY_PENDING');
  });

  it('cannot take a penalty when there is none', () => {
    const s = makeState({ hands: [rest(), rest()] });
    const r = take(s, 0);
    expect(!r.ok && r.code).toBe('NO_PENALTY');
  });

  it('+6 and +10 need a color', () => {
    const w10 = card('W', 'w10');
    const s = makeState({ hands: [[w10, ...rest()], [...rest()]], drawPile: filler(20) });
    const r = play(s, 0, w10);
    expect(!r.ok && r.code).toBe('COLOR_REQUIRED');
    expect(s.discardPile.length).toBe(1);
    expect(play(s, 0, w10, { color: 'B' }).ok).toBe(true);
    expect(s.pendingDraw).toBe(10);
    expect(s.activeColor).toBe('B');
  });
});

describe('skip, skip all, reverse', () => {
  it('Skip jumps over the next player', () => {
    const sk = card('R', 'sk');
    const s = makeState({ hands: [[sk, ...rest()], rest(), rest()] });
    play(s, 0, sk);
    expect(s.currentIndex).toBe(2);
  });

  it('Skip with 2 players gives the turn straight back', () => {
    const sk = card('R', 'sk');
    const s = makeState({ hands: [[sk, ...rest()], rest()] });
    play(s, 0, sk);
    expect(s.currentIndex).toBe(0);
  });

  it('Skip All lets the same player go again', () => {
    const se = card('R', 'se');
    const s = makeState({ hands: [[se, ...rest()], rest(), rest()] });
    const r = play(s, 0, se);
    expect(s.currentIndex).toBe(0);
    expect(r.ok && r.events.some((e) => e.type === 'skipped' && e.playerIds.length === 2)).toBe(true);
  });

  it('Reverse flips direction (3+ players)', () => {
    const rv = card('R', 'rv');
    const s = makeState({ hands: [[rv, ...rest()], rest(), rest()] });
    play(s, 0, rv);
    expect(s.direction).toBe(-1);
    expect(s.currentIndex).toBe(2);
  });

  it('Reverse acts like Skip with 2 players', () => {
    const rv = card('R', 'rv');
    const s = makeState({ hands: [[rv, ...rest()], rest()] });
    play(s, 0, rv);
    expect(s.currentIndex).toBe(0);
  });

  it('Reverse +4 reverses and the next player in the NEW direction gets the penalty', () => {
    const w4r = card('W', 'w4r');
    const s = makeState({ hands: [[w4r, ...rest()], rest(), rest()] });
    expect(play(s, 0, w4r).ok).toBe(false); // color required
    play(s, 0, w4r, { color: 'Y' });
    expect(s.direction).toBe(-1);
    expect(s.pendingDraw).toBe(4);
    expect(s.activeColor).toBe('Y');
    expect(s.currentIndex).toBe(2);
  });

  it('Reverse +4 with 2 players: the OPPONENT faces the +4 (the tester let the player hit themselves)', () => {
    const w4r = card('W', 'w4r');
    const s = makeState({ hands: [[w4r, ...rest()], rest()] });
    play(s, 0, w4r, { color: 'G' });
    expect(s.currentIndex).toBe(1);
    expect(s.pendingDraw).toBe(4);
  });

  it('eliminated players are skipped in turn order', () => {
    const s = makeState({ hands: [rest(), rest(), rest()] });
    const p1 = s.players[1];
    if (p1) p1.eliminated = true;
    expect(nextIndex(s, 0)).toBe(2);
    expect(nextIndex(s, 0, 2)).toBe(0);
  });
});

describe('Discard All', () => {
  it('dumps every card of its color and leaves the played card on top', () => {
    const da = card('R', 'da');
    const r1 = card('R', 'n1');
    const r2 = card('R', 'd2');
    const b1 = card('B', 'n1');
    const s = makeState({ hands: [[da, r1, r2, b1], rest()] });
    const res = play(s, 0, da);
    expect(res.ok).toBe(true);
    expect(s.players[0]?.hand).toEqual([b1]);
    expect(s.discardPile.at(-1)).toBe(da);
    expect(s.discardPile.length).toBe(4);
    expect(s.currentIndex).toBe(1);
  });

  it('wins the game if it empties the hand', () => {
    const da = card('R', 'da');
    const s = makeState({ hands: [[da, card('R', 'n1')], rest()] });
    play(s, 0, da);
    expect(s.status).toBe('finished');
    expect(s.winnerId).toBe('u0');
  });
});

describe('Color Roulette', () => {
  it('the next player chooses a color and draws until they hit it; wilds do not count', () => {
    const cr = card('W', 'cr');
    const green = card('G', 'n1');
    const yellow = card('Y', 'n2');
    const wild = card('W', 'w6');
    const blue = card('B', 'n3');
    // top of pile is the LAST element: draws green, yellow, wild, blue
    const s = makeState({ hands: [[cr, ...rest()], rest(), rest()], drawPile: [card('R', 'n9'), blue, wild, yellow, green] });

    play(s, 0, cr);
    expect(s.prompt).toEqual({ type: 'roulette_color', by: 1, origin: 0 });

    const wrongPlayer = roulette(s, 2, 'B');
    expect(!wrongPlayer.ok && wrongPlayer.code).toBe('NOT_YOUR_PROMPT');

    const r = roulette(s, 1, 'B');
    expect(r.ok).toBe(true);
    expect(s.players[1]?.hand.length).toBe(2 + 4);
    expect(s.activeColor).toBe('B');
    expect(s.prompt).toBeNull();
    expect(s.currentIndex).toBe(2); // victim loses their turn
  });

  it('blocks every other action while the color choice is open', () => {
    const cr = card('W', 'cr');
    const x = card('R', 'n1');
    const s = makeState({ hands: [[cr, x, ...rest()], [x, ...rest()]] });
    play(s, 0, cr);
    const a = play(s, 0, x);
    expect(!a.ok && a.code).toBe('PROMPT_PENDING');
    const b = draw(s, 0);
    expect(!b.ok && b.code).toBe('PROMPT_PENDING');
    const c = roulette(makeState({ hands: [rest(), rest()] }), 0, 'R');
    expect(!c.ok && c.code).toBe('NO_PROMPT');
  });

  it('with 2 players the roulette victim loses their turn and the player goes again', () => {
    const cr = card('W', 'cr');
    const g = card('G', 'n1');
    const s = makeState({ hands: [[cr, ...rest()], rest()], drawPile: [g] });
    play(s, 0, cr);
    roulette(s, 1, 'G');
    expect(s.currentIndex).toBe(0);
  });
});

describe('7 swaps hands, 0 rotates hands', () => {
  it('7 swaps with the chosen player', () => {
    const seven = card('R', 'n7');
    const mine = rest();
    const theirs = [card('B', 'n1'), card('B', 'n2'), card('B', 'n3')];
    const s = makeState({ hands: [[seven, ...mine], theirs, rest()] });
    expect(play(s, 0, seven).ok).toBe(false);
    expect(play(s, 0, seven, { targetId: 'u0' }).ok).toBe(false);
    expect(play(s, 0, seven, { targetId: 'nobody' }).ok).toBe(false);
    expect(play(s, 0, seven, { targetId: 'u1' }).ok).toBe(true);
    expect(s.players[0]?.hand).toEqual(theirs);
    expect(s.players[1]?.hand).toEqual(mine);
    expect(s.currentIndex).toBe(1);
  });

  it('0 passes every hand one seat in the direction of play', () => {
    const zero = card('R', 'n0');
    const h0 = [card('B', 'n1')];
    const h1 = [card('B', 'n2')];
    const h2 = [card('B', 'n3')];
    const s = makeState({ hands: [[zero, ...h0], h1, h2] });
    play(s, 0, zero);
    expect(s.players[1]?.hand).toEqual(h0);
    expect(s.players[2]?.hand).toEqual(h1);
    expect(s.players[0]?.hand).toEqual(h2);

    const t = makeState({ hands: [[zero, ...h0], h1, h2], direction: -1 });
    play(t, 0, zero);
    expect(t.players[2]?.hand).toEqual(h0);
    expect(t.players[1]?.hand).toEqual(h2);
    expect(t.players[0]?.hand).toEqual(h1);
  });

  it('7 and 0 are plain numbers when the option is off', () => {
    const seven = card('R', 'n7');
    const s = makeState({ hands: [[seven, ...rest()], rest()], settings: { sevenZero: false } });
    expect(play(s, 0, seven).ok).toBe(true);
    expect(s.players[0]?.hand.length).toBe(2);
  });
});

describe('drawing when you cannot play', () => {
  it('draws until a playable card and then must play it', () => {
    const bad1 = card('B', 'n1');
    const bad2 = card('G', 'n2');
    const good = card('R', 'n7');
    const s = makeState({
      hands: [[card('B', 'n3'), card('B', 'n4')], rest()],
      drawPile: [good, bad2, bad1], // draws bad1, bad2, then good
      settings: { sevenZero: false },
    });
    const r = draw(s, 0);
    expect(r.ok).toBe(true);
    expect(s.players[0]?.hand.length).toBe(5);
    expect(s.mustPlayCardId).toBe(good.id);
    expect(s.currentIndex).toBe(0); // still your turn

    const again = draw(s, 0);
    expect(!again.ok && again.code).toBe('MUST_PLAY_DRAWN_CARD');
    expect(play(s, 0, good).ok).toBe(true);
    expect(s.mustPlayCardId).toBeNull();
    expect(s.currentIndex).toBe(1);
  });

  it('is refused when you already have a playable card', () => {
    const s = makeState({ hands: [[card('R', 'n1'), ...rest()], rest()] });
    const r = draw(s, 0);
    expect(!r.ok && r.code).toBe('HAS_PLAYABLE_CARD');
  });

  it('reshuffles the discard pile when the draw pile runs out (top card stays)', () => {
    const top = card('R', 'n5');
    const under = [card('B', 'n1'), card('B', 'n2'), card('R', 'n3')];
    const s = makeState({ hands: [[card('B', 'n9'), card('B', 'n8')], rest()], top, discardBelow: under, drawPile: [] });
    const r = draw(s, 0);
    expect(r.ok && r.events.some((e) => e.type === 'reshuffled')).toBe(true);
    expect(s.discardPile).toEqual([top]);
    expect(s.players[0]?.hand.length).toBeGreaterThan(2);
  });

  it('passes the turn if no playable card exists anywhere', () => {
    const s = makeState({ hands: [[card('B', 'n9')], rest()], drawPile: [card('B', 'n1')] });
    const r = draw(s, 0);
    expect(r.ok && r.events.some((e) => e.type === 'passed')).toBe(true);
    expect(s.currentIndex).toBe(1);
  });
});

describe('Mercy rule (reaching 25 cards by drawing)', () => {
  it('eliminates a player who reaches 25 cards and returns their cards to the draw pile', () => {
    const d4 = card('R', 'd4');
    const big = Array.from({ length: 23 }, () => card('B', 'n1'));
    const s = makeState({ hands: [[d4, ...rest()], big, rest()], drawPile: filler(20) });
    const total = () => s.drawPile.length + s.discardPile.length + s.players.reduce((n, p) => n + p.hand.length, 0);
    const before = total();

    play(s, 0, d4);
    const r = take(s, 1);
    expect(r.ok && r.events.some((e) => e.type === 'eliminated' && e.reason === 'mercy')).toBe(true);
    const p1 = s.players[1];
    expect(p1?.eliminated).toBe(true);
    expect(p1?.hand).toEqual([]);
    expect(total()).toBe(before); // no cards vanished
    expect(s.currentIndex).toBe(2);
    expect(s.status).toBe('playing');
  });

  it('declares the last player standing the winner', () => {
    const d4 = card('R', 'd4');
    const big = Array.from({ length: 24 }, () => card('B', 'n1'));
    const s = makeState({ hands: [[d4, ...rest()], big], drawPile: filler(20) });
    play(s, 0, d4);
    take(s, 1);
    expect(s.status).toBe('finished');
    expect(s.winnerId).toBe('u0');
    expect(s.endReason).toBe('last_standing');
  });
});


describe('Lifelines and the turn timer', () => {
  const timeout = (s: GameState, who: number) => applyAction(s, { type: 'timeout', playerId: `u${who}` }, rng);
  const totalCards = (s: GameState) =>
    s.drawPile.length + s.discardPile.length + s.players.reduce((n, p) => n + p.hand.length, 0);
  const hand24 = () => Array.from({ length: 24 }, () => card('B', 'n2'));

  it('everyone starts with 3 and the default timer is 20 seconds', () => {
    const s = createGame({ players: [{ userId: 'a', name: 'A' }, { userId: 'b', name: 'B' }], rng: seeded(2) });
    expect(s.players.map((p) => p.lifelines)).toEqual([3, 3]);
    expect(viewFor(s, 'a').players.map((p) => p.lifelines)).toEqual([3, 3]);
    expect(viewFor(s, 'a').turnSeconds).toBe(20);
  });

  it('validates the settings', () => {
    const two = [{ userId: 'a', name: 'A' }, { userId: 'b', name: 'B' }];
    expect(() => createGame({ players: two, settings: { turnSeconds: 10 } })).not.toThrow();
    expect(() => createGame({ players: two, settings: { turnSeconds: 0 } })).not.toThrow();
    expect(() => createGame({ players: two, settings: { turnSeconds: 2 } })).toThrow();
    expect(() => createGame({ players: two, settings: { lifelines: -1 } })).toThrow();
  });

  it('a timeout draws the player up to 25 EVEN WITH playable cards, then drops the last card', () => {
    const playable = card('R', 'n1');
    const s = makeState({ hands: [[playable, ...rest()], rest(), rest()], drawPile: filler(60) });
    const before = totalCards(s);
    const topBefore = s.discardPile.at(-1);
    const r = timeout(s, 0);
    expect(r.ok).toBe(true);
    const p0 = s.players[0];
    expect(p0?.hand.length).toBe(24); // 3 cards + 22 drawn = 25, last one dropped
    expect(p0?.lifelines).toBe(2);
    expect(p0?.eliminated).toBe(false);
    expect(s.drawPile.length).toBe(60 - 22);
    expect(s.discardPile.length).toBe(2); // the dropped card sits UNDER the top card
    expect(s.discardPile.at(-1)).toBe(topBefore);
    expect(totalCards(s)).toBe(before);
    expect(s.currentIndex).toBe(1);
    if (r.ok) {
      expect(r.events.map((e) => e.type)).toEqual(['timed_out', 'drew', 'lifeline_used']);
      const drew = r.events.find((e) => e.type === 'drew');
      expect(drew && drew.type === 'drew' && drew.reason === 'timeout' && drew.count === 22).toBe(true);
    }
  });

  it('a timeout cancels a pending penalty (the player is already topped up to the limit)', () => {
    const s = makeState({ hands: [rest(), rest()], top: card('R', 'd4'), pending: 4, last: 4, current: 1, drawPile: filler(60) });
    timeout(s, 1);
    expect(s.pendingDraw).toBe(0);
    expect(s.lastDrawValue).toBe(0);
    expect(s.players[1]?.hand.length).toBe(24);
    expect(s.currentIndex).toBe(0);
  });

  it('a timeout after drawing cancels the "must play" card', () => {
    const good = card('R', 'n7');
    const s = makeState({ hands: [[card('B', 'n3')], rest()], drawPile: [good], settings: { sevenZero: false } });
    draw(s, 0);
    expect(s.mustPlayCardId).toBe(good.id);
    timeout(s, 0);
    expect(s.mustPlayCardId).toBeNull();
    expect(s.currentIndex).toBe(1);
  });

  it('a player already at 24 cards just loses the lifeline (they draw one and drop it)', () => {
    const s = makeState({ hands: [hand24(), rest()], drawPile: filler(10) });
    timeout(s, 0);
    expect(s.players[0]?.hand.length).toBe(24);
    expect(s.players[0]?.lifelines).toBe(2);
  });

  it('after 3 lifelines are used, the next timeout is an automatic exit', () => {
    const s = makeState({ hands: [rest(), rest(), rest()], drawPile: filler(80) });
    for (let used = 1; used <= 3; used++) {
      s.currentIndex = 0;
      expect(timeout(s, 0).ok).toBe(true);
      expect(s.players[0]?.eliminated).toBe(false);
      expect(s.players[0]?.lifelines).toBe(3 - used);
    }
    s.currentIndex = 0;
    const before = totalCards(s);
    const r = timeout(s, 0);
    expect(r.ok && r.events.some((e) => e.type === 'eliminated' && e.reason === 'timeout')).toBe(true);
    expect(s.players[0]?.eliminated).toBe(true);
    expect(s.players[0]?.eliminatedBy).toBe('timeout');
    expect(s.players[0]?.hand).toEqual([]);
    expect(totalCards(s)).toBe(before); // their cards went back into the draw pile
    expect(s.status).toBe('playing');
    expect(s.currentIndex).toBe(1);
  });

  it('the last player standing wins when the other times out for good', () => {
    const s = makeState({ hands: [rest(), rest()], settings: { lifelines: 0 } });
    timeout(s, 0);
    expect(s.status).toBe('finished');
    expect(s.winnerId).toBe('u1');
  });

  it('only the player being waited on can time out', () => {
    const s = makeState({ hands: [rest(), rest()] });
    const before = structuredClone(s);
    const r = timeout(s, 1);
    expect(!r.ok && r.code).toBe('NOT_YOUR_TURN');
    expect(s).toEqual(before);
  });

  it('a Color Roulette victim who times out is penalised, the prompt closes and play moves on', () => {
    const cr = card('W', 'cr');
    const s = makeState({ hands: [[cr, ...rest()], rest(), rest()], drawPile: filler(60) });
    play(s, 0, cr);
    expect(s.prompt?.by).toBe(1);
    expect(timeout(s, 0).ok).toBe(false); // the origin is not who we are waiting for
    expect(timeout(s, 1).ok).toBe(true);
    expect(s.prompt).toBeNull();
    expect(s.players[1]?.hand.length).toBe(24);
    expect(s.players[1]?.lifelines).toBe(2);
    expect(s.activeColor).toBe('R'); // no color was chosen, so it is unchanged
    expect(s.currentIndex).toBe(2);
  });

  it('if the piles run dry the player keeps what was drawn and nothing is dropped', () => {
    const s = makeState({ hands: [rest(), rest()], drawPile: filler(5) });
    const r = timeout(s, 0);
    expect(r.ok).toBe(true);
    expect(s.players[0]?.hand.length).toBe(7);
    expect(s.players[0]?.lifelines).toBe(2);
    expect(r.ok && r.events.some((e) => e.type === 'lifeline_used' && e.dropped.length === 0)).toBe(true);
  });

  it('lifelines do NOT protect against reaching 25 cards through penalties (classic Mercy)', () => {
    const d4 = card('R', 'd4');
    const s = makeState({ hands: [[d4, ...rest()], hand24()], drawPile: filler(20) });
    play(s, 0, d4);
    take(s, 1);
    expect(s.players[1]?.eliminated).toBe(true);
    expect(s.players[1]?.lifelines).toBe(3);
  });
});

describe('winning and leaving', () => {
  it('playing your last card wins; nothing works afterwards', () => {
    const last = card('R', 'n1');
    const s = makeState({ hands: [[last], rest()] });
    play(s, 0, last);
    expect(s.status).toBe('finished');
    expect(s.winnerId).toBe('u0');
    expect(s.endReason).toBe('empty_hand');
    const again = draw(s, 1);
    expect(!again.ok && again.code).toBe('GAME_OVER');
  });

  it('a player who leaves on their turn passes the turn and their penalty is dropped', () => {
    const s = makeState({ hands: [rest(), rest(), rest()], pending: 4, last: 4, current: 1, top: card('R', 'd4') });
    const r = applyAction(s, { type: 'forfeit', playerId: 'u1' }, rng);
    expect(r.ok).toBe(true);
    expect(s.players[1]?.eliminated).toBe(true);
    expect(s.pendingDraw).toBe(0);
    expect(s.currentIndex).toBe(2);
  });

  it('a Roulette victim who leaves does not freeze the game', () => {
    const cr = card('W', 'cr');
    const s = makeState({ hands: [[cr, ...rest()], rest(), rest()] });
    play(s, 0, cr);
    applyAction(s, { type: 'forfeit', playerId: 'u1' }, rng);
    expect(s.prompt).toBeNull();
    expect(s.currentIndex).toBe(2);
  });

  it('when all but one leave, the last one wins', () => {
    const s = makeState({ hands: [rest(), rest()] });
    applyAction(s, { type: 'forfeit', playerId: 'u1' }, rng);
    expect(s.status).toBe('finished');
    expect(s.winnerId).toBe('u0');
  });
});

describe('what each player is allowed to see', () => {
  it("never includes other players' cards", () => {
    const s = createGame({
      players: [{ userId: 'a', name: 'A' }, { userId: 'b', name: 'B' }, { userId: 'c', name: 'C' }],
      rng: seeded(3),
      startIndex: 0,
    });
    const view = viewFor(s, 'a');
    const json = JSON.stringify(view);
    for (const c of s.players[1]?.hand ?? []) expect(json).not.toContain(`"${c.id}"`);
    for (const c of s.drawPile) expect(json).not.toContain(`"${c.id}"`);
    expect(view.players.map((p) => p.cardCount)).toEqual([7, 7, 7]);
    expect(view.you?.hand.length).toBe(7);
    expect(viewFor(s, 'spectator').you).toBeNull();
  });

  it('tells the player which cards are playable and what they can do', () => {
    const ok = card('R', 'n1');
    const no = card('B', 'n2');
    const s = makeState({ hands: [[ok, no], rest()] });
    const v = viewFor(s, 'u0');
    expect(v.you?.playableCardIds).toEqual([ok.id]);
    expect(v.you?.canDraw).toBe(false);
    expect(viewFor(s, 'u1').you?.isYourTurn).toBe(false);
  });

  it('hides drawn cards from everyone except the player who drew them', () => {
    const drawn = card('B', 'n1');
    const event: GameEvent = { type: 'drew', playerId: 'u0', count: 1, reason: 'draw', cards: [drawn] };
    expect(redactEvent(event, 'u0')).toHaveProperty('cards');
    expect(redactEvent(event, 'u1')).not.toHaveProperty('cards');
  });
});

describe('simulation: random bots play whole games', () => {
  it('keeps all 168 cards, never throws, and every game finishes', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = seeded(seed);
      const n = 2 + (seed % 5);
      const s = createGame({
        players: Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, name: `P${i}` })),
        settings: { lifelines: seed % 2 === 0 ? 3 : 0 }, // half the games with lifelines, half classic Mercy
        rng: r,
      });

      let moves = 0;
      while (s.status === 'playing') {
        if (++moves > 5000) throw new Error(`seed ${seed}: game did not finish`);
        const actor = s.prompt ? s.prompt.by : s.currentIndex;
        const who = s.players[actor];
        if (!who) throw new Error('no actor');
        const view = viewFor(s, who.userId).you;
        if (!view) throw new Error('no view');

        let action: Action;
        if (r(12) === 0) {
          action = { type: 'timeout', playerId: who.userId };
        } else if (s.prompt) {
          action = { type: 'chooseRouletteColor', playerId: who.userId, color: COLORS[r(4)] ?? 'R' };
        } else if (view.playableCardIds.length > 0 && !(view.canTakePenalty && r(5) === 0)) {
          const id = view.playableCardIds[r(view.playableCardIds.length)] ?? '';
          const others = s.players.filter((p) => !p.eliminated && p.userId !== who.userId);
          action = {
            type: 'play',
            playerId: who.userId,
            cardId: id,
            color: COLORS[r(4)] ?? 'R',
            targetId: others[r(others.length)]?.userId,
          };
        } else if (view.canTakePenalty) {
          action = { type: 'takePenalty', playerId: who.userId };
        } else if (view.canDraw) {
          action = { type: 'draw', playerId: who.userId };
        } else {
          throw new Error(`seed ${seed}: player has no legal action`);
        }

        const result = applyAction(s, action, r);
        if (!result.ok) throw new Error(`seed ${seed}: ${action.type} rejected: ${result.code} ${result.message}`);

        const ids = [...s.drawPile, ...s.discardPile, ...s.players.flatMap((p) => p.hand)].map((c) => c.id);
        expect(ids.length).toBe(168);
        expect(new Set(ids).size).toBe(168);
      }
      expect(s.winnerId).not.toBeNull();
      expect(viewFor(s, 'u0').standings.length).toBe(n);
    }
  });
});
