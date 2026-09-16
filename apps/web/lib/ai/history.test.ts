import { describe, it, expect } from 'vitest';
import { groupByRecency, resumeTarget, scopeChipLabel, type HistoryItem } from './history';

// Local midnight, computed exactly as groupByRecency computes it. Fixtures are
// placed relative to THIS, not to NOW: local midnight can fall as late as NOW
// itself (UTC+12), so an offset from NOW buckets differently by timezone while
// an offset from t0 does not.
const NOW = new Date('2026-09-16T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const t0 = (() => { const d = new Date(NOW); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const at = (ms: number) => new Date(t0 + ms).toISOString();

const item = (id: string, iso: string): HistoryItem => ({
  id, title: id, scopeKind: 'app', scopeId: null, scopeLabel: null,
  lastTurnAt: iso, turnCount: 2,
});

describe('groupByRecency', () => {
  it('buckets by how recent the last turn was', () => {
    const groups = groupByRecency([
      item('today', at(1 * HOUR)),
      item('yesterday', at(-1 * HOUR)),
      item('thisweek', at(-3 * DAY)),
      item('older', at(-40 * DAY)),
    ], NOW);

    expect(groups.map((g) => g.bucket)).toEqual(['Today', 'Yesterday', 'Earlier this week', 'Older']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['today']);
    expect(groups[3].items.map((i) => i.id)).toEqual(['older']);
  });

  it('omits a bucket that has nothing in it', () => {
    const groups = groupByRecency([item('older', at(-40 * DAY))], NOW);
    expect(groups.map((g) => g.bucket)).toEqual(['Older']);
  });

  it('keeps the order it was given within a bucket', () => {
    const groups = groupByRecency([
      item('a', at(1 * HOUR)),
      item('b', at(3 * HOUR)),
    ], NOW);
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('puts an item exactly at local midnight in Today, not Yesterday', () => {
    const groups = groupByRecency([item('boundary', at(0))], NOW);
    expect(groups[0].bucket).toBe('Today');
  });
});

describe('resumeTarget', () => {
  it('sends a thread conversation to its thread', () => {
    expect(resumeTarget({ scopeKind: 'thread', scopeId: 'm1' })).toBe('/mail?open=m1');
  });

  it('sends a doc conversation to its document', () => {
    expect(resumeTarget({ scopeKind: 'doc', scopeId: 'd1' })).toBe('/docs?open=d1');
  });

  it('opens an app-wide conversation in place', () => {
    expect(resumeTarget({ scopeKind: 'app', scopeId: null })).toBeNull();
  });

  it('opens in place when a scoped conversation lost its target', () => {
    expect(resumeTarget({ scopeKind: 'thread', scopeId: null })).toBeNull();
  });

  it('encodes an id that needs it', () => {
    expect(resumeTarget({ scopeKind: 'doc', scopeId: 'a b&c' })).toBe('/docs?open=a%20b%26c');
  });
});

describe('scopeChipLabel', () => {
  it('names what a thread conversation was about', () => {
    expect(scopeChipLabel({ scopeKind: 'thread', scopeLabel: 'Q3 budget' })).toBe('Thread: Q3 budget');
  });

  it('names what a doc conversation was about', () => {
    expect(scopeChipLabel({ scopeKind: 'doc', scopeLabel: 'Cabinet paper' })).toBe('Doc: Cabinet paper');
  });

  it('falls back when the label was never captured', () => {
    expect(scopeChipLabel({ scopeKind: 'thread', scopeLabel: null })).toBe('Thread');
  });

  it('calls an app-wide conversation what it is', () => {
    expect(scopeChipLabel({ scopeKind: 'app', scopeLabel: null })).toBe('Anywhere');
  });
});
