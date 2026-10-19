"use client";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { ScoreBreakdown } from "@/components/ScoreBreakdown";
import { Offline } from "@/components/Status";
import { api, type Verdict } from "@/lib/api";
import { ABI, explorerTx, publicClient } from "@/lib/chain";
import { energy, hourRange, short } from "@/lib/format";
import { useHealth } from "@/lib/hooks";
import { verifyCertificate, type Check } from "@/lib/verify";

type Retirement = { retirementId?: bigint; amountWh: bigint; onBehalfOf: string; beneficiary: string; purpose: string; timestamp: bigint; retiredBy: string };

function CertificatePageInner() {
  const params = { id: useSearchParams().get("id") ?? "" };
  const id = BigInt(params.id || "0");
  const { health: h, error } = useHealth();
  const [cert, setCert] = useState<any>(null);
  const [retired, setRetired] = useState<bigint>(0n);
  const [rets, setRets] = useState<Retirement[]>([]);
  const [ev, setEv] = useState<{ verdict: Verdict; merkle: any; reading: any } | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [running, setRunning] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!h) return;
    const c = publicClient(h);
    const addr = h.contracts.GranularCertificate;
    (async () => {
      const cc = (await c.readContract({ address: addr, abi: ABI.GranularCertificate, functionName: "getCertificate", args: [id] })) as any;
      if (cc.device === "0x0000000000000000000000000000000000000000") {
        setMissing(true);
        return;
      }
      setCert(cc);
      setRetired((await c.readContract({ address: addr, abi: ABI.GranularCertificate, functionName: "retiredWhOf", args: [id] })) as bigint);
      const logs = await c.getLogs({
        address: addr,
        event: parseAbiItem(
          "event CertificateRetired(uint256 indexed retirementId, uint256 indexed certificateId, address indexed onBehalfOf, address retiredBy, uint256 amountWh, string beneficiary, string purpose)"
        ),
        args: { certificateId: id },
        fromBlock: BigInt(h.startBlock || 0),
      });
      const rs = await Promise.all(
        logs.map(async (l: any) => {
          const b = await c.getBlock({ blockNumber: l.blockNumber! });
          return { ...(l.args as any), timestamp: b.timestamp } as Retirement;
        })
      );
      setRets(rs);
    })();
    api<{ verdict: Verdict; merkle: any; reading: any }>(`/v1/certificates/${params.id}/evidence`).then(setEv).catch(() => {});
  }, [h, params.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runChecks() {
    if (!h || !cert || !ev) return;
    setRunning(true);
    setChecks(null);
    try {
      setChecks(await verifyCertificate(h, publicClient(h), id, cert, ev));
    } finally {
      setRunning(false);
    }
  }

  if (error) return <Offline error={error} />;
  if (missing) return <p className="pt-16 text-[18px]">Certificate #{params.id} doesn't exist on this chain.</p>;
  if (!cert || !h) return <p className="pt-16 text-muted">Reading the chain…</p>;

  const v = ev?.verdict;
  const issued = Number(cert.energyWh);
  const ret = Number(retired);
  const tx = v?.tx_hash;
  const ex = tx ? explorerTx(h, tx) : null;

  return (
    <>
      <section className="pt-8 sm:pt-12">
        <p className="text-muted">Hourly energy attribute certificate #{params.id}</p>
        <h1 className="display mt-2 text-[40px] font-[750] sm:text-[60px]">{energy(issued)} of solar</h1>
        <p className="wide mt-3 text-[20px]">
          <Link href={`/meter?address=${cert.device}`} className="link">{v?.device_name ?? short(cert.device)}</Link>
          <span className="text-muted">, {hourRange(Number(cert.hourStart))}</span>
        </p>
        <div className="mt-6 max-w-[560px]">
          <div className="flex h-3 overflow-hidden rounded-full bg-sun" aria-hidden>
            <div className="h-3 bg-ink" style={{ width: `${(ret / issued) * 100}%` }} />
          </div>
          <p className="num mt-2 text-[15px]">
            <span className="font-semibold">{energy(ret)}</span> claimed and burned ·{" "}
            <span className="font-semibold">{energy(issued - ret)}</span> still transferable
          </p>
        </div>
      </section>

      <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <section aria-labelledby="prov-h">
          <h2 id="prov-h" className="wide mb-4 text-[20px] font-semibold">Provenance</h2>
          <ol className="relative space-y-6 border-l-2 border-rule pl-6">
            <Step n={1} title="Measured">
              The meter integrated <b>{energy(issued)}</b> of panel output over the hour.
            </Step>
            <Step n={2} title="Signed by the meter">
              Signed on the device with key <code>{short(cert.device, 10)}</code>, nonce {v?.nonce ?? "—"}.
              <Mono>{v?.device_sig}</Mono>
            </Step>
            <Step n={3} title="Checked against the sky">
              {v ? (
                <>
                  Satellite irradiance for the site was {v.ghi?.toFixed(0)} W/m² ({v.weather_source}), so a healthy array should
                  have produced about <b>{energy(v.expected_wh)}</b>. The physical ceiling for that hour was {energy(v.ceiling_wh)}.
                </>
              ) : (
                "Verifier record unavailable."
              )}
            </Step>
            <Step n={4} title={Number(cert.verifierCount ?? 1) > 1 ? `Attested by ${cert.verifierCount} independent AI verifiers` : "Attested by the AI verifier"}>
              {Number(cert.verifierCount ?? 1) > 1 ? (
                <>
                  Each verifier re-ran every check with its own key, model and fraud history. Lowest score{" "}
                  {(Number(cert.scoreBps) / 100).toFixed(1)}%; model <code>{short(cert.modelHash, 10)}</code>.
                  <ul className="mt-1 text-[14px] text-muted">
                    <li>
                      <code>{short(h.verifier, 10)}</code> verifier A, score {((v?.attestation?.scoreBps ?? 0) / 100).toFixed(1)}%
                    </li>
                    {v?.cosigners?.filter((c) => c.ok).map((c, i) => (
                      <li key={c.verifier}>
                        <code>{short(c.verifier, 10)}</code> verifier {String.fromCharCode(66 + i)}, score {((c.score_bps ?? 0) / 100).toFixed(1)}%
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  Score {(Number(cert.scoreBps) / 100).toFixed(1)}%, signed by <code>{short(cert.verifier, 10)}</code> with model{" "}
                  <code>{short(cert.modelHash, 10)}</code>.
                </>
              )}
            </Step>
            <Step n={5} title="Minted on-chain">
              The contract re-checked both signatures and the nameplate limit, then minted {energy(issued)} to producer{" "}
              <code>{short(cert.producer, 8)}</code>.
              {tx && (
                <Mono>
                  {ex ? <a className="link" href={ex} target="_blank" rel="noreferrer">{tx}</a> : tx}
                </Mono>
              )}
            </Step>
            <Step n={6} title={rets.length ? "Claimed" : "Not claimed yet"}>
              {rets.length ? (
                <ul className="space-y-2">
                  {rets.map((r, i) => (
                    <li key={i}>
                      <b>{energy(Number(r.amountWh))}</b> retired for <b>{r.beneficiary || short(r.onBehalfOf)}</b>
                      {r.purpose && <span className="text-muted"> ({r.purpose})</span>} on{" "}
                      {new Date(Number(r.timestamp) * 1000).toLocaleDateString()} ·{" "}
                      <Link className="link" href={`/claim?cert=${params.id}&r=${String(r.retirementId ?? 0)}`}>Claim statement</Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <>Nobody has claimed this energy yet. <Link href="/market" className="link">Buy it on the market</Link>.</>
              )}
            </Step>
          </ol>
        </section>

        <aside className="space-y-10">
          <section aria-labelledby="verify-h">
            <h2 id="verify-h" className="wide text-[20px] font-semibold">Check it yourself</h2>
            <p className="mt-1 text-[15px] text-muted">
              Your browser re-derives every claim from raw signatures and chain state. Nothing here relies on trusting VoltProof.
            </p>
            <button className="btn btn-sun mt-4" onClick={runChecks} disabled={running || !ev}>
              {running ? "Checking…" : checks ? "Run checks again" : "Run checks in my browser"}
            </button>
            {checks && (
              <ul className="mt-5 space-y-3">
                {checks.map((c, i) => (
                  <li key={i} className="grid grid-cols-[22px_1fr] gap-x-2">
                    <span className={c.ok ? "text-ok" : c.ok === null ? "text-muted" : "text-reject"} aria-label={c.ok ? "passed" : c.ok === null ? "pending" : "failed"}>
                      {c.ok ? "✓" : c.ok === null ? "…" : "✕"}
                    </span>
                    <div>
                      <p className="font-semibold leading-snug">{c.label}</p>
                      <p className="break-all text-[13px] text-muted">{c.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {v && <ScoreBreakdown v={v} />}
        </aside>
      </div>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="relative">
      <span className="num absolute -left-[37px] top-0 grid h-6 w-6 place-items-center rounded-full bg-ink text-[12px] font-semibold text-paper">
        {n}
      </span>
      <p className="font-semibold">{title}</p>
      <div className="mt-0.5 text-[15px] leading-relaxed">{children}</div>
    </li>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 break-all font-mono text-[12px] text-muted">{children}</p>;
}

export default function CertificatePage() {
  return (
    <Suspense fallback={<p className="pt-16 text-muted">Loading…</p>}>
      <CertificatePageInner />
    </Suspense>
  );
}
