'use client';

import { useAiProfileSync } from '@/lib/ai/profileSync';

/**
 * Invisible mount point for the account↔device AI-profile sync (see
 * lib/ai/profileSync.ts). Lives in its own component because the (app)
 * layout is a Server Component (it exports `dynamic = 'force-dynamic'`,
 * which Client Components can't co-locate) and so can't call hooks itself —
 * mirrors how ServiceWorkerRegister is mounted from the server root layout.
 */
export function AiProfileSyncMount() {
  useAiProfileSync();
  return null;
}
