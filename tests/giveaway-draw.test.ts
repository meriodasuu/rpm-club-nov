import { describe, expect, it } from 'vitest';
import { drawWinners } from '../src/lib/giveaways/draw';

describe('giveaway winner selection', () => {
  it('returns no winners for an empty participant list', () => {
    expect(drawWinners([], 3)).toEqual([]);
  });

  it('assigns each participant at most one place even when there are more prizes', () => {
    const winners = drawWinners(['a', 'b', 'c'], 10);
    expect(winners).toHaveLength(3);
    expect(new Set(winners)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('never draws the same participant twice or mutates the snapshot', () => {
    const participants = ['a', 'b', 'c', 'd'];
    const winners = drawWinners(participants, 3);
    expect(winners).toHaveLength(3);
    expect(new Set(winners).size).toBe(3);
    expect(winners.every(winner => participants.includes(winner))).toBe(true);
    expect(participants).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects duplicate participant identities and invalid prize counts', () => {
    expect(() => drawWinners(['a', 'a'], 1)).toThrow();
    for (const count of [-1, 1.5, NaN, Infinity]) {
      expect(() => drawWinners(['a'], count)).toThrow();
    }
  });
});
