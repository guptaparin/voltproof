"use client";
/**
 * In-browser VoltProof backend for the static live demo.
 *
 * Loads a snapshot of a real local-testnet run (certificates, verdicts, signatures, Merkle
 * proofs, anchored roots) and serves the same API shapes as the Python verifier. New Attack
 * Lab submissions go through a TypeScript port of the same seven-gate pipeline:
 *   - meter readings and verifier attestations are really EIP-712 signed with viem,
 *   - signatures are really recovered and checked,
 *   - physics, the isolation forest and CUSUM are the same model (see scripts/parity.mjs),
 *   - two independent verifier keys co-sign (2-of-2),
 * and only the final on-chain mint is simulated in memory.
 */
import { keccak256, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_PATH } from "../runtime";
import { ATTESTATION_TYPES, READING_TYPES, readingStructHash } from "../verify";
import {
  HOUR,
  assess,
  clearSkyCeilingWh,
  clearSkyGhiHour,
  cusumUpdate,
  decodeForest,
  localIrradianceErrorSigma,
  MODEL,
  pvEnergyWh,
  type Forest,
  type Weather,
} from "./model";

type Snap = any;
type V = any;

let ready: Promise<State> | null = null;
const hexKey = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as Hex;

class State {
  snap: Snap;
  forest: Forest;
  verdicts: V[];
  certs: Record<string, any>;
  certificateOf = new Map<string, number>();
  lastNonce: Record<string, number>;
  retirements: any[];
  retiredWhOf: Record<string, bigint>;
  listings: any[];
  cusum = { primary: new Map<string, number>(), peer: new Map<string, number>() };
  suspended = { primary: new Set<string>(), peer: new Set<string>() };
  history: number[];
  loadedAt = Date.now() / 1000;
  nextVerdictId: number;
  nextCertId: number;

  constructor(snap: Snap, forest: Forest) {
    this.snap = snap;
    this.forest = forest;
    this.verdicts = [...snap.verdicts].sort((a, b) => b.id - a.id);
    this.certs = { ...snap.chain.certificates };
    for (const [id, c] of Object.entries<any>(this.certs)) this.certificateOf.set(`${c.device.toLowerCase()}:${c.hourStart}`, Number(id));
    this.lastNonce = Object.fromEntries(Object.entries<number>(snap.chain.lastNonce).map(([k, v]) => [k.toLowerCase(), v]));
    this.retirements = [...snap.chain.retirements];
    this.retiredWhOf = Object.fromEntries(Object.entries<string>(snap.chain.retiredWhOf).map(([k, v]) => [k, BigInt(v)]));
    this.listings = snap.chain.listings.map((l: any) => ({ ...l }));
    for (const d of snap.fleet.devices) {
      this.cusum.primary.set(d.address.toLowerCase(), d.risk.cusum);
      this.cusum.peer.set(d.address.toLowerCase(), d.risk.cusum);
      if (d.risk.suspended) {
        this.suspended.primary.add(d.address.toLowerCase());
        this.suspended.peer.add(d.address.toLowerCase());
      }
    }
    this.history = snap.lab.history;
    this.nextVerdictId = Math.max(0, ...snap.verdicts.map((v: V) => v.id)) + 1;
    this.nextCertId = Object.keys(this.certs).length + 1;
  }

  /** Chain time keeps ticking from the moment the snapshot was taken. */
  now() {
    return Math.floor(this.snap.takenAt + (Date.now() / 1000 - this.loadedAt));
  }
}

export function loadDemo(): Promise<State> {
  ready ??= (async () => {
    const [snap, buf] = await Promise.all([
      fetch(`${BASE_PATH}/demo/snapshot.json`).then((r) => r.json()),
      fetch(`${BASE_PATH}/demo/forest.bin`).then((r) => r.arrayBuffer()),
    ]);
    return new State(snap, decodeForest(snap.forest, buf));
  })();
  return ready;
}

