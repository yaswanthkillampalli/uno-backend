import type { RoomManager } from '../rooms/roomManager.js';
import type { AuthUser } from '../rooms/types.js';
import type { Handler } from './handle.js';
import { anything, createRoomSchema, joinRoomSchema, readySchema, roomSettingsSchema } from './schemas.js';

export function registerRoomHandlers(on: Handler, manager: RoomManager, user: AuthUser): void {
  on('room:create', createRoomSchema, (data) => manager.createRoom(user, data ?? {}));
  on('room:join', joinRoomSchema, (data) => manager.joinRoom(user, data.code));
  on('room:leave', anything, () => manager.leaveRoom(user.id));
  on('room:ready', readySchema, (data) => manager.setReady(user.id, data.ready));
  on('room:settings', roomSettingsSchema, (data) => manager.updateSettings(user.id, data));
  on('room:start', anything, () => manager.startGame(user.id));
  /** Ask for your current room + game again (e.g. after the app was in the background). */
  on('session:sync', anything, () => manager.sync(user.id));
}
