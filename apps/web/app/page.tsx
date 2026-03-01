import Link from 'next/link';
import {
  AlarmClock,
  Undo2,
  CalendarClock,
  FileText,
  Filter,
  BellOff,
  Printer,
  CheckSquare,
  SpellCheck,
} from 'lucide-react';

const FEATURES = [
  {
    icon: AlarmClock,
    title: 'Snooze',
    description:
      'Temporarily hide an email and have it resurface at the perfect moment — later today, tomorrow morning, or any custom time you choose.',
  },
  {
    icon: Undo2,
    title: 'Undo Send',
    description:
      'A 5-second safety net after every send. Changed your mind? Hit Undo and the message never leaves your outbox.',
  },
  {
    icon: CalendarClock,
    title: 'Scheduled Send',
    description:
      "Compose now, deliver later. Queue a message to go out at any date and time — even while you're offline.",
  },
  {
    icon: FileText,
    title: 'Email Templates',
    description:
      'Save your most-used replies as reusable templates and insert them into any compose window in a single click.',
  },
  {
    icon: Filter,
    title: 'Mail Rules',
    description:
      'Build powerful if/then filters that automatically move, label, or forward incoming messages so your inbox stays organised.',
  },
  {
    icon: BellOff,
    title: 'Mute Conversations',
    description:
      'Silence busy threads you no longer need to follow. Muted conversations stay archived and out of your way.',
  },
  {
    icon: Printer,
    title: 'Print View',
    description:
      'Generate a clean, formatted print-ready version of any email thread — no chrome, no clutter, just the content.',
  },
  {
    icon: CheckSquare,
    title: 'Bulk Actions',
    description:
      'Select multiple messages with a checkbox and mark them all read, move them, or delete them in a single action.',
  },
  {
    icon: SpellCheck,
    title: 'Spell Check',
    description:
      'Native browser spell check is active inside the compose editor, flagging typos as you type so every message goes out polished.',
  },
] as const;

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* ── Nav ───────────────────────────────────────────────────── */}
      <header className="border-b border-border/40 sticky top-0 z-30 bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <span className="text-[15px] font-semibold tracking-tight">1Gov Mail</span>
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-medium text-muted-foreground/50 border border-border/40 rounded-full px-2.5 py-0.5">
              v1.4.0
            </span>
            <Link
              href="/login"
              className="h-8 px-4 rounded-lg bg-primary text-primary-foreground text-[13px] font-medium flex items-center hover:bg-primary/90 transition-colors"
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────── */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 pt-24 pb-16">
        <div className="inline-flex items-center gap-2 border border-border/50 rounded-full px-3.5 py-1 mb-8 bg-muted/30">
          <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" />
          <span className="text-[11px] font-medium text-muted-foreground tracking-wide uppercase">
            What&apos;s new in v1.4.0
          </span>
        </div>

        <h1 className="text-[48px] font-bold leading-[1.1] tracking-tight max-w-2xl mb-5">
          The smarter way to handle government email
        </h1>
        <p className="text-[17px] text-muted-foreground max-w-xl leading-relaxed mb-10">
          1Gov Mail gives your team the tools to stay on top of every conversation —
          built on Zimbra, designed for modern work.
        </p>

        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="h-11 px-6 rounded-xl bg-primary text-primary-foreground text-[14px] font-semibold flex items-center hover:bg-primary/90 transition-colors"
          >
            Get started
          </Link>
          <Link
            href="/mail"
            className="h-11 px-6 rounded-xl border border-border/60 text-[14px] font-medium flex items-center hover:bg-muted/50 transition-colors"
          >
            Open inbox
          </Link>
        </div>
      </section>

      {/* ── Features grid ─────────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto w-full px-6 pb-24">
        <h2 className="text-[13px] font-semibold text-muted-foreground/60 uppercase tracking-widest text-center mb-10">
          9 new features in this release
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="rounded-2xl border border-border/40 bg-card p-6 flex flex-col gap-3 hover:border-border/80 hover:shadow-sm transition-all"
            >
              <div className="w-9 h-9 rounded-xl bg-muted/50 flex items-center justify-center shrink-0">
                <Icon className="w-4.5 h-4.5 text-foreground/70" strokeWidth={1.75} />
              </div>
              <div>
                <p className="text-[14px] font-semibold text-foreground mb-1">{title}</p>
                <p className="text-[13px] text-muted-foreground leading-relaxed">{description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────── */}
      <footer className="border-t border-border/30 py-6 text-center">
        <p className="text-[12px] text-muted-foreground/40">
          1Gov Mail v1.4.0 &mdash; Built on Zimbra
        </p>
      </footer>
    </div>
  );
}
