import { randomInt } from 'node:crypto';

export function drawWinners(participants: readonly string[], count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 0 || new Set(participants).size !== participants.length) {
    throw new Error('Invalid giveaway draw input');
  }
  const pool = [...participants];
  const places = Math.min(count, pool.length);
  for (let i = 0; i < places; i++) {
    const selected = randomInt(i, pool.length);
    [pool[i], pool[selected]] = [pool[selected], pool[i]];
  }
  return pool.slice(0, places);
}
