'use client';

import { useCallback, useEffect, useState } from 'react';
import { X, Loader2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface Share {
  id: string;
  invitedEmail: string;
  role: 'VIEWER' | 'EDITOR';
}

/**
 * Who a group is shared with. Only the owner may invite or revoke; everyone
 * with access can see the list, so it is clear who else can send to it.
 */
export function GroupSharePanel({ groupId, isOwner }: { groupId: string; isOwner: boolean }) {
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'VIEWER' | 'EDITOR'>('VIEWER');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setShares((await api.contacts.groups.shares.list(groupId)) as Share[]);
    } catch (err: any) {
      toast.error('Failed to load sharing', { description: err?.message });
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const created = (await api.contacts.groups.shares.add(groupId, { email: trimmed, role })) as Share;
      // Upsert on the server, so replace any existing row for this address.
      setShares((prev) => [
        ...prev.filter((s) => s.invitedEmail.toLowerCase() !== created.invitedEmail.toLowerCase()),
        created,
      ]);
      setEmail('');
      toast.success(`Shared with ${created.invitedEmail}`);
    } catch (err: any) {
      toast.error('Could not share the group', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (share: Share) => {
    try {
      await api.contacts.groups.shares.remove(groupId, share.id);
      setShares((prev) => prev.filter((s) => s.id !== share.id));
      toast.success(`Removed ${share.invitedEmail}`);
    } catch (err: any) {
      toast.error('Could not remove the share', { description: err?.message });
    }
  };

  return (
    <div className="mt-6 border-t border-border/50 pt-4">
      <h3 className="text-xs font-medium text-muted-foreground/60 uppercase tracking-wider mb-3">
        Shared with
      </h3>

      {loading && shares.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
          <Loader2 className="w-3 h-3 animate-spin" />Loading…
        </div>
      ) : shares.length === 0 ? (
        <p className="text-xs text-muted-foreground/50">Not shared with anyone yet</p>
      ) : (
        <ul className="flex flex-col gap-1.5 mb-3">
          {shares.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{s.invitedEmail}</span>
              <span className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground/60">
                  {s.role === 'EDITOR' ? 'Can edit' : 'Can send'}
                </span>
                {isOwner && (
                  <button
                    type="button"
                    aria-label={`Revoke ${s.invitedEmail}`}
                    onClick={() => handleRemove(s)}
                    className="text-muted-foreground/50 hover:text-destructive"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {isOwner && (
        <div className="flex items-center gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
            placeholder="colleague@risa.gov.rw"
            className="flex-1 min-w-0 px-3 py-1.5 bg-muted/30 border border-border/50 rounded-lg text-sm outline-none focus:border-primary/50"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'VIEWER' | 'EDITOR')}
            aria-label="Permission"
            className="px-2 py-1.5 bg-muted/30 border border-border/50 rounded-lg text-xs outline-none"
          >
            <option value="VIEWER">Can send</option>
            <option value="EDITOR">Can edit</option>
          </select>
          <button
            type="button"
            onClick={handleAdd}
            disabled={saving || !email.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
            Share
          </button>
        </div>
      )}
    </div>
  );
}
