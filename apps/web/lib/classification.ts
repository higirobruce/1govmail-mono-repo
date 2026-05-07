/**
 * Government classification taxonomy — shared between Docs and Mail.
 *
 * Today these are stored as display strings on `Document.tags: string[]`.
 * Phase 2 will introduce a proper Prisma enum on Message.classification;
 * the display strings here stay stable so existing docs tags keep matching.
 */

export type ClassificationLabel =
  | 'Unclassified'
  | 'Internal Use Only'
  | 'Restricted'
  | 'Confidential';

export interface ClassificationDef {
  label: ClassificationLabel;
  /** Severity 0 = lowest, 3 = highest. Used to pick the highest of a thread. */
  severity: 0 | 1 | 2 | 3;
  /** Tailwind classes for the badge (light + dark). */
  cls: string;
  /** Tailwind classes for a thin status dot, used in dense rows. */
  dot: string;
}

export const CLASSIFICATIONS: readonly ClassificationDef[] = [
  {
    label: 'Unclassified',
    severity: 0,
    cls: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800',
    dot: 'bg-green-500',
  },
  {
    label: 'Internal Use Only',
    severity: 1,
    cls: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800',
    dot: 'bg-blue-500',
  },
  {
    label: 'Restricted',
    severity: 2,
    cls: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800',
    dot: 'bg-amber-500',
  },
  {
    label: 'Confidential',
    severity: 3,
    cls: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800',
    dot: 'bg-red-500',
  },
] as const;

const BY_LABEL = new Map(CLASSIFICATIONS.map((c) => [c.label, c]));

export function getClassification(label: string | null | undefined): ClassificationDef | null {
  if (!label) return null;
  return BY_LABEL.get(label as ClassificationLabel) ?? null;
}

/**
 * Pick the highest-severity classification from an array of tags. Used to
 * render a single chip on rows that may carry multiple non-classification tags.
 */
export function pickHighestClassification(tags: readonly string[] | null | undefined): ClassificationDef | null {
  if (!tags || tags.length === 0) return null;
  let best: ClassificationDef | null = null;
  for (const t of tags) {
    const c = BY_LABEL.get(t as ClassificationLabel);
    if (c && (!best || c.severity > best.severity)) best = c;
  }
  return best;
}
