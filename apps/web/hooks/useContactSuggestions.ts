'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';

export interface ContactSuggestion {
  email: string;
  display: string;
}

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
 */
export function useContactSuggestions(query: string, options: { exclude?: string[] } = {}) {
  const { exclude } = options;
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
        const results = await api.contacts.autocomplete(query.trim());
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
  }, [query]);

  const suggestions = useMemo(
    () => (exclude && exclude.length > 0 ? fetched.filter((s) => !exclude.includes(s.email)) : fetched),
    [fetched, exclude],
  );

  /** Drop any pending request and hide what is currently loaded. */
  const clear = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    requestSeq.current++;
    setFetched([]);
    setLoading(false);
  };

  return { suggestions, loading, clear };
}
