"use client";
import { Offline } from "@/components/Status";
import { usePoll } from "@/lib/hooks";

type Scenario = {
  accepted: number;
  held: number;
  rejected: number;
  suspended_hours: number;
  meters_suspended: number;
  median_daylight_hours_to_suspension: number | null;
  certified_wh_vs_honest: number;
};
type Eval = {
  model: string;
  meters: number;
  daylight_hours_per_meter: number;
  scenarios: Record<string, Scenario>;
  attacks: Record<string, { accepted: number; held: number; rejected: number; n: number }>;
};

const THREATS: [string, string, string][] = [
  ["A meter's owner inflates readings", "Physics + AI score against satellite irradiance; CUSUM suspends persistent over-reporters; nameplate cap enforced in the contract", "Inflation under ~10% can hide in weather noise; it gains at most ~9% and is bounded by periodic physical audits"],
  ["Someone alters a reading in transit", "EIP-712 signature binds device, hour, energy and nonce; any change breaks it", "None"],
  ["An attacker impersonates a meter", "Signer must equal the registered device key", "Key extraction from the hardware: mitigated with secure boot, flash encryption or an ATECC608 secure element, plus on-chain revocation"],
  ["The same hour is certified twice", "Contract stores one certificate per meter-hour and a strictly increasing nonce", "None"],
  ["The same energy is claimed twice", "Retirement burns the tokens; burned Wh can't be transferred or retired again", "Off-chain double claims (e.g. also selling the same energy as a utility REC) need registry integration"],
  ["A verifier is compromised or colludes", "M-of-N: the contract requires attestations from several distinct verifiers (2-of-2 in this demo), each re-running every check with its own key, model and fraud history. The contract also re-checks the meter signature, uniqueness and nameplate cap, and every verdict is Merkle-anchored", "All M verifiers colluding at once; raise M and recruit verifiers with different incentives (DISCOMs, auditors, buyers)"],
  ["Someone steals certificates via the relayer", "Certificates always mint to the registered producer, whoever submits the transaction", "None"],
  ["Spam or denial of service against the verifier", "Signature checked first and cheaply; on-chain checks before weather lookups", "Production needs per-device rate limits"],
];

