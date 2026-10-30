import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cardsRouter } from '../src/routes/cards.js';
import { corsMiddleware } from '../src/utils/cors.js';

let url = '';
const http = createServer(
  express().use(corsMiddleware(['http://localhost:5173'])).use(cardsRouter),
);

beforeAll(async () => {
  await new Promise<void>((resolve) => http.listen(0, resolve));
  url = `http://localhost:${(http.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())));

describe('GET /cards', () => {
  it('returns the 168-card catalog with stable ids', async () => {
    const res = await fetch(`${url}/cards`);
    const body = (await res.json()) as { deckSize: number; cards: { id: string; color: string; type: string }[] };
    expect(res.status).toBe(200);
    expect(body.deckSize).toBe(168);
    expect(body.cards).toHaveLength(168);
    expect(body.cards[0]).toEqual({ id: 'c_0', color: 'R', type: 'n0' });
    expect(body.cards[167]?.id).toBe('c_167');
  });

  it('allows the configured frontend origin and no one else', async () => {
    const ok = await fetch(`${url}/cards`, { headers: { Origin: 'http://localhost:5173' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const other = await fetch(`${url}/cards`, { headers: { Origin: 'http://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${url}/cards`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    expect(preflight.status).toBe(204);
  });
});
