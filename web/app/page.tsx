"use client";
import Link from "next/link";
import DaylightLedger, { type LedgerPoint } from "@/components/DaylightLedger";
import { Offline } from "@/components/Status";
import VerdictRow from "@/components/VerdictRow";
import { RiskBar } from "@/components/RiskBar";
import type { FleetDevice, Verdict } from "@/lib/api";
import { energy, power } from "@/lib/format";
import { usePoll } from "@/lib/hooks";

type Stats = {
  byStatus: Record<string, { count: number; wh: number }>;
  blockedExcessWh: number;
  totalIssuedWh: number;
  totalRetiredWh: number;
  certificates: number;
  retirements: number;
  auditBatches: number;
  devices: number;
};

export default function Home() {
  const series = usePoll<{ points: LedgerPoint[]; capacityW: number }>("/v1/fleet/series?hours=72", 15000);
  const stats = usePoll<Stats>("/v1/stats", 5000);
  const feed = usePoll<Verdict[]>("/v1/verdicts?limit=14", 3000);
  const fleet = usePoll<{ devices: FleetDevice[] }>("/v1/fleet", 10000);

  if (stats.error && !stats.data) return <Offline error={stats.error} />;
  const s = stats.data;
  const refused = s ? (s.byStatus.REJECTED?.count ?? 0) + (s.byStatus.SUSPENDED?.count ?? 0) : 0;

  return (
    <>
      <section className="pt-8 sm:pt-14">
        <h1 className="display max-w-[15ch] text-[44px] font-[750] sm:text-[72px]">Every kilowatt-hour, proven where it was made.</h1>
        <p className="mt-5 max-w-[62ch] text-[18px] text-muted">
          Rooftop meters sign each hour of solar output with their own key. An AI verifier checks the claim against satellite
          irradiance for that exact place and hour. Only then does the chain mint a certificate, and each one can be claimed
          exactly once.
        </p>
      </section>

      <section className="mt-10" aria-labelledby="ledger-h">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="ledger-h" className="wide text-[20px] font-semibold">
            The last 72 hours of daylight across the network
          </h2>
          {series.data && <p className="text-muted">{power(series.data.capacityW)} of panels in 12 cities</p>}
        </div>
        {series.data ? <DaylightLedger points={series.data.points} height={240} /> : <div className="h-[262px]" />}
      </section>

      <section className="mt-10 grid grid-cols-2 gap-x-8 gap-y-6 border-y border-rule py-6 sm:grid-cols-4">
        <Figure label="Certified on-chain" value={s ? energy(s.totalIssuedWh) : "—"} sub={s ? `${s.certificates} hourly certificates` : ""} />
        <Figure label="Claimed by buyers" value={s ? energy(s.totalRetiredWh) : "—"} sub={s ? `${s.retirements} retirements, burned for good` : ""} />
        <Figure label="Claims refused" value={s ? refused.toLocaleString() : "—"} sub={s ? `${energy(s.blockedExcessWh)} of inflation stopped` : ""} />
        <Figure label="Audit batches anchored" value={s ? s.auditBatches.toLocaleString() : "—"} sub="Every verdict, Merkle-committed" />
      </section>

      <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <section aria-labelledby="feed-h">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 id="feed-h" className="wide text-[20px] font-semibold">Verification feed</h2>
            <Link href="/lab" className="link text-[15px]">Try to cheat it</Link>
          </div>
          <ul>{feed.data?.map((v) => <VerdictRow key={v.id} v={v} />)}</ul>
        </section>

        <section aria-labelledby="fleet-h">
          <h2 id="fleet-h" className="wide mb-2 text-[20px] font-semibold">Meters</h2>
          <table className="w-full text-[15px]">
            <thead className="text-left text-[13px] text-muted">
              <tr>
                <th className="pb-2 font-normal">Site</th>
                <th className="pb-2 text-right font-normal">Certified</th>
                <th className="pb-2 pl-3 text-right font-normal">Fraud evidence</th>
              </tr>
            </thead>
            <tbody>
              {fleet.data?.devices.map((d) => (
                <tr key={d.address} className="border-t border-rule">
                  <td className="py-2.5 pr-2">
                    <Link href={`/meter?address=${d.address}`} className="font-semibold hover:underline">
                      {d.name}
                    </Link>
                    <div className="text-[13px] text-muted">
                      {power(d.capacityW)} · {d.producerName}
                    </div>
                  </td>
                  <td className="num py-2.5 text-right">{energy(d.stats.wh)}</td>
                  <td className="py-2.5 pl-3">
                    <RiskBar risk={d.risk} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <p className="text-[14px] text-muted">{label}</p>
      <p className="wide num mt-0.5 text-[28px] font-semibold leading-tight">{value}</p>
      <p className="mt-0.5 text-[13px] text-muted">{sub}</p>
    </div>
  );
}
