'use client';

import { Download, Eye, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface FileTypeStyle {
  /** Short label rendered inside the icon ("PDF", "DOC", "XLS"…). */
  label: string;
  /** Color class for the icon's accent stripe + label text. */
  color: string;
  /** Light background applied behind the icon container. */
  bgTint: string;
  /** True for office docs / archives — picks the corner-fold style icon. */
  document?: boolean;
}

/** Map a mime type or filename to a coloured file-type style. */
export function fileTypeStyle({ filename, mimeType }: { filename: string; mimeType: string }): FileTypeStyle {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const mt  = mimeType.toLowerCase();

  if (mt === 'application/pdf' || ext === 'pdf') {
    return { label: 'PDF', color: 'text-red-600 dark:text-red-400', bgTint: 'bg-red-50 dark:bg-red-950/30', document: true };
  }
  if (mt.startsWith('image/') || /^(png|jpe?g|gif|webp|bmp|svg|heic)$/.test(ext)) {
    return { label: 'IMG', color: 'text-emerald-600 dark:text-emerald-400', bgTint: 'bg-emerald-50 dark:bg-emerald-950/30' };
  }
  if (mt.includes('word') || ext === 'doc' || ext === 'docx') {
    return { label: 'DOC', color: 'text-blue-600 dark:text-blue-400', bgTint: 'bg-blue-50 dark:bg-blue-950/30', document: true };
  }
  if (mt.includes('sheet') || mt.includes('excel') || ext === 'xls' || ext === 'xlsx' || ext === 'csv') {
    return { label: ext === 'csv' ? 'CSV' : 'XLS', color: 'text-green-700 dark:text-green-400', bgTint: 'bg-green-50 dark:bg-green-950/30', document: true };
  }
  if (mt.includes('presentation') || ext === 'ppt' || ext === 'pptx' || ext === 'key') {
    return { label: 'PPT', color: 'text-orange-600 dark:text-orange-400', bgTint: 'bg-orange-50 dark:bg-orange-950/30', document: true };
  }
  if (/^(zip|rar|7z|tar|gz|bz2)$/.test(ext)) {
    return { label: 'ZIP', color: 'text-amber-600 dark:text-amber-400', bgTint: 'bg-amber-50 dark:bg-amber-950/30', document: true };
  }
  if (mt.startsWith('audio/') || /^(mp3|wav|m4a|flac|ogg)$/.test(ext)) {
    return { label: 'AUD', color: 'text-violet-600 dark:text-violet-400', bgTint: 'bg-violet-50 dark:bg-violet-950/30' };
  }
  if (mt.startsWith('video/') || /^(mp4|mov|avi|mkv|webm)$/.test(ext)) {
    return { label: 'VID', color: 'text-pink-600 dark:text-pink-400', bgTint: 'bg-pink-50 dark:bg-pink-950/30' };
  }
  if (mt.startsWith('text/') || /^(txt|md|rtf|json|xml|yml|yaml)$/.test(ext)) {
    return { label: ext.toUpperCase().slice(0, 3) || 'TXT', color: 'text-slate-600 dark:text-slate-300', bgTint: 'bg-slate-50 dark:bg-slate-800/40', document: true };
  }
  return { label: ext.toUpperCase().slice(0, 3) || 'FILE', color: 'text-slate-600 dark:text-slate-300', bgTint: 'bg-slate-50 dark:bg-slate-800/40', document: true };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Document-style icon (rectangle with corner fold) — accent-coloured by `color`. */
function DocumentIcon({ label, color, size = 56 }: { label: string; color: string; size?: number }) {
  // Icon dimensions: 56x68 default — slightly portrait, matches the mockup's PDF tile.
  const w = size;
  const h = Math.round(size * 1.21);
  return (
    <svg
      viewBox="0 0 56 68"
      width={w}
      height={h}
      className={cn('shrink-0', color)}
      role="img"
      aria-label={`${label} file`}
    >
      {/* paper */}
      <path
        d="M6 4 h32 l12 12 v44 a4 4 0 0 1 -4 4 H6 a4 4 0 0 1 -4 -4 V8 a4 4 0 0 1 4 -4 z"
        fill="currentColor"
        fillOpacity="0.08"
        stroke="currentColor"
        strokeWidth="2"
      />
      {/* corner fold */}
      <path
        d="M38 4 v8 a4 4 0 0 0 4 4 h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* label badge */}
      <rect x="6" y="36" width="38" height="16" rx="3" fill="currentColor" />
      <text
        x="25"
        y="48"
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fill="white"
        letterSpacing="0.4"
      >
        {label}
      </text>
    </svg>
  );
}

/** Square tile with an image-style icon for non-document files. */
function MediaIcon({ label, color, size = 56 }: { label: string; color: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 56 56"
      width={size}
      height={size}
      className={cn('shrink-0', color)}
      role="img"
      aria-label={`${label} file`}
    >
      <rect x="2" y="2" width="52" height="52" rx="8" fill="currentColor" fillOpacity="0.10" stroke="currentColor" strokeWidth="2" />
      <text
        x="28"
        y="34"
        textAnchor="middle"
        fontSize="14"
        fontWeight="700"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fill="currentColor"
        letterSpacing="0.5"
      >
        {label}
      </text>
    </svg>
  );
}

interface AttachmentTileProps {
  attachment: AttachmentMeta;
  onClick?: () => void;
  /** Show preview/download buttons that only appear on hover. */
  onPreview?: () => void;
  onDownload?: () => void;
  downloading?: boolean;
}

/** Card-style attachment tile (mockup-faithful): big colored icon, filename below. */
export function AttachmentTile({
  attachment,
  onClick,
  onPreview,
  onDownload,
  downloading,
}: AttachmentTileProps) {
  const style = fileTypeStyle(attachment);
  const Icon = style.document ? DocumentIcon : MediaIcon;

  return (
    <div
      className={cn(
        'group relative w-[112px] flex flex-col items-center text-center select-none',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'w-[100px] h-[112px] rounded-2xl flex items-center justify-center transition-all',
          style.bgTint,
          'hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)]',
        )}
        title={`${attachment.filename} — ${formatBytes(attachment.size)}`}
      >
        <Icon label={style.label} color={style.color} />
      </button>

      {/* Hover actions */}
      {(onPreview || onDownload) && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          {onPreview && (
            <button
              type="button"
              onClick={onPreview}
              className="p-1 rounded-md bg-card/95 backdrop-blur border border-border/50 text-muted-foreground hover:text-foreground transition-colors"
              title="Preview"
            >
              <Eye className="w-3.5 h-3.5" />
            </button>
          )}
          {onDownload && (
            <button
              type="button"
              onClick={onDownload}
              disabled={downloading}
              className="p-1 rounded-md bg-card/95 backdrop-blur border border-border/50 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              title="Download"
            >
              {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      )}

      {/* Filename pill */}
      <div className="mt-1.5 inline-flex items-center gap-1 max-w-[112px] px-2 py-1 rounded-md bg-muted/60 text-[10.5px] text-foreground/80">
        <span className={cn('text-[9px] font-bold tracking-wide shrink-0', style.color)}>
          {style.label}
        </span>
        <span className="truncate">{attachment.filename}</span>
      </div>
    </div>
  );
}
