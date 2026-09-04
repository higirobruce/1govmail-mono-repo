'use client';

// The one attachment previewer. Both surfaces that show attachment content —
// the full-screen AttachmentLightbox and ThreadView's expand-in-place panel —
// render this component, so type coverage (image / pdf / csv / text / video /
// audio / typed-embed fallback) can no longer drift between them. The only
// preview branch that intentionally lives elsewhere is the lightbox's
// zoomable image (zoom state belongs to the lightbox chrome).

import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPreviewKind, parseCsv } from '@/lib/attachmentPreviewKind';

interface Props {
  url: string;
  mimeType: string;
  filename: string;
  /** 'inline' = compact panel in the thread (theme tokens, capped heights);
   *  'lightbox' = full-surface rendering on the dark overlay. */
  variant?: 'inline' | 'lightbox';
}

/** Fetch a blob: URL as text — avoids embedded-frame restrictions that
 *  privacy-first browsers impose on blob: URLs inside iframes. */
function useBlobText(url: string, enabled: boolean): { text: string | null; failed: boolean } {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setText(null);
    setFailed(false);
    fetch(url)
      .then((r) => r.text())
      .then((t) => { if (!cancelled) setText(t); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [url, enabled]);
  return { text, failed };
}

function Spinner({ light }: { light: boolean }) {
  return (
    <Loader2 className={cn('w-4 h-4 animate-spin mx-auto', light ? 'text-white/40' : 'text-muted-foreground/40')} />
  );
}

export function AttachmentPreview({ url, mimeType, filename, variant = 'inline' }: Props) {
  const kind = getPreviewKind(mimeType, filename);
  const lightbox = variant === 'lightbox';
  const needsText = kind === 'text' || kind === 'csv';
  const { text, failed } = useBlobText(url, needsText);

  if (kind === 'image') {
    return (
      <img
        src={url}
        alt={filename}
        className={cn('h-auto rounded-lg block mx-auto', lightbox ? 'max-w-full max-h-full' : 'max-w-full')}
        style={lightbox ? undefined : { maxHeight: 480 }}
        draggable={false}
      />
    );
  }

  if (kind === 'video') {
    return <video controls src={url} className={cn('w-full rounded-lg')} style={{ maxHeight: lightbox ? undefined : 400 }} />;
  }

  if (kind === 'audio') {
    return <audio controls src={url} className="w-full mt-2" />;
  }

  if (kind === 'csv') {
    if (failed) return <FailureNote light={lightbox} />;
    if (text === null) return <Spinner light={lightbox} />;
    const rows = parseCsv(text);
    if (rows.length === 0) return <FailureNote light={lightbox} label="Empty file" />;
    const [header, ...body] = rows;
    return (
      <div className={cn('overflow-auto rounded-lg border text-[12px]', lightbox ? 'max-h-full border-white/15' : 'max-h-80 border-border/30')}>
        <table className="w-full border-collapse">
          <thead>
            <tr className={lightbox ? 'bg-white/10' : 'bg-muted/50'}>
              {header.map((cell, i) => (
                <th key={i} className={cn('px-3 py-1.5 text-left font-semibold whitespace-nowrap border-b', lightbox ? 'text-white/80 border-white/15' : 'text-foreground/70 border-border/30')}>
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.slice(0, 200).map((row, ri) => (
              <tr key={ri} className={lightbox ? 'even:bg-white/5' : 'even:bg-muted/20 hover:bg-muted/40 transition-colors'}>
                {row.map((cell, ci) => (
                  <td key={ci} className={cn('px-3 py-1.5 whitespace-nowrap border-b', lightbox ? 'text-white/75 border-white/10' : 'text-foreground/80 border-border/10')}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (kind === 'text') {
    if (failed) return <FailureNote light={lightbox} />;
    if (text === null) return <Spinner light={lightbox} />;
    return (
      <pre className={cn(
        'text-[12px] whitespace-pre-wrap font-mono overflow-auto rounded-lg p-3 leading-relaxed',
        lightbox ? 'text-white/80 max-h-full' : 'text-foreground/80 max-h-80 bg-muted/20',
      )}>
        {text}
      </pre>
    );
  }

  if (kind === 'pdf') {
    // MUST be an <iframe>, not <embed>/<object>: the app CSP sets
    // `object-src 'none'` (plugin content), which blanks embeds silently,
    // while `frame-src 'self' blob:` allows frames. No sandbox attribute —
    // Chrome's PDF viewer refuses to render in a fully sandboxed frame; the
    // blob carries the server's application/pdf content type, so the frame
    // hosts Chrome's own viewer, not sender-controlled markup.
    return (
      <iframe
        src={url}
        title={filename}
        className={cn('w-full border-0', lightbox ? 'h-full' : 'rounded-lg')}
        style={lightbox ? undefined : { height: 500 }}
      />
    );
  }

  // No inline preview for this type (only reachable by paging the lightbox
  // onto a non-previewable file) — a note beats a silently blank embed.
  return <FailureNote light={lightbox} label="No inline preview for this file type — use download" />;
}

function FailureNote({ light, label = 'Failed to load file' }: { light: boolean; label?: string }) {
  return (
    <p className={cn('text-[12px] text-center py-4', light ? 'text-white/50' : 'text-muted-foreground/60')}>
      {label}
    </p>
  );
}
