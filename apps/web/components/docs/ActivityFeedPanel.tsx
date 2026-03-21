'use client';

import { useEffect, useState } from 'react';
import { Activity, Eye, Edit3, MessageSquare, CheckCircle, AtSign, X } from 'lucide-react';
import { api } from '@/lib/api';

interface ActivityItem {
  id: string;
  actorName: string | null;
  type: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

const TYPE_CONFIG: Record<string, { label: string; Icon: React.ElementType; color: string }> = {
  VIEWED:    { label: 'viewed',            Icon: Eye,           color: 'text-muted-foreground' },
  EDITED:    { label: 'edited',            Icon: Edit3,         color: 'text-blue-500' },
  COMMENTED: { label: 'commented',         Icon: MessageSquare, color: 'text-violet-500' },
  RESOLVED:  { label: 'resolved a thread', Icon: CheckCircle,   color: 'text-green-500' },
  MENTIONED: { label: 'was mentioned',     Icon: AtSign,        color: 'text-orange-500' },
};

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface Props {
  docId: string;
  onClose: () => void;
}

export function ActivityFeedPanel({ docId, onClose }: Props) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.docs.activity.list(docId)
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [docId]);

  return (
    <div className="w-64 border-l border-border shrink-0 flex flex-col bg-background print:hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold">Activity</span>
        </div>
        <button type="button" onClick={onClose} className="p-0.5 rounded hover:bg-muted text-muted-foreground">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {loading && (
          <p className="text-xs text-muted-foreground text-center py-8">Loading…</p>
        )}
        {!loading && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
            <Activity className="w-6 h-6 opacity-30" />
            <p className="text-xs text-center">No activity yet.</p>
          </div>
        )}
        {items.map((item) => {
          const cfg = TYPE_CONFIG[item.type] ?? TYPE_CONFIG.VIEWED;
          const { Icon } = cfg;
          return (
            <div key={item.id} className="flex items-start gap-2 px-3 py-2 hover:bg-muted/30 transition-colors">
              <div className={`mt-0.5 shrink-0 ${cfg.color}`}>
                <Icon className="w-3.5 h-3.5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] leading-snug">
                  <span className="font-semibold">{item.actorName ?? 'Someone'}</span>
                  {' '}<span className="text-muted-foreground">{cfg.label}</span>
                </p>
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">{relativeTime(item.createdAt)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
