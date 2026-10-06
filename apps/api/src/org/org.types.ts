export type DigestWindow = 'day' | 'week' | 'month';

export const WINDOW_DAYS: Record<DigestWindow, number> = { day: 1, week: 7, month: 30 };

export const DIGEST_WINDOWS: DigestWindow[] = ['day', 'week', 'month'];

/** A meeting is collective at this many invitees. `organizer` is a separate
 *  column, so 2 invitees means three people including the organiser. */
export const MEETING_MIN_ATTENDEES = 2;

/** Below this many items the narrative is suppressed: a model handed three
 *  items pads, and handed zero it invents. */
export const NARRATIVE_MIN_ITEMS = 5;

export interface OrgItem {
  kind: 'meeting' | 'document' | 'minutes';
  /** The artefact's own id, for linking. */
  id: string;
  title: string;
  /** ISO. Start for meetings, last update for documents and minutes. */
  at: string;
  participantCount: number;
  /** Absent when the item cannot be resolved for anyone but its owner — a row
   *  with no href renders as plain text, never as a link that silently 404s
   *  or 403s for the reader. */
  href?: string;
}

export interface OrgDigest {
  window: DigestWindow;
  institutionId: string | null;
  narrative: string | null;
  ahead: OrgItem[];
  concluded: OrgItem[];
}
