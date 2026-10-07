/**
 * Which calendar view a visit opens on.
 *
 * The choice is made per visit from the viewport alone — it is deliberately NOT
 * remembered. Picking a different view from the switcher lasts for that visit
 * and the next one starts from the default again.
 */

export type CalView = 'day' | 'workweek' | 'week' | 'month' | 'year' | 'agenda';

/**
 * Phone boundary. Must agree with the tablet band in `Sidebar.tsx` (which
 * starts at 768px) — a tablet is not a phone here and keeps the work week.
 */
export const PHONE_MEDIA_QUERY = '(max-width: 767.98px)';

/** The view a fresh visit opens on: today on a phone, the work week elsewhere. */
export function defaultCalView(isPhone: boolean): CalView {
  return isPhone ? 'day' : 'workweek';
}
