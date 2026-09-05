// Attachment preview classification + CSV parsing, shared by the lightbox and
// the thread's inline previewer (extracted from ThreadView so the two surfaces
// stop drifting apart in type coverage).

export type PreviewKind = 'image' | 'pdf' | 'csv' | 'text' | 'video' | 'audio';

/** What inline preview a file supports, or null when only download makes sense. */
export function getPreviewKind(mimeType: string, filename: string): PreviewKind | null {
  const mt = mimeType.toLowerCase();
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (mt.startsWith('image/')) return 'image';
  if (mt === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mt === 'text/csv' || ext === 'csv') return 'csv';
  if (mt.startsWith('text/')) return 'text';
  if (mt.startsWith('video/') || ['mp4', 'webm', 'ogg', 'mov'].includes(ext)) return 'video';
  if (mt.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'aac', 'm4a'].includes(ext)) return 'audio';
  return null;
}

/** Naive CSV split (no embedded-comma handling — preview-grade, not an importer). */
export function parseCsv(text: string): string[][] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split('\n').map((line) =>
    line.split(',').map((cell) => cell.replace(/^"|"$/g, '').trim()),
  );
}
