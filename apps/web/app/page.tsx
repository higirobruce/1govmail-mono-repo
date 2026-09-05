import Link from 'next/link';
import {
  Sparkles,
  ClipboardCheck,
  MessageCircleQuestion,
  AlarmClock,
  Undo2,
  CalendarClock,
  FileText,
  Filter,
  BellOff,
  Inbox,
  Send,
  Trash2,
  Archive,
  Settings,
  Plus,
} from 'lucide-react';

const AI_FEATURES = [
  {
    icon: MessageCircleQuestion,
    title: 'Ask your inbox',
    description:
      'Ask questions in plain language — “what did finance say about the budget?” — and get answers grounded in your own mail, with citations back to the source messages.',
  },
  {
    icon: Sparkles,
    title: 'Morning briefing',
    description:
      'One structured brief of what needs a decision, who is waiting on you, and what has a deadline — generated from your inbox, on your infrastructure.',
  },
  {
    icon: ClipboardCheck,
    title: 'Commitments ledger',
    description:
      'Every promise you made and every reply you are owed, extracted automatically and tracked until you resolve it. Nothing silently slips.',
  },
] as const;

const MAIL_FEATURES = [
  { icon: AlarmClock, title: 'Snooze', description: 'Resurface any email at the moment it matters.' },
  { icon: Undo2, title: 'Undo send', description: 'A five-second safety net after every send.' },
  { icon: CalendarClock, title: 'Scheduled send', description: 'Compose now, deliver at the right time.' },
  { icon: FileText, title: 'Templates', description: 'Reusable replies, inserted in one click.' },
  { icon: Filter, title: 'Mail rules', description: 'If-this-then-that filters that keep order.' },
  { icon: BellOff, title: 'Mute threads', description: 'Silence noise without losing the record.' },
] as const;

