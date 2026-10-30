/**
 * End-to-end smoke test against your REAL Supabase project and a RUNNING server (`npm run dev`).
 *
 *   npm run smoke                  play a whole 2-player game, then check what landed in the database
 *   npm run smoke -- --timer       check the real turn timer + lifelines (takes ~10 s)
 *   npm run smoke -- --restart     check restart recovery: the script asks YOU to restart the server
 *   add  --cleanup                 delete the test room afterwards (the test users are kept)
 */
import { createClient } from '@supabase/supabase-js';
import {
  ask,
  connectPlayer,
  disconnectAll,
  must,
  playToEnd,
  restartScenario,
  setupGame,
  sleep,
  waitUntil,
  type Check,
  type Client,
  type Player,
} from './flow.js';

const args = new Set(process.argv.slice(2));
const mode = args.has('--timer') ? 'timer' : args.has('--restart') ? 'restart' : 'full';
const cleanup = args.has('--cleanup');

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Add it to .env (see .env.example).`);
    process.exit(1);
  }
  return value;
}

const supabaseUrl = need('SUPABASE_URL');
const secretKey = need('SUPABASE_SECRET_KEY');
const publishableKey = need('SUPABASE_PUBLISHABLE_KEY');
const serverUrl = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? '3001'}`;
const password = process.env.SMOKE_PASSWORD ?? 'Smoke-Test-123456!';

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = createClient(supabaseUrl, secretKey, noSession); // can do anything: used to create users and look at the tables
const browserLike = createClient(supabaseUrl, publishableKey, noSession); // what the frontend would use

