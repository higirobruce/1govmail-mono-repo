/**
 * Custom 404 page.
 *
 * `force-dynamic` opts this page out of Next.js / Turbopack static prerendering.
 * Without it, Turbopack's prerender worker renders the root layout (which contains
 * Radix UI client components) in an environment where React's internal dispatcher
 * is null, causing "Cannot read properties of null (reading 'useRef')" crashes.
 * Rendering dynamically at request time uses a proper Node.js server context
 * where React is fully initialised.
 */
export const dynamic = 'force-dynamic';

import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          404
        </p>
        <h1 className="text-xl font-semibold text-foreground">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
      </div>
      <Link
        href="/mail"
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        Go to inbox
      </Link>
    </div>
  );
}
