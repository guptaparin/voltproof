"""Thin web3 client for the VoltProof contracts (verifier = attester + gas relayer)."""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path

from eth_account import Account
from eth_utils import keccak, to_checksum_address
from web3 import Web3
from web3.logs import DISCARD


@dataclass
class OnchainDevice:
    address: str
    owner: str
    lat: float
    lon: float
    capacity_w: int
    registered_at: int
    active: bool
    name: str


class Chain:
    def __init__(self, deployment_path: str | Path, rpc_url: str | None, verifier_key: str):
        self.deployment = json.loads(Path(deployment_path).read_text())
        self.rpc_url = rpc_url or self.deployment["rpcUrl"]
        self.w3 = Web3(Web3.HTTPProvider(self.rpc_url, request_kwargs={"timeout": 30}))
        self.chain_id = int(self.deployment["chainId"])
        c = self.deployment["contracts"]
        self.registry = self.w3.eth.contract(address=c["DeviceRegistry"]["address"], abi=c["DeviceRegistry"]["abi"])
        self.certs = self.w3.eth.contract(address=c["GranularCertificate"]["address"], abi=c["GranularCertificate"]["abi"])
        self.market = self.w3.eth.contract(address=c["CertificateMarket"]["address"], abi=c["CertificateMarket"]["abi"])
        self.account = Account.from_key(verifier_key)
        self._lock = threading.Lock()
        self._nonce: int | None = None
        self._errors = {}
        for item in c["GranularCertificate"]["abi"] + c["DeviceRegistry"]["abi"]:
            if item.get("type") == "error":
                sig = f"{item['name']}({','.join(i['type'] for i in item['inputs'])})"
                self._errors["0x" + keccak(text=sig)[:4].hex()] = item["name"]
        self._device_cache: dict[str, OnchainDevice] = {}

    @property
    def certificate_address(self) -> str:
        return self.certs.address

    # ── reads ──
    def device(self, address: str, fresh: bool = False) -> OnchainDevice | None:
        address = to_checksum_address(address)
        if not fresh and address in self._device_cache:
            return self._device_cache[address]
        d = self.registry.functions.getDevice(address).call()
        owner, lat, lon, cap, reg, active, name = d
        if reg == 0:
            return None
        dev = OnchainDevice(address, owner, lat / 1e6, lon / 1e6, cap, reg, active, name)
        self._device_cache[address] = dev
        return dev

    def all_devices(self) -> list[OnchainDevice]:
        return [d for a in self.registry.functions.allDevices().call() if (d := self.device(a, fresh=True))]

    def certificate_of(self, device: str, hour_start: int) -> int:
        return self.certs.functions.certificateOf(to_checksum_address(device), hour_start).call()

    def last_nonce(self, device: str) -> int:
        return self.certs.functions.lastNonce(to_checksum_address(device)).call()

    def block_timestamp(self) -> int:
        return self.w3.eth.get_block("latest")["timestamp"]

    def is_verifier(self) -> bool:
        role = self.certs.functions.VERIFIER_ROLE().call()
        return self.certs.functions.hasRole(role, self.account.address).call()

    # ── writes ──
    def _send(self, fn) -> dict:
        with self._lock:
            if self._nonce is None:
                self._nonce = self.w3.eth.get_transaction_count(self.account.address, "pending")
            try:
                tx = fn.build_transaction({
                    "from": self.account.address,
                    "nonce": self._nonce,
                    "chainId": self.chain_id,
                })
            except Exception as e:  # revert during gas estimation
                raise ChainRevert(self.decode_error(e)) from e
            signed = self.account.sign_transaction(tx)
            h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
            self._nonce += 1
        receipt = self.w3.eth.wait_for_transaction_receipt(h, timeout=120)
        if receipt["status"] != 1:
            raise ChainRevert("transaction reverted")
        return receipt

    def issue(self, reading: dict, device_sig: str, attestation: dict, verifier_sig: str) -> tuple[int, str]:
        r = (to_checksum_address(reading["device"]), int(reading["hourStart"]), int(reading["energyWh"]), int(reading["nonce"]))
        a = (bytes.fromhex(attestation["readingHash"][2:]), int(attestation["expectedWh"]), int(attestation["scoreBps"]),
             bytes.fromhex(attestation["modelHash"][2:]), int(attestation["issuedAt"]))
        receipt = self._send(self.certs.functions.issue(r, bytes.fromhex(device_sig[2:]), a, bytes.fromhex(verifier_sig[2:])))
        ev = self.certs.events.CertificateIssued().process_receipt(receipt, errors=DISCARD)
        return int(ev[0]["args"]["id"]), "0x" + receipt["transactionHash"].hex().removeprefix("0x")

    def anchor(self, root: bytes, accepted: int, rejected: int, from_ts: int, to_ts: int) -> tuple[int, str]:
        receipt = self._send(self.certs.functions.anchorAuditBatch(root, accepted, rejected, from_ts, to_ts))
        ev = self.certs.events.AuditBatchAnchored().process_receipt(receipt, errors=DISCARD)
        return int(ev[0]["args"]["batchId"]), "0x" + receipt["transactionHash"].hex().removeprefix("0x")

    def reset_nonce(self) -> None:
        with self._lock:
            self._nonce = None

    def decode_error(self, e: Exception) -> str:
        data = getattr(e, "data", None)
        if isinstance(data, str) and data.startswith("0x") and len(data) >= 10:
            return self._errors.get(data[:10], data[:10])
        msg = str(e)
        for sel, name in self._errors.items():
            if sel in msg:
                return name
        return msg[:200]


class ChainRevert(Exception):
    pass
