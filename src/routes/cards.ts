import { Router } from 'express';
import { CATALOG, DECK_SIZE } from '../game/deck.js';

export const cardsRouter = Router();

// The fixed 168-card catalog. A card's id never changes, so the frontend can key its art by id.
cardsRouter.get('/cards', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json({ deckSize: DECK_SIZE, cards: CATALOG });
});
