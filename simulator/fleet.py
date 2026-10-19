"""Demo fleet: 12 rooftop/C&I solar meters across India, owned by 5 producers.

Each meter has its own secp256k1 key (in a real deployment: generated inside a secure
element and never exported). Public metadata goes to ``fleet.json`` (registered on-chain
by the deploy script); private keys stay in ``keys.json`` (git-ignored).
"""
from __future__ import annotations

import json
import random
from pathlib import Path

from eth_account import Account

from vpcore.production import MeterProfile
from vpcore.solar import PVSystem

HERE = Path(__file__).resolve().parent
FLEET_FILE = HERE / "fleet.json"
KEYS_FILE = HERE / "keys.json"
STATE_FILE = HERE / "state.json"

PRODUCERS = [
    "Campus Energy Co-op",
    "North India Rooftop Households",
    "South India Rooftop Households",
    "MSME Solar Collective",
    "Agri-Solar Farmers Co-op",
]

# name, city, lat, lon, capacity W, producer index, extras
METERS = [
    ("Patiala Campus Rooftop", "Patiala", 30.3525, 76.3616, 50_000, 0, {"lab": True}),
    ("Chandigarh Sector 21 Home", "Chandigarh", 30.7333, 76.7794, 5_000, 1, {}),
    ("Delhi Dwarka Home", "New Delhi", 28.5921, 77.0460, 3_000, 1, {"shading": [3]}),
    ("Jaipur Malviya Nagar Home", "Jaipur", 26.8549, 75.8243, 4_000, 1, {}),
    ("Jodhpur Farm Pump Array", "Jodhpur", 26.2389, 73.0243, 10_000, 4, {"cheat": 1.45}),
    ("Ahmedabad Textile Unit", "Ahmedabad", 23.0225, 72.5714, 25_000, 3, {}),
    ("Pune Housing Society", "Pune", 18.5204, 73.8567, 8_000, 3, {}),
    ("Hyderabad Gachibowli Office", "Hyderabad", 17.4401, 78.3489, 15_000, 3, {}),
    ("Bengaluru Whitefield Home", "Bengaluru", 12.9698, 77.7500, 4_000, 2, {}),
    ("Chennai Velachery Clinic", "Chennai", 12.9815, 80.2180, 6_000, 2, {"shading": [10]}),
    ("Kochi Kakkanad School", "Kochi", 10.0159, 76.3419, 12_000, 2, {}),
    ("Bhubaneswar Patia Home", "Bhubaneswar", 20.3533, 85.8195, 3_000, 1, {}),
]


def init(force: bool = False) -> dict:
    if FLEET_FILE.exists() and KEYS_FILE.exists() and not force:
        return load()
    rng = random.Random(31)
    producers = [Account.create() for _ in PRODUCERS]
    devices, keys = [], {"devices": {}, "producers": {}}
    for i, p in enumerate(producers):
        keys["producers"][p.address] = {"name": PRODUCERS[i], "key": p.key.hex()}
    for name, city, lat, lon, cap, pi, extra in METERS:
        acct = Account.create()
        keys["devices"][acct.address] = acct.key.hex()
        devices.append({
            "address": acct.address, "name": name, "city": city, "lat": lat, "lon": lon, "capacityW": cap,
            "producer": producers[pi].address, "producerName": PRODUCERS[pi],
            "health": round(rng.uniform(0.9, 1.0), 3),
            "shadingUtcHours": extra.get("shading", []),
            "lab": extra.get("lab", False),
            # simulation-only: this meter's firmware has been tampered to over-report
            "simulatedCheatFactor": extra.get("cheat"),
        })
    fleet = {"producers": [{"address": p.address, "name": PRODUCERS[i]} for i, p in enumerate(producers)], "devices": devices}
    FLEET_FILE.write_text(json.dumps(fleet, indent=2))
    KEYS_FILE.write_text(json.dumps(keys, indent=2))
    STATE_FILE.write_text(json.dumps({"nonces": {}}))
    return fleet


def load() -> dict:
    return json.loads(FLEET_FILE.read_text())


def keys() -> dict:
    return json.loads(KEYS_FILE.read_text())


def public_fleet() -> dict:
    """Fleet metadata safe to publish (no simulation-only fields)."""
    f = load()
    return {
        "producers": f["producers"],
        "devices": [{k: v for k, v in d.items() if k not in ("simulatedCheatFactor", "health", "shadingUtcHours")} for d in f["devices"]],
    }


def profile(d: dict) -> MeterProfile:
    return MeterProfile(PVSystem(d["capacityW"], d["lat"], d["lon"]), health=d["health"],
                        shading_utc_hours=tuple(d.get("shadingUtcHours", [])))


def next_nonce(device: str) -> int:
    s = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {"nonces": {}}
    n = s["nonces"].get(device, 0) + 1
    s["nonces"][device] = n
    STATE_FILE.write_text(json.dumps(s))
    return n
