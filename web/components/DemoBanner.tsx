"use client";
import { useHealth } from "@/lib/hooks";
import { STATIC_DEMO } from "@/lib/runtime";

const REPO = process.env.NEXT_PUBLIC_REPO_URL;

/** Shown only on the static live-demo build, so nobody mistakes it for a live chain. */
export default function DemoBanner() {
  const { health } = useHealth() as { health: any };
  if (!STATIC_DEMO) return null;
  const when = health?.snapshotTakenAt ? new Date(health.snapshotTakenAt * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
  return (
    <div className="no-print bg-ink text-paper">
      <p className="mx-auto max-w-[1180px] px-4 py-2 text-[14px] leading-snug sm:px-6">
        <span className="font-semibold">Live demo, running in your browser. </span>
        Data is a snapshot of a real VoltProof testnet run{when && ` from ${when}`}. In the Attack lab, readings and attestations are
        really signed and checked, and scored by the same AI model; only the final mint is simulated.
        {REPO && (
          <>
            {" "}
            <a className="underline underline-offset-2" href={REPO}>Run the full stack yourself</a>.
          </>
        )}
      </p>
    </div>
  );
}
