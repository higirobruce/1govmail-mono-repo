'use client';

import { useEffect, useRef } from 'react';

/**
 * Ambient landing background: a self-hosted mail network. Server nodes
 * exchange sealed envelopes along encrypted links, and every packet stays
 * inside the dashed sovereign boundary. Pure canvas, ~zero layout cost,
 * static single frame under prefers-reduced-motion.
 */

interface Node { x: number; y: number; r: number; home?: boolean }
interface Packet { from: number; to: number; t: number; speed: number }
interface Pulse { x: number; y: number; t: number }

const BLUE = (a: number) => `rgba(15, 76, 129, ${a})`;   // state blue
const CYAN = (a: number) => `rgba(0, 161, 222, ${a})`;   // Rwanda blue

export function LiveBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let W = 0, H = 0;
    let nodes: Node[] = [];
    let edges: Array<[number, number]> = [];
    let packets: Packet[] = [];
    let pulses: Pulse[] = [];

    const seed = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Nodes inside the boundary inset; one central home server.
      const inset = 0.1;
      nodes = [{ x: W / 2, y: H * 0.42, r: 7, home: true }];
      const COUNT = W < 640 ? 8 : 14;
      for (let i = 0; i < COUNT; i++) {
        nodes.push({
          x: W * (inset + Math.random() * (1 - 2 * inset)),
          y: H * (inset + Math.random() * (1 - 2 * inset)),
          r: 2.5 + Math.random() * 2,
        });
      }
      // Each node links to its two nearest neighbours (dedup).
      const set = new Set<string>();
      edges = [];
      nodes.forEach((n, i) => {
        const near = nodes
          .map((m, j) => ({ j, d: (m.x - n.x) ** 2 + (m.y - n.y) ** 2 }))
          .filter((e) => e.j !== i)
          .sort((a, b) => a.d - b.d)
          .slice(0, n.home ? 4 : 2);
        near.forEach(({ j }) => {
          const key = i < j ? `${i}-${j}` : `${j}-${i}`;
          if (!set.has(key)) { set.add(key); edges.push(i < j ? [i, j] : [j, i]); }
        });
      });
      packets = Array.from({ length: Math.max(5, Math.floor(edges.length / 2)) }, () => spawn());
      pulses = [];
    };

    const spawn = (): Packet => {
      const [a, b] = edges[Math.floor(Math.random() * edges.length)];
      const flip = Math.random() > 0.5;
      return { from: flip ? b : a, to: flip ? a : b, t: 0, speed: 0.003 + Math.random() * 0.004 };
    };

    const envelope = (x: number, y: number, angle: number, alpha: number) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      const w = 11, h = 7.5;
      ctx.strokeStyle = BLUE(alpha);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.rect(-w / 2, -h / 2, w, h);
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(0, 1); ctx.lineTo(w / 2, -h / 2);
      ctx.stroke();
      ctx.restore();
    };

    const draw = (animate: boolean) => {
      ctx.clearRect(0, 0, W, H);

      // Sovereign boundary — dashed rounded rect; everything lives inside it.
      const bx = W * 0.045, by = H * 0.05, bw = W * 0.91, bh = H * 0.9, rr = 28;
      ctx.strokeStyle = BLUE(0.10);
      ctx.setLineDash([6, 7]);
      ctx.lineDashOffset = animate ? -performance.now() / 90 : 0;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, rr);
      ctx.stroke();
      ctx.setLineDash([]);

      // Links
      edges.forEach(([a, b]) => {
        ctx.strokeStyle = BLUE(0.07);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(nodes[a].x, nodes[a].y);
        ctx.lineTo(nodes[b].x, nodes[b].y);
        ctx.stroke();
      });

      // Nodes — the home server gets a shield ring
      nodes.forEach((n) => {
        ctx.fillStyle = n.home ? BLUE(0.35) : BLUE(0.22);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
        if (n.home) {
          ctx.strokeStyle = CYAN(0.35);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2);
          ctx.stroke();
        }
      });

      // Arrival pulses — a lock of delivery
      pulses = pulses.filter((p) => p.t < 1);
      pulses.forEach((p) => {
        p.t += 0.03;
        ctx.strokeStyle = CYAN(0.28 * (1 - p.t));
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 + p.t * 14, 0, Math.PI * 2);
        ctx.stroke();
      });

      // Envelopes in transit
      packets.forEach((pk, i) => {
        const a = nodes[pk.from], b = nodes[pk.to];
        if (animate) pk.t += pk.speed;
        if (pk.t >= 1) {
          pulses.push({ x: b.x, y: b.y, t: 0 });
          packets[i] = spawn();
          return;
        }
        const x = a.x + (b.x - a.x) * pk.t;
        const y = a.y + (b.y - a.y) * pk.t;
        envelope(x, y, Math.atan2(b.y - a.y, b.x - a.x) * 0.25, 0.5);
      });
    };

    const loop = () => { draw(true); raf = requestAnimationFrame(loop); };

    seed();
    if (reduced) {
      packets.forEach((p) => { p.t = Math.random(); });
      draw(false);
    } else {
      loop();
    }

    const onResize = () => { seed(); if (reduced) draw(false); };
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="fixed inset-0 -z-10 w-full h-full pointer-events-none opacity-[0.55] dark:opacity-[0.35]"
    />
  );
}
