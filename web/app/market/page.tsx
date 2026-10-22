"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatEther } from "viem";
import { Offline } from "@/components/Status";
import type { FleetDevice } from "@/lib/api";
import { ABI, getWallet, publicClient, type Wallet } from "@/lib/chain";
import { energy, hourRange } from "@/lib/format";
import { useHealth, usePoll } from "@/lib/hooks";

type Listing = {
  id: number;
  seller: string;
  certificateId: bigint;
  remainingWh: bigint;
  priceWeiPerWh: bigint;
  active: boolean;
  device: string;
  hourStart: number;
};

export default function Market() {
  const { health: h, error } = useHealth();
  const fleet = usePoll<{ devices: FleetDevice[]; producers: Record<string, string> }>("/v1/fleet", 0);
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  // Kept at page level so the confirmation survives the listing disappearing once sold out.
  const [purchase, setPurchase] = useState<{ text: string; certificateId: string; claimed: boolean } | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [bal, setBal] = useState<bigint | null>(null);
  const [onlyShoulder, setOnlyShoulder] = useState(false);
  const [limit, setLimit] = useState(25);

  const load = useCallback(async () => {
    if (!h) return;
    const c = publicClient(h);
    const m = h.contracts.CertificateMarket;
    const n = Number(await c.readContract({ address: m, abi: ABI.CertificateMarket, functionName: "listingCount" }));
    const ls = await Promise.all(
      Array.from({ length: n }, (_, i) => c.readContract({ address: m, abi: ABI.CertificateMarket, functionName: "getListing", args: [BigInt(i)] }))
    );
    const ids = [...new Set(ls.map((l: any) => l.certificateId as bigint))];
    const certs = await Promise.all(
      ids.map((id: any) => c.readContract({ address: h.contracts.GranularCertificate, abi: ABI.GranularCertificate, functionName: "getCertificate", args: [id] }))
    );
    const byId = new Map(ids.map((id: any, i: number) => [id, certs[i] as any]));
    setListings(
      ls
        .map((l: any, i: number) => ({ ...l, id: i, device: byId.get(l.certificateId).device, hourStart: Number(byId.get(l.certificateId).hourStart) }))
        .filter((l: any) => l.active && l.remainingWh > 0n)
        .sort((a: any, b: any) => b.hourStart - a.hourStart)
    );
  }, [h]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!h) return;
    getWallet(h)
      .then(async (w) => {
        setWallet(w);
        setBal(await publicClient(h).getBalance({ address: w.address }));
      })
      .catch(() => {});
  }, [h]);

  if (error) return <Offline error={error} />;
  const names = new Map(fleet.data?.devices.map((d) => [d.address.toLowerCase(), d]) ?? []);
  const sym = h?.chainId === 80002 ? "POL" : "ETH";
  const localHour = (ts: number) => new Date(ts * 1000).getHours();
  const shown = (listings ?? []).filter((l) => !onlyShoulder || [6, 7, 8, 16, 17, 18].includes(localHour(l.hourStart)));

  return (
    <>
      <section className="pt-8 sm:pt-12">
        <h1 className="display text-[40px] font-[750] sm:text-[60px]">Buy clean energy by the hour</h1>
        <p className="mt-4 max-w-[64ch] text-[18px] text-muted">
          Each listing is one meter-hour of verified solar, sold directly by the household, school or co-op that produced it.
          Buy and claim in one step to retire it for your organisation. Once claimed it's burned, so nobody else can count it.
        </p>
        <p className="mt-4 text-[15px]">
          {wallet ? (
            <>
              Buying as <span className="font-mono text-[13px]">{wallet.address}</span>{" "}
              <span className="text-muted">
                ({wallet.kind === "demo" ? "local demo wallet" : "browser wallet"}
                {bal != null && `, ${Number(formatEther(bal)).toFixed(3)} ${sym}`})
              </span>
            </>
          ) : (
            <span className="text-muted">Connect a wallet to buy. On the local demo a test wallet is used automatically.</span>
          )}
        </p>
      </section>

      {purchase && (
        <div role="status" className="mt-8 rounded-lg bg-panel p-4 shadow-[inset_0_0_0_1.5px_rgb(var(--ok))]">
          <p className="font-semibold text-ok">{purchase.text}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Link href={`/certificate?id=${purchase.certificateId}`} className="btn btn-sun">
              View certificate #{purchase.certificateId}
            </Link>
            {purchase.claimed && (
              <Link href="/ledger" className="btn btn-ghost">See it in the public ledger</Link>
            )}
            <button className="btn btn-ghost" onClick={() => setPurchase(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-3">
        <p className="text-muted">{listings ? `${shown.length} listings` : "Reading listings from the chain…"}</p>
        <label className="flex items-center gap-2 text-[15px]">
          <input type="checkbox" checked={onlyShoulder} onChange={(e) => setOnlyShoulder(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--sun))]" />
          Only morning and evening hours (scarcer, for 24/7 matching)
        </label>
      </div>

      <table className="w-full text-[15px]">
        <thead className="text-left text-[13px] text-muted">
          <tr>
            <th className="py-2 font-normal">Produced by</th>
            <th className="hidden py-2 font-normal sm:table-cell">Hour</th>
            <th className="py-2 text-right font-normal">Available</th>
            <th className="py-2 text-right font-normal">Price per kWh</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {shown.slice(0, limit).map((l) => {
            const d = names.get(l.device.toLowerCase());
            return [
              <tr key={l.id} className="border-t border-rule">
                <td className="py-3 pr-2">
                  <Link href={`/certificate?id=${l.certificateId}`} className="font-semibold hover:underline">{d?.name ?? "Meter"}</Link>
                  <div className="text-[13px] text-muted">{d?.producerName}<span className="sm:hidden"> · {hourRange(l.hourStart)}</span></div>
                </td>
                <td className="num hidden py-3 sm:table-cell">{hourRange(l.hourStart)}</td>
                <td className="num py-3 text-right">{energy(Number(l.remainingWh))}</td>
                <td className="num py-3 text-right">
                  {Number(formatEther(l.priceWeiPerWh * 1000n)).toFixed(4)} {sym}
                </td>
                <td className="py-3 pl-3 text-right">
                  <button className="btn btn-ghost px-3 py-1.5 text-[14px]" onClick={() => setOpen(open === l.id ? null : l.id)} aria-expanded={open === l.id}>
                    {open === l.id ? "Close" : "Buy"}
                  </button>
                </td>
              </tr>,
              open === l.id && h && (
                <tr key={`${l.id}-buy`}>
                  <td colSpan={5} className="pb-5">
                    <BuyForm
                      listing={l}
                      sym={sym}
                      onDone={(text, claimed) => {
                        setPurchase({ text, certificateId: String(l.certificateId), claimed });
                        setOpen(null);
                        load();
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    />
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
      {shown.length > limit && (
        <button className="btn btn-ghost mt-4" onClick={() => setLimit(limit + 25)}>
          Show 25 more of {shown.length - limit}
        </button>
      )}
      {listings && shown.length === 0 && (
        <p className="py-10 text-muted">Nothing listed right now. Producers list new hours as they're certified: run <code>python -m simulator market</code>.</p>
      )}
    </>
  );
}

function BuyForm({ listing, sym, onDone }: { listing: Listing; sym: string; onDone: (text: string, claimed: boolean) => void }) {
  const { health: h } = useHealth();
  const max = Number(listing.remainingWh);
  const [kwh, setKwh] = useState(Math.min(1, max / 1000));
  const [beneficiary, setBeneficiary] = useState("Campus Sustainability Office");
  const [purpose, setPurpose] = useState("Scope 2 hourly matching, Oct 2026");
  const [state, setState] = useState<{ busy?: boolean; done?: string; err?: string }>({});
  const wh = BigInt(Math.max(1, Math.min(max, Math.round(kwh * 1000))));
  const cost = wh * listing.priceWeiPerWh;

  async function buy(retire: boolean) {
    if (!h) return;
    setState({ busy: true });
    try {
      const w = await getWallet(h);
      const hash = await w.client.writeContract({
        account: w.account,
        chain: undefined,
        address: h.contracts.CertificateMarket,
        abi: ABI.CertificateMarket,
        functionName: "buy",
        args: [BigInt(listing.id), wh, retire, retire ? beneficiary : "", retire ? purpose : ""],
        value: cost,
      } as any);
      await publicClient(h).waitForTransactionReceipt({ hash });
      const text = retire
        ? `Claimed ${energy(Number(wh))} for ${beneficiary}. It has been burned and can't be claimed again.`
        : `Bought ${energy(Number(wh))}. It's in your wallet.`;
      setState({ done: text });
      onDone(text, retire);
    } catch (e: any) {
      setState({ err: e.shortMessage || e.message });
    }
  }

  return (
    <div className="rounded-lg bg-panel p-4 shadow-[inset_0_0_0_1px_rgb(var(--rule))]">
      {state.done ? (
        <p className="font-semibold text-ok">
          {state.done} <Link href={`/certificate?id=${listing.certificateId}`} className="link ml-1 text-ink">View certificate</Link>
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[140px_1fr_1fr]">
          <label className="text-[14px]">
            Amount (kWh)
            <input className="field num mt-1" type="number" min={0.001} max={max / 1000} step={0.1} value={kwh} onChange={(e) => setKwh(+e.target.value)} />
          </label>
          <label className="text-[14px]">
            Claim on behalf of
            <input className="field mt-1" value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} />
          </label>
          <label className="text-[14px]">
            Purpose
            <input className="field mt-1" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </label>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
            <button className="btn btn-sun" disabled={state.busy} onClick={() => buy(true)}>
              {state.busy ? "Confirming…" : `Buy and claim ${energy(Number(wh))}`}
            </button>
            <button className="btn btn-ghost" disabled={state.busy} onClick={() => buy(false)}>Buy only</button>
            <span className="num text-[14px] text-muted">Total {Number(formatEther(cost)).toFixed(4)} {sym}, paid straight to the producer</span>
          </div>
          {state.err && <p className="text-[14px] text-reject sm:col-span-3">{state.err}</p>}
        </div>
      )}
    </div>
  );
}
