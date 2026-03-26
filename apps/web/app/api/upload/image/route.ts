import { NextResponse } from 'next/server';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

// Images are returned as base64 data URIs so they are embedded directly in the
// TipTap document JSON and persisted in the database.  This avoids any
// dependency on the filesystem, which is unreliable in standalone/container
// deployments where `public/uploads/` is not persistent across restarts.
export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file') as File | null;

  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  if (!ALLOWED_TYPES.includes(file.type)) return NextResponse.json({ error: 'Invalid file type' }, { status: 400 });
  if (file.size > MAX_SIZE) return NextResponse.json({ error: 'File too large (max 10 MB)' }, { status: 400 });

  const base64 = Buffer.from(await file.arrayBuffer()).toString('base64');
  const url = `data:${file.type};base64,${base64}`;

  return NextResponse.json({ url });
}
