'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { X, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';

interface TourStep {
  target?: string;          // CSS selector for the spotlight element
  title: string;
  description: string;
  side?: 'right' | 'left' | 'top' | 'bottom';
}

const STEPS: TourStep[] = [
  {
    title: 'Welcome to 1Gov Mail',
    description:
      "Your secure government email client. Let's take a 60-second tour of the key features.",
  },
  {
    target: '[data-tour="compose"]',
    side: 'right',
    title: 'Compose Emails',
    description:
      'Click Compose to write a new email. Add colleagues in CC, attach files, and format your message with rich text.',
  },
  {
    target: '[data-tour="inbox"]',
    side: 'right',
    title: 'Mail & Folders',
    description:
      'Your email is organized into folders. Unread counts are shown on the right. Click any folder to browse messages.',
  },
  {
    target: '[data-tour="tasks-nav"]',
    side: 'right',
    title: 'Task Management',
    description:
      'Create tasks from scratch or directly from an email thread. Set due dates, reminders, subtasks, and assign work to colleagues.',
  },
  {
    target: '[data-tour="calendar-nav"]',
    side: 'right',
    title: 'Calendar & Availability',
    description:
      "Schedule events and overlay colleagues' free/busy times on a shared timeline. Find a slot that works for everyone with one click.",
  },
  {
    target: '[data-tour="contacts-nav"]',
    side: 'right',
    title: 'Contacts Directory',
    description:
      'Browse and search your organisation directory. Contact details are auto-suggested when composing emails or assigning tasks.',
  },
  {
    title: "You're all set!",
    description:
      'Explore at your own pace. You can restart this tour any time using the button at the bottom of the sidebar.',
  },
];

interface Rect { top: number; left: number; width: number; height: number; }

function getTargetRect(selector: string): Rect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

const PAD = 8;   // spotlight padding around target
const TIP_W = 280; // tooltip width in px
const TIP_GAP = 16; // gap between spotlight and tooltip

function tooltipStyle(rect: Rect | null, side: TourStep['side']): React.CSSProperties {
  if (!rect) {
    // Centered
    return {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: TIP_W,
    };
  }

  const padded = {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };

  switch (side) {
    case 'right':
      return {
        position: 'fixed',
        top: Math.max(12, padded.top + padded.height / 2 - 80),
        left: padded.left + padded.width + TIP_GAP,
        width: TIP_W,
      };
    case 'left':
      return {
        position: 'fixed',
        top: Math.max(12, padded.top + padded.height / 2 - 80),
        left: padded.left - TIP_W - TIP_GAP,
        width: TIP_W,
      };
    case 'top':
      return {
        position: 'fixed',
        top: padded.top - TIP_GAP - 160,
        left: Math.max(12, padded.left + padded.width / 2 - TIP_W / 2),
        width: TIP_W,
      };
    case 'bottom':
    default:
      return {
        position: 'fixed',
        top: padded.top + padded.height + TIP_GAP,
        left: Math.max(12, padded.left + padded.width / 2 - TIP_W / 2),
        width: TIP_W,
      };
  }
}

export function AppTour({
  active,
  onClose,
}: {
  active: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);

  const current = STEPS[step];

  const measureTarget = useCallback(() => {
    if (!current.target) { setTargetRect(null); return; }
    setTargetRect(getTargetRect(current.target));
  }, [current.target]);

  useEffect(() => {
    if (!active) return;
    setStep(0);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    measureTarget();
    window.addEventListener('resize', measureTarget);
    return () => window.removeEventListener('resize', measureTarget);
  }, [active, measureTarget]);

  if (!active) return null;

  const isFirst = step === 0;
  const isLast  = step === STEPS.length - 1;

  const next = () => {
    if (isLast) { onClose(); return; }
    setStep((s) => s + 1);
  };
  const prev = () => setStep((s) => Math.max(0, s - 1));

  // Spotlight box (padded around target)
  const spotlight = targetRect
    ? {
        top:    targetRect.top    - PAD,
        left:   targetRect.left   - PAD,
        width:  targetRect.width  + PAD * 2,
        height: targetRect.height + PAD * 2,
      }
    : null;

  return (
    <>
      {/* Dark overlay */}
      <div
        className="fixed inset-0 z-[9998] pointer-events-none"
        style={{ background: 'rgba(0,0,0,0.55)' }}
      />

      {/* Spotlight "hole" using box-shadow spread */}
      {spotlight && (
        <div
          className="fixed z-[9999] pointer-events-none rounded-xl"
          style={{
            top:    spotlight.top,
            left:   spotlight.left,
            width:  spotlight.width,
            height: spotlight.height,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
            borderRadius: 10,
          }}
        />
      )}

      {/* Tooltip card */}
      <div
        className="fixed z-[10000] bg-card border border-border shadow-2xl rounded-2xl p-5 flex flex-col gap-3"
        style={tooltipStyle(targetRect, current.side)}
      >
        {/* Step counter + close */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground/50 font-medium uppercase tracking-wider">
            {step + 1} / {STEPS.length}
          </span>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-lg text-muted-foreground/40 hover:bg-muted/60 hover:text-foreground transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Title */}
        <div className="flex items-start gap-2.5">
          {(isFirst || isLast) && (
            <Sparkles className="w-4 h-4 text-primary shrink-0 mt-0.5" />
          )}
          <h3 className="text-sm font-semibold text-foreground leading-snug">
            {current.title}
          </h3>
        </div>

        {/* Description */}
        <p className="text-xs text-muted-foreground/70 leading-relaxed">
          {current.description}
        </p>

        {/* Navigation */}
        <div className="flex items-center justify-between pt-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={prev}
            disabled={isFirst}
            className="h-7 text-xs px-2 text-muted-foreground/50 hover:text-foreground"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            Back
          </Button>

          {/* Dot indicators */}
          <div className="flex gap-1">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  i === step ? 'bg-primary' : 'bg-muted-foreground/20'
                }`}
              />
            ))}
          </div>

          <Button
            size="sm"
            onClick={next}
            className="h-7 text-xs px-3 bg-primary hover:bg-primary/90 text-primary-foreground gap-1"
          >
            {isLast ? 'Done' : 'Next'}
            {!isLast && <ChevronRight className="w-3.5 h-3.5" />}
          </Button>
        </div>
      </div>
    </>
  );
}
