"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { GatePipeline } from "@/components/Gates";
import { RiskBar } from "@/components/RiskBar";
import { Offline, Status } from "@/components/Status";
import { ScoreBreakdown } from "@/components/ScoreBreakdown";
import { post, type FleetDevice, type Verdict } from "@/lib/api";
import { energy, hourRange } from "@/lib/format";
import { usePoll } from "@/lib/hooks";

type Scenario = { title: string; attacker: string; description: string; defence: string };
type Result = Verdict & { scenario: Scenario };

const ORDER = ["honest", "inflated", "cloud_fake", "night", "tampered", "forged", "unregistered", "replay"];

export default function Lab() {
  const catalog = usePoll<{ attacks: Record<string, Scenario>; labDevice: string }>("/v1/demo/attacks", 0);
  const history = usePoll<Verdict[]>("/v1/verdicts?labelled=true&limit=12", 4000);
  const fleet = usePoll<{ devices: FleetDevice[] }>("/v1/fleet", 4000);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const resultRef = useRef<HTMLElement>(null);

  if (catalog.error && !catalog.data) return <Offline error={catalog.error} />;
  const lab = fleet.data?.devices.find((d) => d.address === catalog.data?.labDevice);

  async function fire(kind: string) {
    setBusy(kind);
    setErr(null);
    try {
      const r = await post<Result>("/v1/demo/attack", { type: kind });
      setResult(r);
      if (window.innerWidth < 1024) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      history.reload();
      fleet.reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function reinstate() {
    if (!lab) return;
    await post("/v1/demo/reinstate", { device: lab.address });
    fleet.reload();
  }

  return (
    <>
      <section className="pt-8 sm:pt-12">
        <h1 className="display text-[40px] font-[750] sm:text-[60px]">Attack lab</h1>
        <p className="mt-4 max-w-[64ch] text-[18px] text-muted">
          Every scenario below sends a real submission for the{" "}
          {lab ? (
            <Link href={`/meter/${lab.address}`} className="link text-ink">{lab.name}</Link>
          ) : (
            "campus"
          )}{" "}
          meter through the same pipeline real meters use. Watch which check stops it.
        </p>
      </section>

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
        <section aria-label="Scenarios">
          <ul className="divide-y divide-rule border-y border-rule">
            {ORDER.filter((k) => catalog.data?.attacks[k]).map((k) => {
              const a = catalog.data!.attacks[k];
              const honest = k === "honest";
              return (
                <li key={k}>
                  <button
                    onClick={() => fire(k)}
                    disabled={!!busy}
                    className={`group flex w-full items-start gap-3 py-3.5 text-left disabled:opacity-60 ${result?.label === k ? "bg-panel" : "hover:bg-panel"}`}
                  >
                    <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${honest ? "bg-sun" : "bg-reject"}`} aria-hidden />
                    <span className="min-w-0 flex-1 px-0.5">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="font-semibold">{a.title}</span>
                        <span className="text-[13px] text-muted">{busy === k ? "Sending…" : honest ? "Submit" : "Launch"}</span>
                      </span>
                      <span className="block text-[14px] leading-snug text-muted">{a.description}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {lab && (
            <div className="mt-6 rounded-lg bg-panel p-4 shadow-[inset_0_0_0_1px_rgb(var(--rule))]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-semibold">Fraud evidence on this meter</p>
                  <p className="text-[14px] text-muted">
                    Signed over-claims accumulate (CUSUM). Past the threshold the meter is suspended until a physical audit.
                  </p>
                </div>
                <RiskBar risk={lab.risk} />
              </div>
              {lab.risk.suspended && (
                <button onClick={reinstate} className="btn btn-ghost mt-3 text-[14px]">
                  Mark audit passed and reinstate
                </button>
              )}
            </div>
          )}
        </section>

        <section ref={resultRef} aria-live="polite" aria-label="Result" className="scroll-mt-4">
          <GatePipeline verdict={result} />
          {err && <p className="mt-4 rounded-md bg-panel p-4 text-reject shadow-[inset_0_0_0_1px_rgb(var(--rule))]">{err}</p>}
          {!result && !err && (
            <p className="mt-6 max-w-[52ch] text-muted">
              Pick a scenario. An honest reading passes all seven checks and becomes a certificate. Each attack is stopped by a
              different one.
            </p>
          )}
          {result && <ResultPanel r={result} />}
        </section>
      </div>

      <section className="mt-14" aria-labelledby="hist-h">
        <h2 id="hist-h" className="wide mb-2 text-[20px] font-semibold">Lab history</h2>
        <table className="w-full text-[15px]">
          <tbody>
            {history.data?.map((v) => (
              <tr key={v.id} className="border-t border-rule align-top">
                <td className="py-2.5 pr-3 font-semibold">{catalog.data?.attacks[v.label ?? ""]?.title ?? v.label}</td>
                <td className="num hidden py-2.5 pr-3 text-muted sm:table-cell">{hourRange(v.hour_start)}</td>
                <td className="num py-2.5 pr-3 text-right">{energy(v.energy_wh)}</td>
                <td className="py-2.5 text-right">
                  <Link href={v.certificate_id ? `/certificate/${v.certificate_id}` : `/verdict/${v.id}`}>
                    <Status status={v.status} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function ResultPanel({ r }: { r: Result }) {
  const honest = r.label === "honest";
  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Status status={r.status} className="text-[20px]" />
        <span className="text-muted">{r.scenario.title}</span>
      </div>
      {r.note && <p className="mt-1 text-[15px] text-muted">{r.note}</p>}

      <ul className="mt-4 space-y-2">
        {r.reasons.map((x, i) => (
          <li key={i} className="border-l-2 pl-3 text-[16px]" style={{ borderColor: x.severity === "ok" || x.severity === "info" ? "rgb(var(--ok))" : x.severity === "medium" ? "rgb(var(--held))" : "rgb(var(--reject))" }}>
            {x.message}
          </li>
        ))}
      </ul>

      {r.expected_wh != null && (
        <dl className="num mt-6 grid grid-cols-3 gap-4 border-y border-rule py-4">
          <Num k="Claimed" v={energy(r.energy_wh)} strong />
          <Num k="Expected from satellite data" v={energy(r.expected_wh)} />
          <Num k="Physical ceiling" v={energy(r.ceiling_wh)} />
        </dl>
      )}
      {r.components && <ScoreBreakdown v={r} className="mt-5" />}

      {!honest && <p className="mt-5 text-[15px]"><span className="font-semibold">Stopped by: </span>{r.scenario.defence}</p>}
      {r.certificate_id && (
        <Link href={`/certificate/${r.certificate_id}`} className="btn btn-sun mt-5">
          Open certificate #{r.certificate_id}
        </Link>
      )}
      {!r.certificate_id && (
        <Link href={`/verdict/${r.id}`} className="link mt-5 inline-block text-[15px]">
          Full verdict record
        </Link>
      )}
    </div>
  );
}

function Num({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-[13px] leading-tight text-muted">{k}</dt>
      <dd className={`wide mt-1 text-[22px] ${strong ? "font-semibold" : ""}`}>{v}</dd>
    </div>
  );
}
