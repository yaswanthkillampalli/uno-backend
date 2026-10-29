-- =============================================================================
-- UNO No Mercy: database schema
-- Run this whole file once in: Supabase Dashboard > SQL Editor > New query.
-- Safe to re-run: it uses "if not exists" / "create or replace" where possible.
-- =============================================================================

-- ---------- helper: keep updated_at fresh -----------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- profiles (one row per Supabase Auth user) -----------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null,
  created_at timestamptz not null default now(),
  constraint profiles_username_length check (char_length(username) between 3 and 20),
  constraint profiles_username_chars  check (username ~ '^[A-Za-z0-9_]+$')
);

create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

-- Auto-create a profile on sign-up. The client can pass a username via
-- signUp({ options: { data: { username: 'Sam' } } }). If it is missing,
-- invalid or already taken, we fall back to "player_xxxxxxxx".
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  desired  text := nullif(trim(new.raw_user_meta_data ->> 'username'), '');
  fallback text := 'player_' || substr(replace(new.id::text, '-', ''), 1, 8);
begin
  begin
    insert into public.profiles (id, username)
    values (new.id, coalesce(desired, fallback));
  exception when unique_violation or check_violation then
    insert into public.profiles (id, username) values (new.id, fallback);
  end;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for users that already exist (safe if there are none).
insert into public.profiles (id, username)
select u.id, 'player_' || substr(replace(u.id::text, '-', ''), 1, 8)
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- ---------- rooms -----------------------------------------------------------
create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  host_id     uuid not null references public.profiles (id) on delete cascade,
  status      text not null default 'lobby',
  max_players smallint not null default 4,
  settings    jsonb not null default '{"sevenZero": true}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint rooms_code_format   check (code ~ '^[A-Z0-9]{6}$'),
  constraint rooms_status_valid  check (status in ('lobby', 'playing', 'finished', 'closed')),
  constraint rooms_players_range check (max_players between 2 and 6)
);

create unique index if not exists rooms_code_idx on public.rooms (code);
create index if not exists rooms_status_idx on public.rooms (status);

drop trigger if exists rooms_set_updated_at on public.rooms;
create trigger rooms_set_updated_at
  before update on public.rooms
  for each row execute function public.set_updated_at();

-- ---------- room_players ----------------------------------------------------
create table if not exists public.room_players (
  room_id   uuid not null references public.rooms (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  seat      smallint not null,
  is_ready  boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id),
  constraint room_players_seat_unique unique (room_id, seat),
  constraint room_players_seat_range  check (seat between 0 and 5)
);

create index if not exists room_players_user_idx on public.room_players (user_id);

-- ---------- games (server snapshots) ----------------------------------------
-- "state" holds EVERY player's hand and the draw pile. It is only ever read by
-- the backend. Clients must never be able to query this table.
create table if not exists public.games (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms (id) on delete cascade,
  status      text not null default 'playing',
  state       jsonb not null,
  version     integer not null default 0,
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  finished_at timestamptz,
  constraint games_status_valid check (status in ('playing', 'finished', 'aborted'))
);

-- At most one running game per room.
create unique index if not exists games_one_active_per_room_idx
  on public.games (room_id) where status = 'playing';
create index if not exists games_room_idx on public.games (room_id);

drop trigger if exists games_set_updated_at on public.games;
create trigger games_set_updated_at
  before update on public.games
  for each row execute function public.set_updated_at();

-- ---------- game_results ----------------------------------------------------
create table if not exists public.game_results (
  game_id    uuid not null references public.games (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  placement  smallint not null,
  cards_left smallint not null default 0,
  eliminated boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (game_id, user_id),
  constraint game_results_placement_pos check (placement >= 1),
  constraint game_results_cards_pos     check (cards_left >= 0)
);

create index if not exists game_results_user_idx
  on public.game_results (user_id, created_at desc);

-- ---------- security --------------------------------------------------------
-- The backend uses the secret key (role service_role), which bypasses RLS.
-- Browsers must go through the WebSocket server for everything except reading
-- profiles, so rooms / room_players / games / game_results get RLS enabled with
-- NO policies and NO grants for anon/authenticated = closed to clients.
alter table public.profiles     enable row level security;
alter table public.rooms        enable row level security;
alter table public.room_players enable row level security;
alter table public.games        enable row level security;
alter table public.game_results enable row level security;

revoke all on public.profiles, public.rooms, public.room_players,
              public.games, public.game_results
  from anon, authenticated;

grant all on public.profiles, public.rooms, public.room_players,
             public.games, public.game_results
  to service_role;

-- Signed-in users may read profiles and change only their own username.
grant select on public.profiles to authenticated;
grant update (username) on public.profiles to authenticated;

drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated
  on public.profiles for select to authenticated
  using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));