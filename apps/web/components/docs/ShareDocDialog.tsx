'use client';

import { useState } from 'react';
import { Copy, Link, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ShareDocDialogProps {
  docId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isShared: boolean;
  shareToken: string | null;
  onShareChange: (state: { isShared: boolean; shareToken: string | null }) => void;
}

export function ShareDocDialog({
  docId,
  open,
  onOpenChange,
  isShared,
  shareToken,
  onShareChange,
}: ShareDocDialogProps) {
  const [loading, setLoading] = useState(false);

  const shareUrl = shareToken
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/docs/share/${shareToken}`
    : '';

  const handleToggle = async () => {
    setLoading(true);
    try {
      if (isShared) {
        const result = await api.docs.share.disable(docId);
        onShareChange({ isShared: result.isShared, shareToken: result.shareToken });
      } else {
        const result = await api.docs.share.enable(docId);
        onShareChange({ isShared: result.isShared, shareToken: result.shareToken });
      }
    } catch {
      toast.error('Failed to update sharing settings');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success('Link copied to clipboard');
    } catch {
      toast.error('Failed to copy link');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share document</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 pt-2">
          {/* Toggle row */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Public link</span>
              <span className="text-xs text-muted-foreground">
                Anyone with the link can edit this document
              </span>
            </div>

            {/* Inline toggle switch */}
            <button
              type="button"
              role="switch"
              aria-checked={isShared}
              disabled={loading}
              onClick={handleToggle}
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
                isShared ? 'bg-primary' : 'bg-input',
              )}
            >
              {loading ? (
                <Loader2 className="absolute left-0.5 w-3.5 h-3.5 animate-spin text-white" />
              ) : (
                <span
                  className={cn(
                    'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm ring-0 transition-transform',
                    isShared ? 'translate-x-4' : 'translate-x-0',
                  )}
                />
              )}
            </button>
          </div>

          {/* Share link */}
          {isShared && shareToken ? (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 min-w-0">
                <Link className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs text-muted-foreground truncate flex-1">{shareUrl}</span>
              </div>
              <Button size="sm" variant="outline" onClick={handleCopy} className="gap-1.5 shrink-0">
                <Copy className="w-3.5 h-3.5" />
                Copy
              </Button>
            </div>
          ) : !isShared ? (
            <p className="text-xs text-muted-foreground/60">
              Enable the toggle above to generate a shareable link.
            </p>
          ) : null}

          {isShared && (
            <p className="text-[11px] text-muted-foreground/60">
              Disabling the link will revoke access for everyone using it.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
