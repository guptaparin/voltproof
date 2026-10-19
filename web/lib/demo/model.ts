/**
 * TypeScript port of the VoltProof verifier (vpcore/solar.py, vpcore/production.py,
 * verifier/model.py). Used by the in-browser live demo. `scripts/parity.mjs` checks that it
 * produces the same scores as the Python verifier.
 */

// ───────────────────────────── solar physics ─────────────────────────────
const SOLAR_CONSTANT = 1361.0;
export const HOUR = 3600;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export type Sun = { zenith: number; azimuth: number; e0: number; cosZ: number };

function dayOfYear(d: Date) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86400000) + 1;
}

export function sunPosition(ts: number, lat: number, lon: number): Sun {
  const dt = new Date(ts * 1000);
  const doy = dayOfYear(dt);
  const hour = dt.getUTCHours() + dt.getUTCMinutes() / 60 + dt.getUTCSeconds() / 3600;
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (hour - 12) / 24);
  const eqtime =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tsm = hour * 60 + eqtime + 4 * lon;
  const ha = rad(tsm / 4 - 180);
  const la = rad(lat);
  let cz = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
  cz = Math.max(-1, Math.min(1, cz));
  const zen = Math.acos(cz);
  const sz = Math.sin(zen);
  let az: number;
  if (sz < 1e-6) az = 180;
  else {
    const caz = (Math.sin(decl) - Math.sin(la) * cz) / (Math.cos(la) * sz);
    az = deg(Math.acos(Math.max(-1, Math.min(1, caz))));
    if (ha > 0) az = 360 - az;
  }
  const e0 = SOLAR_CONSTANT * (1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365));
  const zd = deg(zen);
  return { zenith: zd, azimuth: az, e0, cosZ: Math.cos(rad(zd)) };
}

export function clearSkyGhi(ts: number, lat: number, lon: number) {
  const cz = sunPosition(ts, lat, lon).cosZ;
  return cz <= 0 ? 0 : 1098.0 * cz * Math.exp(-0.059 / cz);
}

export function clearSkyGhiHour(h: number, lat: number, lon: number, samples = 12) {
  const step = HOUR / samples;
  let s = 0;
  for (let i = 0; i < samples; i++) s += clearSkyGhi(h + (i + 0.5) * step, lat, lon);
  return s / samples;
}

function poaFromGhi(ghi: number, sun: Sun, tilt: number, azimuth: number, albedo = 0.2) {
  const cz = sun.cosZ;
  if (ghi <= 0 || cz <= 0.01) return 0;
  const kt = Math.min(1, ghi / (sun.e0 * cz));
  let df: number;
  if (kt <= 0.22) df = 1 - 0.09 * kt;
  else if (kt <= 0.8) df = 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  else df = 0.165;
  const dhi = ghi * df;
  const dni = Math.max(0, (ghi - dhi) / cz);
  const b = rad(tilt);
  const z = rad(sun.zenith);
  const cosAoi = Math.cos(z) * Math.cos(b) + Math.sin(z) * Math.sin(b) * Math.cos(rad(sun.azimuth - azimuth));
  return dni * Math.max(0, cosAoi) + (dhi * (1 + Math.cos(b))) / 2 + (ghi * albedo * (1 - Math.cos(b))) / 2;
}

export type PVSystem = { capacityW: number; lat: number; lon: number; pr?: number; tempCoeff?: number };

export function pvEnergyWh(sys: PVSystem, h: number, ghiMean: number, tempC: number, samples = 6): [number, number] {
  const pr = sys.pr ?? 0.86;
  const tc = sys.tempCoeff ?? -0.0037;
  const tilt = Math.abs(sys.lat);
  const az = sys.lat >= 0 ? 180 : 0;
  const step = HOUR / samples;
  const times = Array.from({ length: samples }, (_, i) => h + (i + 0.5) * step);
  const cs = times.map((t) => clearSkyGhi(t, sys.lat, sys.lon));
  const csMean = cs.reduce((a, b) => a + b, 0) / samples;
  if (csMean <= 0 || ghiMean <= 0) return [0, 0];
  let energy = 0;
  let poaTotal = 0;
  times.forEach((t, i) => {
    const g = ghiMean * (cs[i] / csMean);
    const poa = poaFromGhi(g, sunPosition(t, sys.lat, sys.lon), tilt, az);
    const tCell = tempC + ((45 - 20) / 800) * poa;
    const dc = sys.capacityW * (poa / 1000) * (1 + tc * (tCell - 25));
    energy += Math.min(Math.max(dc, 0) * pr, sys.capacityW) * (step / HOUR);
    poaTotal += poa;
  });
  return [energy, poaTotal / samples];
}

