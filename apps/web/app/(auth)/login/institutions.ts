export type InstitutionOption = { id: string; label: string };

/**
 * Defensive: the API already filters/orders institutions, but this drops
 * malformed rows so the login form never renders blank/broken options.
 */
export function institutionsToOptions(rows: InstitutionOption[]): InstitutionOption[] {
  return rows.filter((r) => r && typeof r.id === 'string' && r.id && typeof r.label === 'string' && r.label);
}

export type CanSubmitState = {
  loading: boolean;
  institutionsLoading: boolean;
  institutionsError: string | null;
  institution: string;
};

/**
 * Single source of truth for whether the credentials form may be submitted.
 * Used both to disable the submit button and as an early-return guard inside
 * handleSubmit, so an Enter-key submit that bypasses the disabled button
 * can't send `institution: ''` — e.g. autofilled credentials submitted
 * before institutions finish loading, or submitted forever after a failed
 * institutions fetch.
 */
export function canSubmit(state: CanSubmitState): boolean {
  return (
    !state.loading &&
    !state.institutionsLoading &&
    !state.institutionsError &&
    state.institution.length > 0
  );
}

