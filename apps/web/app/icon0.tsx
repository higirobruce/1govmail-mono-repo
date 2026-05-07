import { ImageResponse } from 'next/og';

export const size = { width: 192, height: 192 };
export const contentType = 'image/png';

export default function Icon192() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#0F4C81',
          borderRadius: '40px',
          width: 192,
          height: 192,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width="108" height="84" viewBox="0 0 18 14" fill="none">
          <rect x="1" y="1" width="16" height="12" rx="2" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M1 3.5L9 8.5L17 3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
