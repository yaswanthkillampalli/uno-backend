import type { RoomManager } from '../rooms/roomManager.js';
import type { AuthUser } from '../rooms/types.js';
import type { Handler } from './handle.js';
import { anything, chooseColorSchema, playSchema } from './schemas.js';

// Only these four requests exist. Note there is deliberately NO socket event for the engine's
// 'timeout' or 'forfeit' actions: the server's timers and room:leave are the only way those happen.
export function registerGameHandlers(on: Handler, manager: RoomManager, user: AuthUser): void {
  on('game:play', playSchema, (data) =>
    manager.gameAction(user.id, { type: 'play', cardId: data.cardId, color: data.color, targetId: data.targetId }),
  );
  on('game:draw', anything, () => manager.gameAction(user.id, { type: 'draw' }));
  on('game:takePenalty', anything, () => manager.gameAction(user.id, { type: 'takePenalty' }));
  /** Only the Color Roulette victim may call this. */
  on('game:chooseColor', chooseColorSchema, (data) =>
    manager.gameAction(user.id, { type: 'chooseRouletteColor', color: data.color }),
  );
}
