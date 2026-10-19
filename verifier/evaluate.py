"""Offline evaluation of the verification model.

Simulates a fresh fleet of meters (never seen in training) across India. Every meter is
run as several parallel "twins" under identical weather: one honest, and one per cheating
strategy that inflates *every* reading by a fixed factor for weeks. The verifier's full
policy is applied, including per-hour scoring and sequential (CUSUM) suspension.

Reported:
* honest false-reject / false-suspension rates,
* per-hour detection rate per inflation level,
* how fast persistent cheaters get suspended,
* the economics: certified Wh a cheater earns relative to its honest twin.
  Below 1.0× ⇒ cheating is strictly worse than telling the truth.

    python -m verifier.evaluate            # prints a table, writes eval/results.json
"""
from __future__ import annotations

import json
import random
import statistics
from collections import Counter
from pathlib import Path

from vpcore.production import MeterProfile, honest_energy_wh
from vpcore.solar import PVSystem, clear_sky_ceiling_wh, clear_sky_ghi_hour
from vpcore.weather import SyntheticProvider

from .model import CUSUM_H, VerificationModel, cusum_update

SCENARIOS = [1.0, 1.1, 1.2, 1.35, 1.5, 2.0, 3.0]


class Twin:
    def __init__(self, k: float):
        self.k = k
        self.status = Counter()
        self.history: list[float] = []
        self.cusum = 0.0
        self.suspended_at: int | None = None
        self.true_wh = 0
        self.cert_wh = 0


def run(n_meters: int = 80, daylight_hours: int = 300, seed: int = 4242, model: VerificationModel | None = None) -> dict:
    model = model or VerificationModel().train()
    rng = random.Random(seed)
    wx_src = SyntheticProvider(seed=seed)  # weather realisation unseen in training

    all_twins: dict[float, list[Twin]] = {k: [] for k in SCENARIOS}
    attacks = {"night_generation": Counter(), "full_sun_under_heavy_cloud": Counter()}

    for _ in range(n_meters):
        lat, lon = rng.uniform(8, 32), rng.uniform(70, 92)
        cap = rng.choice([2000, 3000, 5000, 10000, 25000])
        system = PVSystem(cap, lat, lon)
        meter = MeterProfile(system, health=rng.uniform(0.88, 1.02),
                             shading_utc_hours=(rng.randrange(2, 5),) if rng.random() < 0.2 else ())
        twins = {k: Twin(k) for k in SCENARIOS}
        h = 1767225600 + rng.randrange(0, 300) * 86400
        n = 0
        while n < daylight_hours:
            h += 3600
            if clear_sky_ghi_hour(h, lat, lon) < 30:
                continue
            n += 1
            wx = wx_src.hour(lat, lon, h)
            e = honest_energy_wh(meter, h, wx, rng)
            if e <= 0:
                continue
            for k, t in twins.items():
                claim = int(min(e * k, cap * 1.1))
                t.true_wh += e
                if t.suspended_at is not None:
                    t.status["SUSPENDED"] += 1
                    continue
                a = model.assess(claim, system, h, wx, t.history)
                t.status[a.status] += 1
                t.cusum = cusum_update(t.cusum, a.evidence_z)
                if a.status == "ACCEPTED":
                    t.cert_wh += claim
                    if a.expected_wh > 0.05 * cap:
                        t.history = (t.history + [a.ratio])[-48:]
                if t.cusum > CUSUM_H:
                    t.suspended_at = n

            if (wx.cloud_cover or 0) > 70:
                fs = int(clear_sky_ceiling_wh(system, h) / 1.15 * 0.92)
                attacks["full_sun_under_heavy_cloud"][model.assess(fs, system, h, wx, twins[1.0].history).status] += 1

        nh = h
        while clear_sky_ghi_hour(nh, lat, lon) > 0:
            nh += 3600
        attacks["night_generation"][model.assess(int(cap * 0.3), system, nh, wx_src.hour(lat, lon, nh), []).status] += 1
        for k, t in twins.items():
            all_twins[k].append(t)

    honest_cert = sum(t.cert_wh for t in all_twins[1.0])
    honest_true = sum(t.true_wh for t in all_twins[1.0])

    def summary(k: float) -> dict:
        ts = all_twins[k]
        c = sum((t.status for t in ts), Counter())
        tot = sum(c.values()) or 1
        susp = [t.suspended_at for t in ts if t.suspended_at is not None]
        return {
            "accepted": round(c["ACCEPTED"] / tot, 4),
            "held": round(c["HELD"] / tot, 4),
            "rejected": round(c["REJECTED"] / tot, 4),
            "suspended_hours": round(c["SUSPENDED"] / tot, 4),
            "meters_suspended": round(len(susp) / len(ts), 4),
            "median_daylight_hours_to_suspension": statistics.median(susp) if susp else None,
            "certified_wh_vs_honest": round(sum(t.cert_wh for t in ts) / max(honest_cert, 1), 4),
        }

    def rates(c: Counter) -> dict:
        n = sum(c.values()) or 1
        return {s.lower(): round(c[s] / n, 4) for s in ("ACCEPTED", "HELD", "REJECTED")} | {"n": sum(c.values())}

    return {
        "model": model.model_hash,
        "meters": n_meters,
        "daylight_hours_per_meter": daylight_hours,
        "honest_certified_share_of_true_energy": round(honest_cert / honest_true, 4),
        "scenarios": {f"x{k}": summary(k) for k in SCENARIOS},
        "attacks": {k: rates(v) for k, v in attacks.items()},
    }


def main():
    res = run()
    print(f"\nModel {res['model'][:18]}…  {res['meters']} unseen meters × {res['daylight_hours_per_meter']} daylight hours\n")
    print("scenario   accepted  held  rejected  suspended  meters-susp  hrs-to-susp  certified Wh vs honest")
    for k, v in res["scenarios"].items():
        hts = v["median_daylight_hours_to_suspension"]
        print(f"  {k:<7} {v['accepted']:>8.1%} {v['held']:>5.1%} {v['rejected']:>8.1%} {v['suspended_hours']:>9.1%}"
              f" {v['meters_suspended']:>11.0%} {('—' if hts is None else f'{hts:.0f}'):>11}     {v['certified_wh_vs_honest']:.2f}×")
    for k, v in res["attacks"].items():
        print(f"\n{k:28s} rejected {v['rejected']:.1%}  held {v['held']:.1%}  accepted {v['accepted']:.1%}  (n={v['n']})")
    out = Path(__file__).resolve().parent.parent / "eval"
    out.mkdir(exist_ok=True)
    (out / "results.json").write_text(json.dumps(res, indent=2))
    print(f"\nwrote {out / 'results.json'}")


if __name__ == "__main__":
    main()
