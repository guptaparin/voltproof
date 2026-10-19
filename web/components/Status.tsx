import type { Verdict } from "@/lib/api";

const STYLE: Record<string, { label: string; cls: string; dot: string }> = {
  ACCEPTED: { label: "Certified", cls: "text-ok", dot: "bg-sun" },
  HELD: { label: "Held for review", cls: "text-held", dot: "bg-held" },
  REJECTED: { label: "Rejected", cls: "text-reject", dot: "bg-reject" },
  SUSPENDED: { label: "Meter suspended", cls: "text-reject", dot: "bg-reject" },
  FAILED_ONCHAIN: { label: "Contract refused", cls: "text-reject", dot: "bg-reject" },
};

export function Status({ status, className = "" }: { status: Verdict["status"]; className?: string }) {
  const s = STYLE[status] ?? STYLE.REJECTED;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap font-semibold ${s.cls} ${className}`}>
      <span className={`h-2 w-2 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

export function Offline({ error }: { error: string }) {
  return (
    <div className="my-10 rounded-lg bg-panel p-6 shadow-[inset_0_0_0_1px_rgb(var(--rule))]">
      <p className="font-semibold">The verifier isn't reachable.</p>
      <p className="mt-1 text-muted">
        Start it with <code className="rounded bg-paper px-1.5 py-0.5">./demo.sh</code> or{" "}
        <code className="rounded bg-paper px-1.5 py-0.5">uvicorn verifier.app:app --port 8000</code>, then refresh. ({error})
      </p>
    </div>
  );
}
