import { describe, expect, it } from 'vitest';
import { institutionsToOptions, type InstitutionOption } from './institutions';

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
