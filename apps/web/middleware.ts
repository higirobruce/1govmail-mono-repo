import { NextRequest, NextResponse } from 'next/server';

// Auth gate for the server-side Route Handlers (/export/docs/*, /upload/*),
// which are otherwise reachable by anyone who can reach the web app. Tokens
// are the HS256 JWTs issued by apps/api: verified locally when JWT_SECRET is
// set (must match the API's), otherwise validated against the API itself.
export const config = { matcher: ['/export/:path*', '/upload/:path*'] };

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function verifyHs256Jwt(token: string, secret: string): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerB64))) as {
      alg?: string;
    };
    // Pin the algorithm — never trust the token's own header to pick it.
    if (header.alg !== 'HS256') return false;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(signatureB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return false;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64))) as {
      exp?: number;
    };
    return typeof payload.exp !== 'number' || payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

async function verifyAgainstApi(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const secret = process.env.JWT_SECRET;
  const valid = secret ? await verifyHs256Jwt(token, secret) : await verifyAgainstApi(token);
  if (!valid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.next();
}