const t0 = Date.now();
const log = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${msg}`);

// ---------- users --------------------------------------------------------------------
async function ensureUser(n: number): Promise<Player> {
  const email = `uno-smoke-${n}@example.com`;
  const username = `smoke_${n}`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username },
  });
  if (created.error && created.error.code !== 'email_exists' && !/already|exists|registered/i.test(created.error.message)) {
    throw new Error(`Could not create ${email}: ${created.error.message}`);
  }
  const signedIn = await browserLike.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) {
    throw new Error(
      `Could not sign in as ${email}: ${signedIn.error?.message}. If this user already exists with another password, delete it in Authentication > Users or set SMOKE_PASSWORD.`,
    );
  }
  return { name: username, userId: signedIn.data.user.id, token: signedIn.data.session.access_token };
}

// ---------- database checks ------------------------------------------------------------
async function databaseChecks(
  code: string,
  players: Player[],
  expect: { gameStatus: 'finished'; roomStatus: 'lobby' | 'closed'; results: boolean },
): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  };
  const ids = players.map((p) => p.userId);

  const profiles = await admin.from('profiles').select('id, username').in('id', ids);
  check('profiles: each test user has a profile row (created by the sign-up trigger)', (profiles.data?.length ?? 0) === ids.length, profiles.error?.message);

  const room = await admin.from('rooms').select('id, status, host_id, max_players, settings').eq('code', code).maybeSingle();
  check('rooms: the room was saved', !!room.data, room.error?.message);
  if (!room.data) return checks;
  check(`rooms: status is "${expect.roomStatus}"`, room.data.status === expect.roomStatus, `status=${room.data.status}`);
  check('rooms: host is the first player', room.data.host_id === ids[0]);

  const seats = await admin.from('room_players').select('user_id, seat').eq('room_id', room.data.id);
  if (expect.roomStatus === 'lobby') {
    check('room_players: both players are listed', (seats.data?.length ?? 0) === players.length, `rows=${seats.data?.length}`);
  } else {
    check('room_players: emptied when everyone left', (seats.data?.length ?? 0) === 0, `rows=${seats.data?.length}`);
  }

  // Database writes are queued behind the game, so give them a moment.
  let game: { id: string; status: string; version: number; finished_at: string | null } | null = null;
  for (let i = 0; i < 40; i++) {
    const g = await admin.from('games').select('id, status, version, finished_at').eq('room_id', room.data.id).order('started_at', { ascending: false }).limit(1).maybeSingle();
    game = g.data;
    if (game?.status === expect.gameStatus) break;
    await sleep(250);
  }
  check('games: the game was saved', !!game);
  check(`games: status is "${expect.gameStatus}" with a finish time`, game?.status === expect.gameStatus && !!game.finished_at, `status=${game?.status}`);
  check('games: the snapshot has been updated during play', (game?.version ?? 0) > 0, `version=${game?.version}`);

  if (game && expect.results) {
    const results = await admin.from('game_results').select('user_id, placement, cards_left, eliminated').eq('game_id', game.id).order('placement');
    check('game_results: one row per player', (results.data?.length ?? 0) === players.length, results.error?.message);
    check('game_results: placements are 1..N', JSON.stringify(results.data?.map((r) => r.placement)) === JSON.stringify(players.map((_, i) => i + 1)), JSON.stringify(results.data?.map((r) => r.placement)));
  }
  return checks;
}

// ---------- scenarios --------------------------------------------------------------------
async function main(): Promise<Check[]> {
  const health = await fetch(`${serverUrl}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`Could not reach the server at ${serverUrl}. Is "npm run dev" running?`);

  log('creating / signing in the two test users...');
  const players = [await ensureUser(1), await ensureUser(2)];
  const clients: Client[] = [];
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  };

  try {
    // A bad token must be refused.
    const refused = await connectPlayer(serverUrl, { name: 'intruder', userId: 'x', token: 'not-a-real-token' }).then(
      (c) => (c.socket.close(), false),
      () => true,
    );
    check('auth: a made-up token is refused', refused);

    for (const p of players) clients.push(await connectPlayer(serverUrl, p));
    check('auth: real Supabase tokens are accepted', clients.every((c) => c.socket.connected));

    if (mode === 'timer') {
      const code = await setupGame(clients, { turnSeconds: 5 }, log);
      const first = clients[0]!.game!.state.turnPlayerId;
      log('not acting on purpose, waiting for the 5 s turn timer...');
      const update = await waitUntil(() => clients[0]!.updates.find((u) => u.events.some((e) => e.type === 'timed_out')), 12_000, 'the turn timer to fire');
      const lost = update.state.players.find((p) => p.userId === first);
      check('timer: the player being waited on timed out', update.events.some((e) => e.type === 'timed_out' && e.playerId === first));
      check('timer: it cost one lifeline (3 -> 2)', lost?.lifelines === 2, `lifelines=${lost?.lifelines}`);
      check('timer: they were dealt up to the limit and dropped one card (24 cards)', lost?.cardCount === 24, `cards=${lost?.cardCount}`);
      check('timer: the next turn has a fresh ~5 s deadline', update.deadlineAt !== null && Math.abs(update.deadlineAt - update.serverNow - 5000) <= 100, `deadline in ${update.deadlineAt === null ? 'n/a' : update.deadlineAt - update.serverNow} ms`);

      log('player 2 leaves (forfeit), then the host leaves...');
      await must(ask(clients[1]!, 'room:leave'), 'room:leave');
      await waitUntil(() => clients[0]!.game?.state.status === 'finished', 5000, 'the game to end');
      check('leaving: the other player wins the game', clients[0]!.game?.state.winnerId === players[0]!.userId);
      await must(ask(clients[0]!, 'room:leave'), 'room:leave');
      checks.push(...(await databaseChecks(code, players, { gameStatus: 'finished', roomStatus: 'closed', results: true })));
      return finish(code, checks);
    }

    const code = await setupGame(clients, { turnSeconds: 0 }, log);

    if (mode === 'restart') {
      checks.push(...(await restartScenario(clients, log)));
      log('finishing the game after the restart...');
    }

    const moves = await playToEnd(clients, 3000, log);
    log(`game over after ${moves} more moves`);
    const end = clients[0]!.game!.state;
    check('game: every player sees the game as finished', clients.every((c) => c.game?.state.status === 'finished'));
    check('game: a winner was decided', !!end.winnerId, `${end.endReason}`);
    check('game: standings list every player', end.standings.length === players.length);

    checks.push(...(await databaseChecks(code, players, { gameStatus: 'finished', roomStatus: 'lobby', results: true })));
    return finish(code, checks);
  } finally {
    disconnectAll(clients);
  }
}

async function finish(code: string, checks: Check[]): Promise<Check[]> {
  if (cleanup) {
    await admin.from('rooms').delete().eq('code', code); // cascades to room_players, games and game_results
    log(`deleted room ${code}`);
  } else {
    log(`room ${code} left in the database so you can look at it in the Table Editor (use --cleanup to delete it)`);
  }
  return checks;
}

try {
  const checks = await main();
  console.log('');
  for (const c of checks) console.log(`${c.ok ? '  PASS' : '  FAIL'}  ${c.name}${c.detail && !c.ok ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed (${mode} mode)`);
  process.exit(failed > 0 ? 1 : 0);
} catch (error) {
  console.error(`\nSmoke test stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
