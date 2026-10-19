"use client";
import { useMemo, useState } from "react";
import { energy, hourRange } from "@/lib/format";

export type LedgerPoint = {
  hour: number;
  ceilingWh: number;
  certifiedWh: number;
  blockedWh?: number;
  heldWh?: number;
  expectedWh?: number;
  status?: string;
};

/**
 * Each column is one hour. The dashed outline is the physical ceiling (clear sky, perfect
 * panel) — nothing honest can ever rise above it. Sun-filled is energy certified on-chain;
 * crimson is what the verifier refused to certify.
 */
export default function DaylightLedger({
  points,
  height = 220,
  animate = true,
  onSelect,
}: {
  points: LedgerPoint[];
  height?: number;
  animate?: boolean;
  onSelect?: (p: LedgerPoint) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = useMemo(
    () => Math.max(1, ...points.map((p) => Math.max(p.ceilingWh, p.certifiedWh + (p.blockedWh ?? 0) + (p.heldWh ?? 0)))),
    [points]
  );
  const n = points.length;
  const W = 1000;
  const colW = W / Math.max(n, 1);
  const H = height;
  const y = (v: number) => H - (v / max) * (H - 8);

  // night bands
  const nights: [number, number][] = [];
  let start: number | null = null;
  points.forEach((p, i) => {
    if (p.ceilingWh <= 0 && start === null) start = i;
    if (p.ceilingWh > 0 && start !== null) {
      nights.push([start, i]);
      start = null;
    }
  });
  if (start !== null) nights.push([start, n]);

  const days = points
    .map((p, i) => ({ i, d: new Date(p.hour * 1000) }))
    .filter(({ d }) => d.getHours() === 0);

  const hp = hover != null ? points[hover] : null;

  return (
    <figure className="relative">
      <svg
        viewBox={`0 0 ${W} ${H + 22}`}
        className="h-auto w-full"
        role="img"
        aria-label="Hourly certified solar energy against the physical clear-sky ceiling"
        onMouseLeave={() => setHover(null)}
      >
        {nights.map(([a, b]) => (
          <rect key={a} x={a * colW} y={0} width={(b - a) * colW} height={H} fill="rgb(var(--ink))" opacity={0.045} />
        ))}
        {points.map((p, i) => {
          const x = i * colW;
          const cert = p.certifiedWh;
          const held = p.heldWh ?? 0;
          const blocked = p.blockedWh ?? 0;
          const gap = Math.min(1.5, colW * 0.12);
          return (
            <g
              key={p.hour}
              onMouseEnter={() => setHover(i)}
              onClick={() => onSelect?.(p)}
              style={{ cursor: onSelect ? "pointer" : "default" }}
            >
              <rect x={x} y={0} width={colW} height={H} fill="transparent" />
              {p.ceilingWh > 0 && (
                <rect
                  x={x + gap}
                  y={y(p.ceilingWh)}
                  width={colW - 2 * gap}
                  height={H - y(p.ceilingWh)}
                  fill="none"
                  stroke="rgb(var(--ceiling))"
                  strokeWidth={1}
                  strokeDasharray="3 2.5"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <g className={animate ? "rise" : undefined} style={animate ? { animationDelay: `${i * 9}ms` } : undefined}>
                {cert > 0 && <rect x={x + gap} y={y(cert)} width={colW - 2 * gap} height={H - y(cert)} fill="rgb(var(--sun))" />}
                {held > 0 && (
                  <rect x={x + gap} y={y(cert + held)} width={colW - 2 * gap} height={y(cert) - y(cert + held)} fill="rgb(var(--held))" />
                )}
                {blocked > 0 && (
                  <rect
                    x={x + gap}
                    y={y(cert + held + blocked)}
                    width={colW - 2 * gap}
                    height={y(cert + held) - y(cert + held + blocked)}
                    fill="rgb(var(--reject))"
                  />
                )}
              </g>
              {p.expectedWh != null && p.expectedWh > 0 && (
                <line
                  x1={x + gap}
                  x2={x + colW - gap}
                  y1={y(p.expectedWh)}
                  y2={y(p.expectedWh)}
                  stroke="rgb(var(--ink))"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {hover === i && <rect x={x} y={0} width={colW} height={H} fill="rgb(var(--ink))" opacity={0.07} />}
            </g>
          );
        })}
        <line x1={0} x2={W} y1={H} y2={H} stroke="rgb(var(--ink))" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {days.map(({ i, d }) => (
          <text key={i} x={i * colW + 3} y={H + 16} fontSize={12} fill="rgb(var(--muted))">
            {d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
          </text>
        ))}
      </svg>
      <div className="mt-2 min-h-[44px] text-[14px]">
        {hp ? (
          <p className="num">
            <span className="font-semibold">{hourRange(hp.hour)}</span>
            <span className="text-muted"> · ceiling {energy(hp.ceilingWh)}</span>
            {hp.expectedWh != null && <span className="text-muted"> · expected {energy(hp.expectedWh)}</span>}
            <span className="text-sunink"> · certified {energy(hp.certifiedWh)}</span>
            {!!hp.heldWh && <span className="text-held"> · held {energy(hp.heldWh)}</span>}
            {!!hp.blockedWh && <span className="text-reject"> · refused {energy(hp.blockedWh)}</span>}
          </p>
        ) : (
          <Legend expected={points.some((p) => p.expectedWh != null)} />
        )}
      </div>
    </figure>
  );
}

function Legend({ expected }: { expected: boolean }) {
  const item = "inline-flex items-center gap-2";
  return (
    <p className="flex flex-wrap gap-x-5 gap-y-1 text-muted">
      <span className={item}>
        <span className="h-3 w-3 bg-sun" /> Certified on-chain
      </span>
      <span className={item}>
        <span className="h-3 w-3 bg-held" /> Held
      </span>
      <span className={item}>
        <span className="h-3 w-3 bg-reject" /> Refused
      </span>
      <span className={item}>
        <span className="h-3 w-3 border border-dashed border-ceiling" /> Physical clear-sky ceiling
      </span>
      {expected && (
        <span className={item}>
          <span className="h-0.5 w-3 bg-ink" /> Expected from satellite irradiance
        </span>
      )}
    </p>
  );
}
