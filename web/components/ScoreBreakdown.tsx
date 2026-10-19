import type { Verdict } from "@/lib/api";
import { pct } from "@/lib/format";

const PARTS = [
  { k: "physics", label: "Physics agreement", w: 0.5, hint: "Claim vs output expected from satellite irradiance, cloud-aware tolerance" },
  { k: "anomaly", label: "Anomaly model", w: 0.25, hint: "Isolation forest trained on honest meter behaviour" },
  { k: "consistency", label: "Meter track record", w: 0.25, hint: "Claim vs this meter's own verified history" },
] as const;

export function ScoreBreakdown({ v, className = "" }: { v: Verdict; className?: string }) {
  if (!v.components) return null;
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between">
        <p className="font-semibold">Plausibility score</p>
        <p className="wide num text-[22px] font-semibold">{pct(v.score_bps)}</p>
      </div>
      <div className="relative mt-2 h-2.5 rounded-full bg-rule">
        <div
          className={`h-2.5 rounded-full ${v.score_bps >= 7000 ? "bg-sun" : v.score_bps >= 5000 ? "bg-held" : "bg-reject"}`}
          style={{ width: `${v.score_bps / 100}%` }}
        />
        <div className="absolute top-[-4px] h-[18px] w-0.5 bg-ink" style={{ left: "70%" }} title="Issuance threshold 70%" />
      </div>
      <p className="mt-1 text-right text-[12px] text-muted">certificates issue at 70% and above</p>
      <dl className="mt-3 space-y-2.5">
        {PARTS.map((p) => {
          const val = v.components![p.k];
          return (
            <div key={p.k} className="grid grid-cols-[1fr_auto] items-center gap-x-3">
              <dt className="text-[14px]">
                {p.label} <span className="text-muted">· weight {p.w * 100}%</span>
              </dt>
              <dd className="num text-right text-[14px]">{Math.round(val * 100)}%</dd>
              <div className="col-span-2 h-1.5 rounded-full bg-rule">
                <div className="h-1.5 rounded-full bg-ink" style={{ width: `${val * 100}%` }} />
              </div>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
