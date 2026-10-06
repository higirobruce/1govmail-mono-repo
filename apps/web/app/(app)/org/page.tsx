'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Menu, Building2 } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import Sidebar from '@/components/layout/Sidebar';
import { MobileSidebarSheet } from '@/components/layout/MobileSidebarSheet';
import { OrgDigest } from '@/components/org/OrgDigest';

export default function OrgPage() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const [hydrated, setHydrated] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Auth hydration — the same guard every page in this group uses. There is no
  // `hydrated` field on the store; it comes from the persist middleware.
  useEffect(() => {
    const unsub = useAuthStore.persist.onFinishHydration(() => setHydrated(true));
    if (useAuthStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  if (!hydrated) return null;

  // Pages in this group render their own shell — there is no shared chrome in
  // (app)/layout.tsx beyond the Ask panel and the notification mounts. This
  // page has no folders of its own, so folder actions route to /mail — same
  // pattern as ai/history/page.tsx.
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        folders={[]}
        activeFolderId=""
        onFolderSelect={() => router.push('/mail')}
        onCompose={() => router.push('/mail')}
      />
      <MobileSidebarSheet
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        folders={[]}
        activeFolderId=""
        onFolderSelect={() => router.push('/mail')}
        onCompose={() => router.push('/mail')}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 pt-8">
          <div className="flex items-baseline gap-2 mb-1">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-1 -ml-0.5 rounded-md text-muted-foreground/60 hover:bg-muted/50 hover:text-foreground transition-colors"
              aria-label="Open navigation"
            >
              <Menu className="w-4 h-4" />
            </button>
            <h1 className="text-display flex items-center gap-2">
              <Building2 className="w-5 h-5 text-ink-2" />
              Organisation
            </h1>
          </div>
        </div>
        <OrgDigest />
      </div>
    </div>
  );
}
