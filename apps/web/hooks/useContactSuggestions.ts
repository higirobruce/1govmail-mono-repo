'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';

export interface ContactAddressSuggestion {
  kind?: undefined;
  email: string;
  display: string;
}

export interface ContactGroupSuggestion {
  kind: 'group';
  groupId: string;
  display: string;
  memberCount: number;
  members: Array<{ email: string; name?: string }>;
}

export type ContactSuggestion = ContactAddressSuggestion | ContactGroupSuggestion;

export const isGroupSuggestion = (s: ContactSuggestion): s is ContactGroupSuggestion =>
  s.kind === 'group';

/** Suggestions only start once the query is worth a round-trip. */
const MIN_CHARS = 2;
/** Matches the compose recipient field's feel. */
const DEBOUNCE_MS = 280;

/**
 * Debounced contact/GAL lookup shared by the recipient chip input (compose) and
 * the single-address inputs in advanced search, so both fields behave the same
 * and the fetch policy lives in one place.
 *
 * `exclude` is applied to the fetched list rather than to the request, so
 * removing a chip re-reveals its suggestion without another round-trip.
 *
 * `includeGroups` is opt-in and defaults to false: only the compose recipient
 * field wants contact groups offered — a single-address field (e.g. Advanced
 * Search From/To) must never be offered one, and omitting the option keeps
 * the client call at one argument so existing single-argument assertions
 * elsewhere keep passing.
 */
export function useContactSuggestions(
  query: string,
  options: { exclude?: string[]; includeGroups?: boolean } = {},
) {
  const { exclude, includeGroups } = options;
  const [fetched, setFetched] = useState<ContactSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slow earlier response landing after a newer one and
  // overwriting it with stale suggestions.
  const requestSeq = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < MIN_CHARS) {
      setFetched([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++requestSeq.current;
    debounceRef.current = setTimeout(async () => {
      try {
        // Two explicit call shapes rather than a spread over a conditional
        // tuple: TS cannot spread a union of differently-shaped tuple types
        // (TS2556), and this form still keeps the one-argument call intact
        // when groups are not requested.
        const results = includeGroups
          ? await api.contacts.autocomplete(query.trim(), { includeGroups: true })
          : await api.contacts.autocomplete(query.trim());
        if (seq === requestSeq.current) setFetched(results);
      } catch {
        if (seq === requestSeq.current) setFetched([]);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, includeGroups]);

  const suggestions = useMemo(() => {
    if (!exclude || exclude.length === 0) return fetched;
    const skip = new Set(exclude.map((e) => e.trim().toLowerCase()));
    return fetched.filter(
      (s) => isGroupSuggestion(s) || !skip.has(s.email.trim().toLowerCase()),
    );
  }, [fetched, exclude]);

  /** Drop any pending request and hide what is currently loaded. */
  const clear = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    requestSeq.current++;
    setFetched([]);
    setLoading(false);
  };

  return { suggestions, loading, clear };
}
