'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Loader2, Globe } from 'lucide-react';
import { api, type Doc } from '@/lib/api';
import { DocsEditor } from '@/components/docs/DocsEditor';
import { getUserColor } from '@/lib/utils';

export default function SharedDocPage() {
  const params = useParams();
  const token = params?.token as string;

  const [doc, setDoc] = useState<Doc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localTitle, setLocalTitle] = useState('');

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api.shared.getOne(token)
      .then((d) => {
        setDoc(d);
        setLocalTitle(d.title);
      })
      .catch(() => setError('This document is not available or the link has been revoked.'))
      .finally(() => setLoading(false));
  }, [token]);

  // Collaboration via share token (no JWT — public access)
  const collabToken = useMemo(
    () => JSON.stringify({ type: 'share', value: token }),
    [token],
  );
  const collabUser = useMemo(
    () => ({ name: 'Guest', color: getUserColor(token) }),
    [token],
  );

  // Title is still saved via REST (shared endpoint)
  const onTitleSave = useCallback(
    async (title: string) => {
      await api.shared.update(token, { title });
    },
    [token],
  );

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background text-center px-4">
        <Globe className="w-10 h-10 text-muted-foreground/30" />
        <p className="text-sm font-medium text-foreground">Document not found</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          {error ?? 'This shared link is invalid or has been revoked by the owner.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Shared banner */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/30 shrink-0">
        <Globe className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          Shared document — anyone with this link can edit
        </span>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        <DocsEditor
          key={doc.id}
          docId={doc.id}
          initialContent={doc.content}
          title={localTitle}
          onTitleChange={setLocalTitle}
          onTitleSave={onTitleSave}
          collaborationToken={collabToken}
          collaborationUser={collabUser}
        />
      </div>
    </div>
  );
}
