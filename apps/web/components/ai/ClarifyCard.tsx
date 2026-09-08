'use client';

import { HelpCircle } from 'lucide-react';
import type { AgentClarify } from '@/lib/ai/agent';
import { cn } from '@/lib/utils';

/**
 * Renders one clarifying question from the agent (ask_user tool) with
 * quick-reply chips. Picking a chip sends that option as the user's next
 * message via onPick; the user can equally ignore the chips and type a free
 * answer in the input. Chips are only interactive on the latest turn —
 * older cards render disabled so history can't fork the conversation.
 */
export default function ClarifyCard({
  clarify,
  onPick,
  disabled,
}: {
  clarify: AgentClarify;
  onPick: (option: string) => void;
  disabled: boolean;
}) {
  return (
    <div
      className="rounded-md border border-border/40 bg-card p-3 text-[0.75rem] text-foreground space-y-2"
      data-clarify={clarify.clarifyId}
    >
      <div className="flex items-start gap-1.5 font-medium">
        <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span>{clarify.question}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {clarify.options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={disabled}
            onClick={() => onPick(option)}
            className={cn(
              'rounded-full border border-border/40 px-2.5 py-1 text-[0.6875rem] transition-colors',
              disabled
                ? 'text-muted-foreground/50'
                : 'text-foreground hover:bg-muted/60 hover:border-border',
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
