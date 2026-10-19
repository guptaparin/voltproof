"use client";
import { encodeAbiParameters, keccak256, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { ABI } from "./chain";
import type { Health, Verdict } from "./api";

export const READING_TYPES = {
  Reading: [
    { name: "device", type: "address" },
    { name: "hourStart", type: "uint64" },
    { name: "energyWh", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;
export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "readingHash", type: "bytes32" },
    { name: "expectedWh", type: "uint64" },
    { name: "scoreBps", type: "uint16" },
    { name: "modelHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

const READING_TYPEHASH = keccak256(toHex("Reading(address device,uint64 hourStart,uint64 energyWh,uint64 nonce)"));
const STATUS_CODE: Record<string, number> = { ACCEPTED: 1, HELD: 2, REJECTED: 3, FAILED_ONCHAIN: 4, SUSPENDED: 5 };

export function readingStructHash(r: { device: Hex; hourStart: bigint; energyWh: bigint; nonce: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }],
      [READING_TYPEHASH, r.device, r.hourStart, r.energyWh, r.nonce]
    )
  );
}

export function verdictLeaf(v: Verdict): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "uint16" }, { type: "bytes32" }],
      [BigInt(v.id), v.device as Hex, BigInt(v.hour_start), BigInt(v.energy_wh), BigInt(v.nonce), STATUS_CODE[v.status], v.score_bps, v.reading_hash as Hex]
    )
  );
  return keccak256(inner);
}

function pairHash(a: Hex, b: Hex): Hex {
  return a.toLowerCase() < b.toLowerCase() ? keccak256(`${a}${b.slice(2)}` as Hex) : keccak256(`${b}${a.slice(2)}` as Hex);
}

export type Check = { label: string; detail: string; ok: boolean | null };

/** Re-derive every claim behind a certificate from raw data, in the browser. */
export async function verifyCertificate(
  h: Health,
  client: any,
  certId: bigint,
  cert: any,
  ev: { verdict: Verdict; merkle: any; reading: any }
): Promise<Check[]> {
  const v = ev.verdict;
  const domain = { ...h.domain, chainId: h.domain.chainId };
  const reading = {
    device: v.device as Hex,
    hourStart: BigInt(v.hour_start),
    energyWh: BigInt(v.energy_wh),
    nonce: BigInt(v.nonce),
  };
  const checks: Check[] = [];

  // 1 — meter signature
  const meter = await recoverTypedDataAddress({ domain, types: READING_TYPES, primaryType: "Reading", message: reading, signature: v.device_sig as Hex });
  checks.push({
    label: "Meter signed this exact reading",
    detail: `EIP-712 signature recovers to ${meter}`,
    ok: meter.toLowerCase() === cert.device.toLowerCase(),
  });

  // 2 — meter registered
  const dev = (await client.readContract({ address: h.contracts.DeviceRegistry, abi: ABI.DeviceRegistry, functionName: "getDevice", args: [cert.device] })) as any;
  checks.push({
    label: "Meter is in the on-chain registry",
    detail: `${dev.name}, ${dev.capacityW} W nameplate, ${dev.active ? "active" : "revoked"}`,
    ok: dev.registeredAt > 0n,
  });

  // 3 — on-chain record matches the signed data
  const rh = readingStructHash(reading);
  checks.push({
    label: "Certificate commits to the signed reading",
    detail: `struct hash ${rh.slice(0, 18)}… equals the readingHash stored on-chain`,
    ok: rh.toLowerCase() === (cert.readingHash as string).toLowerCase() && BigInt(cert.energyWh) === reading.energyWh,
  });

  // 4 — verifier attestation
  if (v.attestation && v.verifier_sig) {
    const a = v.attestation;
    const att = {
      readingHash: a.readingHash as Hex,
      expectedWh: BigInt(a.expectedWh),
      scoreBps: a.scoreBps,
      modelHash: a.modelHash as Hex,
      issuedAt: BigInt(a.issuedAt),
    };
    const ver = await recoverTypedDataAddress({ domain, types: ATTESTATION_TYPES, primaryType: "Attestation", message: att, signature: v.verifier_sig as Hex });
    const role = (await client.readContract({ address: h.contracts.GranularCertificate, abi: ABI.GranularCertificate, functionName: "VERIFIER_ROLE" })) as Hex;
    const has = (await client.readContract({ address: h.contracts.GranularCertificate, abi: ABI.GranularCertificate, functionName: "hasRole", args: [role, ver] })) as boolean;
    checks.push({
      label: "An authorised AI verifier attested it",
      detail: `attestation signed by ${ver.slice(0, 10)}…, score ${(a.scoreBps / 100).toFixed(1)}%, holds VERIFIER_ROLE: ${has ? "yes" : "no"}`,
      ok: has && ver.toLowerCase() === cert.verifier.toLowerCase() && a.readingHash.toLowerCase() === rh.toLowerCase(),
    });
  }

  // 5 — Merkle audit log
  if (ev.merkle) {
    let node = verdictLeaf(v);
    const leafOk = node.toLowerCase() === ev.merkle.leaf.toLowerCase();
    for (const p of ev.merkle.proof as Hex[]) node = pairHash(node, p);
    const batch = (await client.readContract({
      address: h.contracts.GranularCertificate,
      abi: ABI.GranularCertificate,
      functionName: "getAuditBatch",
      args: [BigInt(ev.merkle.onchainBatchId)],
    })) as any;
    checks.push({
      label: "Verdict is in an anchored audit batch",
      detail: `Merkle proof (${ev.merkle.proof.length} hashes) reaches root ${batch.merkleRoot.slice(0, 14)}… anchored on-chain as batch #${ev.merkle.onchainBatchId}`,
      ok: leafOk && node.toLowerCase() === batch.merkleRoot.toLowerCase(),
    });
  } else {
    checks.push({ label: "Verdict is in an anchored audit batch", detail: "Not anchored yet; batches are committed every 60 verdicts", ok: null });
  }
  return checks;
}
