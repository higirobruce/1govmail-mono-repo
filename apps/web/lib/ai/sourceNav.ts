/**
 * Pure chip-navigation mapping for Ask 1Gov's typed sources — where a
 * citation/source-rail click should take the user when it's not handled
 * in-page (i.e. everywhere except the mail page's own message-open flow).
 */
import type { AskSourceType } from './ask';

export function sourceHref(s: { type: AskSourceType; id: string }): string {
  const id = encodeURIComponent(s.id);
  switch (s.type) {
    case 'mail': return `/mail?open=${id}`;
    case 'doc': return `/docs?open=${id}`;
    case 'event': return `/calendar?event=${id}`;
  }
}
