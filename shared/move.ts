// Movement with tile collision. Shared so the client can predict its own movement
// exactly the way the authoritative server simulates it.

import { type GameMap, isBlocking } from "./map.ts";
import { ENTITY_RADIUS } from "./constants.ts";

function collides(map: GameMap, x: number, y: number, r: number): boolean {
  return (
    isBlocking(map, Math.floor(x - r), Math.floor(y - r)) ||
    isBlocking(map, Math.floor(x + r), Math.floor(y - r)) ||
    isBlocking(map, Math.floor(x - r), Math.floor(y + r)) ||
    isBlocking(map, Math.floor(x + r), Math.floor(y + r))
  );
}

/**
 * Move a position by direction (dx,dy) (any length; normalized here) for dt seconds.
 * Axis-separated so entities slide along walls. Mutates and returns pos.
 */
export function stepMove(map: GameMap, pos: { x: number; y: number }, dx: number, dy: number, speed: number, dt: number) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return pos;
  const vx = (dx / len) * speed * dt, vy = (dy / len) * speed * dt;
  const r = ENTITY_RADIUS;
  if (!collides(map, pos.x + vx, pos.y, r)) pos.x += vx;
  if (!collides(map, pos.x, pos.y + vy, r)) pos.y += vy;
  return pos;
}

/** Screen-relative input → world direction. Isometric: screen up = world (-1,-1). */
export function screenDirToWorld(sx: number, sy: number): { x: number; y: number } {
  // screen x axis = (world x - world y), screen y axis = (world x + world y)/2
  const wx = sx + sy;
  const wy = sy - sx;
  const l = Math.hypot(wx, wy);
  return l < 1e-6 ? { x: 0, y: 0 } : { x: wx / l, y: wy / l };
}

/** 8-way facing index from a world-space direction (0 = +x, clockwise in world). */
export function facingFromDir(dx: number, dy: number, prev = 0): number {
  if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) return prev;
  const a = Math.atan2(dy, dx);
  return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
}
