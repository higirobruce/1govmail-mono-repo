import { NextRequest, NextResponse } from 'next/server';
// This import is intentionally server-side only — html-to-docx uses Node.js
// built-ins (util, Buffer) and cannot be bundled for the browser.
type HtmlToDocxFn = (html: string, headerHtml: null, options: Record<string, unknown>) => Promise<Buffer>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _mod = require('html-to-docx');
const HtmlToDocx: HtmlToDocxFn = _mod.default ?? _mod;

// Generous because images are inlined as base64 data URIs (the 10 MB upload
// cap is ~13.4 MB once encoded).
const MAX_BODY_BYTES = 25 * 1024 * 1024;

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

  const buffer = await HtmlToDocx(html, null, {
    title,
    creator: '1Gov Mail',
    font: 'Calibri',
    fontSize: 24,
    margins: { top: 1080, bottom: 1080, left: 1260, right: 1260 },
    table: { row: { cantSplit: true } },
  });

  const safe = title.replace(/[^a-z0-9 _-]/gi, '_');
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${safe}.docx"`,
    },
  });
}