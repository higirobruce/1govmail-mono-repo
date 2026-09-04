'use client';

import { Mail } from 'lucide-react';
import { cn } from '@/lib/utils';

const SYSTEM_PREFIXES = [
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'postmaster',
  'notifications',
  'notification',
  'auto-confirm',
  'bounces',
];

function isSystemSender(email: string): boolean {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  return SYSTEM_PREFIXES.some((p) => local === p || local.startsWith(`${p}+`) || local.startsWith(`${p}-`));
}

function initials(name: string | null | undefined, email: string): string {
  const n = (name ?? '').trim();
  if (n) {
    const parts = n.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  const local = email.split('@')[0] ?? '';
  return local.slice(0, 2).toUpperCase() || '?';
}

const SIZE_CLS = {
  xs: 'w-6 h-6 text-[0.5625rem]',
  sm: 'w-8 h-8 text-[0.6875rem]',
  md: 'w-9 h-9 text-[0.75rem]',
  lg: 'w-11 h-11 text-[0.875rem]',
} as const;

const ICON_CLS = {
  xs: 'w-3 h-3',
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-5 h-5',
} as const;

export interface MailAvatarProps {
  name?: string | null;
  email: string;
  size?: keyof typeof SIZE_CLS;
  className?: string;
}

export function MailAvatar({ name, email, size = 'md', className }: MailAvatarProps) {
  const system = isSystemSender(email);
  const sizeCls = SIZE_CLS[size];

  if (system) {
    return (
      <div
        className={cn(
          'shrink-0 rounded-full bg-muted text-muted-foreground/70 flex items-center justify-center border border-border/50',
          sizeCls,
          className,
        )}
        aria-hidden
      >
        <Mail className={ICON_CLS[size]} />
      </div>
    );
  }

  // Neutral light-gray avatar with deep-foreground initials — keeps the list
  // visually calm. Identity is conveyed by the name/sender text, not by colour.
  return (
    <div
      className={cn(
        'shrink-0 rounded-full bg-muted text-foreground/70 font-semibold flex items-center justify-center select-none border border-border/50',
        sizeCls,
        className,
      )}
      aria-hidden
    >
      {initials(name, email)}
    </div>
  );
}
