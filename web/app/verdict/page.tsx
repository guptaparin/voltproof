"use client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { GatePipeline } from "@/components/Gates";
import { ScoreBreakdown } from "@/components/ScoreBreakdown";
import { Offline, Status } from "@/components/Status";
import type { Verdict } from "@/lib/api";
import { energy, hourRange, short } from "@/lib/format";
import { usePoll } from "@/lib/hooks";

function VerdictPageInner() {
  const params = { id: useSearchParams().get("id") ?? "" };
  const { data: v, error } = usePoll<Verdict & { merkle: any }>(`/v1/verdicts/${params.id}`, 0);
  if (error) return <Offline error={error} />;
  if (!v) return <p className="pt-16 text-muted">Loading…</p>;
  return (
    <>
      <section className="pt-8 sm:pt-12">
        <p className="text-muted">Verdict #{v.id}</p>
        <h1 className="display mt-2 text-[36px] font-[750] sm:text-[52px]">
          {energy(v.energy_wh)} claimed by {v.device_name ?? short(v.device)}
        </h1>
        <p className="mt-3 text-[18px]">
          <Status status={v.status} className="mr-2" />
          <span className="text-muted">{hourRange(v.hour_start)}</span>
        </p>
      </section>

      <div className="mt-8">
        <GatePipeline verdict={v} />
      </div>

      <div className="mt-10 grid gap-12 lg:grid-cols-2">
        <section>
          <h2 className="wide mb-3 text-[20px] font-semibold">Why</h2>
          <ul className="space-y-3">
            {v.reasons.map((r, i) => (
              <li key={i} className="border-l-2 pl-3" style={{ borderColor: r.severity === "ok" || r.severity === "info" ? "rgb(var(--ok))" : r.severity === "medium" ? "rgb(var(--held))" : "rgb(var(--reject))" }}>
                {r.message}
              </li>
            ))}
          </ul>
          {v.certificate_id && (
            <Link href={`/certificate?id=${v.certificate_id}`} className="btn btn-sun mt-6">Open certificate #{v.certificate_id}</Link>
          )}
          <dl className="mt-8 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[15px]">
            <dt className="text-muted">Meter</dt>
            <dd><Link className="link" href={`/meter?address=${v.device}`}>{v.device}</Link></dd>
            <dt className="text-muted">Nonce</dt>
            <dd className="num">{v.nonce}</dd>
            <dt className="text-muted">Reading hash</dt>
            <dd className="break-all font-mono text-[12px]">{v.reading_hash}</dd>
            {v.expected_wh != null && (
              <>
                <dt className="text-muted">Expected</dt>
                <dd className="num">{energy(v.expected_wh)} (ratio {v.ratio?.toFixed(2)})</dd>
                <dt className="text-muted">Physical ceiling</dt>
                <dd className="num">{energy(v.ceiling_wh)}</dd>
                <dt className="text-muted">Irradiance</dt>
                <dd className="num">{v.ghi?.toFixed(0)} W/m², {v.cloud_cover?.toFixed(0)}% cloud, {v.temp_c?.toFixed(1)} °C · {v.weather_source}</dd>
              </>
            )}
            <dt className="text-muted">Audit log</dt>
            <dd>
              {v.merkle ? (
                <>Included in batch #{v.merkle.onchainBatchId}, root <span className="font-mono text-[12px]">{short(v.merkle.root, 12)}</span> · proof {v.merkle.valid ? "valid" : "invalid"}</>
              ) : (
                "Waiting for the next anchored batch"
              )}
            </dd>
          </dl>
        </section>
        {v.components && (
          <section>
            <ScoreBreakdown v={v} />
          </section>
        )}
      </div>
    </>
  );
}

export default function VerdictPage() {
  return (
    <Suspense fallback={<p className="pt-16 text-muted">Loading…</p>}>
      <VerdictPageInner />
    </Suspense>
  );
}
