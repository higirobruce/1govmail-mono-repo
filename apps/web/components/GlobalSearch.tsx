'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAIStore } from '@/stores/ai.store';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { Mail, Users, ListTodo, Calendar, MessageCircleQuestion } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  /** If provided, the search is pre-populated */
  initialQuery?: string;
}

export function GlobalSearch({ open, onClose, initialQuery }: Props) {
  const router = useRouter();
  const aiEnabled = useAIStore((s) => s.enabled);
  const [query, setQuery] = useState(initialQuery ?? '');
  const [mailResults, setMailResults] = useState<any[]>([]);
  const [mailLoading, setMailLoading] = useState(false);
  const [semanticResults, setSemanticResults] = useState<any[]>([]);

  // Pre-fetch contacts, tasks, calendar — React Query cache keeps them fresh
  const { data: contacts = [] } = useQuery({
    queryKey: ['contacts'],
    queryFn: () => api.contacts.getAll(),
    staleTime: 5 * 60_000,
    enabled: open,
  });
  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => api.tasks.getAll(),
    staleTime: 2 * 60_000,
    enabled: open,
  });
  const { data: events = [] } = useQuery({
    queryKey: ['calendarEvents', 'global'],
    queryFn: () => {
      const start = new Date();
      start.setMonth(start.getMonth() - 1);
      const end = new Date();
      end.setMonth(end.getMonth() + 3);
      return api.calendar.getEvents(start.toISOString(), end.toISOString());
    },
    staleTime: 5 * 60_000,
    enabled: open,
  });

  // Reset query when dialog opens
  useEffect(() => {
    if (open) setQuery(initialQuery ?? '');
  }, [open, initialQuery]);

  // Debounce mail search (server-side)
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length < 2) { setMailResults([]); return; }
    setMailLoading(true);
    const id = setTimeout(async () => {
      try {
        const data = await api.mail.search(trimmed, 5, 0);
        setMailResults(data.messages ?? []);
      } catch {
        setMailResults([]);
      } finally {
        setMailLoading(false);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [query]);

  // Debounce semantic search (best-effort — never breaks ⌘K)
  useEffect(() => {
    const trimmed = query.trim();
    if (!aiEnabled || trimmed.length < 3) { setSemanticResults([]); return; }
    const id = setTimeout(async () => {
      try {
        const data = await api.mail.semanticSearch(trimmed, 5);
        setSemanticResults(data.messages ?? []);
      } catch {
        setSemanticResults([]); // semantic search is best-effort — never breaks ⌘K
      }
    }, 400);
    return () => clearTimeout(id);
  }, [query, aiEnabled]);

  const q = query.toLowerCase().trim();

  const filteredContacts = q.length >= 1
    ? contacts.filter((c: any) =>
        (c.fullName ?? '').toLowerCase().includes(q) ||
        (c.email ?? '').toLowerCase().includes(q),
      ).slice(0, 5)
    : [];

  const filteredTasks = q.length >= 1
    ? tasks.filter((t: any) =>
        (t.title ?? '').toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q),
      ).slice(0, 5)
    : [];

  const filteredEvents = q.length >= 1
    ? events.filter((ev: any) =>
        (ev.title ?? '').toLowerCase().includes(q) ||
        (ev.description ?? '').toLowerCase().includes(q),
      ).slice(0, 5)
    : [];

  const mailResultIds = new Set(mailResults.map((m: any) => m.id));
  const dedupedSemanticResults = semanticResults.filter((m: any) => !mailResultIds.has(m.id));

  const showAskRow = aiEnabled && query.trim().length >= 3;

  const handleSelect = useCallback((type: string, item: any) => {
    onClose();
    if (type === 'mail') {
      router.push(`/mail?messageId=${item.id}`);
    } else if (type === 'contact') {
      router.push('/contacts');
    } else if (type === 'task') {
      router.push('/tasks');
    } else if (type === 'event') {
      router.push('/calendar');
    }
  }, [router, onClose]);

  const handleAskSelect = useCallback(() => {
    onClose();
    router.push('/mail?ask=' + encodeURIComponent(query.trim()));
  }, [router, onClose, query]);

  const hasResults = showAskRow || mailResults.length > 0 || dedupedSemanticResults.length > 0 ||
    filteredContacts.length > 0 || filteredTasks.length > 0 || filteredEvents.length > 0;

  return (
    <CommandDialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <CommandInput
        placeholder="Search messages, contacts, tasks, events…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {!hasResults && !mailLoading && q.length >= 2 && (
          <CommandEmpty>No results found.</CommandEmpty>
        )}
        {mailLoading && (
          <div className="py-4 text-center text-xs text-muted-foreground">Searching messages…</div>
        )}

        {showAskRow && (
          <CommandGroup heading="Ask AI">
            <CommandItem
              value={`ask-${query.trim()}`}
              onSelect={handleAskSelect}
              className="flex items-center gap-3"
            >
              <MessageCircleQuestion className="w-4 h-4 shrink-0 text-muted-foreground" />
              <p className="text-[13px] font-medium truncate">
                Ask your inbox: &ldquo;{query.trim()}&rdquo;
              </p>
            </CommandItem>
          </CommandGroup>
        )}

        {mailResults.length > 0 && (
          <CommandGroup heading="Messages">
            {mailResults.map((msg: any) => (
              <CommandItem
                key={msg.id}
                value={`mail-${msg.id}`}
                onSelect={() => handleSelect('mail', msg)}
                className="flex items-start gap-3"
              >
                <Mail className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium truncate">{msg.subject || '(no subject)'}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {msg.from?.email ?? msg.from} · {msg.snippet}
                  </p>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {dedupedSemanticResults.length > 0 && (
          <CommandGroup heading="From your mail (semantic)">
            {dedupedSemanticResults.map((msg: any) => (
              <CommandItem
                key={msg.id}
                value={`semantic-${msg.id}`}
                onSelect={() => handleSelect('mail', msg)}
                className="flex items-start gap-3"
              >
                <Mail className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium truncate">{msg.subject || '(no subject)'}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {msg.from?.email ?? msg.from} · {msg.snippet}
                  </p>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {filteredContacts.length > 0 && (
          <CommandGroup heading="Contacts">
            {filteredContacts.map((c: any) => (
              <CommandItem
                key={c.id}
                value={`contact-${c.id}`}
                onSelect={() => handleSelect('contact', c)}
                className="flex items-center gap-3"
              >
                <Users className="w-4 h-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium truncate">{c.fullName}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{c.email}</p>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {filteredTasks.length > 0 && (
          <CommandGroup heading="Tasks">
            {filteredTasks.map((t: any) => (
              <CommandItem
                key={t.id}
                value={`task-${t.id}`}
                onSelect={() => handleSelect('task', t)}
                className="flex items-center gap-3"
              >
                <ListTodo className="w-4 h-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium truncate">{t.title}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{t.status}</p>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {filteredEvents.length > 0 && (
          <CommandGroup heading="Calendar Events">
            {filteredEvents.map((ev: any) => (
              <CommandItem
                key={ev.id}
                value={`event-${ev.id}`}
                onSelect={() => handleSelect('event', ev)}
                className="flex items-center gap-3"
              >
                <Calendar className="w-4 h-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium truncate">{ev.title}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {ev.startAt ? new Date(ev.startAt).toLocaleDateString() : ''}
                  </p>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
