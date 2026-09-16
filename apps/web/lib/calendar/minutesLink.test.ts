import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sourceHref } from '@/lib/ai/sourceNav';

/**
 * The two ends of the minutes deep link live in client pages that cannot mount
 * in jsdom (the calendar page is 2,400+ lines), so the contract between them is
 * pinned on their source instead: the drawer must route through the one shared
 * helper, and the docs page must read the parameter that helper writes.
 *
 * This exists because both minutes navigations shipped as `/docs?doc=<id>`,
 * which no page handles — the user landed on an empty Docs list.
 */
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const CALENDAR_PAGE = read('app/(app)/calendar/page.tsx');
const DOCS_PAGE = read('app/(app)/docs/page.tsx');

describe('the minutes deep link into /docs', () => {
  it('routes both drawer navigations through sourceHref, never a hand-written /docs URL', () => {
    expect(CALENDAR_PAGE).toContain("sourceHref({ type: 'doc', id: minutesId })");
    expect(CALENDAR_PAGE).toContain("sourceHref({ type: 'doc', id: documentId })");
    expect(CALENDAR_PAGE).not.toMatch(/\/docs\?/);
  });

  it('writes the query parameter the docs page actually reads', () => {
    const url = new URL(sourceHref({ type: 'doc', id: 'doc-1' }), 'http://local');
    const param = [...url.searchParams.keys()];

    expect(param).toEqual(['open']);
    expect(url.searchParams.get('open')).toBe('doc-1');
    expect(DOCS_PAGE).toContain(`.get('${param[0]}')`);
  });
});
