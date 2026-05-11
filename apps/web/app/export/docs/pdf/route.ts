import { NextRequest, NextResponse } from 'next/server';
import { homedir } from 'os';
import { existsSync, readdirSync } from 'fs';
import path from 'path';

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
  const { html, title } = (await req.json()) as { html: string; title: string };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: findChromeBinary(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer: Buffer = await page.pdf({
      format: 'A4',
      margin: { top: '15mm', right: '20mm', bottom: '15mm', left: '20mm' },
      printBackground: true,
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
}