/** A miniature of the actual app chrome, drawn with the real design tokens. */
function AppMiniature() {
  return (
    <div
      aria-hidden
      className="w-full max-w-4xl mx-auto rounded-2xl border border-border bg-card shadow-[0_24px_80px_-32px_color-mix(in_oklch,var(--primary)_28%,transparent)] overflow-hidden select-none pointer-events-none"
    >
      <div className="flex h-[340px] text-left">
        {/* Left rail */}
        <div className="w-10 shrink-0 border-r border-sidebar-border bg-sidebar flex flex-col items-center py-3 gap-2.5">
          <span className="w-5 h-5 rounded-md bg-primary/10 flex items-center justify-center">
            <Plus className="w-3 h-3 text-primary" />
          </span>
          <Inbox className="w-3.5 h-3.5 text-primary" />
          <Send className="w-3.5 h-3.5 text-ink-4" />
          <Archive className="w-3.5 h-3.5 text-ink-4" />
          <Trash2 className="w-3.5 h-3.5 text-ink-4" />
        </div>

        {/* List */}
        <div className="w-[30%] shrink-0 border-r border-border-faint px-4 pt-4 hidden sm:block">
          <p className="text-title text-foreground mb-2.5">Inbox</p>
          <div className="h-6 rounded-lg bg-muted/60 mb-3" />
          {[
            { name: 'Finance · MINECOFIN', unread: true },
            { name: 'Cabinet secretariat', unread: false },
            { name: 'ICT steering committee', unread: false },
            { name: 'Legal review', unread: true },
          ].map((row) => (
            <div key={row.name} className="flex items-start gap-2 py-2 border-b border-border-faint last:border-0">
              <span className="w-5 h-5 rounded-full bg-muted shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className={`text-micro leading-none truncate ${row.unread ? 'text-primary' : 'text-foreground'} font-semibold`}>
                  {row.name}
                </p>
                <div className="h-1.5 w-4/5 rounded bg-muted/70 mt-1.5" />
                <div className="h-1.5 w-3/5 rounded bg-muted/50 mt-1" />
              </div>
              {row.unread && <span className="w-1.5 h-1.5 rounded-full bg-primary mt-1 shrink-0" />}
            </div>
          ))}
        </div>

        {/* Thread */}
        <div className="flex-1 min-w-0 px-5 pt-4">
          <div className="flex items-center gap-1.5 mb-2.5">
            <span className="text-micro leading-none px-1.5 py-0.5 rounded-full bg-warning/10 text-warning-strong">Awaiting reply</span>
            <div className="flex-1" />
            <span className="w-4 h-4 rounded bg-muted/70" />
            <span className="w-4 h-4 rounded bg-muted/70" />
            <span className="w-4 h-4 rounded bg-muted/70" />
          </div>
          <p className="text-title text-foreground mb-2.5">Budget ceiling for the digital services programme</p>
          <div className="rounded-xl border border-border-faint bg-card p-3">
            <div className="h-1.5 w-1/3 rounded bg-muted/80 mb-2" />
            <div className="h-1.5 w-full rounded bg-muted/50 mb-1.5" />
            <div className="h-1.5 w-11/12 rounded bg-muted/50 mb-1.5" />
            <div className="h-1.5 w-4/6 rounded bg-muted/50" />
          </div>
        </div>

        {/* Docked AI panel + intelligence rail */}
        <div className="w-[26%] shrink-0 border-l border-border-faint bg-card px-3.5 pt-4 hidden md:block">
          <div className="flex items-center gap-1.5 mb-3">
            <MessageCircleQuestion className="w-3 h-3 text-primary" />
            <span className="text-micro leading-none text-foreground">Ask your inbox</span>
          </div>
          <div className="rounded-md bg-muted/50 px-2 py-1.5 mb-2">
            <p className="text-micro leading-tight font-normal text-ink-2">What did finance say about the budget?</p>
          </div>
          <div className="h-1.5 w-full rounded bg-muted/50 mb-1.5" />
          <div className="h-1.5 w-5/6 rounded bg-muted/50 mb-1.5" />
          <div className="h-1.5 w-2/3 rounded bg-muted/50 mb-2.5" />
          <span className="inline-flex text-micro leading-none px-1.5 py-0.5 rounded-full border border-primary/25 bg-primary/5 text-primary">
            [1] MINECOFIN · Yesterday
          </span>
        </div>
        <div className="w-9 shrink-0 border-l border-sidebar-border bg-sidebar flex-col items-center py-3 gap-2.5 hidden md:flex">
          <Sparkles className="w-3.5 h-3.5 text-ink-4" />
          <ClipboardCheck className="w-3.5 h-3.5 text-ink-4" />
          <MessageCircleQuestion className="w-3.5 h-3.5 text-primary" />
          <div className="flex-1" />
          <Settings className="w-3.5 h-3.5 text-ink-4" />
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* ── Nav ───────────────────────────────────────────────────── */}
      <header className="border-b border-border-faint sticky top-0 z-30 bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <span className="text-title tracking-tight">1Gov Mail</span>
          <Link
            href="/login"
            className="h-8 px-4 rounded-lg bg-primary text-primary-foreground text-ui font-medium flex items-center hover:bg-primary/90 transition-colors"
          >
            Sign in
          </Link>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────── */}
      <section className="flex flex-col items-center text-center px-6 pt-20 pb-16">
        <div className="inline-flex items-center gap-2 border border-border rounded-full px-3.5 py-1 mb-8 bg-muted/30">
          <Sparkles className="w-3 h-3 text-primary" />
          <span className="text-micro text-ink-2 tracking-[0.06em] uppercase">
            Now with an intelligence rail
          </span>
        </div>

        <h1 className="text-[3rem] font-bold leading-[1.08] tracking-tight text-balance max-w-2xl mb-5">
          Government email that reads itself
        </h1>
        <p className="text-[1.0625rem] text-ink-2 max-w-xl leading-relaxed text-balance mb-10">
          Built on Zimbra, run on your own infrastructure. 1Gov Mail briefs you every
          morning, tracks every commitment, and answers questions about your inbox —
          without a single message leaving government servers.
        </p>

        <div className="flex items-center gap-3 mb-16">
          <Link
            href="/login"
            className="h-11 px-6 rounded-xl bg-primary text-primary-foreground text-body font-semibold flex items-center hover:bg-primary/90 transition-colors"
          >
            Get started
          </Link>
          <Link
            href="/mail"
            className="h-11 px-6 rounded-xl border border-border text-body font-medium flex items-center hover:bg-muted/50 transition-colors"
          >
            Open inbox
          </Link>
        </div>

        <AppMiniature />
      </section>

      {/* ── AI story ──────────────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto w-full px-6 pb-20">
        <h2 className="text-micro font-semibold text-ink-3 uppercase tracking-[0.06em] text-center mb-10">
          Your inbox, with a staff of three
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {AI_FEATURES.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="rounded-2xl border border-border bg-card p-6 flex flex-col gap-3 hover:shadow-active-row transition-shadow"
            >
              <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <Icon className="w-4.5 h-4.5 text-primary" strokeWidth={1.75} />
              </div>
              <div>
                <p className="text-body font-semibold text-foreground mb-1">{title}</p>
                <p className="text-ui text-ink-2 leading-relaxed">{description}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="text-micro font-normal text-ink-3 text-center mt-6">
          All AI runs against the organisation&apos;s own hosted model — answers cite their sources, and suspicious
          content is flagged before it can mislead.
        </p>
      </section>

      {/* ── Mail fundamentals ─────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto w-full px-6 pb-24">
        <h2 className="text-micro font-semibold text-ink-3 uppercase tracking-[0.06em] text-center mb-10">
          And every tool a serious mailbox needs
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {MAIL_FEATURES.map(({ icon: Icon, title, description }) => (
            <div key={title} className="rounded-xl border border-border-faint bg-card px-4 py-3.5 flex items-start gap-3">
              <Icon className="w-4 h-4 text-ink-3 shrink-0 mt-0.5" strokeWidth={1.75} />
              <div className="min-w-0">
                <p className="text-ui font-medium text-foreground">{title}</p>
                <p className="text-micro font-normal text-ink-3 leading-relaxed">{description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────── */}
      <footer className="border-t border-border-faint py-6 text-center">
        <p className="text-micro font-normal text-ink-4">
          1Gov Mail &mdash; built on Zimbra, run on your infrastructure
        </p>
      </footer>
    </div>
  );
}
