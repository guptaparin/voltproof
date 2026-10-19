"""VoltProof verifier API.

    uvicorn verifier.app:app --port 8000

Environment:
    VERIFIER_KEY   private key of the verifier/relayer (must hold VERIFIER_ROLE)
    DEPLOYMENT     path to deployments/<chainId>.json (default deployments/current.json)
    RPC_URL        override RPC endpoint
    WEATHER        auto | open-meteo | synthetic        (default auto)
    DEMO_MODE      1 to enable the Attack Lab endpoints (uses simulator keys)
"""
from __future__ import annotations

import json
import logging
import os
import pickle
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from vpcore.solar import PVSystem, clear_sky_ceiling_wh, clear_sky_ghi_hour, pv_energy_wh
from vpcore.weather import AutoProvider

from .chain import Chain
from .engine import Engine
from .model import ACCEPT_BPS, CUSUM_H, HOLD_BPS, MODEL_VERSION, VerificationModel

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("voltproof")

# Hardhat account #1 — only ever used on the local dev chain.
LOCAL_VERIFIER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

S: dict = {}


def load_model() -> VerificationModel:
    cache = HERE / f".model-{MODEL_VERSION}.pkl"
    if cache.exists():
        try:
            return pickle.loads(cache.read_bytes())
        except Exception:
            pass
    t = time.time()
    m = VerificationModel().train()
    cache.write_bytes(pickle.dumps(m))
    log.info("trained verification model in %.1fs (%s)", time.time() - t, m.model_hash[:18])
    return m


def fleet_meta() -> dict:
    p = ROOT / "simulator" / "fleet.json"
    if not p.exists():
        return {}
    f = json.loads(p.read_text())
    return {d["address"].lower(): {"name": d["name"], "city": d["city"], "producerName": d["producerName"], "lab": d.get("lab", False)}
            for d in f["devices"]}


@asynccontextmanager
async def lifespan(_: FastAPI):
    dep = Path(os.environ.get("DEPLOYMENT", ROOT / "deployments" / "current.json"))
    chain = Chain(dep, os.environ.get("RPC_URL"), os.environ.get("VERIFIER_KEY", LOCAL_VERIFIER_KEY))
    if not chain.is_verifier():
        log.warning("verifier %s does not hold VERIFIER_ROLE — issuance will revert", chain.account.address)
    store = Store(os.environ.get("DB_PATH", HERE / f"verdicts-{chain.chain_id}.sqlite"))
    weather = AutoProvider(HERE / "weather_cache.sqlite", mode=os.environ.get("WEATHER", "auto"))
    S.update(chain=chain, store=store, weather=weather, model=load_model(), demo=os.environ.get("DEMO_MODE", "1") == "1")
    S["engine"] = Engine(chain, store, S["model"], weather, fleet_meta())
    log.info("VoltProof verifier %s on chain %s (%s)", chain.account.address, chain.chain_id, chain.rpc_url)
    yield


from .store import Store  # noqa: E402  (after lifespan definition for readability)