export default function ModelPage() {
  const { data, error } = usePoll<Eval>("/v1/eval", 0);
  if (error && !data) return <Offline error={error} />;
  const sc = data ? Object.entries(data.scenarios) : [];

  return (
    <>
      <section className="pt-8 sm:pt-12">
        <h1 className="display max-w-[18ch] text-[40px] font-[750] sm:text-[60px]">Why cheating doesn't pay</h1>
        <p className="mt-4 max-w-[66ch] text-[18px] text-muted">
          A blockchain only proves that someone wrote a number down. VoltProof also asks whether the number could be true:
          each claim is checked against the physics of that rooftop, the sky above it that hour, and the meter's own history.
        </p>
      </section>

      <section className="mt-12 grid gap-10 lg:grid-cols-3">
        <Layer title="Physics" body="Solar geometry gives a hard ceiling: no output after sunset, and never more than a cloudless sky allows at that site and hour. Independent irradiance and temperature (Open-Meteo) give the output a healthy array should have produced. The tolerance widens under broken cloud, where satellite estimates are least certain, so honest meters aren't punished for weather." />
        <Layer title="Learned anomaly detection" body="An isolation forest trained on 40,000 simulated honest meter-hours across India, including soiling, shading, seasons and realistic satellite-vs-rooftop disagreement. It flags combinations of output, irradiance and cloud that honest meters rarely produce." />
        <Layer title="Sequential evidence" body="A meter that inflates a little every hour can hide inside the noise of a single hour, but not for weeks. A CUSUM detector accumulates each meter's standardised over-claims and suspends it once the evidence is overwhelming. The on-chain record then shows exactly when and why." />
      </section>

      {data && (
        <section className="mt-14" aria-labelledby="econ-h">
          <h2 id="econ-h" className="wide text-[20px] font-semibold">Certified energy a cheater earns, relative to its honest twin</h2>
          <p className="mt-1 max-w-[70ch] text-[15px] text-muted">
            {data.meters} unseen meters, each run for {data.daylight_hours_per_meter} daylight hours alongside identical twins that
            over-report every reading by a fixed factor. Below the line, lying earns fewer certificates than telling the truth.
          </p>
          <Economics rows={sc} />

          <table className="mt-8 w-full text-[15px]">
            <thead className="text-left text-[13px] text-muted">
              <tr>
                <th className="py-2 font-normal">Meter reports</th>
                <th className="py-2 text-right font-normal">Hours certified</th>
                <th className="py-2 text-right font-normal">Refused or held</th>
                <th className="py-2 text-right font-normal">Meters suspended</th>
                <th className="hidden py-2 text-right font-normal sm:table-cell">Daylight hours until suspended</th>
              </tr>
            </thead>
            <tbody>
              {sc.map(([k, v]) => (
                <tr key={k} className="num border-t border-rule">
                  <td className="py-2.5 font-semibold">{k === "x1.0" ? "The truth" : `${k.slice(1)}× the truth`}</td>
                  <td className="py-2.5 text-right">{(v.accepted * 100).toFixed(1)}%</td>
                  <td className="py-2.5 text-right">{((v.rejected + v.held) * 100).toFixed(1)}%</td>
                  <td className="py-2.5 text-right">{(v.meters_suspended * 100).toFixed(0)}%</td>
                  <td className="hidden py-2.5 text-right sm:table-cell">{v.median_daylight_hours_to_suspension ?? "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[14px] text-muted">
            Night-time claims: {(data.attacks.night_generation.rejected * 100).toFixed(0)}% rejected. Full-sun claims under heavy
            cloud: {(data.attacks.full_sun_under_heavy_cloud.rejected * 100).toFixed(1)}% rejected. Weather in this evaluation is a
            synthetic physical model; reproduce it with <code>python -m verifier.evaluate</code>.
          </p>
        </section>
      )}

      <section className="mt-14" aria-labelledby="threat-h">
        <h2 id="threat-h" className="wide mb-3 text-[20px] font-semibold">Threat model</h2>
        <table className="w-full text-[15px]">
          <thead className="text-left text-[13px] text-muted">
            <tr>
              <th className="w-[26%] py-2 pr-4 font-normal">Attack</th>
              <th className="py-2 pr-4 font-normal">Defence</th>
              <th className="hidden w-[30%] py-2 font-normal md:table-cell">What's left</th>
            </tr>
          </thead>
          <tbody>
            {THREATS.map(([a, d, r]) => (
              <tr key={a} className="border-t border-rule align-top">
                <td className="py-3 pr-4 font-semibold">{a}</td>
                <td className="py-3 pr-4">{d}</td>
                <td className="hidden py-3 text-muted md:table-cell">{r}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Layer({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h2 className="wide text-[20px] font-semibold">{title}</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">{body}</p>
    </div>
  );
}

function Economics({ rows }: { rows: [string, Scenario][] }) {
  const W = 760, H = 220, pad = 34;
  const max = 1.2;
  const bw = (W - pad) / rows.length;
  const y = (v: number) => H - (Math.min(v, max) / max) * (H - 20);
  return (
    <svg viewBox={`0 0 ${W} ${H + 40}`} className="mt-5 h-auto w-full max-w-[860px]" role="img" aria-label="Certified energy relative to honest, by inflation factor">
      {rows.map(([k, v], i) => {
        const val = v.certified_wh_vs_honest;
        const x = pad + i * bw + bw * 0.18;
        const w = bw * 0.64;
        const honest = k === "x1.0";
        return (
          <g key={k}>
            <rect x={x} y={y(val)} width={w} height={H - y(val)} fill={honest ? "rgb(var(--sun))" : val > 1 ? "rgb(var(--held))" : "rgb(var(--reject))"} />
            <text x={x + w / 2} y={y(val) - 6} textAnchor="middle" fontSize={14} fontWeight={600} fill="rgb(var(--ink))">
              {val.toFixed(2)}×
            </text>
            <text x={x + w / 2} y={H + 20} textAnchor="middle" fontSize={13} fill="rgb(var(--muted))">
              {honest ? "honest" : k.replace("x", "×")}
            </text>
          </g>
        );
      })}
      <line x1={pad} x2={W} y1={y(1)} y2={y(1)} stroke="rgb(var(--ink))" strokeWidth={1.5} strokeDasharray="5 4" />
      <text x={0} y={y(1) + 4} fontSize={12} fill="rgb(var(--muted))">1.0×</text>
      <line x1={pad} x2={W} y1={H} y2={H} stroke="rgb(var(--ink))" strokeWidth={1.5} />
    </svg>
  );
}
