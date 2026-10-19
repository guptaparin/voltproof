"use client";
import { useRouter } from "next/navigation";
import DaylightLedger, { type LedgerPoint } from "@/components/DaylightLedger";
import { RiskBar } from "@/components/RiskBar";
import { Offline } from "@/components/Status";
import VerdictRow from "@/components/VerdictRow";
import type { FleetDevice, Verdict } from "@/lib/api";
import { energy, power, short } from "@/lib/format";
import { usePoll } from "@/lib/hooks";

type SeriesPoint = {
  hour: number;
  ceilingWh: number;
  energyWh?: number;
  expectedWh?: number;
  status?: string;
  certificateId?: number;
  verdictId?: number;
};

export default function MeterPage({ params }: { params: { address: string } }) {
  const router = useRouter();
  const series = usePoll<{ points: SeriesPoint[]; risk: { cusum: number; threshold: number; suspended: boolean } }>(
    `/v1/devices/${params.address}/series?hours=96`,
    15000
  );
  const fleet = usePoll<{ devices: FleetDevice[] }>("/v1/fleet", 15000);
  const feed = usePoll<Verdict[]>(`/v1/verdicts?device=${params.address}&limit=20`, 6000);
  if (series.error && !series.data) return <Offline error={series.error} />;
  const d = fleet.data?.devices.find((x) => x.address.toLowerCase() === params.address.toLowerCase());

  const pts: LedgerPoint[] =
    series.data?.points.map((p) => ({
      hour: p.hour,
      ceilingWh: p.ceilingWh,
      expectedWh: p.expectedWh,
      certifiedWh: p.status === "ACCEPTED" ? p.energyWh ?? 0 : 0,
      heldWh: p.status === "HELD" ? p.energyWh ?? 0 : 0,
      blockedWh: p.status && !["ACCEPTED", "HELD"].includes(p.status) ? p.energyWh ?? 0 : 0,
      status: p.status,
      ...(p.certificateId ? { cert: p.certificateId } : {}),
      ...(p.verdictId ? { vid: p.verdictId } : {}),
    })) ?? [];

  return (
    <>
      <section className="pt-8 sm:pt-12">
        <p className="text-muted">{d ? `${d.city} · ${d.producerName}` : short(params.address)}</p>
        <h1 className="display mt-2 text-[38px] font-[750] sm:text-[56px]">{d?.name ?? "Meter"}</h1>
        {d && (
          <dl className="num mt-6 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
            <Fig k="Nameplate" v={power(d.capacityW)} />
            <Fig k="Certified" v={energy(d.stats.wh)} />
            <Fig k="Hours verified" v={`${d.stats.acc} of ${d.stats.n}`} />
            <div>
              <dt className="text-[14px] text-muted">Fraud evidence</dt>
              <dd className="mt-1.5"><RiskBar risk={d.risk} /></dd>
            </div>
          </dl>
        )}
        {d?.risk.suspended && (
          <p className="mt-6 max-w-[70ch] rounded-md bg-panel p-4 text-[15px] shadow-[inset_0_0_0_1px_rgb(var(--reject))]">
            <span className="font-semibold text-reject">Suspended pending physical audit. </span>
            This meter kept claiming more than the sky allowed, hour after hour. The accumulated evidence crossed the fraud
            threshold, so attestations are paused until an inspector reinstates it.
          </p>
        )}
      </section>

      <section className="mt-10">
        <h2 className="wide mb-3 text-[20px] font-semibold">Claimed output vs. what the sky allowed</h2>
        {pts.length > 0 && (
          <DaylightLedger
            points={pts}
            height={230}
            onSelect={(p: any) => p.cert ? router.push(`/certificate/${p.cert}`) : p.vid && router.push(`/verdict/${p.vid}`)}
          />
        )}
      </section>

      <section className="mt-10">
        <h2 className="wide mb-2 text-[20px] font-semibold">Verdicts</h2>
        <ul>{feed.data?.map((v) => <VerdictRow key={v.id} v={v} />)}</ul>
      </section>
    </>
  );
}

function Fig({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[14px] text-muted">{k}</dt>
      <dd className="wide mt-0.5 text-[24px] font-semibold">{v}</dd>
    </div>
  );
}