app = FastAPI(title="VoltProof Verifier", version=MODEL_VERSION, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class ReadingIn(BaseModel):
    device: str
    hourStart: int = Field(ge=0)
    energyWh: int = Field(ge=0)
    nonce: int = Field(ge=0)


class Submission(BaseModel):
    reading: ReadingIn
    signature: str = Field(pattern=r"^0x[0-9a-fA-F]{128,130}$")


class AttackIn(BaseModel):
    type: str


class DeviceIn(BaseModel):
    device: str


# ───────────────────────────────── core ─────────────────────────────────
@app.get("/v1/health")
def health():
    c: Chain = S["chain"]
    return {
        "ok": True, "chainId": c.chain_id, "rpcUrl": c.rpc_url, "verifier": c.account.address,
        "isVerifier": c.is_verifier(),
        "contracts": {k: v["address"] for k, v in c.deployment["contracts"].items()},
        "startBlock": c.deployment.get("startBlock", 0),
        "model": {"version": MODEL_VERSION, "hash": S["model"].model_hash, "acceptBps": ACCEPT_BPS, "holdBps": HOLD_BPS, "cusumH": CUSUM_H},
        "weather": S["weather"].name, "demoMode": S["demo"],
        "domain": {"name": "VoltProof", "version": "1", "chainId": c.chain_id, "verifyingContract": c.certificate_address},
    }


@app.post("/v1/readings")
def submit(sub: Submission):
    return S["engine"].process(sub.reading.model_dump(), sub.signature)


@app.get("/v1/verdicts")
def verdicts(limit: int = Query(50, le=500), device: str | None = None, status: str | None = None,
             labelled: bool | None = None, before: int | None = None):
    return S["store"].verdicts(limit, device, status, labelled, before)


@app.get("/v1/verdicts/{vid}")
def verdict(vid: int):
    v = S["store"].verdict(vid)
    if not v:
        raise HTTPException(404)
    return v | {"merkle": S["engine"].proof(v)}


@app.get("/v1/certificates/{cid}/evidence")
def evidence(cid: int):
    v = S["store"].verdict_by_certificate(cid)
    if not v:
        raise HTTPException(404, "no verifier record for this certificate")
    c: Chain = S["chain"]
    return {
        "verdict": v, "merkle": S["engine"].proof(v),
        "domain": {"name": "VoltProof", "version": "1", "chainId": c.chain_id, "verifyingContract": c.certificate_address},
        "reading": {"device": v["device"], "hourStart": v["hour_start"], "energyWh": v["energy_wh"], "nonce": v["nonce"]},
    }


@app.get("/v1/fleet")
def fleet():
    c: Chain = S["chain"]
    st: Store = S["store"]
    meta = fleet_meta()
    summary = st.per_device_summary()
    states = st.all_meter_states()
    out = []
    for d in c.all_devices():
        k = d.address.lower()
        out.append({
            "address": d.address, "owner": d.owner, "lat": d.lat, "lon": d.lon, "capacityW": d.capacity_w,
            "active": d.active, "name": d.name, **meta.get(k, {}),
            "stats": summary.get(k, {"n": 0, "acc": 0, "rej": 0, "held": 0, "wh": 0, "last": None}),
            "risk": {"cusum": round(states.get(k, {}).get("cusum", 0), 2), "threshold": CUSUM_H,
                     "suspended": bool(states.get(k, {}).get("suspended", 0)),
                     "reason": states.get(k, {}).get("suspended_reason")},
        })
    producers = {}
    p = ROOT / "simulator" / "fleet.json"
    if p.exists():
        producers = {x["address"].lower(): x["name"] for x in json.loads(p.read_text())["producers"]}
    return {"devices": out, "producers": producers}


@app.get("/v1/devices/{address}/series")
def series(address: str, hours: int = 72):
    c: Chain = S["chain"]
    d = c.device(address, fresh=True)
    if not d:
        raise HTTPException(404)
    now = int(time.time())
    end = now - now % 3600
    start = end - hours * 3600
    rows = {v["hour_start"]: v for v in S["store"].device_series(address, start) if v.get("label") is None}
    system = PVSystem(d.capacity_w, d.lat, d.lon)
    pts = []
    for h in range(start, end, 3600):
        v = rows.get(h)
        cs = clear_sky_ghi_hour(h, d.lat, d.lon)
        point = {"hour": h, "clearSkyGhi": round(cs, 1), "ceilingWh": round(clear_sky_ceiling_wh(system, h), 1) if cs > 0 else 0}
        if v:
            point |= {"energyWh": v["energy_wh"], "expectedWh": v["expected_wh"], "status": v["status"],
                      "scoreBps": v["score_bps"], "verdictId": v["id"], "certificateId": v["certificate_id"], "ghi": v["ghi"]}
        if cs > 0 and point.get("expectedWh") is None:
            try:
                wx = S["weather"].hour(d.lat, d.lon, h)
                point["expectedWh"] = round(pv_energy_wh(system, h, wx.ghi, wx.temp_c)[0], 1)
                point["ghi"] = round(wx.ghi, 1)
            except Exception:
                pass
        pts.append(point)
    st = S["store"].meter_state(address)
    return {"device": address, "points": pts, "risk": {"cusum": st["cusum"], "threshold": CUSUM_H, "suspended": bool(st["suspended"])}}


_CEIL_CACHE: dict[tuple, float] = {}


@app.get("/v1/fleet/series")
def fleet_series(hours: int = Query(72, le=24 * 14)):
    """Per-hour fleet totals: physical ceiling, certified Wh, and claims that were blocked."""
    c: Chain = S["chain"]
    now = int(time.time())
    end = now - now % 3600
    start = end - hours * 3600
    devs = c.all_devices()
    pts = {h: {"hour": h, "ceilingWh": 0.0, "certifiedWh": 0, "blockedWh": 0, "heldWh": 0, "claims": 0}
           for h in range(start, end, 3600)}
    for d in devs:
        system = PVSystem(d.capacity_w, d.lat, d.lon)
        for h in pts:
            k = (d.address, h)
            if k not in _CEIL_CACHE:
                _CEIL_CACHE[k] = clear_sky_ceiling_wh(system, h) if clear_sky_ghi_hour(h, d.lat, d.lon) > 0 else 0.0
            pts[h]["ceilingWh"] += _CEIL_CACHE[k]
    rows = S["store"].db.execute(
        "SELECT hour_start, status, SUM(energy_wh) wh, COUNT(*) n FROM verdicts WHERE hour_start>=? GROUP BY hour_start, status",
        (start,)).fetchall()
    for r in rows:
        p = pts.get(r["hour_start"])
        if not p:
            continue
        p["claims"] += r["n"]
        if r["status"] == "ACCEPTED":
            p["certifiedWh"] += r["wh"]
        elif r["status"] == "HELD":
            p["heldWh"] += r["wh"]
        else:
            p["blockedWh"] += r["wh"]
    out = list(pts.values())
    for p in out:
        p["ceilingWh"] = round(p["ceilingWh"])
    return {"points": out, "capacityW": sum(d.capacity_w for d in devs)}


@app.get("/v1/stats")
def stats():
    c: Chain = S["chain"]
    s = S["store"].stats()
    return s | {
        "totalIssuedWh": c.certs.functions.totalIssuedWh().call(),
        "totalRetiredWh": c.certs.functions.totalRetiredWh().call(),
        "certificates": c.certs.functions.nextId().call() - 1,
        "retirements": c.certs.functions.retirementCount().call(),
        "auditBatches": c.certs.functions.auditBatchCount().call(),
        "devices": c.registry.functions.deviceCount().call(),
    }


@app.get("/v1/audit/batches")
def batches():
    return S["store"].batches()


@app.post("/v1/audit/anchor")
def anchor():
    return {"batch": S["engine"].anchor()}


@app.get("/v1/eval")
def evaluation():
    p = ROOT / "eval" / "results.json"
    if not p.exists():
        raise HTTPException(404, "run `python -m verifier.evaluate` first")
    return json.loads(p.read_text())


# ───────────────────────────────── demo ─────────────────────────────────
def _require_demo():
    if not S["demo"]:
        raise HTTPException(403, "demo endpoints disabled (DEMO_MODE=0)")


@app.get("/v1/demo/attacks")
def attack_catalog():
    _require_demo()
    from simulator.attacks import ATTACKS, lab_device
    return {"attacks": ATTACKS, "labDevice": lab_device()["address"]}


@app.post("/v1/demo/attack")
def run_attack(body: AttackIn):
    _require_demo()
    from simulator import attacks
    c: Chain = S["chain"]
    d = attacks.lab_device()
    accepted = next((v for v in S["store"].verdicts(200, status="ACCEPTED") if v.get("certificate_id")), None)
    try:
        sub = attacks.build(
            body.type, chain_id=c.chain_id, contract=c.certificate_address, weather=S["weather"],
            is_certified=lambda h: c.certificate_of(d["address"], h) != 0, now=c.block_timestamp(),
            accepted_verdict=accepted,
        )
    except (LookupError, ValueError) as e:
        raise HTTPException(409, str(e))
    v = S["engine"].process(sub["reading"], sub["signature"], label=body.type, note=sub["note"])
    return v | {"scenario": attacks.ATTACKS[body.type]}


@app.post("/v1/demo/reinstate")
def reinstate(body: DeviceIn):
    """Simulates a passed physical audit: clears the meter's fraud-evidence state."""
    _require_demo()
    S["store"].set_meter_state(body.device, 0.0, False)
    S["store"].db.execute("UPDATE meter_state SET suspended_reason=NULL WHERE lower(device)=lower(?)", (body.device,))
    S["store"].db.commit()
    return {"ok": True}
