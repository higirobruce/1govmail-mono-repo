'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { getAttachmentUrl } from '@/lib/attachmentBlobCache';
import { AttachmentPreview } from './AttachmentPreview';
import { toast } from 'sonner';
import {
  X, Download, ChevronLeft, ChevronRight,
  ZoomIn, ZoomOut, Maximize2, Minimize2,
  Loader2, File, FileText, Image as ImageIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface Props {
  open: boolean;
  attachments: Attachment[];
  selectedId: string;
  messageId: string;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Above this size, skip the inline preview and offer download instead —
 *  a preview fully buffers the file into memory before showing anything. */
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

export function AttachmentLightbox({ open, attachments, selectedId, messageId, onClose }: Props) {
  const [currentId, setCurrentId] = useState(selectedId);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState(true); // true = fit, false = actual size

  const current = attachments.find((a) => a.id === currentId) ?? attachments[0];
  const currentIndex = attachments.findIndex((a) => a.id === currentId);

  const isImage = current?.mimeType.startsWith('image/') ?? false;
  const isPdf = current?.mimeType === 'application/pdf' || current?.filename.toLowerCase().endsWith('.pdf');
  const tooLarge = (current?.size ?? 0) > MAX_PREVIEW_BYTES;

  // Load blob URL when selection changes — served from the shared blob cache,
  // so paging next/back never re-downloads a file this session already fetched,
  // and preview-then-download transfers the file once. The cache owns the URLs
  // (LRU-revoked; per-message revocation happens when the reader moves on).
  useEffect(() => {
    if (!open || !current || tooLarge) return;
    let cancelled = false;

    setLoading(true);
    setBlobUrl(null);

    getAttachmentUrl(messageId, current.id, () => api.mail.downloadAttachment(messageId, current.id))
      .then((url) => {
        if (cancelled) return;
        setBlobUrl(url);
        setZoom(1);
        setFitMode(true);
      })
      .catch((err) => { if (!cancelled) toast.error('Failed to load attachment', { description: err?.message }); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [open, current?.id, messageId, tooLarge]); // eslint-disable-line react-hooks/exhaustive-deps

  const goNext = useCallback(() => {
    if (currentIndex < attachments.length - 1) setCurrentId(attachments[currentIndex + 1].id);
  }, [currentIndex, attachments]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) setCurrentId(attachments[currentIndex - 1].id);
  }, [currentIndex, attachments]);

  const handleDownload = async () => {
    if (!current) return;
    try {
      const url = blobUrl
        ?? await getAttachmentUrl(messageId, current.id, () => api.mail.downloadAttachment(messageId, current.id));
      const a = document.createElement('a');
      a.href = url;
      a.download = current.filename;
      a.click();
    } catch (err: any) {
      toast.error('Download failed', { description: err?.message });
    }
  };

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowRight') goNext();
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(z + 0.25, 4));
      if (e.key === '-') setZoom((z) => Math.max(z - 0.25, 0.25));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, goNext, goPrev, onClose]);

  if (!open || !current) return null;

  const FileIcon = isImage ? ImageIcon : isPdf ? FileText : File;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/60 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <FileIcon className="w-4 h-4 text-white/60 shrink-0" />
          <span className="text-[13px] font-medium text-white/80 truncate">{current.filename}</span>
          <span className="text-[11px] text-white/40 shrink-0">{formatBytes(current.size)}</span>
          {attachments.length > 1 && (
            <span className="text-[11px] text-white/30 shrink-0">{currentIndex + 1} / {attachments.length}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isImage && (
            <>
              <button
                onClick={() => setZoom((z) => Math.max(z - 0.25, 0.25))}
                className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                title="Zoom out (−)"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-[11px] text-white/40 w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
              <button
                onClick={() => setZoom((z) => Math.min(z + 0.25, 4))}
                className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                title="Zoom in (+)"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                onClick={() => { setFitMode((f) => !f); setZoom(1); }}
                className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                title={fitMode ? 'Actual size' : 'Fit to screen'}
              >
                {fitMode ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
              </button>
            </>
          )}
          <button
            onClick={handleDownload}
            className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
            title="Download"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden">
        {/* Prev / Next arrows */}
        {currentIndex > 0 && (
          <button
            onClick={goPrev}
            className="absolute left-3 z-10 p-2 rounded-full bg-black/50 text-white/70 hover:text-white hover:bg-black/80 transition-colors"
            title="Previous (←)"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        )}
        {currentIndex < attachments.length - 1 && (
          <button
            onClick={goNext}
            className="absolute right-3 z-10 p-2 rounded-full bg-black/50 text-white/70 hover:text-white hover:bg-black/80 transition-colors"
            title="Next (→)"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        )}

        {loading && (
          <Loader2 className="w-8 h-8 text-white/40 animate-spin" />
        )}

        {!loading && blobUrl && isImage && (
          <div
            className={cn('overflow-auto w-full h-full flex items-center justify-center', fitMode ? '' : 'cursor-zoom-out')}
            onWheel={(e) => {
              e.preventDefault();
              const delta = e.deltaY > 0 ? -0.1 : 0.1;
              setZoom((z) => Math.min(Math.max(z + delta, 0.1), 5));
              setFitMode(false);
            }}
          >
            <img
              src={blobUrl}
              alt={current.filename}
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: 'center',
                maxWidth: fitMode ? '100%' : 'none',
                maxHeight: fitMode ? '100%' : 'none',
                transition: 'transform 0.15s ease',
              }}
              className="block"
              draggable={false}
            />
          </div>
        )}

        {/* Everything except the zoomable image goes through the shared
            previewer — same component as the thread's inline panel, so type
            coverage (pdf/csv/text/video/audio/embed) can't drift. */}
        {!loading && blobUrl && !isImage && (
          <div className={cn('w-full h-full overflow-auto', isPdf ? '' : 'p-6')}>
            <AttachmentPreview
              url={blobUrl}
              mimeType={current.mimeType}
              filename={current.filename}
              variant="lightbox"
            />
          </div>
        )}

        {!loading && tooLarge && (
          <div className="flex flex-col items-center gap-3">
            <FileIcon className="w-10 h-10 text-white/30" />
            <p className="text-[13px] text-white/60">
              Too large to preview ({formatBytes(current.size)})
            </p>
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white/10 text-[13px] text-white/80 hover:bg-white/20 hover:text-white transition-colors"
            >
              <Download className="w-4 h-4" />
              Download
            </button>
          </div>
        )}
      </div>

      {/* Bottom minibar — thumbnails */}
      {attachments.length > 1 && (
        <div className="shrink-0 flex items-center justify-center gap-2 px-4 py-3 bg-black/60 border-t border-white/10 overflow-x-auto">
          {attachments.map((att) => {
            const ThumbIcon = att.mimeType.startsWith('image/') ? ImageIcon : att.mimeType === 'application/pdf' ? FileText : File;
            return (
              <button
                key={att.id}
                onClick={() => setCurrentId(att.id)}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] border transition-all shrink-0',
                  att.id === currentId
                    ? 'bg-white/15 border-white/30 text-white'
                    : 'border-white/10 text-white/40 hover:text-white/70 hover:border-white/20',
                )}
              >
                <ThumbIcon className="w-3 h-3 shrink-0" />
                <span className="max-w-[100px] truncate">{att.filename}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