export function clearSkyCeilingWh(sys: PVSystem, h: number, margin = 1.15) {
  const g = clearSkyGhiHour(h, sys.lat, sys.lon);
  const [e] = pvEnergyWh({ ...sys, pr: 1.0, tempCoeff: 0 }, h, g, 25);
  return Math.min(e * margin, (sys.capacityW * 11) / 10);
}

export function localIrradianceErrorSigma(cloud: number | null) {
  if (cloud == null) return 0.15;
  const c = Math.max(0, Math.min(1, cloud / 100));
  return 0.05 + 0.22 * 4 * c * (1 - c);
}

// ───────────────────────────── verification model ─────────────────────────────
export const MODEL = {
  W_PHYSICS: 0.5,
  W_ANOMALY: 0.25,
  W_CONSISTENCY: 0.25,
  ACCEPT_BPS: 7000,
  HOLD_BPS: 5000,
  PRIOR_RATIO: 0.95,
  SIGMA_FLOOR: 0.07,
  SIGMA_INFLATION: 1.1,
  Z_FREE: 1.5,
  CUSUM_K: 1.0,
  CUSUM_H: 18.0,
};

export type Forest = {
  starts: number[];
  left: Int32Array;
  right: Int32Array;
  val: Float64Array; // threshold for internal nodes, path-length correction for leaves
  feat: Int8Array;
  norm: number;
  offset: number;
  calib: [number, number];
};

export function decodeForest(meta: { starts: number[]; n: number; norm: number; offset: number; calib: [number, number] }, buf: ArrayBuffer): Forest {
  const n = meta.n;
  return {
    starts: meta.starts,
    left: new Int32Array(buf, 0, n),
    right: new Int32Array(buf, 4 * n, n),
    val: new Float64Array(buf, 8 * n, n),
    feat: new Int8Array(buf, 16 * n, n),
    norm: meta.norm,
    offset: meta.offset,
    calib: meta.calib,
  };
}

function decision(f: Forest, x: number[]) {
  let total = 0;
  const T = f.starts.length;
  for (let t = 0; t < T; t++) {
    const base = f.starts[t];
    let node = 0;
    let depth = 0;
    while (f.left[base + node] !== -1) {
      node = x[f.feat[base + node]] <= f.val[base + node] ? f.left[base + node] : f.right[base + node];
      depth++;
    }
    total += depth + f.val[base + node];
  }
  const mean = total / T;
  return -(2 ** (-mean / f.norm)) - f.offset;
}

export function anomalyScore(f: Forest, x: number[]) {
  const d = decision(f, x);
  const [lo, spread] = f.calib;
  return 1 / (1 + Math.exp(-(d - lo) / (0.25 * spread)));
}

/** Python's round(): half to even. */
export function pyRound(x: number) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export type Weather = { ghi: number; temp_c: number; cloud_cover: number | null; source: string };
export type Reason = { code: string; severity: "ok" | "info" | "medium" | "high" | "critical"; message: string };

