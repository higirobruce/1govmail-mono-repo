'use client';

import { useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';

interface InboxZeroProps {
  /** When true, fires a one-shot confetti burst on mount / on flip to true */
  celebrate?: boolean;
  /** Called after the confetti burst completes so the parent can clear its state */
  onCelebrated?: () => void;
}

// Confetti palette matches the app's accent colours (primary + semantic tones).
const CONFETTI_COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#ffffff'];

function runConfetti(canvas: HTMLCanvasElement, onDone: () => void) {
  const ctx = canvas.getContext('2d');
  if (!ctx) { onDone(); return; }

  // HiDPI-safe sizing: read parent box via getBoundingClientRect, scale by DPR.
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const cx = rect.width / 2;
  const cy = rect.height / 2 - 10;

  type Particle = {
    x: number; y: number;
    vx: number; vy: number;
    color: string;
    size: number;
    rotation: number; vr: number;
  };

  const particles: Particle[] = [];
  const count = 48;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.35;
    const speed = 3 + Math.random() * 3.5;
    particles.push({
      x: cx, y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2.2,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      size: 4 + Math.random() * 4,
      rotation: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.3,
    });
  }

  const maxFrames = 90;       // ~1.5 s at 60 fps
  const gravity = 0.16;
  const drag = 0.985;
  let frame = 0;
  let rafId = 0;

  const tick = () => {
    ctx.clearRect(0, 0, rect.width, rect.height);
    const life = 1 - frame / maxFrames;
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= drag;
      p.vy = p.vy * drag + gravity;
      p.rotation += p.vr;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.globalAlpha = Math.max(0, life);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }

    frame++;
    if (frame < maxFrames) {
      rafId = requestAnimationFrame(tick);
    } else {
      ctx.clearRect(0, 0, rect.width, rect.height);
      onDone();
    }
  };

  rafId = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(rafId);
}

export function InboxZero({ celebrate = false, onCelebrated }: InboxZeroProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Latest-callback ref so the effect below doesn't re-run when the parent passes
  // a fresh inline onCelebrated each render.
  const onCelebratedRef = useRef(onCelebrated);
  onCelebratedRef.current = onCelebrated;

  useEffect(() => {
    if (!celebrate) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cancel = runConfetti(canvas, () => onCelebratedRef.current?.());
    return cancel;
  }, [celebrate]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="relative flex flex-col items-center justify-center py-16 px-8 text-center"
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="absolute inset-0 w-full h-full pointer-events-none"
      />
      <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mb-4 relative z-10">
        <Sparkles className="w-6 h-6 text-primary" />
      </div>
      <h2 className="text-base font-semibold text-foreground mb-1 relative z-10">Inbox Zero</h2>
      <p className="text-sm text-muted-foreground/70 max-w-xs relative z-10">
        You&rsquo;re all caught up. Nice work.
      </p>
    </div>
  );
}
