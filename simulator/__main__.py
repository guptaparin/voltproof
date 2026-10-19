"""VoltProof meter-fleet simulator.

    python -m simulator init                    # create meter + producer keys, fleet.json
    python -m simulator backfill --hours 72     # submit signed readings for past hours
    python -m simulator live                    # keep submitting each new finished hour
    python -m simulator attack inflated         # fire one Attack Lab scenario
    python -m simulator market                  # producers list their certificates for sale

Meters talk to the verifier over HTTP exactly like the ESP32 firmware does.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import httpx

from vpcore import eip712
from vpcore.production import honest_energy_wh
from vpcore.solar import clear_sky_ghi_hour
from vpcore.weather import AutoProvider

from . import fleet as F

ROOT = Path(__file__).resolve().parent.parent


def _health(url: str) -> dict:
    return httpx.get(f"{url}/v1/health", timeout=10).json()


def _weather(mode: str) -> AutoProvider:
    return AutoProvider(ROOT / "verifier" / "weather_cache.sqlite", mode=mode)


def submit(url: str, chain_id: int, contract: str, d: dict, key: str, hour: int, energy: int) -> dict:
    r = {"device": d["address"], "hourStart": hour, "energyWh": energy, "nonce": F.next_nonce(d["address"])}
    sig = eip712.sign_reading(key, chain_id, contract, r)
    res = httpx.post(f"{url}/v1/readings", json={"reading": r, "signature": sig}, timeout=120)
    res.raise_for_status()
    return res.json()


def meter_reading(d: dict, hour: int, weather, rng: random.Random) -> int:
    if clear_sky_ghi_hour(hour, d["lat"], d["lon"]) < 1:
        return 0
    e = honest_energy_wh(F.profile(d), hour, weather.hour(d["lat"], d["lon"], hour), rng)
    if d.get("simulatedCheatFactor"):
        e = int(min(e * d["simulatedCheatFactor"], d["capacityW"] * 1.08))
    return e


def cmd_init(a):
    f = F.init(force=a.force)
    print(f"Fleet ready: {len(f['devices'])} meters, {len(f['producers'])} producers → {F.FLEET_FILE}")


def cmd_backfill(a):
    h = _health(a.url)
    chain_id, contract = h["chainId"], h["contracts"]["GranularCertificate"]
    weather = _weather(a.weather)
    keys = F.keys()["devices"]
    devices = F.load()["devices"]
    rng = random.Random(a.seed)
    now = int(time.time())
    last = now - now % 3600 - 3600
    hours = [last - k * 3600 for k in range(a.hours)][::-1]
    counts: dict[str, int] = {}
    for hr in hours:
        for d in devices:
            if d.get("lab") and hr > last - a.lab_holdout * 3600:
                continue
            e = meter_reading(d, hr, weather, rng)
            if e <= 0:
                continue
            v = submit(a.url, chain_id, contract, d, keys[d["address"]], hr, e)
            counts[v["status"]] = counts.get(v["status"], 0) + 1
            mark = {"ACCEPTED": "✓", "HELD": "~", "REJECTED": "✗", "SUSPENDED": "⏸"}.get(v["status"], "?")
            sys.stdout.write(mark)
            sys.stdout.flush()
    print(f"\n{counts}")
    httpx.post(f"{a.url}/v1/audit/anchor", timeout=120)


def cmd_live(a):
    h = _health(a.url)
    chain_id, contract = h["chainId"], h["contracts"]["GranularCertificate"]
    weather = _weather(a.weather)
    keys = F.keys()["devices"]
    rng = random.Random()
    done: set[tuple[str, int]] = set()
    print("Live mode: submitting each finished hour. Ctrl-C to stop.")
    while True:
        now = int(time.time())
        hr = now - now % 3600 - 3600
        for d in F.load()["devices"]:
            if d.get("lab") or (d["address"], hr) in done:
                continue
            done.add((d["address"], hr))
            e = meter_reading(d, hr, weather, rng)
            if e > 0:
                v = submit(a.url, chain_id, contract, d, keys[d["address"]], hr, e)
                print(f"{time.strftime('%H:%M:%S')} {d['name']:<30} {e:>7,} Wh → {v['status']} ({v['score_bps'] / 100:.1f}%)")
        time.sleep(a.interval)


def cmd_attack(a):
    res = httpx.post(f"{a.url}/v1/demo/attack", json={"type": a.type}, timeout=120)
    print(json.dumps(res.json(), indent=2)[:3000])


def cmd_market(a):
    from eth_account import Account
    from web3 import Web3

    dep = json.loads((ROOT / "deployments" / "current.json").read_text())
    w3 = Web3(Web3.HTTPProvider(a.rpc or dep["rpcUrl"]))
    c = dep["contracts"]
    certs = w3.eth.contract(address=c["GranularCertificate"]["address"], abi=c["GranularCertificate"]["abi"])
    market = w3.eth.contract(address=c["CertificateMarket"]["address"], abi=c["CertificateMarket"]["abi"])
    pkeys = {addr.lower(): v["key"] for addr, v in F.keys()["producers"].items()}

    def send(acct, fn):
        tx = fn.build_transaction({"from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address, "pending"),
                                   "chainId": dep["chainId"]})
        rc = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(acct.sign_transaction(tx).raw_transaction))
        assert rc["status"] == 1

    listed_ids = {market.functions.getListing(i).call()[1] for i in range(market.functions.listingCount().call())}
    n_next = certs.functions.nextId().call()
    approved: set[str] = set()
    made = 0
    rng = random.Random(5)
    for cid in range(1, n_next):
        if cid in listed_ids:
            continue
        cert = certs.functions.getCertificate(cid).call()
        producer = cert[1]
        key = pkeys.get(producer.lower())
        if not key or rng.random() > a.share:
            continue
        bal = certs.functions.balanceOf(producer, cid).call()
        if bal < 50:
            continue
        acct = Account.from_key(key)
        if acct.address not in approved and not certs.functions.isApprovedForAll(acct.address, market.address).call():
            send(acct, certs.functions.setApprovalForAll(market.address, True))
        approved.add(acct.address)
        # time-of-day pricing: solar-scarce shoulder hours are worth more for 24/7 matching
        local_h = ((cert[3] // 3600) % 24 + 5.5) % 24  # IST
        scarcity = 1.0 + 0.6 * min(abs(local_h - 12.5) / 5.5, 1.0)
        price_wei_per_wh = int(a.base_price_gwei * 1e9 * scarcity)
        send(acct, market.functions.list(cid, int(bal * 0.8), price_wei_per_wh))
        made += 1
    print(f"Listed {made} certificates on the market.")


# Hardhat default accounts #5–#7: funded test keys that exist only on the local dev chain.
DEMO_BUYERS = [
    ("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", "Acme Textiles (fictional)", "Scope 2 hourly matching, Oct 2026"),
    ("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", "Green Campus Initiative", "Hostel electricity, evening hours"),
    ("0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", "Pune Data Centre (fictional)", "24/7 carbon-free energy pilot"),
]


def cmd_buy_demo(a):
    from eth_account import Account
    from web3 import Web3

    dep = json.loads((ROOT / "deployments" / "current.json").read_text())
    if dep["chainId"] != 31337:
        print("buy-demo only runs on the local chain"); return
    w3 = Web3(Web3.HTTPProvider(dep["rpcUrl"]))
    c = dep["contracts"]
    market = w3.eth.contract(address=c["CertificateMarket"]["address"], abi=c["CertificateMarket"]["abi"])
    n = market.functions.listingCount().call()
    rng = random.Random(9)
    ids = [i for i in range(n) if market.functions.getListing(i).call()[4]]
    rng.shuffle(ids)
    done = 0
    for k, lid in enumerate(ids[: a.count]):
        key, who, why = DEMO_BUYERS[k % len(DEMO_BUYERS)]
        acct = Account.from_key(key)
        seller, cid, remaining, price, active = market.functions.getListing(lid).call()
        amt = max(1, int(remaining * rng.uniform(0.3, 1.0)))
        fn = market.functions.buy(lid, amt, True, who, why)
        tx = fn.build_transaction({"from": acct.address, "value": amt * price, "chainId": dep["chainId"],
                                   "nonce": w3.eth.get_transaction_count(acct.address, "pending")})
        rc = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(acct.sign_transaction(tx).raw_transaction))
        done += rc["status"] == 1
    print(f"{done} buy-and-claim purchases made")


def main():
    p = argparse.ArgumentParser(prog="simulator")
    p.add_argument("--url", default="http://127.0.0.1:8000", help="verifier URL")
    p.add_argument("--weather", default="auto", choices=["auto", "open-meteo", "synthetic"])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("init"); s.add_argument("--force", action="store_true"); s.set_defaults(fn=cmd_init)
    s = sub.add_parser("backfill"); s.add_argument("--hours", type=int, default=72); s.add_argument("--seed", type=int, default=11)
    s.add_argument("--lab-holdout", type=int, default=30, help="hours left open on the lab meter for live demos")
    s.set_defaults(fn=cmd_backfill)
    s = sub.add_parser("live"); s.add_argument("--interval", type=int, default=60); s.set_defaults(fn=cmd_live)
    s = sub.add_parser("attack"); s.add_argument("type"); s.set_defaults(fn=cmd_attack)
    s = sub.add_parser("market"); s.add_argument("--rpc"); s.add_argument("--share", type=float, default=0.35)
    s.add_argument("--base-price-gwei", type=float, default=2000.0, help="price per Wh in gwei (= native token per MWh ×1e-3)")
    s.set_defaults(fn=cmd_market)
    s = sub.add_parser("buy-demo"); s.add_argument("--count", type=int, default=8); s.set_defaults(fn=cmd_buy_demo)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
