import { z } from 'zod';

const color = z.enum(['R', 'Y', 'G', 'B']);
/** 0 = no timer, otherwise 5-300 seconds. */
const turnSeconds = z.union([z.literal(0), z.number().int().min(5).max(300)]);

const settingsPatch = z.strictObject({
  sevenZero: z.boolean().optional(),
  turnSeconds: turnSeconds.optional(),
  lifelines: z.number().int().min(0).max(10).optional(),
});

export const anything = z.unknown();

export const createRoomSchema = z
  .strictObject({
    maxPlayers: z.number().int().min(2).max(6).optional(),
    settings: settingsPatch.optional(),
  })
  .optional();

export const joinRoomSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6}$/, 'Room codes are 6 letters/numbers'),
});

export const readySchema = z.strictObject({ ready: z.boolean() });

export const roomSettingsSchema = z.strictObject({
  maxPlayers: z.number().int().min(2).max(6).optional(),
  settings: settingsPatch.optional(),
});

export const playSchema = z.strictObject({
  cardId: z.string().min(1).max(32),
  /** Required for Reverse +4, +6 and +10. */
  color: color.optional(),
  /** Required for a 7 when the 7-0 rule is on: the player to swap hands with. */
  targetId: z.string().min(1).max(64).optional(),
});

export const chooseColorSchema = z.strictObject({ color });
