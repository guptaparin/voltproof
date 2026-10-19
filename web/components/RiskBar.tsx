import type { FleetDevice } from "@/lib/api";

export function RiskBar({ risk }: { risk: FleetDevice["risk"] }) {
  const f = Math.min(1, risk.cusum / risk.threshold);
  return (
    <div className="ml-auto w-[110px]">
      <div className="h-1.5 w-full rounded-full bg-rule" role="meter" aria-valuemin={0} aria-valuemax={risk.threshold} aria-valuenow={risk.cusum}>
        <div className={`h-1.5 rounded-full ${risk.suspended ? "bg-reject" : f > 0.5 ? "bg-held" : "bg-ok"}`} style={{ width: `${Math.max(4, f * 100)}%` }} />
      </div>
      <p className={`mt-1 text-right text-[12px] ${risk.suspended ? "font-semibold text-reject" : "text-muted"}`}>
        {risk.suspended ? "Suspended" : f < 0.1 ? "None" : f < 0.5 ? "Low" : "Rising"}
      </p>
    </div>
  );
}
