export const VERIFIER_URL = (process.env.NEXT_PUBLIC_VERIFIER_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

export type Reason = { code: string; severity: "ok" | "info" | "medium" | "high" | "critical"; message: string };

export type Verdict = {
  id: number;
  created_at: number;
  device: string;
  device_name: string | null;
  hour_start: number;
  energy_wh: number;
  nonce: number;
  device_sig: string;
  reading_hash: string;
  status: "ACCEPTED" | "HELD" | "REJECTED" | "SUSPENDED" | "FAILED_ONCHAIN";
  score_bps: number;
  expected_wh: number | null;
  ceiling_wh: number | null;
  ratio: number | null;
  ghi: number | null;
  poa: number | null;
  temp_c: number | null;
  cloud_cover: number | null;
  clear_sky_ghi: number | null;
  weather_source: string | null;
  components: { physics: number; anomaly: number; consistency: number } | null;
  reasons: Reason[];
  evidence_z: number | null;
  cusum: number | null;
  attestation: { readingHash: string; expectedWh: number; scoreBps: number; modelHash: string; issuedAt: number } | null;
  verifier_sig: string | null;
  tx_hash: string | null;
  certificate_id: number | null;
  label: string | null;
  batch_id: number | null;
  note?: string;
};

export type Health = {
  chainId: number;
  rpcUrl: string;
  verifier: string;
  isVerifier: boolean;
  contracts: { DeviceRegistry: `0x${string}`; GranularCertificate: `0x${string}`; CertificateMarket: `0x${string}` };
  startBlock: number;
  model: { version: string; hash: string; acceptBps: number; holdBps: number; cusumH: number };
  weather: string;
  demoMode: boolean;
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
};

export type FleetDevice = {
  address: string;
  owner: string;
  lat: number;
  lon: number;
  capacityW: number;
  active: boolean;
  name: string;
  city?: string;
  producerName?: string;
  lab?: boolean;
  stats: { n: number; acc: number; rej: number; held: number; wh: number; last: number | null };
  risk: { cusum: number; threshold: number; suspended: boolean; reason: string | null };
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${VERIFIER_URL}${path}`, { cache: "no-store", ...init });
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const j = await r.json();
      msg = j.detail || msg;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

export const post = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
