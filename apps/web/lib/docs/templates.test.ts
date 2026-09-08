import { describe, it, expect } from 'vitest';
import { TEMPLATES, CATEGORIES } from './templates';

describe('doc templates', () => {
  it('exposes all 18 templates with the fields the AI catalog needs', () => {
    expect(TEMPLATES).toHaveLength(18);
    for (const t of TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(Array.isArray(t.sections)).toBe(true);
      expect(t.content).toMatchObject({ type: 'doc' });
    }
    expect(TEMPLATES.map((t) => t.id)).toContain('memo');
    expect(TEMPLATES.map((t) => t.id)).toContain('minutes');
    expect(TEMPLATES.map((t) => t.id)).toContain('blank');
  });

  it('derives categories', () => {
    expect(CATEGORIES.length).toBeGreaterThan(2);
  });
});
