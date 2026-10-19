import type { Verdict } from "@/lib/api";
import { STATIC_DEMO } from "@/lib/runtime";

export const GATES = [
  { name: "Signature", fail: "the signature doesn't belong to the registered meter key", detail: "The registered meter key signed exactly these numbers" },
  { name: "Identity", fail: "this meter isn't registered and active on-chain", detail: "Meter is registered and active on-chain" },
  { name: "Risk", fail: "this meter is suspended for sustained over-reporting", detail: "Meter isn't suspended for sustained over-reporting" },
  { name: "Time", fail: "the hour isn't finished, aligned to the hour, or recent enough", detail: "Hour is finished, aligned and recent" },
  { name: "Uniqueness", fail: "this meter-hour was already certified, or the nonce was reused", detail: "Meter-hour never certified before; nonce is fresh" },
  { name: "Physics + AI", fail: "the claim isn't plausible for the sky over that site that hour", detail: "Plausible against independent satellite irradiance" },
  { name: "Consensus", fail: "not enough independent verifiers agreed, or the contract refused to mint", detail: "Independent verifiers co-sign; the contract re-checks every signature and mints" },
];

const CODE_GATE: Record<string, number> = {
  SIGNATURE_INVALID: 0,
  UNREGISTERED_DEVICE: 1,
  DEVICE_REVOKED: 1,
  METER_SUSPENDED: 2,
  HOUR_NOT_ALIGNED: 3,
  HOUR_NOT_FINISHED: 3,
  READING_TOO_OLD: 3,
  ZERO_ENERGY: 3,
  ALREADY_CERTIFIED: 4,
  NONCE_REUSED: 4,
  NIGHT_GENERATION: 5,
  ABOVE_CLEAR_SKY_CEILING: 5,
  OVER_PRODUCTION: 5,
  PERFORMANCE_JUMP: 5,
  ANOMALY_DETECTED: 5,
  HELD_FOR_REVIEW: 5,
  ONCHAIN_REVERT: 6,
  PEER_DISAGREED: 6,
};

export function stoppedAt(v: Verdict): number | null {
  if (v.status === "ACCEPTED") return null;
  if (v.status === "SUSPENDED") return 2;
  const gates = v.reasons.map((r) => CODE_GATE[r.code]).filter((g) => g != null);
  return gates.length ? Math.min(...gates) : 5;
}

/** The seven checks every reading passes through, with the one that stopped it marked. */
export function GatePipeline({ verdict }: { verdict: Verdict | null }) {
  const stop = verdict ? stoppedAt(verdict) : null;
  const accepted = verdict?.status === "ACCEPTED";
  const held = verdict?.status === "HELD";
  const caption = !verdict
    ? "Every reading passes these seven checks in order."
    : accepted
    ? STATIC_DEMO
      ? "Passed all seven checks and both verifiers signed. Minting is simulated in this browser demo."
      : "Passed all seven checks. The contract minted a certificate."
    : held
    ? `Held at check ${stop! + 1}: plausibility is just below the issuance threshold, so it waits for review.`
    : `Stopped at check ${stop! + 1}: ${GATES[stop!].fail}.`;
  return (
    <div>
      <ol className="grid grid-cols-4 gap-px overflow-hidden rounded-lg bg-rule sm:grid-cols-7">
        {GATES.map((g, i) => {
          let state: "idle" | "pass" | "stop" | "skip" = "idle";
          if (verdict) {
            if (accepted || (stop !== null && i < stop)) state = "pass";
            else if (i === stop) state = "stop";
            else state = "skip";
          }
          const cls =
            state === "stop" ? (held ? "bg-held text-white" : "bg-reject text-white") : state === "skip" ? "bg-panel text-muted" : "bg-panel";
          return (
            <li key={g.name} title={g.detail} className={`${cls} flex min-h-[64px] flex-col justify-between px-2.5 py-2 transition-colors duration-300`} aria-current={state === "stop" ? "step" : undefined}>
              <div className="flex items-center justify-between text-[13px]">
                <span className={state === "stop" ? "" : "text-muted"}>{i + 1}</span>
                {state === "pass" && <span className="text-ok" aria-label="passed">✓</span>}
                {state === "stop" && <span aria-label="stopped here">{held ? "‖" : "✕"}</span>}
              </div>
              <span className="narrow text-[15px] font-semibold leading-tight">{g.name}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[14px] text-muted">{caption}</p>
    </div>
  );
}
