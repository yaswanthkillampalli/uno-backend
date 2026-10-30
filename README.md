# UNO No Mercy server

Server-authoritative UNO No Mercy over Socket.IO, with Supabase for users and storage
(no Supabase Realtime). Node 22.12+ / 24 LTS, TypeScript 7.

## Setup

1. `npm install`
2. Run `sql/schema.sql` once in the Supabase SQL Editor.
3. Copy `.env.example` to `.env` and fill it in (the **secret** key stays on the server).
4. `npm run dev`

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server with auto-reload |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm test` | All tests (rules, rooms, sockets; no Supabase needed) |
| `npm run typecheck` | Type-check `src`, `tests` and `scripts` |
| `npm run smoke` | Plays a real game against your running server and Supabase project |

## Layout

- `src/game/` pure rules engine (no sockets, no database)
- `src/rooms/` rooms, lobby, turn timer, persistence
- `src/sockets/` auth, validation, `room:*` / `game:*` events
- `sql/schema.sql` database schema
- `docs/PROTOCOL.md` everything a frontend needs to talk to this server
