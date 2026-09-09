import { describe, expect, it } from 'vitest';
import { canSubmit, institutionsToOptions, type InstitutionOption } from './institutions';

describe('institutionsToOptions', () => {
  it('preserves valid rows in order', () => {
    const rows: InstitutionOption[] = [
      { id: 'risa', label: 'RISA' },
      { id: 'minict', label: 'MINICT' },
    ];
    expect(institutionsToOptions(rows)).toEqual([
      { id: 'risa', label: 'RISA' },
      { id: 'minict', label: 'MINICT' },
    ]);
  });

  it('drops malformed rows (missing/empty/non-string id or label)', () => {
    const rows = [
      { id: 'risa', label: 'RISA' },
      { id: '', label: 'Empty id' },
      { id: 'no-label', label: '' },
      { id: 123, label: 'Numeric id' },
      { id: 'no-label-field' },
      { label: 'no-id-field' },
      null,
      undefined,
      { id: 'minict', label: 'MINICT' },
    ] as unknown as InstitutionOption[];

    expect(institutionsToOptions(rows)).toEqual([
      { id: 'risa', label: 'RISA' },
      { id: 'minict', label: 'MINICT' },
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(institutionsToOptions([])).toEqual([]);
  });
});

describe('canSubmit', () => {
  const base = {
    loading: false,
    institutionsLoading: false,
    institutionsError: null as string | null,
    institution: 'risa',
  };

  it('allows submit once institutions are loaded, an institution is picked, and nothing else is in flight', () => {
    expect(canSubmit(base)).toBe(true);
  });

  it('blocks submit while institutions are still loading, even if institution is somehow set', () => {
    expect(canSubmit({ ...base, institutionsLoading: true })).toBe(false);
  });

  it('blocks submit with an empty institution (mount race before the fetch resolves)', () => {
    expect(canSubmit({ ...base, institution: '' })).toBe(false);
  });

  it('blocks submit forever after a failed institutions fetch', () => {
    expect(canSubmit({ ...base, institutionsError: 'Could not load institutions' })).toBe(false);
  });

  it('blocks submit while a login/2FA request is already in flight', () => {
    expect(canSubmit({ ...base, loading: true })).toBe(false);
  });
});
