'use client';

import { Sparkles, X } from 'lucide-react';
import { useUIStore } from '@/stores/ui.store';
import { shouldShowAiProfileNudge, type AiProfileNudgeInput } from '@/lib/ai/profileNudge';

interface AiProfileNudgeProps {
  /** The account's AI profile, or undefined while it is still loading. */
  profile?: AiProfileNudgeInput | null;
  /** Opens Settings → AI Profile. Omitted where there is nowhere to send them. */
  onOpenSettings?: () => void;
}

/**
 * A one-line invitation to fill in the AI profile, shown inside the AI panes
 * and nowhere else — someone who never opens AI never sees it.
 *
 * Deliberately not a modal, a toast, or a checklist: it does not block, it
 * does not follow the user around, and waving it away is permanent.
 */
export function AiProfileNudge({ profile, onOpenSettings }: AiProfileNudgeProps) {
  const dismissed = useUIStore((s) => s.aiProfileNudgeDismissed);
  const dismiss = useUIStore((s) => s.dismissAiProfileNudge);

  if (!shouldShowAiProfileNudge(profile, dismissed)) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-ui text-ink-2 bg-muted/50 border-b border-border-faint">
      <Sparkles className="w-3.5 h-3.5 shrink-0 text-primary" />
      <span className="flex-1 min-w-0">
        Answers improve when 1Gov knows your role.
      </span>
      {onOpenSettings && (
        <button
          onClick={onOpenSettings}
          className="shrink-0 font-medium text-primary hover:underline"
        >
          Add details
        </button>
      )}
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 p-0.5 rounded hover:bg-muted text-ink-3 hover:text-foreground transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
