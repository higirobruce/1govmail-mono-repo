/**
 * Route-group layout for all authenticated app pages
 * (/mail, /calendar, /contacts, /settings, …).
 *
 * `force-dynamic` opts every page in this group out of Next.js / Turbopack
 * static prerendering.  Without it, Turbopack's prerender worker renders
 * these pages in an isolated environment where React's internal dispatcher
 * is null, causing "Cannot read properties of null (reading 'useRef')"
 * crashes from Radix UI components (e.g. TooltipProvider) that are mounted
 * in the root layout.
 *
 * All pages here are auth-gated anyway, so static prerendering provides
 * no real benefit — they always need server-side session data at request time.
 */
export const dynamic = 'force-dynamic';

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