// ───────────────────────────── API router ─────────────────────────────
export async function demoApi(path: string, init?: RequestInit): Promise<any> {
  const S = await loadDemo();
  const url = new URL(path, "http://x");
  const p = url.pathname;
  const q = url.searchParams;
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  let m: RegExpMatchArray | null;

  if (p === "/v1/health") return { ...S.snap.health, staticDemo: true, snapshotTakenAt: S.snap.takenAt };
  if (p === "/v1/stats") return stats(S);
  if (p === "/v1/fleet") return fleet(S);
  if (p === "/v1/fleet/series") return S.snap.fleetSeries;
  if ((m = p.match(/^\/v1\/devices\/(0x[0-9a-fA-F]+)\/series$/))) {
    const key = Object.keys(S.snap.deviceSeries).find((k) => k.toLowerCase() === m![1].toLowerCase());
    const sr = key ? S.snap.deviceSeries[key] : { points: [] };
    const a = m[1].toLowerCase();
    return { ...sr, risk: { cusum: S.cusum.primary.get(a) ?? 0, threshold: MODEL.CUSUM_H, suspended: S.suspended.primary.has(a) } };
  }
  if (p === "/v1/verdicts") {
    let vs = S.verdicts;
    if (q.get("device")) vs = vs.filter((v) => v.device.toLowerCase() === q.get("device")!.toLowerCase());
    if (q.get("status")) vs = vs.filter((v) => v.status === q.get("status"));
    if (q.get("labelled") === "true") vs = vs.filter((v) => v.label);
    if (q.get("before")) vs = vs.filter((v) => v.id < Number(q.get("before")));
    return vs.slice(0, Number(q.get("limit") || 50));
  }
  if ((m = p.match(/^\/v1\/verdicts\/(\d+)$/))) {
    const v = S.verdicts.find((x) => x.id === Number(m![1]));
    if (!v) throw new Error("404");
    return { merkle: null, ...v };
  }
  if ((m = p.match(/^\/v1\/certificates\/(\d+)\/evidence$/))) {
    const v = S.verdicts.find((x) => x.certificate_id === Number(m![1]));
    if (!v) throw new Error("no verifier record for this certificate");
    return {
      verdict: v,
      merkle: v.merkle ?? null,
      domain: S.snap.health.domain,
      reading: { device: v.device, hourStart: v.hour_start, energyWh: v.energy_wh, nonce: v.nonce },
    };
  }
  if (p === "/v1/audit/batches") return S.snap.batches;
  if (p === "/v1/eval") return S.snap.eval;
  if (p === "/v1/demo/attacks") return S.snap.attacks;
  if (p === "/v1/demo/attack") return runAttack(S, body.type);
  if (p === "/v1/demo/reinstate") {
    const a = body.device.toLowerCase();
    for (const k of ["primary", "peer"] as const) {
      S.cusum[k].set(a, 0);
      S.suspended[k].delete(a);
    }
    return { ok: true };
  }
  throw new Error(`404 ${p}`);
}

function stats(S: State) {
  const by: Record<string, { count: number; wh: number }> = {};
  let blocked = 0;
  for (const v of S.verdicts) {
    by[v.status] ??= { count: 0, wh: 0 };
    by[v.status].count++;
    by[v.status].wh += v.energy_wh;
    if ((v.status === "REJECTED" || v.status === "SUSPENDED") && v.expected_wh != null && v.energy_wh > v.expected_wh)
      blocked += v.energy_wh - v.expected_wh;
  }
  const certs = Object.values<any>(S.certs);
  return {
    byStatus: by,
    blockedExcessWh: Math.round(blocked),
    totalIssuedWh: certs.reduce((s, c) => s + Number(c.energyWh), 0),
    totalRetiredWh: S.retirements.reduce((s, r) => s + Number(r.amountWh), 0),
    certificates: certs.length,
    retirements: S.retirements.length,
    auditBatches: Object.keys(S.snap.chain.auditBatches).length,
    devices: S.snap.fleet.devices.length,
  };
}

