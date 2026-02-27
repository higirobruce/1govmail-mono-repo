import { ImageResponse } from 'next/og';

// Next.js App Router uses this file as the <link rel="icon"> for the app.
// The old favicon.ico in this directory still serves at /favicon.ico for
// browsers that request it directly, but modern browsers prefer the
// <link rel="icon"> tag that Next.js injects from this file.
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#1c1c1c',
          borderRadius: '7px',
          width: 32,
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Mail envelope */}
        <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
          <rect x="1" y="1" width="16" height="12" rx="2" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M1 3.5L9 8.5L17 3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
