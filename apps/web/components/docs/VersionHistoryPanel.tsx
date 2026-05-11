'use client';

import { useEffect, useState } from 'react';
import { History, RotateCcw, X, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Version {
  id: string;
  title: string;
  authorName: string | null;
  createdAt: string;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface Props {
  docId: string;
  onClose: () => void;
  onRestored: () => void;
}

export function VersionHistoryPanel({ docId, onClose, onRestored }: Props) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api.docs.versions.list(docId)
      .then(setVersions)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [docId]);

  const restore = async (v: Version) => {
    if (!confirm(`Restore version from ${formatDate(v.createdAt)}? The current content will be saved as a new version first.`)) return;
    setRestoring(v.id);
    try {
      await api.docs.versions.restore(docId, v.id);
      onRestored();
      onClose();
    } catch {
      alert('Failed to restore version.');
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="w-64 border-l border-border shrink-0 flex flex-col bg-background print:hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5">
          <History className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold">Version History</span>
        </div>
        <button type="button" onClick={onClose} className="p-0.5 rounded hover:bg-muted text-muted-foreground">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {loading && (
          <p className="text-xs text-muted-foreground text-center py-8">Loading…</p>
        )}
        {!loading && versions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
            <History className="w-6 h-6 opacity-30" />
            <p className="text-xs text-center">No versions saved yet.<br />Versions are auto-saved as you edit.</p>
          </div>
        )}
        {versions.map((v, i) => (
          <div key={v.id} className="px-3 py-0.5">
            <button
              type="button"
              onClick={() => setExpanded((prev) => (prev === v.id ? null : v.id))}
              className={cn(
                'w-full flex items-center justify-between gap-2 py-2 rounded-md px-1 text-left hover:bg-muted/40 transition-colors group',
                expanded === v.id && 'bg-muted/40',
              )}
            >
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-medium truncate">{v.title || 'Untitled'}</p>
                <p className="text-[10px] text-muted-foreground">{formatDate(v.createdAt)}</p>
                {v.authorName && (
                  <p className="text-[10px] text-muted-foreground/60">{v.authorName}</p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {i === 0 && (
                  <span className="text-[9px] bg-primary/10 text-primary rounded px-1 py-0.5 font-medium">Latest</span>
                )}
                <ChevronRight className={cn('w-3 h-3 text-muted-foreground transition-transform', expanded === v.id && 'rotate-90')} />
              </div>
            </button>

            {expanded === v.id && (
              <div className="pl-1 pb-1">
                <button
                  type="button"
                  disabled={restoring === v.id}
                  onClick={() => restore(v)}
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors w-full disabled:opacity-40"
                >
                  <RotateCcw className="w-3 h-3" />
                  {restoring === v.id ? 'Restoring…' : 'Restore this version'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
