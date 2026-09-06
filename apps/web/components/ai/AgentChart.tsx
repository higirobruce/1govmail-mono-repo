'use client';

import type { AgentChartSpec } from '@/lib/ai/agent';

const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f'];
const W = 320;
const H = 180;
const PAD = { top: 8, right: 8, bottom: 24, left: 32 };

/**
 * Tiny dependency-free SVG renderer for agent-emitted chart specs (bar / line
 * / pie). Deliberately minimal — no axis ticks beyond the max label, no
 * animation, no legend interaction — this is a glanceable inline chart in a
 * chat transcript, not a dashboard widget.
 */
export default function AgentChart({ spec }: { spec: AgentChartSpec }) {
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const max = Math.max(1, ...spec.series.flatMap((s) => s.data));
  const n = spec.labels.length;

  return (
    <figure className="my-2 rounded-md border border-border/40 bg-card p-2 max-w-full overflow-x-auto">
      <figcaption className="text-[0.6875rem] font-medium text-foreground mb-1">{spec.title}</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxWidth: W }}
        role="img"
        aria-label={spec.title}
        className="text-foreground"
      >
        {spec.type === 'pie' ? (
          <PieSlices data={spec.series[0].data.slice(0, n)} cx={W / 2} cy={H / 2} r={Math.min(W, H) / 2 - 12} />
        ) : (
          <>
            <line x1={PAD.left} y1={PAD.top + ih} x2={PAD.left + iw} y2={PAD.top + ih} stroke="currentColor" opacity={0.3} />
            {spec.series.map((s, si) =>
              spec.type === 'bar' ? (
                <g key={s.name}>
                  {s.data.slice(0, n).map((v, i) => {
                    const bw = iw / n / spec.series.length - 2;
                    const x = PAD.left + (iw / n) * i + bw * si + 2;
                    const h = (v / max) * ih;
                    return <rect key={i} x={x} y={PAD.top + ih - h} width={bw} height={h} fill={PALETTE[si % 3]} />;
                  })}
                </g>
              ) : (
                <polyline
                  key={s.name}
                  fill="none"
                  stroke={PALETTE[si % 3]}
                  strokeWidth={2}
                  points={s.data
                    .slice(0, n)
                    .map((v, i) => `${PAD.left + (iw / Math.max(1, n - 1)) * i},${PAD.top + ih - (v / max) * ih}`)
                    .join(' ')}
                />
              ),
            )}
            {spec.labels.map((l, i) => (
              <text key={i} x={PAD.left + (iw / n) * i + iw / n / 2} y={H - 8} fontSize={8} textAnchor="middle" fill="currentColor" opacity={0.7}>
                {l.slice(0, 8)}
              </text>
            ))}
            <text x={PAD.left - 4} y={PAD.top + 8} fontSize={8} textAnchor="end" fill="currentColor" opacity={0.7}>{max}</text>
          </>
        )}
      </svg>
      {spec.series.length > 1 && (
        <div className="flex gap-3 text-[0.625rem] text-muted-foreground/70 mt-1">
          {spec.series.map((s, i) => (
            <span key={s.name} className="inline-flex items-center gap-1">
              <span style={{ background: PALETTE[i % 3], width: 8, height: 8, display: 'inline-block', borderRadius: 2 }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </figure>
  );
}

function PieSlices({ data, cx, cy, r }: { data: number[]; cx: number; cy: number; r: number }) {
  const total = data.reduce((a, b) => a + b, 0) || 1;
  // Cumulative start angle per slice, computed without mutating a shared
  // loop variable across iterations.
  const starts = data.reduce<number[]>((acc, v, i) => {
    const prev = i === 0 ? -Math.PI / 2 : acc[i - 1];
    acc.push(i === 0 ? prev : prev + (data[i - 1] / total) * Math.PI * 2);
    return acc;
  }, []);
  return (
    <>
      {data.map((v, i) => {
        const angle = starts[i];
        const slice = (v / total) * Math.PI * 2;
        const x1 = cx + r * Math.cos(angle);
        const y1 = cy + r * Math.sin(angle);
        const endAngle = angle + slice;
        const x2 = cx + r * Math.cos(endAngle);
        const y2 = cy + r * Math.sin(endAngle);
        const large = slice > Math.PI ? 1 : 0;
        return <path key={i} d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`} fill={PALETTE[i % 3]} opacity={0.9} />;
      })}
    </>
  );
}
