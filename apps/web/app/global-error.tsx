'use client';

// Explicit React import is required even though the new JSX transform doesn't
// need it for JSX syntax.  Without it, Turbopack omits React (module 88972)
// from the _global-error page's root-of-server chunk.  Next.js's shared
// OuterLayoutRouter chunk calls `a.i(88972)` to obtain React, and if that
// module hasn't been registered it returns null — causing the build-time
// prerender to throw "Cannot read properties of null (reading 'useContext')".
// The explicit import forces Turbopack to include React in the dependency
// graph for this page, registering module 88972 before the shared chunk runs.
import React from 'react';

export const dynamic = 'force-dynamic';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          background: '#0a0a0a',
          color: '#e5e5e5',
          gap: '16px',
          padding: '24px',
          textAlign: 'center',
        }}
      >
        <p
          style={{
            fontSize: '11px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: '#666',
            margin: 0,
          }}
        >
          Error
        </p>
        <h1 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>
          Something went wrong
        </h1>
        <p style={{ fontSize: '14px', color: '#888', margin: 0 }}>
          An unexpected error occurred. Please try again.
        </p>
        <button
          onClick={reset}
          style={{
            marginTop: '8px',
            padding: '8px 20px',
            borderRadius: '8px',
            border: '1px solid #333',
            background: 'transparent',
            color: '#e5e5e5',
            fontSize: '13px',
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
