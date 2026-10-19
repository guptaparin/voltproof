"""The verification pipeline: every reading passes through the same ordered gates.

  1. Signature      — the registered meter key signed exactly these numbers (EIP-712)
  2. Identity       — the meter is registered and active on-chain
  3. Risk state     — the meter is not suspended by sequential fraud detection
  4. Time           — the hour is aligned, finished and recent
  5. Uniqueness     — this meter-hour was never certified; nonce is fresh
  6. Physics + AI   — plausibility against independent weather data
  7. Attest + mint  — verifier signs an attestation; the contract re-checks it all

Every outcome, including rejections, is stored and later committed to the chain in a
Merkle-rooted audit batch, so the verifier cannot quietly rewrite its own history.
"""
from __future__ import annotations

import logging
import threading
import time

import httpx
from eth_account import Account
from eth_utils import to_checksum_address

from vpcore import eip712
from vpcore.solar import PVSystem

from . import merkle
from .chain import Chain, ChainRevert
from .model import CUSUM_H, VerificationModel, cusum_update
from .store import Store

log = logging.getLogger("voltproof.engine")
MAX_AGE = 30 * 86400
AUTO_ANCHOR_EVERY = 60


class Engine:
    def __init__(self, chain: Chain, store: Store, model: VerificationModel, weather, fleet_meta: dict | None = None,
                 mode: str = "primary", peers: list[str] | None = None):
        # primary: collects attestations and mints. peer: an independent verifier that only co-signs.
        self.mode = mode
        self.peers = peers or []
        self.chain = chain
        self.store = store
        self.model = model
        self.weather = weather
        self.fleet_meta = fleet_meta or {}
        self.lock = threading.Lock()

    # ───────────────────────────────────────────────────────────────────────
    def process(self, reading: dict, signature: str, label: str | None = None, note: str | None = None) -> dict:
        with self.lock:
            v = self._process(reading, signature, label, note)
        if self.mode == "primary" and self.store.count_unbatched() >= AUTO_ANCHOR_EVERY:
            try:
                self.anchor()
            except Exception as e:  # never fail a submission because anchoring failed
                log.warning("auto-anchor failed: %s", e)
        return v

    def _process(self, reading: dict, signature: str, label: str | None, note: str | None) -> dict:
        r = {
            "device": to_checksum_address(reading["device"]),
            "hourStart": int(reading["hourStart"]),
            "energyWh": int(reading["energyWh"]),
            "nonce": int(reading["nonce"]),
        }
        rhash = "0x" + eip712.reading_struct_hash(r).hex()
        meta = self.fleet_meta.get(r["device"].lower(), {})
        base = {
            "device": r["device"], "device_name": meta.get("name"), "hour_start": r["hourStart"],
            "energy_wh": r["energyWh"], "nonce": r["nonce"], "device_sig": signature, "reading_hash": rhash,
            "label": label,
        }

        def finish(status: str, reasons: list[dict], **extra) -> dict:
            row = base | {"status": status, "score_bps": extra.pop("score_bps", 0), "reasons": reasons} | extra
            vid = self.store.insert_verdict(row)
            out = self.store.verdict(vid)
            if note:
                out["note"] = note
            return out

        def reject(code: str, msg: str, **extra) -> dict:
            return finish("REJECTED", [{"code": code, "severity": "critical", "message": msg}], **extra)

        # 1 ── signature
        try:
            signer = eip712.recover_reading_signer(self.chain.chain_id, self.chain.certificate_address, r, signature)
        except Exception:
            signer = None
        if not signer or signer.lower() != r["device"].lower():
            return reject("SIGNATURE_INVALID",
                          "The signature does not match this meter's key. The reading was forged or altered after the meter signed it.")
        signature = eip712.normalize_signature(self.chain.chain_id, self.chain.certificate_address, r, signature)
        base["device_sig"] = signature

        # 2 ── on-chain identity
        dev = self.chain.device(r["device"], fresh=True)
        if dev is None:
            return reject("UNREGISTERED_DEVICE", "This meter key is not in the on-chain device registry.")
        if not dev.active:
            return reject("DEVICE_REVOKED", "This meter has been revoked in the on-chain registry.")
        base["device_name"] = dev.name

        # 3 ── sequential risk state
        state = self.store.meter_state(r["device"])
        if state["suspended"]:
            return finish("SUSPENDED", [{
                "code": "METER_SUSPENDED", "severity": "high",
                "message": f"Meter suspended pending physical audit: {state.get('suspended_reason') or 'sustained over-reporting'}."}])

        # 4 ── time
        now = self.chain.block_timestamp()
        h = r["hourStart"]
        if h % 3600:
            return reject("HOUR_NOT_ALIGNED", "hourStart must be aligned to a UTC hour.")
        if h + 3600 > now:
            return reject("HOUR_NOT_FINISHED", "The hour has not finished yet.")
        if now - h > MAX_AGE:
            return reject("READING_TOO_OLD", "Readings older than 30 days are not accepted.")
        if r["energyWh"] <= 0:
            return reject("ZERO_ENERGY", "Nothing to certify.")

        # 5 ── uniqueness
        existing = self.chain.certificate_of(r["device"], h)
        if existing:
            return reject("ALREADY_CERTIFIED",
                          f"This meter-hour was already certified as certificate #{existing}. Each Wh can be issued only once.")
        last = self.chain.last_nonce(r["device"])
        if r["nonce"] <= last:
            return reject("NONCE_REUSED", f"Nonce {r['nonce']} is not greater than the last used nonce {last} (replay).")

        # 6 ── physics + AI
        system = PVSystem(dev.capacity_w, dev.lat, dev.lon)
        wx = self.weather.hour(dev.lat, dev.lon, h)
        a = self.model.assess(r["energyWh"], system, h, wx, self.store.history_ratios(r["device"]))
        cusum = cusum_update(state["cusum"], a.evidence_z)
        suspended = cusum > CUSUM_H
        reasons = list(a.reasons)
        status = a.status
        if suspended:
            reasons.append({"code": "METER_SUSPENDED", "severity": "high",
                            "message": "Sequential fraud detector (CUSUM) crossed its threshold: this meter has over-reported "
                                       "persistently. Further attestations are paused pending a physical audit."})
            if status == "ACCEPTED":
                status = "HELD"
        self.store.set_meter_state(r["device"], cusum, suspended,
                                   "sustained over-reporting (CUSUM)" if suspended else None)

        extra = dict(
            score_bps=a.score_bps, expected_wh=round(a.expected_wh, 1), ceiling_wh=round(a.ceiling_wh, 1),
            ratio=round(a.ratio, 4), ghi=round(wx.ghi, 1), poa=round(a.poa, 1), temp_c=round(wx.temp_c, 1),
            cloud_cover=wx.cloud_cover, clear_sky_ghi=round(a.clear_sky_ghi, 1), weather_source=wx.source,
            components=a.components, features=a.features, evidence_z=a.evidence_z, cusum=round(cusum, 3),
        )
        if status != "ACCEPTED":
            return finish(status, reasons, **extra)

        # 7 ── attest (+ collect independent co-signatures) + mint
        att = {
            "readingHash": rhash,
            "expectedWh": int(round(a.expected_wh)),
            "scoreBps": a.score_bps,
            "modelHash": self.model.model_hash,
            "issuedAt": now,
        }
        vsig = eip712.sign_attestation(self.chain.account.key.hex(), self.chain.chain_id, self.chain.certificate_address, att)
        if self.mode == "peer":
            return finish("ACCEPTED", reasons, attestation=att, verifier_sig=vsig, **extra)

        collected = [(self.chain.account.address, att, vsig)]
        cosigners = []
        for url in self.peers:
            c = self._cosign(url, r, signature, rhash)
            cosigners.append(c)
            if c.get("ok"):
                collected.append((c["verifier"], c["attestation"], c["signature"]))
        need = self.chain.threshold()
        cosign_info = cosigners  # signatures are public evidence; browsers re-verify them
        if len(collected) < need:
            dissent = "; ".join(f"{c.get('verifier', c['url'])[:10]}…: {c.get('reason', 'unavailable')}" for c in cosigners if not c.get("ok"))
            reasons.append({"code": "PEER_DISAGREED", "severity": "medium",
                            "message": f"Only {len(collected)} of the {need} required independent verifiers attested. {dissent}"})
            return finish("HELD", reasons, attestation=att, verifier_sig=vsig, cosigners=cosign_info, **extra)

        collected.sort(key=lambda x: int(x[0], 16))
        try:
            cert_id, tx = self.chain.issue(r, signature, [(x[1], x[2]) for x in collected])
        except ChainRevert as e:
            self.chain.reset_nonce()
            reasons.append({"code": "ONCHAIN_REVERT", "severity": "critical", "message": f"Contract rejected issuance: {e}"})
            return finish("FAILED_ONCHAIN", reasons, attestation=att, verifier_sig=vsig, cosigners=cosign_info, **extra)
        if len(collected) > 1:
            reasons.append({"code": "MULTI_VERIFIED", "severity": "ok",
                            "message": f"Independently confirmed by {len(collected)} verifiers before minting."})
        return finish("ACCEPTED", reasons, attestation=att, verifier_sig=vsig, cosigners=cosign_info,
                      tx_hash=tx, certificate_id=cert_id, **extra)

    def _cosign(self, url: str, r: dict, device_sig: str, rhash: str) -> dict:
        """Ask an independent verifier to re-run the whole pipeline. Never trust its word:
        its attestation must recover to a VERIFIER_ROLE holder and commit to this reading."""
        try:
            res = httpx.post(f"{url}/v1/cosign", json={"reading": r, "signature": device_sig}, timeout=60).json()
        except Exception as e:
            return {"url": url, "ok": False, "reason": f"unreachable ({type(e).__name__})"}
        if res.get("status") != "ACCEPTED" or not res.get("attestation"):
            top = (res.get("reasons") or [{"message": res.get("detail", "declined")}])[0]["message"]
            return {"url": url, "ok": False, "verifier": res.get("verifier", url), "status": res.get("status"),
                    "score_bps": res.get("score_bps"), "reason": top}
        att = res["attestation"]
        d = eip712.digest(self.chain.chain_id, self.chain.certificate_address, eip712.attestation_struct_hash(att))
        signer = Account._recover_hash(d, signature=bytes.fromhex(res["verifier_sig"][2:]))
        role = self.chain.certs.functions.VERIFIER_ROLE().call()
        if att["readingHash"].lower() != rhash.lower() or not self.chain.certs.functions.hasRole(role, signer).call():
            return {"url": url, "ok": False, "verifier": signer, "reason": "returned an invalid attestation"}
        return {"url": url, "ok": True, "verifier": signer, "score_bps": att["scoreBps"], "expected_wh": att["expectedWh"],
                "attestation": att, "signature": res["verifier_sig"]}

    # ───────────────────────────────────────────────────────────────────────
    def anchor(self) -> dict | None:
        with self.lock:
            pending = self.store.unbatched()
            if not pending:
                return None
            leaves = [merkle.leaf(v) for v in pending]
            root, _ = merkle.root_and_proofs(leaves)
            acc = sum(v["status"] == "ACCEPTED" for v in pending)
            rej = len(pending) - acc
            onchain_id, tx = self.chain.anchor(root, acc, rej, min(v["created_at"] for v in pending), max(v["created_at"] for v in pending))
            bid = self.store.insert_batch({
                "onchain_id": onchain_id, "root": "0x" + root.hex(), "from_verdict": pending[0]["id"],
                "to_verdict": pending[-1]["id"], "accepted": acc, "rejected": rej, "tx_hash": tx,
            }, [v["id"] for v in pending])
            return self.store.batch(bid)

    def proof(self, verdict: dict) -> dict | None:
        if not verdict.get("batch_id"):
            return None
        rows = self.store.batch_verdicts(verdict["batch_id"])
        leaves = [merkle.leaf(v) for v in rows]
        root, proofs = merkle.root_and_proofs(leaves)
        i = next(k for k, v in enumerate(rows) if v["id"] == verdict["id"])
        b = self.store.batch(verdict["batch_id"])
        return {
            "batchId": b["id"], "onchainBatchId": b["onchain_id"], "root": "0x" + root.hex(), "anchorTx": b["tx_hash"],
            "leaf": "0x" + leaves[i].hex(), "proof": ["0x" + p.hex() for p in proofs[i]],
            "valid": merkle.verify(proofs[i], root, leaves[i]) and ("0x" + root.hex()) == b["root"],
        }