function fleet(S: State) {
  const per = new Map<string, any>();
  for (const v of S.verdicts) {
    const k = v.device.toLowerCase();
    const s = per.get(k) ?? { n: 0, acc: 0, rej: 0, held: 0, wh: 0, last: null };
    s.n++;
    if (v.status === "ACCEPTED") (s.acc++, (s.wh += v.energy_wh));
    if (v.status === "REJECTED") s.rej++;
    if (v.status === "HELD") s.held++;
    s.last = Math.max(s.last ?? 0, v.hour_start);
    per.set(k, s);
  }
  return {
    ...S.snap.fleet,
    devices: S.snap.fleet.devices.map((d: any) => {
      const k = d.address.toLowerCase();
      return {
        ...d,
        stats: per.get(k) ?? d.stats,
        risk: { ...d.risk, cusum: Math.round((S.cusum.primary.get(k) ?? 0) * 100) / 100, suspended: S.suspended.primary.has(k) },
      };
    }),
  };
}

// ───────────────────────────── Attack Lab ─────────────────────────────
function gauss(mean: number, sd: number) {
  const u = 1 - Math.random();
  const v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function labSystem(S: State) {
  const p = S.snap.lab.profile;
  return { capacityW: p.capacityW, lat: p.lat, lon: p.lon };
}

function wxAt(S: State, h: number): Weather {
  const w = S.snap.lab.weather[String(h)];
  if (w) return w;
  // hours after the snapshot: clear-sky physics scaled by the snapshot's average clearness
  const sys = labSystem(S);
  return { ghi: clearSkyGhiHour(h, sys.lat, sys.lon) * 0.8, temp_c: 26, cloud_cover: 20, source: "synthetic-physics" };
}

function honestWh(S: State, h: number, wx: Weather) {
  const prof = S.snap.lab.profile;
  const sys = labSystem(S);
  const sigma = localIrradianceErrorSigma(wx.cloud_cover);
  let g = wx.ghi * Math.exp(gauss(-(sigma ** 2) / 2, sigma));
  g = Math.min(g, clearSkyGhiHour(h, sys.lat, sys.lon) * 1.08);
  let [e] = pvEnergyWh(sys, h, g, wx.temp_c);
  e *= prof.health * gauss(1, 0.025);
  if (prof.shadingUtcHours.includes(Math.floor(h / 3600) % 24)) e *= 0.55;
  return Math.round(Math.min(Math.max(e, 0), sys.capacityW));
}

function candidateHours(S: State) {
  const sys = labSystem(S);
  const now = S.now();
  const cur = now - (now % 3600) - 3600;
  const day: number[] = [];
  const night: number[] = [];
  for (let k = 0; k < 36; k++) {
    const h = cur - k * 3600;
    if (S.certificateOf.has(`${S.snap.lab.device.toLowerCase()}:${h}`)) continue;
    const cs = clearSkyGhiHour(h, sys.lat, sys.lon);
    if (cs > 150) day.push(h);
    else if (cs < 1) night.push(h);
  }
  return { day, night };
}

function domainOf(S: State) {
  const d = S.snap.health.domain;
  return { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract as Hex };
}

async function signReading(S: State, key: Hex, r: any) {
  return privateKeyToAccount(key).signTypedData({
    domain: domainOf(S),
    types: READING_TYPES,
    primaryType: "Reading",
    message: { device: r.device, hourStart: BigInt(r.hourStart), energyWh: BigInt(r.energyWh), nonce: BigInt(r.nonce) },
  });
}

function nextNonce(S: State, device: string) {
  // the contract only requires nonce > last minted nonce; rejected attempts consume nothing
  return (S.lastNonce[device.toLowerCase()] ?? 0) + 1;
}

async function buildAttack(S: State, kind: string) {
  const lab = S.snap.lab;
  const sys = labSystem(S);
  const key = hexKey(lab.key);
  const dev = lab.device;
  const { day, night } = candidateHours(S);

  if (kind === "replay") {
    const v = S.verdicts.find((x) => x.status === "ACCEPTED" && x.certificate_id);
    if (!v) throw new Error("no certified reading to replay yet");
    return { reading: { device: v.device, hourStart: v.hour_start, energyWh: v.energy_wh, nonce: v.nonce }, signature: v.device_sig, note: `Re-submitting certificate #${v.certificate_id} (meter-hour already used).` };
  }
  if (kind === "night") {
    if (!night.length) throw new Error("no uncertified night hour in the last 36 h");
    const r = { device: dev, hourStart: night[0], energyWh: Math.floor(sys.capacityW * 0.3), nonce: nextNonce(S, dev) };
    return { reading: r, signature: await signReading(S, key, r), note: "Night-time claim." };
  }
  if (!day.length) throw new Error("no uncertified daylight hour left in the last 36 h — reload the page to reset the lab");

  if (kind === "cloud_fake") {
    const clear = day.map((h) => [wxAt(S, h).ghi / Math.max(clearSkyGhiHour(h, sys.lat, sys.lon), 1), h] as const).sort((a, b) => a[0] - b[0]);
    let [k, h] = clear[0];
    let why: string;
    if (k > 0.6) {
      h = [...day].sort((a, b) => clearSkyGhiHour(a, sys.lat, sys.lon) - clearSkyGhiHour(b, sys.lat, sys.lon))[0];
      why = "a low-sun hour";
    } else why = `an hour with only ${Math.round(k * 100)}% of clear-sky sunshine`;
    const best = Math.max(...day.map((x) => clearSkyCeilingWh(sys, x))) / 1.15;
    const claim = Math.floor(Math.min(best * 0.9, sys.capacityW * 1.05));
    const r = { device: dev, hourStart: h, energyWh: claim, nonce: nextNonce(S, dev) };
    return { reading: r, signature: await signReading(S, key, r), note: `Claimed ${claim.toLocaleString()} Wh, a clear midday's output, for ${why}.` };
  }

  const h = day.find((x) => wxAt(S, x).ghi > 150) ?? day[0];
  const wx = wxAt(S, h);
  const trueWh = Math.max(1, honestWh(S, h, wx));
  const typical = Math.max(1, Math.floor(pvEnergyWh(sys, h, wx.ghi, wx.temp_c)[0] * lab.profile.health));

  if (kind === "honest") {
    const r = { device: dev, hourStart: h, energyWh: trueWh, nonce: nextNonce(S, dev) };
    return { reading: r, signature: await signReading(S, key, r), note: `True output ${trueWh.toLocaleString()} Wh.` };
  }
  if (kind === "inflated") {
    const claim = Math.floor(Math.min(typical * 2.2, sys.capacityW * 1.09));
    const r = { device: dev, hourStart: h, energyWh: claim, nonce: nextNonce(S, dev) };
    return { reading: r, signature: await signReading(S, key, r), note: `Real output about ${typical.toLocaleString()} Wh; the meter signed ${claim.toLocaleString()} Wh.` };
  }
  if (kind === "tampered") {
    const r = { device: dev, hourStart: h, energyWh: typical, nonce: nextNonce(S, dev) };
    const sig = await signReading(S, key, r);
    const t = { ...r, energyWh: Math.floor(typical * 1.8) };
    return { reading: t, signature: sig, note: `Meter signed ${typical.toLocaleString()} Wh; value changed to ${t.energyWh.toLocaleString()} Wh in transit.` };
  }
  const rogueKey = keccak256(toHex(`rogue-${Date.now()}-${Math.random()}`)) as Hex;
  const rogue = privateKeyToAccount(rogueKey);
  if (kind === "forged") {
    const r = { device: dev, hourStart: h, energyWh: typical, nonce: nextNonce(S, dev) };
    return { reading: r, signature: await signReading(S, rogueKey, r), note: `Signed by attacker key ${rogue.address.slice(0, 10)}…` };
  }
  if (kind === "unregistered") {
    const r = { device: rogue.address, hourStart: h, energyWh: typical, nonce: 1 };
    return { reading: r, signature: await signReading(S, rogueKey, r), note: `Rogue device ${rogue.address.slice(0, 10)}… with a valid self-signature.` };
  }
  throw new Error(`unknown attack ${kind}`);
}

async function runAttack(S: State, kind: string) {
  const sub = await buildAttack(S, kind);
  const v = await processReading(S, sub.reading, sub.signature as Hex, kind, sub.note);
  return { ...v, scenario: S.snap.attacks.attacks[kind] };
}

/** The seven gates, mirroring verifier/engine.py. */
async function processReading(S: State, r: any, signature: Hex, label: string, note: string) {
  const rh = readingStructHash({ device: r.device, hourStart: BigInt(r.hourStart), energyWh: BigInt(r.energyWh), nonce: BigInt(r.nonce) });
  const devMeta = S.snap.chain.devices[Object.keys(S.snap.chain.devices).find((k) => k.toLowerCase() === r.device.toLowerCase()) ?? ""];
  const base: V = {
    id: S.nextVerdictId++,
    created_at: Math.floor(Date.now() / 1000),
    device: r.device,
    device_name: devMeta?.name ?? null,
    hour_start: r.hourStart,
    energy_wh: r.energyWh,
    nonce: r.nonce,
    device_sig: signature,
    reading_hash: rh,
    label,
    note,
    score_bps: 0,
    expected_wh: null,
    ceiling_wh: null,
    ratio: null,
    components: null,
    attestation: null,
    verifier_sig: null,
    cosigners: null,
    tx_hash: null,
    certificate_id: null,
    batch_id: null,
    merkle: null,
  };
  const finish = (status: string, reasons: any[], extra: any = {}) => {
    const v = { ...base, status, reasons, ...extra };
    S.verdicts.unshift(v);
    return v;
  };
  const reject = (code: string, message: string, extra: any = {}) => finish("REJECTED", [{ code, severity: "critical", message }], extra);

  // 1 signature
  let signer = "";
  try {
    signer = await recoverTypedDataAddress({
      domain: domainOf(S),
      types: READING_TYPES,
      primaryType: "Reading",
      message: { device: r.device, hourStart: BigInt(r.hourStart), energyWh: BigInt(r.energyWh), nonce: BigInt(r.nonce) },
      signature,
    });
  } catch {}
  if (signer.toLowerCase() !== r.device.toLowerCase())
    return reject("SIGNATURE_INVALID", "The signature does not match this meter's key. The reading was forged or altered after the meter signed it.");
  // 2 identity
  if (!devMeta) return reject("UNREGISTERED_DEVICE", "This meter key is not in the on-chain device registry.");
  if (!devMeta.active) return reject("DEVICE_REVOKED", "This meter has been revoked in the on-chain registry.");
  const a = r.device.toLowerCase();
  // 3 risk
  if (S.suspended.primary.has(a))
    return finish("SUSPENDED", [{ code: "METER_SUSPENDED", severity: "high", message: "Meter suspended pending physical audit: sustained over-reporting (CUSUM)." }]);
  // 4 time
  const now = S.now();
  if (r.hourStart % 3600) return reject("HOUR_NOT_ALIGNED", "hourStart must be aligned to a UTC hour.");
  if (r.hourStart + 3600 > now) return reject("HOUR_NOT_FINISHED", "The hour has not finished yet.");
  // 5 uniqueness
  const existing = S.certificateOf.get(`${a}:${r.hourStart}`);
  if (existing)
    return reject("ALREADY_CERTIFIED", `This meter-hour was already certified as certificate #${existing}. Each Wh can be issued only once.`);
  const last = S.lastNonce[a] ?? 0;
  if (r.nonce <= last) return reject("NONCE_REUSED", `Nonce ${r.nonce} is not greater than the last used nonce ${last} (replay).`);

  // 6 physics + AI (primary) — the peer independently repeats this with its own state
  const sys = { capacityW: devMeta.capacityW, lat: devMeta.latE6 / 1e6, lon: devMeta.lonE6 / 1e6 };
  const wx = wxAt(S, r.hourStart);
  const as = assess(S.forest, r.energyWh, sys, r.hourStart, wx, S.history);
  const cus = cusumUpdate(S.cusum.primary.get(a) ?? 0, as.evidenceZ);
  S.cusum.primary.set(a, cus);
  const reasons = [...as.reasons];
  let status: string = as.status;
  if (cus > MODEL.CUSUM_H) {
    S.suspended.primary.add(a);
    reasons.push({ code: "METER_SUSPENDED", severity: "high", message: "Sequential fraud detector (CUSUM) crossed its threshold: this meter has over-reported persistently. Further attestations are paused pending a physical audit." });
    if (status === "ACCEPTED") status = "HELD";
  }
  const extra = {
    score_bps: as.scoreBps,
    expected_wh: Math.round(as.expectedWh * 10) / 10,
    ceiling_wh: Math.round(as.ceilingWh * 10) / 10,
    ratio: Math.round(as.ratio * 1e4) / 1e4,
    ghi: Math.round(wx.ghi * 10) / 10,
    poa: Math.round(as.poa * 10) / 10,
    temp_c: Math.round(wx.temp_c * 10) / 10,
    cloud_cover: wx.cloud_cover,
    clear_sky_ghi: Math.round(as.clearSkyGhi * 10) / 10,
    weather_source: wx.source,
    components: as.components,
    features: as.features,
    evidence_z: as.evidenceZ,
    cusum: Math.round(cus * 1000) / 1000,
  };
  if (status !== "ACCEPTED") return finish(status, reasons, extra);

  // 7 attest + co-sign + mint (mint simulated)
  const keys = S.snap.lab.verifierKeys;
  const att = { readingHash: rh, expectedWh: Math.round(as.expectedWh), scoreBps: as.scoreBps, modelHash: S.snap.health.model.hash, issuedAt: now };
  const signAtt = (k: Hex, x: typeof att) =>
    privateKeyToAccount(k).signTypedData({
      domain: domainOf(S),
      types: ATTESTATION_TYPES,
      primaryType: "Attestation",
      message: { readingHash: x.readingHash as Hex, expectedWh: BigInt(x.expectedWh), scoreBps: x.scoreBps, modelHash: x.modelHash as Hex, issuedAt: BigInt(x.issuedAt) },
    });
  const vsig = await signAtt(hexKey(keys.primary), att);

  // peer verifier: its own CUSUM state, same model
  const pc = cusumUpdate(S.cusum.peer.get(a) ?? 0, as.evidenceZ);
  S.cusum.peer.set(a, pc);
  const peer = privateKeyToAccount(hexKey(keys.peer));
  let cosigners: any[];
  if (S.suspended.peer.has(a) || pc > MODEL.CUSUM_H) {
    S.suspended.peer.add(a);
    cosigners = [{ url: "verifier B", ok: false, verifier: peer.address, reason: "Meter suspended pending physical audit." }];
  } else {
    const patt = { ...att };
    cosigners = [{ url: "verifier B", ok: true, verifier: peer.address, score_bps: as.scoreBps, expected_wh: att.expectedWh, attestation: patt, signature: await signAtt(hexKey(keys.peer), patt) }];
  }
  const okCount = 1 + cosigners.filter((c) => c.ok).length;
  if (okCount < S.snap.chain.threshold) {
    reasons.push({ code: "PEER_DISAGREED", severity: "medium", message: `Only ${okCount} of the ${S.snap.chain.threshold} required independent verifiers attested. ${cosigners[0].verifier.slice(0, 10)}…: ${cosigners[0].reason}` });
    return finish("HELD", reasons, { ...extra, attestation: att, verifier_sig: vsig, cosigners });
  }
  const id = S.nextCertId++;
  const primaryAddr = privateKeyToAccount(hexKey(keys.primary)).address;
  const first = BigInt(primaryAddr) < BigInt(peer.address) ? primaryAddr : peer.address;
  S.certs[id] = {
    device: r.device,
    producer: devMeta.owner,
    verifier: first,
    hourStart: String(r.hourStart),
    energyWh: String(r.energyWh),
    expectedWh: String(att.expectedWh),
    scoreBps: String(as.scoreBps),
    issuedAt: String(now),
    readingHash: rh,
    modelHash: att.modelHash,
    verifierCount: String(okCount),
  };
  S.certificateOf.set(`${a}:${r.hourStart}`, id);
  S.lastNonce[a] = r.nonce;
  S.retiredWhOf[id] = 0n;
  reasons.push({ code: "MULTI_VERIFIED", severity: "ok", message: `Independently confirmed by ${okCount} verifiers. Minting simulated in this browser demo.` });
  return finish("ACCEPTED", reasons, {
    ...extra,
    attestation: att,
    verifier_sig: vsig,
    cosigners,
    certificate_id: id,
    tx_hash: keccak256(toHex(`simulated-mint-${id}`)),
  });
}

// ───────────────────────────── chain mock ─────────────────────────────
export function demoPublicClient() {
  const big = (x: any) => BigInt(x);
  return {
    async readContract({ functionName, args = [] }: { functionName: string; args?: any[] }) {
      const S = await loadDemo();
      const c = S.snap.chain;
      switch (functionName) {
        case "getCertificate": {
          const x = S.certs[String(args[0])];
          if (!x) return { device: "0x0000000000000000000000000000000000000000" };
          return { ...x, hourStart: big(x.hourStart), energyWh: big(x.energyWh), expectedWh: big(x.expectedWh), scoreBps: Number(x.scoreBps), issuedAt: big(x.issuedAt), verifierCount: Number(x.verifierCount) };
        }
        case "retiredWhOf":
          return S.retiredWhOf[String(args[0])] ?? 0n;
        case "getDevice": {
          const k = Object.keys(c.devices).find((d) => d.toLowerCase() === String(args[0]).toLowerCase());
          const d = k ? c.devices[k] : null;
          return d ? { ...d, registeredAt: big(d.registeredAt), capacityW: d.capacityW } : { registeredAt: 0n, active: false, name: "", capacityW: 0 };
        }
        case "VERIFIER_ROLE":
          return c.verifierRole;
        case "hasRole":
          return c.verifiers.some((v: string) => v.toLowerCase() === String(args[1]).toLowerCase());
        case "attestationThreshold":
          return c.threshold;
        case "getAuditBatch":
          return c.auditBatches[String(args[0])];
        case "listingCount":
          return BigInt(S.listings.length);
        case "getListing": {
          const l = S.listings[Number(args[0])];
          return { ...l, certificateId: big(l.certificateId), remainingWh: big(l.remainingWh), priceWeiPerWh: big(l.priceWeiPerWh) };
        }
      }
      throw new Error(`demo chain: ${functionName} not supported`);
    },
    async getLogs({ args }: { args?: { certificateId?: bigint } }) {
      const S = await loadDemo();
      return S.retirements
        .filter((r) => args?.certificateId == null || BigInt(r.certificateId) === args.certificateId)
        .map((r) => ({
          args: { ...r, retirementId: big(r.retirementId), certificateId: big(r.certificateId), amountWh: big(r.amountWh) },
          blockNumber: big(r.timestamp), // the demo uses timestamps as block numbers
          transactionHash: r.tx,
        }));
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      return { timestamp: blockNumber };
    },
    async getBalance() {
      return 10n ** 22n;
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
  };
}

export const DEMO_BUYER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Hex;

export function demoWalletClient() {
  return {
    async writeContract({ functionName, args, value }: any) {
      const S = await loadDemo();
      if (functionName !== "buy") throw new Error("only market purchases are supported in the demo");
      const [lid, wh, retire, beneficiary, purpose] = args;
      const l = S.listings[Number(lid)];
      if (!l?.active) throw new Error("listing is no longer active");
      if (BigInt(l.remainingWh) < wh) throw new Error("not enough energy left in this listing");
      if (wh * BigInt(l.priceWeiPerWh) !== value) throw new Error("wrong payment");
      l.remainingWh = String(BigInt(l.remainingWh) - wh);
      if (BigInt(l.remainingWh) === 0n) l.active = false;
      const tx = keccak256(toHex(`simulated-buy-${Date.now()}`));
      if (retire) {
        S.retirements.push({
          retirementId: String(S.retirements.length),
          certificateId: l.certificateId,
          onBehalfOf: DEMO_BUYER,
          retiredBy: S.snap.health.contracts.CertificateMarket,
          amountWh: String(wh),
          beneficiary,
          purpose,
          timestamp: String(S.now()),
          tx,
        });
        S.retiredWhOf[l.certificateId] = (S.retiredWhOf[l.certificateId] ?? 0n) + wh;
      }
      return tx;
    },
  };
}
