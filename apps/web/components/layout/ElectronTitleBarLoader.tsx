'use client';

/**
 * Client Component wrapper that lazy-loads ElectronTitleBar with ssr:false.
 *
 * Why the extra indirection?
 *   next/dynamic({ ssr: false }) must live inside a Client Component — it is not
 *   allowed directly in a Server Component layout.  This file is the Client
 *   boundary; layout.tsx (Server Component) imports this, and this module
 *   defers the actual component to the browser only.
 *
 * The result: ElectronTitleBar (which reads window.electronAPI) never executes
 * during Next.js prerendering, so the /_global-error static page — which Next.js
 * renders without the normal provider tree — no longer triggers the
 * "Cannot read useContext on null" crash.
 */

import dynamic from 'next/dynamic';

const TitleBar = dynamic(
  () =>
    import('./ElectronTitleBar').then((m) => ({ default: m.ElectronTitleBar })),
  { ssr: false },
);

export function ElectronTitleBarLoader() {
  return <TitleBar />;
}
