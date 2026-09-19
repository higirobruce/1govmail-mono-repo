import { describe, it, expect } from 'vitest';
import { PHONE_MEDIA_QUERY, defaultCalView } from './defaultView';

describe('defaultCalView', () => {
  it('opens on the single day — today — on a phone', () => {
    // A week grid squeezed into a phone width is unreadable; on a phone the
    // useful default is the day you are actually in.
    expect(defaultCalView(true)).toBe('day');
  });

  it('opens on the work week everywhere else', () => {
    expect(defaultCalView(false)).toBe('workweek');
  });
});

describe('PHONE_MEDIA_QUERY', () => {
  it('treats only sub-768px as a phone, so tablets keep the work week', () => {
    // 768px is where Sidebar.tsx starts its tablet band — the phone boundary
    // has to agree with it or the two components disagree about the same device.
    expect(PHONE_MEDIA_QUERY).toBe('(max-width: 767.98px)');
  });
});