export function assess(forest: Forest, energyWh: number, sys: PVSystem, h: number, wx: Weather, history: number[]) {
  const M = MODEL;
  const cap = sys.capacityW;
  const [expected, poa] = pvEnergyWh(sys, h, wx.ghi, wx.temp_c);
  const ceiling = clearSkyCeilingWh(sys, h);
  const csGhi = clearSkyGhiHour(h, sys.lat, sys.lon);
  const reasons: Reason[] = [];
  const reason = (code: string, severity: Reason["severity"], message: string) => reasons.push({ code, severity, message });
  const ratio = (energyWh + 0.01 * cap) / (expected + 0.01 * cap);

  let hard = false;
  if (csGhi < 2 && energyWh > 0.02 * cap) {
    hard = true;
    reason("NIGHT_GENERATION", "critical", `Sun is below the horizon at this site for the whole hour, yet ${fmt(energyWh)} Wh was claimed.`);
  } else if (energyWh > ceiling) {
    hard = true;
    reason("ABOVE_CLEAR_SKY_CEILING", "critical", `${fmt(energyWh)} Wh exceeds the physical maximum of ${fmt(ceiling)} Wh for a cloudless sky at this hour and location.`);
  }

  const sigma = Math.hypot(M.SIGMA_FLOOR, localIrradianceErrorSigma(wx.cloud_cover)) * M.SIGMA_INFLATION;
  let devRatio = M.PRIOR_RATIO;
  let nHist = 0;
  if (history.length >= 6) {
    devRatio = Math.min(Math.max(median(history), 0.5), M.PRIOR_RATIO * 1.08);
    nHist = history.length;
  }

  const z = Math.log(ratio / Math.min(devRatio, M.PRIOR_RATIO)) / sigma;
  let physics: number;
  if (expected < 0.02 * cap && energyWh < 0.04 * cap) physics = 1;
  else if (z <= 0) {
    physics = 1;
    if (ratio < 0.55) reason("UNDER_PRODUCTION", "info", `Output is ${Math.round(ratio * 100)}% of expected — possible shading, soiling or a fault. Accepted (under-reporting cannot inflate credits).`);
  } else {
    physics = Math.exp(-0.5 * Math.max(0, z - M.Z_FREE) ** 2);
    if (physics < 0.6)
      reason(
        "OVER_PRODUCTION",
        physics < 0.2 ? "high" : "medium",
        `Claimed ${fmt(energyWh)} Wh is ${ratio.toFixed(2)}× the ${fmt(expected)} Wh expected from measured irradiance (${wx.ghi.toFixed(0)} W/m², ${wx.cloud_cover != null ? wx.cloud_cover.toFixed(0) : "?"}% cloud) — ${z.toFixed(1)}σ above what this sky allows.`
      );
  }

  const drift = Math.log(ratio) - Math.log(devRatio);
  const consistency = drift <= sigma ? 1 : Math.exp(-0.5 * ((drift - sigma) / sigma) ** 2);
  if (consistency < 0.6 && nHist)
    reason("PERFORMANCE_JUMP", "medium", `This meter usually delivers ${devRatio.toFixed(2)}× expected (median of ${nHist} verified hours); this hour claims ${ratio.toFixed(2)}×.`);

  const eps = 0.01 * cap;
  const lr = Math.log((energyWh + eps) / (expected + eps));
  const feats = [lr, energyWh / cap, expected / cap, lr - Math.log(devRatio), (wx.cloud_cover ?? 50) / 100];
  const anomaly = anomalyScore(forest, feats);
  if (anomaly < 0.4)
    reason("ANOMALY_DETECTED", "medium", `Isolation-forest anomaly score ${anomaly.toFixed(2)}: this combination of output, irradiance and cloud is rare among honest meters.`);

  let score = M.W_PHYSICS * physics + M.W_ANOMALY * anomaly + M.W_CONSISTENCY * consistency;
  if (physics < 0.15) score = Math.min(score, 0.45);
  let scoreBps = pyRound(score * 10000);
  let status: "ACCEPTED" | "HELD" | "REJECTED";
  if (hard) {
    status = "REJECTED";
    scoreBps = Math.min(scoreBps, 1000);
  } else if (scoreBps >= M.ACCEPT_BPS) status = "ACCEPTED";
  else if (scoreBps >= M.HOLD_BPS) {
    status = "HELD";
    reason("HELD_FOR_REVIEW", "medium", "Plausibility below the issuance threshold; held for re-evaluation with more data.");
  } else status = "REJECTED";

  if (status === "ACCEPTED" && !reasons.some((r) => ["medium", "high", "critical"].includes(r.severity)))
    reason("CONSISTENT", "ok", `Matches satellite irradiance of ${wx.ghi.toFixed(0)} W/m² (${ratio.toFixed(2)}× expected).`);

  let evidenceZ = expected > 0.05 * cap ? Math.log(ratio / M.PRIOR_RATIO) / sigma : 0;
  if (hard) evidenceZ = 6;

  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  return {
    status,
    scoreBps,
    expectedWh: expected,
    ceilingWh: ceiling,
    clearSkyGhi: csGhi,
    poa,
    ratio,
    components: { physics: r4(physics), anomaly: r4(anomaly), consistency: r4(consistency) },
    reasons,
    features: feats,
    evidenceZ: r4(evidenceZ),
    sigma: r4(sigma),
  };
}

export function cusumUpdate(s: number, z: number) {
  return Math.max(0, s + Math.min(z, 6) - MODEL.CUSUM_K);
}
