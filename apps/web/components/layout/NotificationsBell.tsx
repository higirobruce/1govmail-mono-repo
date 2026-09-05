'use client';

import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Bell, Mail, Calendar, ListTodo, Clock, X, CheckCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';

const TYPE_ICON: Record<string, React.ElementType> = {
  MAIL_SNOOZE_EXPIRED: Clock,
  SCHEDULED_SENT:      Mail,
  TASK_DUE:            ListTodo,
  EVENT_SOON:          Calendar,
};

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications.getAll(50),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const unread = notifications.filter((n: any) => !n.isRead).length;

  const markAllRead = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const deleteOne = useMutation({
    mutationFn: (id: string) => api.notifications.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  // Mark all read when opening
  const handleOpen = () => {
    setOpen((o) => {
      if (!o && unread > 0) markAllRead.mutate();
      return !o;
    });
  };

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={handleOpen}
        title="Notifications"
        className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[0.8125rem] text-foreground/65 hover:bg-muted/50 hover:text-foreground transition-all relative group-data-[collapsed=true]/sidebar:justify-center group-data-[collapsed=true]/sidebar:px-0"
      >
        <Bell className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1 text-left group-data-[collapsed=true]/sidebar:hidden">Notifications</span>
        {unread > 0 && (
          <span className="w-4 h-4 rounded-full bg-primary text-primary-foreground text-[0.625rem] font-bold flex items-center justify-center shrink-0 group-data-[collapsed=true]/sidebar:hidden">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
        {unread > 0 && (
          <span className="hidden group-data-[collapsed=true]/sidebar:block absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full bg-primary" />
        )}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-80 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
            <span className="text-[0.8125rem] font-semibold text-foreground">Notifications</span>
            {notifications.length > 0 && (
              <button
                onClick={() => markAllRead.mutate()}
                className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground/50 hover:text-foreground transition-colors"
                title="Mark all read"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                All read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-[0.75rem] text-muted-foreground/40">
                No notifications
              </div>
            ) : (
              notifications.map((n: any) => {
                const Icon = TYPE_ICON[n.type] ?? Bell;
                return (
                  <div
                    key={n.id}
                    className={cn(
                      'flex items-start gap-3 px-4 py-3 border-b border-border/20 last:border-0 hover:bg-muted/30 transition-colors group',
                      !n.isRead && 'bg-primary/3',
                    )}
                    onClick={() => { if (!n.isRead) markRead.mutate(n.id); }}
                  >
                    <div className="w-7 h-7 rounded-full bg-muted/60 flex items-center justify-center shrink-0 mt-0.5">
                      <Icon className="w-3.5 h-3.5 text-muted-foreground/70" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={cn('text-[0.75rem] font-medium truncate', !n.isRead && 'text-foreground')}>{n.title}</p>
                      {n.body && <p className="text-[0.6875rem] text-muted-foreground/55 mt-0.5 line-clamp-2">{n.body}</p>}
                      <p className="text-[0.625rem] text-muted-foreground/35 mt-1">
                        {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                      </p>
                    </div>
                    {!n.isRead && (
                      <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-1.5" />
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteOne.mutate(n.id); }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground/30 hover:text-muted-foreground transition-all shrink-0"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
