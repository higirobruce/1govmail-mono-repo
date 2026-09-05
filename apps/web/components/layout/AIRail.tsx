'use client';

import { useRouter } from 'next/navigation';
import {
  Newspaper, ClipboardCheck, MessageCircleQuestion, Settings, Sun, Moon, Monitor,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useThemeStore, type Theme } from '@/stores/theme.store';

interface RailButtonProps {
  label: string;
  onClick: () => void;
  active?: boolean;
  badge?: number;
  children: React.ReactNode;
}

function RailButton({ label, onClick, active, badge, children }: RailButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            'relative text-ink-3 hover:bg-muted hover:text-foreground',
            active && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
          )}
        >
          {children}
          {typeof badge === 'number' && badge > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-micro leading-none font-semibold tabular-nums">
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left" className="text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

interface Props {
  aiEnabled: boolean;
  briefingOpen: boolean;
  commitmentsOpen: boolean;
  /** True when the Ask panel is open AND expanded (not minimized). */
  askOpen: boolean;
  commitmentsCount?: number;
  onBriefing: () => void;
  onCommitments: () => void;
  onAsk: () => void;
}

/** The intelligence rail — right-hand counterpart to the folder rail.
 *  AI panel triggers at the top (their panels dock right beside it at xl),
 *  utilities (theme, settings) at the bottom. Hidden below md, where the
 *  Ask FAB and the mobile chip row take over. */
export function AIRail({
  aiEnabled, briefingOpen, commitmentsOpen, askOpen, commitmentsCount,
  onBriefing, onCommitments, onAsk,
}: Props) {
  const router = useRouter();
  const { theme, setTheme } = useThemeStore();
  const THEME_CYCLE: Theme[] = ['light', 'dark', 'system'];
  const nextTheme = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

  return (
    <nav
      aria-label="Intelligence and utilities"
      className="hidden md:flex shrink-0 w-12 flex-col items-center gap-1 border-l border-sidebar-border bg-sidebar py-3"
    >
      {aiEnabled && (
        <>
          <RailButton label="Brief me" active={briefingOpen} onClick={onBriefing}>
            <Newspaper className="size-4" />
          </RailButton>
          <RailButton label="Commitments" active={commitmentsOpen} onClick={onCommitments} badge={commitmentsCount}>
            <ClipboardCheck className="size-4" />
          </RailButton>
          <RailButton label="Ask your inbox" active={askOpen} onClick={onAsk}>
            <MessageCircleQuestion className="size-4" />
          </RailButton>
        </>
      )}
      <div className="flex-1" />
      <RailButton label={`Theme: ${theme} (click for ${nextTheme})`} onClick={() => setTheme(nextTheme)}>
        <ThemeIcon className="size-4" />
      </RailButton>
      <RailButton label="Settings" onClick={() => router.push('/settings')}>
        <Settings className="size-4" />
      </RailButton>
    </nav>
  );
}
