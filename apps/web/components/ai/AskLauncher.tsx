'use client';

import { usePathname } from 'next/navigation';
import { MessageCircleQuestion } from 'lucide-react';
import { useAIStore } from '@/stores/ai.store';
import { useAskStore } from '@/stores/ask.store';
import AskPanel from '@/components/ai/AskPanel';

/**
 * App-wide Ask 1Gov shell: mounts the single <AskPanel/> instance (store-driven,
 * see stores/ask.store.ts) plus a floating launcher button.
 *
 * The mail page has its own intelligence rail + FAB that open the very same
 * store, so the launcher's own button is hidden there to avoid a duplicate
 * trigger — the panel itself is still this same mounted instance either way.
 */
export function AskLauncher() {
  const pathname = usePathname();
  const aiEnabled = useAIStore((s) => s.enabled);
  const open = useAskStore((s) => s.open);
  const collapsed = useAskStore((s) => s.collapsed);
  const openAsk = useAskStore((s) => s.openAsk);

  const isMailPage = pathname === '/mail';

  return (
    <>
      <AskPanel />
      {aiEnabled && !isMailPage && (!open || collapsed) && (
        <button
          type="button"
          onClick={() => openAsk()}
          className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xl hover:bg-primary/90 transition-colors"
          aria-label="Ask 1Gov"
          title="Ask 1Gov"
        >
          <MessageCircleQuestion className="w-5 h-5" />
        </button>
      )}
    </>
  );
}
