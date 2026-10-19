"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { Mark } from "@/components/Nav";
import { Offline } from "@/components/Status";
import { api, type Verdict } from "@/lib/api";
import { ABI, publicClient } from "@/lib/chain";
import { energy, hourRange } from "@/lib/format";
import { useHealth } from "@/lib/hooks";
import { BASE_PATH } from "@/lib/runtime";

const RETIRED = parseAbiItem(
  "event CertificateRetired(uint256 indexed retirementId, uint256 indexed certificateId, address indexed onBehalfOf, address retiredBy, uint256 amountWh, string beneficiary, string purpose)"
);

/**
 * A claim statement for one retirement: everything an auditor needs to accept the claim under
 * the GHG Protocol Scope 2 market-based method (unique, retired, vintage, location,
 * technology), plus the links and hashes to verify it independently.
 */
function ClaimInner() {
  const qs = useSearchParams();
  const certId = qs.get("cert") ?? "";
  const retId = qs.get("r") ?? "";
  const { health: h, error } = useHealth();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!h || !certId) return;
    const c = publicClient(h);
    (async () => {
      const cert = await c.readContract({ address: h.contracts.GranularCertificate, abi: ABI.GranularCertificate, functionName: "getCertificate", args: [BigInt(certId)] });
      const dev = await c.readContract({ address: h.contracts.DeviceRegistry, abi: ABI.DeviceRegistry, functionName: "getDevice", args: [cert.device] });
      const logs = await c.getLogs({ address: h.contracts.GranularCertificate, event: RETIRED, args: { certificateId: BigInt(certId) }, fromBlock: BigInt(h.startBlock || 0) });
      const log = logs.find((l: any) => String(l.args.retirementId) === retId) ?? logs[0];
      if (!log) throw new Error("This certificate hasn't been claimed yet.");
      const block = await c.getBlock({ blockNumber: log.blockNumber });
      let ev: { verdict: Verdict } | null = null;
      try {
        ev = await api(`/v1/certificates/${certId}/evidence`);
      } catch {}
      setData({ cert, dev, ret: log.args, tx: log.transactionHash, ts: Number(block.timestamp), verdict: ev?.verdict ?? null });
    })().catch((e) => setErr(e.message));
  }, [h, certId, retId]);

  if (error) return <Offline error={error} />;
  if (err) return <p className="pt-16 text-[18px]">{err}</p>;
  if (!data || !h) return <p className="pt-16 text-muted">Reading the chain…</p>;

  const { cert, dev, ret, tx, ts, verdict: v } = data;
  const verifyUrl = typeof window !== "undefined" ? `${window.location.origin}${BASE_PATH}/certificate/?id=${certId}` : "";
  const bundle = {
    type: "VoltProof energy attribute claim",
    claim: {
      beneficiary: ret.beneficiary, purpose: ret.purpose, claimant: ret.onBehalfOf, energyWh: String(ret.amountWh),
      retiredAt: new Date(ts * 1000).toISOString(), retirementId: String(ret.retirementId), retirementTx: tx,
    },
    generation: {
      certificateId: certId, site: dev.name, latitude: Number(dev.latE6) / 1e6, longitude: Number(dev.lonE6) / 1e6,
      nameplateW: Number(dev.capacityW), technology: "Solar PV", country: "IN",
      intervalStart: new Date(Number(cert.hourStart) * 1000).toISOString(), intervalEnd: new Date((Number(cert.hourStart) + 3600) * 1000).toISOString(),
      meter: cert.device, producer: cert.producer,
    },
    verification: {
      chainId: h.chainId, certificateContract: h.contracts.GranularCertificate, readingHash: cert.readingHash,
      meterSignature: v?.device_sig ?? null, verifierCount: Number(cert.verifierCount ?? 1), plausibilityScoreBps: Number(cert.scoreBps),
      modelHash: cert.modelHash, attestations: v ? [{ attestation: v.attestation, signature: v.verifier_sig }, ...(v.cosigners ?? []).filter((c: any) => c.ok).map((c: any) => ({ attestation: c.attestation, signature: c.signature }))] : [],
      verifyAt: verifyUrl,
    },
  };

  function download() {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `voltproof-claim-${certId}-${String(ret.retirementId)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
    <div className="grid grid-cols-[minmax(0,180px)_1fr] gap-x-6 border-t border-rule py-2.5 text-[15px] print:py-1.5">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );

  return (
    <article className="mx-auto max-w-[760px] pt-8 print:pt-0">
      <div className="no-print mb-8 flex flex-wrap gap-3">
        <button className="btn btn-sun" onClick={() => window.print()}>Print or save as PDF</button>
        <button className="btn btn-ghost" onClick={download}>Download evidence (JSON)</button>
        <Link className="btn btn-ghost" href={`/certificate?id=${certId}`}>Back to certificate</Link>
      </div>

      <header className="flex items-start justify-between gap-6">
        <div>
          <p className="text-muted">Renewable energy claim statement</p>
          <h1 className="display mt-2 text-[40px] font-[750]">{energy(Number(ret.amountWh))} of solar electricity</h1>
          <p className="wide mt-3 text-[20px]">claimed by {ret.beneficiary || ret.onBehalfOf}</p>
        </div>
        <Mark size={44} />
      </header>

      <dl className="mt-8">
        <Row k="Purpose">{ret.purpose || "—"}</Row>
        <Row k="Claimed on">{new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}</Row>
        <Row k="Generated">{hourRange(Number(cert.hourStart))} (one-hour vintage)</Row>
        <Row k="Generator">{dev.name}, {(Number(dev.capacityW) / 1000).toLocaleString()} kW solar PV, India ({(Number(dev.latE6) / 1e6).toFixed(4)}, {(Number(dev.lonE6) / 1e6).toFixed(4)})</Row>
        <Row k="Certificate">#{certId} on chain {h.chainId}, contract <span className="font-mono text-[13px]">{h.contracts.GranularCertificate}</span></Row>
        <Row k="Verification">
          Meter-signed reading, checked against independent satellite irradiance by {Number(cert.verifierCount ?? 1)} independent AI verifier{Number(cert.verifierCount ?? 1) > 1 ? "s" : ""};
          plausibility {(Number(cert.scoreBps) / 100).toFixed(1)}%
        </Row>
        <Row k="Retirement">Burned permanently; this energy cannot be transferred or claimed again. Retirement #{String(ret.retirementId)}, transaction <span className="font-mono text-[13px]">{tx}</span></Row>
        <Row k="Reading hash"><span className="font-mono text-[13px]">{cert.readingHash}</span></Row>
      </dl>

      <section className="mt-8 rounded-lg bg-panel p-5 text-[15px] shadow-[inset_0_0_0_1px_rgb(var(--rule))] print:shadow-none">
        <p className="font-semibold">Scope 2 market-based criteria</p>
        <ul className="mt-2 space-y-1">
          <li>✓ Conveys a unique claim: one certificate per meter-hour, enforced on-chain</li>
          <li>✓ Retired on behalf of the claimant, with beneficiary and purpose recorded</li>
          <li>✓ Vintage matched to the hour of generation</li>
          <li>✓ Generator location, technology and capacity identified</li>
        </ul>
      </section>

      <p className="mt-6 text-[14px] text-muted">
        Verify independently at <span className="break-all text-ink">{verifyUrl}</span>. Anyone can recompute the meter and verifier signatures and the
        audit-log Merkle proof from public data.
      </p>
    </article>
  );
}

export default function ClaimPage() {
  return (
    <Suspense fallback={<p className="pt-16 text-muted">Loading…</p>}>
      <ClaimInner />
    </Suspense>
  );
}
