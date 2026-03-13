import { NextRequest, NextResponse } from 'next/server';
// This import is intentionally server-side only — html-to-docx uses Node.js
// built-ins (util, Buffer) and cannot be bundled for the browser.
type HtmlToDocxFn = (html: string, headerHtml: null, options: Record<string, unknown>) => Promise<Buffer>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _mod = require('html-to-docx');
const HtmlToDocx: HtmlToDocxFn = _mod.default ?? _mod;

export async function POST(req: NextRequest) {
  const { html, title } = (await req.json()) as { html: string; title: string };

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