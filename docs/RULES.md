# Rules implemented

Source of truth for the official rules: Mattel's *UNO Show 'Em No Mercy* instruction sheet
(<https://service.mattel.com/instruction_sheets/HVW18-Eng.pdf>). The engine is `src/game/`.

## Official rules, implemented

| Rule | Implementation |
|---|---|
| 168-card deck, 7 cards each | `deck.ts`, `createGame` |
| A card must match the top card's **color, number or symbol** | `rules.ts` `checkPlay` |
| Wilds can always be played (unless a penalty is pending). After a wild, only the chosen color counts | `rules.ts` |
| **Stacking**: answer a draw card with a draw card of equal or higher value (+2, +4, Reverse +4, +6, +10); the penalty adds up and the last victim takes it all | `rules.ts`, `engine.ts` |
| **Draw until you can play**, only when you have no playable card, and you must then play that card | `handleDraw` |
| **Mercy**: 25 or more cards and you are out. Last player standing wins | `finalize` |
| Skip, Reverse (with 2 players it acts as a Skip), Skip Everyone | `handlePlay` |
| **Discard All**: dump every other card of that color under the played card | `handlePlay` |
| **Wild Reverse Draw 4**: reverse, next player in the new direction draws 4. With 2 players it skips the other player, so **you** draw 4 unless you stack a draw card of equal or higher value back | `handlePlay` |
| **Wild Color Roulette**: the next player chooses a color and draws until they get it (wilds don't count), then loses their turn | `handleRouletteColor` |
| **7** swaps hands with a player of your choice, **0** passes every hand one seat in the direction of play | `handlePlay` |
| Win by playing your last card | `finalize` |

## Rules that are specific to this game (not in the official rules)

| Rule | Notes |
|---|---|
| **Turn timer** (`turnSeconds`, 0 = off) and **lifelines** (`lifelines`, default 3) | A timeout costs one lifeline: the player is dealt cards up to 25, the last card is dropped (so they are left with 24), and any pending penalty is cancelled. With no lifelines left, a timeout is an automatic exit. Reaching 25 by drawing is still the normal Mercy elimination. |
| Leaving or disconnecting mid-game | Counts as a forfeit after the grace period (`DISCONNECT_GRACE_SECONDS`). |
| Eliminated players' cards | Shuffled straight back into the draw pile. |

## Known differences from the official rules / not implemented

- **Mercy**: the official sheet says to *set aside* an eliminated player's hand until the draw pile
  runs out and is reshuffled. Here the cards go back into the draw pile immediately.
- **Calling "UNO!"** is not implemented (the official sheet has a section for it).
- **Scoring** across several hands (the "optional victory method") is not implemented.
