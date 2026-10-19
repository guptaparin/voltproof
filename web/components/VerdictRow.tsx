import Link from "next/link";
import type { Verdict } from "@/lib/api";
import { ago, energy, hourRange, pct } from "@/lib/format";
import { Status } from "./Status";

export function primaryReason(v: Verdict) {
  const rank = { critical: 0, high: 1, medium: 2, info: 3, ok: 4 } as const;
  return [...v.reasons].sort((a, b) => rank[a.severity] - rank[b.severity])[0];
}

export default function VerdictRow({ v }: { v: Verdict }) {
  const r = primaryReason(v);
  const href = v.certificate_id ? `/certificate?id=${v.certificate_id}` : `/verdict?id=${v.id}`;
  return (
    <li className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 border-t border-rule py-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <Link href={href} className="font-semibold hover:underline">
          {v.device_name ?? "Unknown meter"}
        </Link>
        <p className="num text-[14px] text-muted">
          {hourRange(v.hour_start)} · {energy(v.energy_wh)} claimed
        </p>
      </div>
      <p className="col-span-2 row-start-2 text-[14px] leading-snug text-muted sm:col-span-1 sm:row-start-auto">
        {r?.message}
      </p>
      <div className="row-start-1 text-right sm:row-start-auto">
        <Status status={v.status} />
        <p className="num text-[13px] text-muted">
          {v.score_bps > 0 && <>{pct(v.score_bps)} · </>}
          {ago(v.created_at)}
        </p>
      </div>
    </li>
  );
}
