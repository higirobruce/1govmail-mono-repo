import { CUSTOM_INSTRUCTIONS_MAX_CHARS } from '@/lib/ai/prompt';
import type { AiProfileSuggestions } from '@/lib/api';

/** Max length for jobTitle/institution/department — mirrors the input `maxLength` in the UI. */
export const AI_PROFILE_FIELD_MAX_CHARS = 80;

export interface AiProfileDraft {
  jobTitle: string;
  institution: string;
  department: string;
  /** '' (Auto) | 'en' | 'fr' | 'rw' */
  language: string;
  instructions: string;
}

export interface UpdateAiProfilePayload {
  jobTitle: string;
  institution: string;
  department: string;
  language: string;
  instructions: string;
}

function clean(value: string, maxChars: number): string {
  return value.trim().slice(0, maxChars);
}

/**
 * Trims and length-caps every field. Empty strings are preserved (never
 * omitted) so the PATCH payload can explicitly clear a previously-set field.
 */
export function normalizeProfileDraft(draft: AiProfileDraft): UpdateAiProfilePayload {
  return {
    jobTitle: clean(draft.jobTitle, AI_PROFILE_FIELD_MAX_CHARS),
    institution: clean(draft.institution, AI_PROFILE_FIELD_MAX_CHARS),
    department: clean(draft.department, AI_PROFILE_FIELD_MAX_CHARS),
    language: clean(draft.language, AI_PROFILE_FIELD_MAX_CHARS),
    instructions: clean(draft.instructions, CUSTOM_INSTRUCTIONS_MAX_CHARS),
  };
}

function fillIfBlank(current: string, suggested: string | null): string {
  if (current.trim()) return current;
  return suggested && suggested.trim() ? suggested : current;
}

/**
 * Applies directory suggestions to the draft, filling only fields that are
 * currently empty (or whitespace-only). A field the user has already typed
 * something into is never overwritten, even if the suggestion differs.
 * Suggestions carry no `language`/`instructions` — those pass through untouched.
 */
export function mergeSuggestions(current: AiProfileDraft, suggestions: AiProfileSuggestions): AiProfileDraft {
  return {
    ...current,
    jobTitle: fillIfBlank(current.jobTitle, suggestions.jobTitle),
    institution: fillIfBlank(current.institution, suggestions.institution),
    department: fillIfBlank(current.department, suggestions.department),
  };
}
