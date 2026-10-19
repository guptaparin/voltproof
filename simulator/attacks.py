"""Builds honest and adversarial meter submissions for the Attack Lab.

Every attack here is something a real adversary could try against an energy-certificate
system. Each one is stopped by a different layer of VoltProof.
"""
from __future__ import annotations

import random
import time

from eth_account import Account

from vpcore import eip712
from vpcore.production import honest_energy_wh
from vpcore.solar import clear_sky_ceiling_wh, clear_sky_ghi_hour, pv_energy_wh

from . import fleet as F

ATTACKS = {
    "honest": {
        "title": "Honest reading",
        "attacker": "—",
        "description": "The meter reports exactly what it measured for the latest daylight hour.",
        "defence": "Should be ACCEPTED and minted as a certificate.",
    },
    "inflated": {
        "title": "Inflated reading",
        "attacker": "Dishonest producer / modified firmware",
        "description": "The meter's own key signs 2.2× the energy it really produced.",
        "defence": "AI verifier: claim far above what satellite irradiance allows.",
    },
    "cloud_fake": {
        "title": "Sunshine that wasn't there",
        "attacker": "Dishonest producer",
        "description": "Claims full midday output for an hour when clouds or a low sun made that impossible.",
        "defence": "AI verifier: independent irradiance and solar geometry contradict the claim.",
    },
    "night": {
        "title": "Generation at night",
        "attacker": "Dishonest producer / buggy meter",
        "description": "Claims 30% of nameplate output for an hour when the sun was below the horizon.",
        "defence": "Physics hard limit: solar geometry says zero is possible.",
    },
    "tampered": {
        "title": "Tampered in transit",
        "attacker": "Man-in-the-middle / aggregator",
        "description": "An honest signed reading is intercepted and its energy value raised 1.8×.",
        "defence": "Signature check: the meter never signed the altered value.",
    },
    "forged": {
        "title": "Forged meter identity",
        "attacker": "Outside attacker",
        "description": "Attacker signs a reading with their own key but claims to be the campus meter.",
        "defence": "Signature check: signer is not the registered meter key.",
    },
    "unregistered": {
        "title": "Rogue meter",
        "attacker": "Outside attacker",
        "description": "A brand-new, never-registered device submits a perfectly signed reading.",
        "defence": "On-chain device registry: only registered, active meters count.",
    },
    "replay": {
        "title": "Replay / double issuance",
        "attacker": "Anyone",
        "description": "Resubmits a reading that was already certified, hoping to mint it twice.",
        "defence": "Smart contract: one certificate per meter-hour, ever.",
    },
}


def lab_device() -> dict:
    return next(d for d in F.load()["devices"] if d.get("lab"))


def _sign(key: str, chain_id: int, contract: str, r: dict) -> str:
    return eip712.sign_reading(key, chain_id, contract, r)


def candidate_hours(device: dict, is_certified, now: int, lookback_h: int = 36) -> tuple[list[int], list[int]]:
    """Recent finished hours for this meter that have no certificate yet (daylight, night)."""
    cur = now - now % 3600 - 3600
    day, night = [], []
    for k in range(lookback_h):
        h = cur - k * 3600
        if is_certified(h):
            continue
        cs = clear_sky_ghi_hour(h, device["lat"], device["lon"])
        (day if cs > 150 else night if cs < 1 else []).append(h)
    return day, night


