"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { Offline } from "@/components/Status";
import { ABI, publicClient } from "@/lib/chain";
import { energy, short } from "@/lib/format";
import { useHealth, usePoll } from "@/lib/hooks";

type Ret = { id: bigint; certificateId: bigint; onBehalfOf: string; amountWh: bigint; beneficiary: string; purpose: string; ts: number; tx: string };
type Batch = { id: number; onchain_id: number; root: string; from_verdict: number; to_verdict: number; accepted: number; rejected: number; tx_hash: string; created_at: number };

export default function Ledger() {
  const { health: h, error } = useHealth();
  const batches = usePoll<Batch[]>("/v1/audit/batches", 10000);
  const [rets, setRets] = useState<Ret[] | null>(null);
  const [roots, setRoots] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!h) return;
    const c = publicClient(h);
    (async () => {
      const logs = await c.getLogs({
        address: h.contracts.GranularCertificate,
        event: parseAbiItem(
          "event CertificateRetired(uint256 indexed retirementId, uint256 indexed certificateId, address indexed onBehalfOf, address retiredBy, uint256 amountWh, string beneficiary, string purpose)"
        ),
        fromBlock: BigInt(h.startBlock || 0),
      });
      const blocks = new Map<bigint, number>();
      for (const l of logs as any[]) if (!blocks.has(l.blockNumber!)) blocks.set(l.blockNumber!, Number((await c.getBlock({ blockNumber: l.blockNumber! })).timestamp));
      setRets(
        (logs as any[])
          .map((l: any) => {
            const a = l.args as any;
            return { id: a.retirementId, certificateId: a.certificateId, onBehalfOf: a.onBehalfOf, amountWh: a.amountWh, beneficiary: a.beneficiary, purpose: a.purpose, ts: blocks.get(l.blockNumber!)!, tx: l.transactionHash! };
          })
          .reverse()
      );
    })();
  }, [h]);

  useEffect(() => {
    if (!h || !batches.data) return;
    const c = publicClient(h);
    Promise.all(
      batches.data.map((b) =>
        c.readContract({ address: h.contracts.GranularCertificate, abi: ABI.GranularCertificate, functionName: "getAuditBatch", args: [BigInt(b.onchain_id)] }).then((x: any) => [b.id, x.merkleRoot] as const)
      )
    ).then((pairs) => setRoots(Object.fromEntries(pairs)));
  }, [h, batches.data]);

  if (error) return <Offline error={error} />;
  const totalRetired = rets?.reduce((s, r) => s + Number(r.amountWh), 0) ?? 0;

  return (
    <>
      <section className="pt-8 sm:pt-12">
        <h1 className="display text-[40px] font-[750] sm:text-[60px]">Public ledger</h1>
        <p className="mt-4 max-w-[64ch] text-[18px] text-muted">
          Two records anyone can audit straight from the chain: who claimed which hour of clean energy, and a tamper-evident
          commitment to every decision the verifier made, including every rejection.
        </p>
      </section>

      <section className="mt-10" aria-labelledby="ret-h">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="ret-h" className="wide text-[20px] font-semibold">Claims</h2>
          {rets && <p className="num text-muted">{energy(totalRetired)} claimed in {rets.length} retirements</p>}
        </div>
        <table className="w-full text-[15px]">
          <thead className="text-left text-[13px] text-muted">
            <tr>
              <th className="py-2 font-normal">Claimed for</th>
              <th className="hidden py-2 font-normal md:table-cell">Purpose</th>
              <th className="py-2 text-right font-normal">Energy</th>
              <th className="py-2 pl-3 text-right font-normal">Certificate</th>
            </tr>
          </thead>
          <tbody>
            {rets?.map((r) => (
              <tr key={String(r.id)} className="border-t border-rule">
                <td className="py-2.5">
                  <span className="font-semibold">{r.beneficiary || short(r.onBehalfOf)}</span>
                  <div className="text-[13px] text-muted">{new Date(r.ts * 1000).toLocaleString()} · {short(r.onBehalfOf)}</div>
                </td>
                <td className="hidden py-2.5 text-muted md:table-cell">{r.purpose}</td>
                <td className="num py-2.5 text-right">{energy(Number(r.amountWh))}</td>
                <td className="py-2.5 pl-3 text-right"><Link className="link" href={`/certificate/${r.certificateId}`}>#{String(r.certificateId)}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rets && rets.length === 0 && <p className="py-6 text-muted">No energy claimed yet. <Link className="link" href="/market">Claim some on the market</Link>.</p>}
      </section>

      <section className="mt-14" aria-labelledby="audit-h">
        <h2 id="audit-h" className="wide mb-1 text-[20px] font-semibold">Verifier audit log</h2>
        <p className="mb-3 max-w-[70ch] text-[15px] text-muted">
          Verdicts are hashed into a Merkle tree and the root is written on-chain. If the verifier later edits or deletes a
          single decision, its proof stops matching the anchored root.
        </p>
        <table className="w-full text-[15px]">
          <thead className="text-left text-[13px] text-muted">
            <tr>
              <th className="py-2 font-normal">Batch</th>
              <th className="py-2 font-normal">Verdicts</th>
              <th className="py-2 text-right font-normal">Certified / refused</th>
              <th className="hidden py-2 pl-3 font-normal md:table-cell">Merkle root</th>
              <th className="py-2 pl-3 text-right font-normal">On-chain match</th>
            </tr>
          </thead>
          <tbody>
            {batches.data?.map((b) => (
              <tr key={b.id} className="border-t border-rule">
                <td className="num py-2.5 font-semibold">#{b.onchain_id}</td>
                <td className="num py-2.5">
                  <Link className="link" href={`/verdict/${b.from_verdict}`}>{b.from_verdict}</Link>–<Link className="link" href={`/verdict/${b.to_verdict}`}>{b.to_verdict}</Link>
                </td>
                <td className="num py-2.5 text-right">{b.accepted} / {b.rejected}</td>
                <td className="hidden py-2.5 pl-3 font-mono text-[12px] text-muted md:table-cell">{short(b.root, 14)}</td>
                <td className="py-2.5 pl-3 text-right">
                  {roots[b.id] == null ? "…" : roots[b.id].toLowerCase() === b.root.toLowerCase() ? <span className="text-ok">✓ matches</span> : <span className="text-reject">✕ differs</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
