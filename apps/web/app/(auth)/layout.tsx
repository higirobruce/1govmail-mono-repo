/**
 * Route-group layout for all unauthenticated / auth pages (/login, …).
 *
 * `force-dynamic` opts every page in this group out of Next.js / Turbopack
 * static prerendering for the same reason as the (app) group layout:
 * Turbopack's prerender workers run with a null React dispatcher, which
 * causes Radix UI client components in the root layout to crash.
 */
export const dynamic = 'force-dynamic';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