def build(kind: str, *, chain_id: int, contract: str, weather, is_certified, now: int,
          accepted_verdict: dict | None = None) -> dict:
    """Return {"reading", "signature", "label", "note"} for the requested scenario."""
    if kind not in ATTACKS:
        raise ValueError(f"unknown attack {kind}")
    d = lab_device()
    key = F.keys()["devices"][d["address"]]
    rng = random.Random(time.time_ns())
    meter = F.profile(d)
    day, night = candidate_hours(d, is_certified, now)

    if kind == "replay":
        if not accepted_verdict:
            raise LookupError("no certified reading to replay yet")
        v = accepted_verdict
        r = {"device": v["device"], "hourStart": v["hour_start"], "energyWh": v["energy_wh"], "nonce": v["nonce"]}
        return {"reading": r, "signature": v["device_sig"], "label": kind,
                "note": f"Re-submitting certificate #{v['certificate_id']} (meter-hour already used)."}

    if kind == "night":
        if not night:
            raise LookupError("no uncertified night hour in the last 36 h")
        h = night[0]
        r = {"device": d["address"], "hourStart": h, "energyWh": int(d["capacityW"] * 0.3), "nonce": F.next_nonce(d["address"])}
        return {"reading": r, "signature": _sign(key, chain_id, contract, r), "label": kind, "note": "Night-time claim."}

    if not day:
        raise LookupError("no uncertified daylight hour left in the last 36 h — reset the lab")

    if kind == "cloud_fake":
        # Prefer the cloudiest recent hour; if the sky was clear all day, use the hour with the
        # lowest sun instead. Either way, claim what a clear midday hour would have produced.
        clearness = []
        for h in day:
            wx = weather.hour(d["lat"], d["lon"], h)
            clearness.append((wx.ghi / max(clear_sky_ghi_hour(h, d["lat"], d["lon"]), 1), h))
        k, h = min(clearness)
        if k > 0.6:
            h = min(day, key=lambda x: clear_sky_ghi_hour(x, d["lat"], d["lon"]))
            why = "a low-sun hour"
        else:
            why = f"an hour with only {k:.0%} of clear-sky sunshine"
        best = max(clear_sky_ceiling_wh(meter.system, x) for x in day) / 1.15
        claim = int(min(best * 0.9, d["capacityW"] * 1.05))
        r = {"device": d["address"], "hourStart": h, "energyWh": claim, "nonce": F.next_nonce(d["address"])}
        return {"reading": r, "signature": _sign(key, chain_id, contract, r), "label": kind,
                "note": f"Claimed {claim:,} Wh, a clear midday's output, for {why}."}

    h = next((x for x in day if weather.hour(d["lat"], d["lon"], x).ghi > 150), day[0])
    wx = weather.hour(d["lat"], d["lon"], h)
    true_wh = max(1, honest_energy_wh(meter, h, wx, rng))
    # Attacks start from the meter's *typical* output for this hour (no random local
    # cloud), so each demo run is reproducible rather than depending on a lucky draw.
    typical_wh = max(1, int(pv_energy_wh(meter.system, h, wx.ghi, wx.temp_c)[0] * meter.health))

    if kind == "honest":
        r = {"device": d["address"], "hourStart": h, "energyWh": true_wh, "nonce": F.next_nonce(d["address"])}
        return {"reading": r, "signature": _sign(key, chain_id, contract, r), "label": kind, "note": f"True output {true_wh:,} Wh."}

    if kind == "inflated":
        claim = int(min(typical_wh * 2.2, d["capacityW"] * 1.09))
        r = {"device": d["address"], "hourStart": h, "energyWh": claim, "nonce": F.next_nonce(d["address"])}
        return {"reading": r, "signature": _sign(key, chain_id, contract, r), "label": kind,
                "note": f"Real output about {typical_wh:,} Wh; the meter signed {claim:,} Wh."}

    if kind == "tampered":
        r = {"device": d["address"], "hourStart": h, "energyWh": typical_wh, "nonce": F.next_nonce(d["address"])}
        sig = _sign(key, chain_id, contract, r)
        r = dict(r, energyWh=int(typical_wh * 1.8))
        return {"reading": r, "signature": sig, "label": kind,
                "note": f"Meter signed {typical_wh:,} Wh; value changed to {r['energyWh']:,} Wh in transit."}

    if kind == "forged":
        attacker = Account.create()
        r = {"device": d["address"], "hourStart": h, "energyWh": true_wh, "nonce": F.next_nonce(d["address"])}
        return {"reading": r, "signature": _sign(attacker.key.hex(), chain_id, contract, r), "label": kind,
                "note": f"Signed by attacker key {attacker.address[:10]}…"}

    if kind == "unregistered":
        rogue = Account.create()
        r = {"device": rogue.address, "hourStart": h, "energyWh": true_wh, "nonce": 1}
        return {"reading": r, "signature": _sign(rogue.key.hex(), chain_id, contract, r), "label": kind,
                "note": f"Rogue device {rogue.address[:10]}… with a valid self-signature."}

    raise ValueError(kind)
