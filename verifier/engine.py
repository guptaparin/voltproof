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
    def __init__(self, chain: Chain, store: Store, model: VerificationModel, weather, fleet_meta: dict | None = None):
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
        if len(self.store.unbatched()) >= AUTO_ANCHOR_EVERY:
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

        # 7 ── attest + mint
        att = {
            "readingHash": rhash,
            "expectedWh": int(round(a.expected_wh)),
            "scoreBps": a.score_bps,
            "modelHash": self.model.model_hash,
            "issuedAt": now,
        }
        vsig = eip712.sign_attestation(self.chain.account.key.hex(), self.chain.chain_id, self.chain.certificate_address, att)
        try:
            cert_id, tx = self.chain.issue(r, signature, att, vsig)
        except ChainRevert as e:
            self.chain.reset_nonce()
            reasons.append({"code": "ONCHAIN_REVERT", "severity": "critical", "message": f"Contract rejected issuance: {e}"})
            return finish("FAILED_ONCHAIN", reasons, attestation=att, verifier_sig=vsig, **extra)
        return finish("ACCEPTED", reasons, attestation=att, verifier_sig=vsig, tx_hash=tx, certificate_id=cert_id, **extra)

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
