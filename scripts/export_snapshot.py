"""Export a snapshot of a running VoltProof stack for the in-browser live demo.

    python scripts/export_snapshot.py          # with ./demo.sh running
      → web/public/demo/snapshot.json, web/public/demo/forest.bin

Everything in the snapshot is real output of the local run: certificates and retirements
read from the chain, every verdict with its signatures and Merkle proof, and the audit
roots as anchored on-chain. The lab meter's key and the two verifier keys are throwaway
test keys from the local dev chain, included so the browser can sign new readings and
attestations for real.
"""
from __future__ import annotations

import json
import pickle
import struct
import sys
import time
from pathlib import Path

import httpx
from web3 import Web3

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from simulator import fleet as F  # noqa: E402
from verifier.model import MODEL_VERSION  # noqa: E402
from vpcore.weather import AutoProvider  # noqa: E402

API = "http://127.0.0.1:8000"
PEER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
PRIMARY_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
OUT = ROOT / "web" / "public" / "demo"


def get(path):
    r = httpx.get(API + path, timeout=60)
    r.raise_for_status()
    return r.json()


def s(x):  # bigint-safe
    return str(x)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    health = get("/v1/health")
    dep = json.loads((ROOT / "deployments" / "current.json").read_text())
    w3 = Web3(Web3.HTTPProvider(dep["rpcUrl"]))
    c = dep["contracts"]
    reg = w3.eth.contract(address=c["DeviceRegistry"]["address"], abi=c["DeviceRegistry"]["abi"])
    certs = w3.eth.contract(address=c["GranularCertificate"]["address"], abi=c["GranularCertificate"]["abi"])
    market = w3.eth.contract(address=c["CertificateMarket"]["address"], abi=c["CertificateMarket"]["abi"])
    taken_at = w3.eth.get_block("latest")["timestamp"]

    fleet = get("/v1/fleet")
    print(f"fleet: {len(fleet['devices'])} meters")

    # chain state ────────────────────────────────────────────────────────────
    devices = {}
    for a in reg.functions.allDevices().call():
        o, lat, lon, cap, regd, active, name = reg.functions.getDevice(a).call()
        devices[a] = {"owner": o, "latE6": lat, "lonE6": lon, "capacityW": cap, "registeredAt": s(regd), "active": active, "name": name}
    n_next = certs.functions.nextId().call()
    keys = ["device", "producer", "verifier", "hourStart", "energyWh", "expectedWh", "scoreBps", "issuedAt", "readingHash", "modelHash", "verifierCount"]
    certificates, retired_of = {}, {}
    for i in range(1, n_next):
        v = certs.functions.getCertificate(i).call()
        d = dict(zip(keys, v))
        d["readingHash"] = "0x" + d["readingHash"].hex()
        d["modelHash"] = "0x" + d["modelHash"].hex()
        certificates[i] = {k: (s(x) if isinstance(x, int) and not isinstance(x, bool) else x) for k, x in d.items()}
        retired_of[i] = s(certs.functions.retiredWhOf(i).call())
    print(f"certificates: {len(certificates)}")

    rets = []
    for ev in certs.events.CertificateRetired().get_logs(from_block=dep.get("startBlock", 0)):
        a = ev["args"]
        rets.append({
            "retirementId": s(a["retirementId"]), "certificateId": s(a["certificateId"]), "onBehalfOf": a["onBehalfOf"],
            "retiredBy": a["retiredBy"], "amountWh": s(a["amountWh"]), "beneficiary": a["beneficiary"], "purpose": a["purpose"],
            "timestamp": s(w3.eth.get_block(ev["blockNumber"])["timestamp"]), "tx": "0x" + ev["transactionHash"].hex().removeprefix("0x"),
        })
    listings = []
    for i in range(market.functions.listingCount().call()):
        sel, cid, rem, price, active = market.functions.getListing(i).call()
        listings.append({"seller": sel, "certificateId": s(cid), "remainingWh": s(rem), "priceWeiPerWh": s(price), "active": active})
    batches_onchain = {}
    for i in range(certs.functions.auditBatchCount().call()):
        b = certs.functions.getAuditBatch(i).call()
        batches_onchain[i] = {"merkleRoot": "0x" + b[0].hex(), "accepted": b[1], "rejected": b[2], "fromTs": s(b[3]), "toTs": s(b[4]), "verifier": b[5]}
    role = certs.functions.VERIFIER_ROLE().call()
    verifiers = [v for v in dep.get("verifiers", [dep["verifier"]]) if certs.functions.hasRole(role, v).call()]

    # verifier state ─────────────────────────────────────────────────────────
    verdicts = []
    page = get("/v1/verdicts?limit=500")
    for v in page:
        full = get(f"/v1/verdicts/{v['id']}")
        verdicts.append(full)
    print(f"verdicts: {len(verdicts)}")
    series = get("/v1/fleet/series?hours=72")
    dev_series = {d["address"]: get(f"/v1/devices/{d['address']}/series?hours=96") for d in fleet["devices"]}

    # lab meter: weather for its open hours, so attacks can be scored in the browser ─
    lab = next(d for d in F.load()["devices"] if d.get("lab"))
    weather = AutoProvider(ROOT / "verifier" / "weather_cache.sqlite", mode="auto")
    cur = taken_at - taken_at % 3600
    lab_wx = {}
    for k in range(1, 72):
        h = cur - k * 3600
        w = weather.hour(lab["lat"], lab["lon"], h)
        lab_wx[str(h)] = {"ghi": w.ghi, "temp_c": w.temp_c, "cloud_cover": w.cloud_cover, "source": w.source}
    history = sorted(
        [v for v in verdicts if v["device"].lower() == lab["address"].lower() and v["status"] == "ACCEPTED" and not v.get("label")
         and v.get("features") and v["features"][2] > 0.05],
        key=lambda v: -v["hour_start"])[:48]

    # compiled isolation forest ────────────────────────────────────────────────
    model = pickle.loads(next((ROOT / "verifier").glob(f".model-{MODEL_VERSION}.pkl")).read_bytes())
    lefts, rights, vals, feats, starts = [], [], [], [], []
    for left, right, feat, thr, extra in model._trees:
        starts.append(len(lefts))
        for i in range(len(left)):
            lefts.append(left[i]); rights.append(right[i]); feats.append(max(feat[i], -1))
            vals.append(extra[i] if left[i] == -1 else thr[i])
    n = len(lefts)
    blob = struct.pack(f"<{n}i", *lefts) + struct.pack(f"<{n}i", *rights) + struct.pack(f"<{n}d", *vals) + struct.pack(f"<{n}b", *feats)
    (OUT / "forest.bin").write_bytes(blob)
    print(f"forest: {len(starts)} trees, {n} nodes, {len(blob) / 1e6:.2f} MB")

    snap = {
        "takenAt": taken_at,
        "exportedAt": int(time.time()),
        "health": health,
        "fleet": fleet,
        "fleetSeries": series,
        "deviceSeries": dev_series,
        "stats": get("/v1/stats"),
        "eval": get("/v1/eval"),
        "attacks": get("/v1/demo/attacks"),
        "verdicts": verdicts,
        "batches": get("/v1/audit/batches"),
        "chain": {
            "devices": devices, "certificates": certificates, "retiredWhOf": retired_of, "retirements": rets,
            "listings": listings, "auditBatches": batches_onchain, "verifierRole": "0x" + role.hex(), "verifiers": verifiers,
            "threshold": certs.functions.attestationThreshold().call(),
            "lastNonce": {a: certs.functions.lastNonce(a).call() for a in devices},
        },
        "lab": {
            "device": lab["address"], "key": F.keys()["devices"][lab["address"]],
            "profile": {"health": lab["health"], "capacityW": lab["capacityW"], "lat": lab["lat"], "lon": lab["lon"],
                        "shadingUtcHours": lab.get("shadingUtcHours", [])},
            "weather": lab_wx, "history": [v["ratio"] for v in history],
            "verifierKeys": {"primary": PRIMARY_KEY, "peer": PEER_KEY},
        },
        "forest": {"starts": starts, "n": n, "norm": model._norm, "offset": model._offset, "calib": list(model.calib)},
    }
    (OUT / "snapshot.json").write_text(json.dumps(snap, separators=(",", ":")))
    print(f"snapshot: {(OUT / 'snapshot.json').stat().st_size / 1e6:.2f} MB → {OUT}")


if __name__ == "__main__":
    main()
