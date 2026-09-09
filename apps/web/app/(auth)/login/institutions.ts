export type InstitutionOption = { id: string; label: string };

/**
 * Defensive: the API already filters/orders institutions, but this drops
 * malformed rows so the login form never renders blank/broken options.
 */
export function institutionsToOptions(rows: InstitutionOption[]): InstitutionOption[] {
  return rows.filter((r) => r && typeof r.id === 'string' && r.id && typeof r.label === 'string' && r.label);
}
