import { NextRequest, NextResponse } from 'next/server';
import { homedir } from 'os';
import { existsSync, readdirSync } from 'fs';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import path from 'path';

// Generous because images are inlined as base64 data URIs (the 10 MB upload
// cap is ~13.4 MB once encoded).
const MAX_BODY_BYTES = 25 * 1024 * 1024;

// Every render launches a full Chrome process — cap concurrency so the route
// can't be used to exhaust the host.
const MAX_CONCURRENT_RENDERS = 2;
let activeRenders = 0;

function isBlockedIp(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  const lower = ip.toLowerCase();
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fe80:') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd')
  );
}

// SSRF guard: only data:/https: subresources, and never to loopback,
// link-local or RFC1918 ranges — hostnames are resolved first so DNS names
// pointing at private IPs are blocked too.
async function isRequestAllowed(rawUrl: string): Promise<boolean> {
  const url = new URL(rawUrl);
  if (url.protocol === 'data:' || url.protocol === 'about:') return true;
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return !isBlockedIp(host);
  const addresses = await lookup(host, { all: true });
  return addresses.length > 0 && addresses.every((a) => !isBlockedIp(a.address));
}

function findChromeBinary(): string {
  // Docker/CI override — set in the production image so we don't depend on a
  // hardcoded path that can shift between Alpine chromium package versions.
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const candidates = [
    // Homebrew Chromium (macOS, properly signed)
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Chrome / Edge (macOS)
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    // Puppeteer's cached Chrome for Testing (macOS arm)
    path.join(
      homedir(),
      '.cache/puppeteer/chrome/mac_arm-146.0.7680.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      'No Chromium browser found. Install with: brew install --cask chromium',
    );
  }
  return found;
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  let html: string;
  let title: string;
  try {
    ({ html, title } = JSON.parse(raw) as { html: string; title: string });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof html !== 'string' || typeof title !== 'string') {
    return NextResponse.json({ error: 'html and title are required' }, { status: 400 });
  }

  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    return NextResponse.json({ error: 'Too many concurrent exports' }, { status: 429 });
  }
  activeRenders++;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({
      executablePath: findChromeBinary(),
      headless: true,
    });

    try {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request', (request: { url(): string; continue(): Promise<void>; abort(): Promise<void> }) => {
        void isRequestAllowed(request.url())
          .then((allowed) => (allowed ? request.continue() : request.abort()))
          .catch(() => request.abort().catch(() => {}));
      });
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 5000 });

      const pdfBuffer: Buffer = await page.pdf({
        format: 'A4',
        margin: { top: '15mm', right: '20mm', bottom: '15mm', left: '20mm' },
        printBackground: true,
        timeout: 10000,
      });

      const safe = title.replace(/[^a-z0-9 _-]/gi, '_');
      return new NextResponse(pdfBuffer as unknown as BodyInit, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${safe}.pdf"`,
        },
      });
    } finally {
      await browser.close();
    }
  } finally {
    activeRenders--;
  }
}