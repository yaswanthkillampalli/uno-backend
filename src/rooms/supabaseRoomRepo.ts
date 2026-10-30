import { supabase } from '../lib/supabase.js';
import type { GameState } from '../game/types.js';
import type { Standing } from '../game/view.js';
import type { PersistedRoom, RoomRepo } from './roomRepo.js';
import { DEFAULT_ROOM_SETTINGS, type RoomSettings } from './types.js';

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

interface RoomRow {
  id: string;
  code: string;
  host_id: string;
  status: 'lobby' | 'playing';
  max_players: number;
  settings: Partial<RoomSettings> | null;
  room_players: {
    user_id: string;
    seat: number;
    is_ready: boolean;
    profiles: { username: string } | { username: string }[] | null;
  }[];
}

export class SupabaseRoomRepo implements RoomRepo {
  async getProfile(userId: string): Promise<{ username: string } | null> {
    const { data, error } = await supabase.from('profiles').select('username').eq('id', userId).maybeSingle();
    check(error, 'getProfile');
    return data ? { username: String(data.username) } : null;
  }

  async insertRoom(room: {
    id: string;
    code: string;
    hostId: string;
    maxPlayers: number;
    settings: RoomSettings;
  }): Promise<'ok' | 'code_taken'> {
    const { error } = await supabase.from('rooms').insert({
      id: room.id,
      code: room.code,
      host_id: room.hostId,
      max_players: room.maxPlayers,
      settings: room.settings,
    });
    if (error?.code === '23505') return 'code_taken';
    check(error, 'insertRoom');
    return 'ok';
  }

  async updateRoom(
    id: string,
    patch: { status?: 'lobby' | 'playing' | 'closed'; hostId?: string; maxPlayers?: number; settings?: RoomSettings },
  ): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.hostId !== undefined) row.host_id = patch.hostId;
    if (patch.maxPlayers !== undefined) row.max_players = patch.maxPlayers;
    if (patch.settings !== undefined) row.settings = patch.settings;
    const { error } = await supabase.from('rooms').update(row).eq('id', id);
    check(error, 'updateRoom');
  }

  async upsertRoomPlayer(roomId: string, userId: string, seat: number, isReady: boolean): Promise<void> {
    const { error } = await supabase
      .from('room_players')
      .upsert({ room_id: roomId, user_id: userId, seat, is_ready: isReady }, { onConflict: 'room_id,user_id' });
    check(error, 'upsertRoomPlayer');
  }

  async deleteRoomPlayer(roomId: string, userId: string): Promise<void> {
    const { error } = await supabase.from('room_players').delete().eq('room_id', roomId).eq('user_id', userId);
    check(error, 'deleteRoomPlayer');
  }

  async insertGame(game: { id: string; roomId: string; state: GameState }): Promise<void> {
    const { error } = await supabase
      .from('games')
      .insert({ id: game.id, room_id: game.roomId, state: game.state, version: game.state.version, status: 'playing' });
    check(error, 'insertGame');
  }

  async saveGame(id: string, state: GameState): Promise<void> {
    const { error } = await supabase.from('games').update({ state, version: state.version }).eq('id', id);
    check(error, 'saveGame');
  }

  async finishGame(id: string, state: GameState, standings: Standing[]): Promise<void> {
    const { error } = await supabase
      .from('games')
      .update({ state, version: state.version, status: 'finished', finished_at: new Date().toISOString() })
      .eq('id', id);
    check(error, 'finishGame');
    if (standings.length > 0) {
      const { error: resultsError } = await supabase.from('game_results').upsert(
        standings.map((s) => ({
          game_id: id,
          user_id: s.userId,
          placement: s.placement,
          cards_left: s.cardsLeft,
          eliminated: s.eliminated,
        })),
        { onConflict: 'game_id,user_id' },
      );
      check(resultsError, 'finishGame results');
    }
  }

  async abortGame(id: string): Promise<void> {
    const { error } = await supabase
      .from('games')
      .update({ status: 'aborted', finished_at: new Date().toISOString() })
      .eq('id', id);
    check(error, 'abortGame');
  }

  async loadActiveRooms(): Promise<PersistedRoom[]> {
    const { data, error } = await supabase
      .from('rooms')
      .select('id, code, host_id, status, max_players, settings, room_players(user_id, seat, is_ready, profiles(username))')
      .in('status', ['lobby', 'playing']);
    check(error, 'loadActiveRooms');
    const rooms = (data ?? []) as unknown as RoomRow[];
    if (rooms.length === 0) return [];

    const { data: games, error: gamesError } = await supabase
      .from('games')
      .select('id, room_id, state')
      .eq('status', 'playing')
      .in('room_id', rooms.map((r) => r.id));
    check(gamesError, 'loadActiveRooms games');
    const gameByRoom = new Map<string, { id: string; state: unknown }>();
    for (const g of (games ?? []) as unknown as { id: string; room_id: string; state: unknown }[]) {
      gameByRoom.set(g.room_id, { id: g.id, state: g.state });
    }

    return rooms.map((r) => ({
      id: r.id,
      code: r.code,
      hostId: r.host_id,
      status: r.status,
      maxPlayers: r.max_players,
      settings: { ...DEFAULT_ROOM_SETTINGS, ...(r.settings ?? {}) },
      players: r.room_players.map((p) => {
        const profile = Array.isArray(p.profiles) ? p.profiles[0] : p.profiles;
        return { userId: p.user_id, username: profile?.username ?? 'player', seat: p.seat, isReady: p.is_ready };
      }),
      game: gameByRoom.get(r.id) ?? null,
    }));
  }
}
