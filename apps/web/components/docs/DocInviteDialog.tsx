'use client';

import { useEffect, useState } from 'react';
import { Loader2, UserPlus, X, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { api, type DocInvite } from '@/lib/api';
import { cn } from '@/lib/utils';
import { EmailChipInput } from '@/components/mail/EmailChipInput';

interface DocInviteDialogProps {
  docId: string;
  isOwner: boolean;
}

type Role = 'EDITOR' | 'VIEWER';

const ROLE_LABELS: Record<Role, string> = {
  EDITOR: 'Editor',
  VIEWER: 'Viewer',
};

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  EDITOR: 'Can read and edit',
  VIEWER: 'Can read only',
};

function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: Role;
  onChange: (r: Role) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {ROLE_LABELS[value]}
        <ChevronDown className="w-3 h-3 text-muted-foreground" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-7 z-50 w-40 rounded-md border border-border bg-popover shadow-md py-1"
          onMouseLeave={() => setOpen(false)}
        >
          {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
            <button
              key={r}
              type="button"
              className={cn(
                'w-full text-left px-3 py-2 text-xs hover:bg-muted',
                r === value && 'font-medium',
              )}
              onClick={() => { onChange(r); setOpen(false); }}
            >
              <div>{ROLE_LABELS[r]}</div>
              <div className="text-muted-foreground">{ROLE_DESCRIPTIONS[r]}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function getInitials(email: string) {
  const parts = email.split('@')[0].split(/[._-]/);
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

export function DocInvitePanel({ docId, isOwner }: DocInviteDialogProps) {
  const [invites, setInvites]     = useState<DocInvite[]>([]);
  const [loading, setLoading]     = useState(true);
  const [emails, setEmails]       = useState<string[]>([]);
  const [role, setRole]           = useState<Role>('EDITOR');
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOwner) { setLoading(false); return; }
    api.docs.invites.list(docId)
      .then(setInvites)
      .catch(() => toast.error('Failed to load invites'))
      .finally(() => setLoading(false));
  }, [docId, isOwner]);

  const handleAdd = async () => {
    if (emails.length === 0) return;
    setSubmitting(true);
    const toInvite = [...emails];
    setEmails([]);
    let successCount = 0;
    for (const e of toInvite) {
      try {
        const invite = await api.docs.invites.add(docId, { email: e, role });
        setInvites((prev) => [...prev, invite]);
        successCount++;
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : `Failed to invite ${e}`);
      }
    }
    if (successCount > 0) {
      toast.success(
        successCount === 1
          ? `Invited ${toInvite[0]} — a notification email has been sent`
          : `Invited ${successCount} people — notification emails have been sent`,
      );
    }
    setSubmitting(false);
  };

  const handleRoleChange = async (inviteId: string, newRole: Role) => {
    setUpdatingId(inviteId);
    try {
      const updated = await api.docs.invites.updateRole(docId, inviteId, newRole);
      setInvites((prev) => prev.map((i) => i.id === inviteId ? { ...i, role: updated.role } : i));
    } catch {
      toast.error('Failed to update role');
    } finally {
      setUpdatingId(null);
    }
  };

  const handleRemove = async (inviteId: string, invitedEmail: string) => {
    setRemovingId(inviteId);
    try {
      await api.docs.invites.remove(docId, inviteId);
      setInvites((prev) => prev.filter((i) => i.id !== inviteId));
      toast.success(`Removed access for ${invitedEmail}`);
    } catch {
      toast.error('Failed to remove invite');
    } finally {
      setRemovingId(null);
    }
  };

  if (!isOwner) {
    return (
      <p className="text-xs text-muted-foreground py-2">
        Only the document owner can manage invitations.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Invite input */}
      <div className="flex flex-col gap-2">
        <EmailChipInput
          value={emails}
          onChange={setEmails}
          placeholder="colleague@gov.za"
        />
        <div className="flex gap-2 justify-end">
          <RoleSelect value={role} onChange={setRole} />
          <button
            type="button"
            disabled={submitting || emails.length === 0}
            onClick={() => void handleAdd()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
            Invite
          </button>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground -mt-2">
        An email notification will be sent via your Zimbra account. The invitee must have a 1Gov Mail account.
      </p>

      {/* Invite list */}
      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      ) : invites.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-3">No one has been invited yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {invites.length} {invites.length === 1 ? 'person' : 'people'} with access
          </p>
          {invites.map((invite) => (
            <div key={invite.id} className="flex items-center gap-2">
              {/* Avatar */}
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-semibold text-primary shrink-0">
                {getInitials(invite.invitedEmail)}
              </div>
              {/* Email */}
              <span className="flex-1 min-w-0 text-xs truncate">{invite.invitedEmail}</span>
              {/* Role selector */}
              <RoleSelect
                value={invite.role as Role}
                onChange={(r) => void handleRoleChange(invite.id, r)}
                disabled={updatingId === invite.id}
              />
              {/* Remove */}
              <button
                type="button"
                disabled={removingId === invite.id}
                onClick={() => void handleRemove(invite.id, invite.invitedEmail)}
                className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                title="Remove access"
              >
                {removingId === invite.id
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <X className="w-3.5 h-3.5" />
                }
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
