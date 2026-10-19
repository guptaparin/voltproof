"""The VoltProof verification model: physics + learned anomaly detection.

A reading is scored on three independent signals, each in [0, 1]:

physics      How well the claimed energy agrees with the energy the panel *should* have
             produced given independent irradiance + temperature for that exact hour and
             location. Asymmetric: over-reporting is penalised hard (that is where fraud
             pays), under-reporting only gently (faults, shading and soiling are common and
             hurt only the producer).

anomaly      An Isolation Forest trained on hundreds of thousands of simulated *honest*
             meter-hours, covering realistic satellite-vs-rooftop disagreement, soiling,
             shading and seasonality. It learns the joint shape of normal readings, so it
             catches combinations no single rule would (e.g. full-sun output under heavy
             cloud at a modest ratio).

consistency  A meter's own track record. Each array has a stable performance signature;
             a sudden jump far above its historical ratio is suspicious even when it is
             within weather uncertainty.

score = 0.5·physics + 0.25·anomaly + 0.25·consistency, in basis points.
ACCEPT ≥ 7000 · HOLD 5000–6999 (needs more evidence / human review) · REJECT < 5000.
Hard physical violations (generation after sunset, above the clear-sky ceiling) reject
outright regardless of score.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
from dataclasses import dataclass

import numpy as np
from sklearn.ensemble import IsolationForest

from vpcore.production import MeterProfile, honest_energy_wh, local_irradiance_error_sigma
from vpcore.solar import PVSystem, clear_sky_ceiling_wh, clear_sky_ghi_hour, pv_energy_wh
from vpcore.weather import HourWeather, SyntheticProvider

MODEL_VERSION = "voltproof-verifier-1.3.0"
W_PHYSICS, W_ANOMALY, W_CONSISTENCY = 0.5, 0.25, 0.25
ACCEPT_BPS, HOLD_BPS = 7000, 5000
PRIOR_RATIO = 0.95  # typical measured/expected ratio of a healthy array
MODEL_SIGMA_FLOOR = 0.07  # PV-model + metering uncertainty, log units
SIGMA_INFLATION = 1.1
Z_FREE = 1.5  # claims within 1.5σ of the expectation carry no physics penalty
TRAIN_SAMPLES = 40_000
SEED = 7


def _avg_path(n: int) -> float:
    """Average path length of an unsuccessful BST search (Isolation Forest normaliser)."""
    if n <= 1:
        return 0.0
    if n == 2:
        return 1.0
    return 2.0 * (math.log(n - 1.0) + 0.5772156649) - 2.0 * (n - 1.0) / n


def _log_ratio(energy: float, expected: float, cap: float) -> float:
    eps = 0.01 * cap
    return math.log((energy + eps) / (expected + eps))


def features(energy: float, expected: float, cap: float, cloud: float | None, device_log_ratio: float) -> list[float]:
    lr = _log_ratio(energy, expected, cap)
    return [lr, energy / cap, expected / cap, lr - device_log_ratio, (cloud if cloud is not None else 50.0) / 100]


@dataclass
class Assessment:
    status: str  # ACCEPTED | HELD | REJECTED
    score_bps: int
    expected_wh: float
    ceiling_wh: float
    clear_sky_ghi: float
    poa: float
    ratio: float
    components: dict
    reasons: list[dict]
    features: list[float]
    evidence_z: float = 0.0  # standardised over-claim vs a healthy array; feeds the CUSUM
    sigma: float = 0.0


# ── sequential fraud detection ───────────────────────────────────────────────
# A meter that inflates a little every hour can hide inside weather noise for any single
# hour, but not for long. We run a one-sided CUSUM over each meter's standardised
# over-claim z: S ← max(0, S + z − K). When S crosses H the meter is suspended (no more
# attestations) and flagged for physical audit / on-chain revocation.
CUSUM_K = 1.0
CUSUM_H = 18.0


def cusum_update(s: float, z: float) -> float:
    return max(0.0, s + min(z, 6.0) - CUSUM_K)


class VerificationModel:
    def __init__(self):
        self.forest: IsolationForest | None = None
        self.calib = (0.0, 1.0)
        self.model_hash = ""

    # ───────────────────────────── training ─────────────────────────────
    def train(self, n: int = TRAIN_SAMPLES) -> "VerificationModel":
        rng = random.Random(SEED)
        wx_src = SyntheticProvider(seed=rng.randrange(1 << 30))
        X = []
        base = 1767225600  # 2026-01-01 UTC
        while len(X) < n:
            lat, lon = rng.uniform(8, 34), rng.uniform(68, 92)
            cap = rng.choice([1000, 2000, 3000, 5000, 8000, 10000, 25000, 50000])
            meter = MeterProfile(PVSystem(cap, lat, lon, tilt_deg=rng.uniform(5, 35), azimuth_deg=rng.uniform(150, 210)),
                                 health=rng.uniform(0.86, 1.03),
                                 shading_utc_hours=(rng.randrange(2, 5),) if rng.random() < 0.25 else ())
            hour = base + rng.randrange(0, 365 * 24) * 3600
            if clear_sky_ghi_hour(hour, lat, lon) < 20:
                continue
            wx = wx_src.hour(lat, lon, hour)
            # satellite products also carry their own bias; vary cloud estimate slightly
            wx_seen = HourWeather(wx.ghi, wx.temp_c, None if rng.random() < 0.1 else wx.cloud_cover, wx.source)
            e = honest_energy_wh(meter, hour, wx, rng)
            expected, _ = pv_energy_wh(PVSystem(cap, lat, lon), hour, wx_seen.ghi, wx_seen.temp_c)
            dev_lr = math.log(meter.health * rng.gauss(1.0, 0.04))
            X.append(features(e, expected, cap, wx_seen.cloud_cover, dev_lr))
        Xa = np.asarray(X)
        self.forest = IsolationForest(n_estimators=200, max_samples=1024, contamination="auto", random_state=SEED).fit(Xa)
        self._compile()
        d = self.forest.decision_function(Xa)
        # calibrate so that the 1st percentile of honest data maps to ~0.5
        lo = float(np.percentile(d, 1))
        spread = float(np.std(d)) or 1.0
        self.calib = (lo, spread)
        h = hashlib.sha256(json.dumps({"v": MODEL_VERSION, "n": n, "seed": SEED, "calib": self.calib,
                                       "w": [W_PHYSICS, W_ANOMALY, W_CONSISTENCY]}, sort_keys=True).encode())
        self.model_hash = "0x" + h.hexdigest()
        return self

    def _compile(self) -> None:
        """Flatten the fitted trees so one reading scores in ~0.3 ms instead of ~12 ms."""
        f = self.forest
        self._trees = []
        for est, feats in zip(f.estimators_, f.estimators_features_):
            t = est.tree_
            leaf_extra = np.array([_avg_path(int(n)) for n in t.n_node_samples])
            self._trees.append((t.children_left.tolist(), t.children_right.tolist(),
                                [int(feats[i]) if i >= 0 else -1 for i in t.feature], t.threshold.tolist(),
                                leaf_extra.tolist()))
        self._norm = _avg_path(f.max_samples_)
        self._offset = float(f.offset_)

    def decision(self, x: list[float]) -> float:
        total = 0.0
        for left, right, feat, thr, extra in self._trees:
            node, depth = 0, 0
            while left[node] != -1:
                node = left[node] if x[feat[node]] <= thr[node] else right[node]
                depth += 1
            total += depth + extra[node]
        mean = total / len(self._trees)
        return -(2 ** (-mean / self._norm)) - self._offset

    def anomaly_score(self, f: list[float]) -> float:
        d = self.decision(f)
        lo, spread = self.calib
        return 1 / (1 + math.exp(-(d - lo) / (0.25 * spread)))

    # ───────────────────────────── scoring ─────────────────────────────
    def assess(self, energy_wh: int, system: PVSystem, hour_start: int, wx: HourWeather,
               device_history_ratios: list[float]) -> Assessment:
        cap = system.capacity_w
        expected, poa = pv_energy_wh(system, hour_start, wx.ghi, wx.temp_c)
        ceiling = clear_sky_ceiling_wh(system, hour_start)
        cs_ghi = clear_sky_ghi_hour(hour_start, system.lat, system.lon)
        reasons: list[dict] = []

        def reason(code, severity, msg):
            reasons.append({"code": code, "severity": severity, "message": msg})

        ratio = (energy_wh + 0.01 * cap) / (expected + 0.01 * cap)

        # ── hard physical limits ──
        hard_reject = False
        if cs_ghi < 2 and energy_wh > 0.02 * cap:
            hard_reject = True
            reason("NIGHT_GENERATION", "critical",
                   f"Sun is below the horizon at this site for the whole hour, yet {energy_wh:,} Wh was claimed.")
        elif energy_wh > ceiling:
            hard_reject = True
            reason("ABOVE_CLEAR_SKY_CEILING", "critical",
                   f"{energy_wh:,} Wh exceeds the physical maximum of {ceiling:,.0f} Wh for a cloudless sky at this hour and location.")

        # Uncertainty of "what this rooftop really saw" vs the satellite estimate.
        # Small under clear or fully overcast skies, large under broken cloud.
        sigma = math.hypot(MODEL_SIGMA_FLOOR, local_irradiance_error_sigma(wx.cloud_cover)) * SIGMA_INFLATION

        # ── device track record (needed to centre the physics test) ──
        if len(device_history_ratios) >= 6:
            dev_ratio = float(np.clip(np.median(device_history_ratios), 0.5, PRIOR_RATIO * 1.08))
            n_hist = len(device_history_ratios)
        else:
            dev_ratio = PRIOR_RATIO
            n_hist = 0

        # ── physics agreement ──
        # z = how many standard deviations above the physically expected output the claim is.
        # The expectation is centred on a healthy array (≤ PRIOR_RATIO·1.08), so a meter cannot
        # "train" a higher baseline by inflating from day one.
        z = math.log(ratio / min(dev_ratio, PRIOR_RATIO)) / sigma
        if expected < 0.02 * cap and energy_wh < 0.04 * cap:
            physics = 1.0
        elif z <= 0:
            physics = 1.0
            if ratio < 0.55:
                reason("UNDER_PRODUCTION", "info",
                       f"Output is {ratio:.0%} of expected — possible shading, soiling or a fault. Accepted (under-reporting cannot inflate credits).")
        else:
            physics = math.exp(-0.5 * max(0.0, z - Z_FREE) ** 2)
            if physics < 0.6:
                reason("OVER_PRODUCTION", "high" if physics < 0.2 else "medium",
                       f"Claimed {energy_wh:,} Wh is {ratio:.2f}× the {expected:,.0f} Wh expected from measured irradiance "
                       f"({wx.ghi:.0f} W/m², {f'{wx.cloud_cover:.0f}' if wx.cloud_cover is not None else '?'}% cloud) — "
                       f"{z:.1f}σ above what this sky allows.")

        drift = math.log(ratio) - math.log(dev_ratio)
        consistency = 1.0 if drift <= sigma else math.exp(-0.5 * ((drift - sigma) / sigma) ** 2)
        if consistency < 0.6 and n_hist:
            reason("PERFORMANCE_JUMP", "medium",
                   f"This meter usually delivers {dev_ratio:.2f}× expected (median of {n_hist} verified hours); this hour claims {ratio:.2f}×.")

        # ── learned anomaly detector ──
        f = features(energy_wh, expected, cap, wx.cloud_cover, math.log(dev_ratio))
        anomaly = self.anomaly_score(f)
        if anomaly < 0.4:
            reason("ANOMALY_DETECTED", "medium",
                   f"Isolation-forest anomaly score {anomaly:.2f}: this combination of output, irradiance and cloud is rare among honest meters.")

        score = W_PHYSICS * physics + W_ANOMALY * anomaly + W_CONSISTENCY * consistency
        if physics < 0.15:
            score = min(score, 0.45)
        score_bps = int(round(score * 10000))

        if hard_reject:
            status, score_bps = "REJECTED", min(score_bps, 1000)
        elif score_bps >= ACCEPT_BPS:
            status = "ACCEPTED"
        elif score_bps >= HOLD_BPS:
            status = "HELD"
            reason("HELD_FOR_REVIEW", "medium", "Plausibility below the issuance threshold; held for re-evaluation with more data.")
        else:
            status = "REJECTED"

        if status == "ACCEPTED" and not any(r["severity"] in ("medium", "high", "critical") for r in reasons):
            reason("CONSISTENT", "ok",
                   f"Matches satellite irradiance of {wx.ghi:.0f} W/m² ({ratio:.2f}× expected).")

        evidence_z = math.log(ratio / PRIOR_RATIO) / sigma if expected > 0.05 * cap else 0.0
        if hard_reject:
            evidence_z = 6.0

        return Assessment(status, score_bps, expected, ceiling, cs_ghi, poa, ratio,
                          {"physics": round(physics, 4), "anomaly": round(anomaly, 4), "consistency": round(consistency, 4)},
                          reasons, [round(x, 5) for x in f], round(evidence_z, 4), round(sigma, 4))
