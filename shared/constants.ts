// Global tunables shared by client and server.
// All world positions are in tile units (1.0 = one tile).

/** Server network/movement tick (Hz). */
export const SERVER_TICK_HZ = 20;
/** How often the server sends world snapshots to clients (Hz). */
export const SNAPSHOT_HZ = 10;
/** Fixed client input step in seconds (client sends one input per step while moving). */
export const INPUT_DT = 1 / 20;

/**
 * Prototype world clock: game minutes per real second.
 * NOTE: the concept cancels "1s = 1min" as canon; this is a prototype-only
 * value so a full day/night cycle fits into a play session (24 real minutes).
 * Only the server may change it — clients never control world time.
 */
export const GAME_MINUTES_PER_SECOND = 1;
export const MINUTES_PER_DAY = 24 * 60;
/** World starts at day 1, 07:00. */
export const WORLD_START_MINUTE = 7 * 60;

export const PLAYER_SPEED = 4.2; // tiles / sec
export const NPC_SPEED = 2.8;
export const ENTITY_RADIUS = 0.28;

/** Max distance (tiles) for talking / trading / pickpocketing. */
export const INTERACT_RANGE = 2.2;
/** Radius (tiles) in which agents perceive events (witnesses). */
export const PERCEPTION_RADIUS = 7;
/** Radius in which chat/speech bubbles are delivered to nearby players as "local" speech. */
export const SPEECH_RADIUS = 14;

export const START_COINS = 25;
