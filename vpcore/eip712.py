"""EIP-712 typed data shared by meters, verifier and the on-chain contract."""
from __future__ import annotations

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak, to_checksum_address
from eth_abi import encode

READING_FIELDS = [
    {"name": "device", "type": "address"},
    {"name": "hourStart", "type": "uint64"},
    {"name": "energyWh", "type": "uint64"},
    {"name": "nonce", "type": "uint64"},
]
ATTESTATION_FIELDS = [
    {"name": "readingHash", "type": "bytes32"},
    {"name": "expectedWh", "type": "uint64"},
    {"name": "scoreBps", "type": "uint16"},
    {"name": "modelHash", "type": "bytes32"},
    {"name": "issuedAt", "type": "uint64"},
]
DOMAIN_FIELDS = [
    {"name": "name", "type": "string"},
    {"name": "version", "type": "string"},
    {"name": "chainId", "type": "uint256"},
    {"name": "verifyingContract", "type": "address"},
]

READING_TYPEHASH = keccak(b"Reading(address device,uint64 hourStart,uint64 energyWh,uint64 nonce)")
ATTESTATION_TYPEHASH = keccak(
    b"Attestation(bytes32 readingHash,uint64 expectedWh,uint16 scoreBps,bytes32 modelHash,uint64 issuedAt)"
)


def domain(chain_id: int, contract: str) -> dict:
    return {"name": "VoltProof", "version": "1", "chainId": chain_id, "verifyingContract": to_checksum_address(contract)}


def domain_separator(chain_id: int, contract: str) -> bytes:
    return keccak(encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [
            keccak(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak(b"VoltProof"), keccak(b"1"), chain_id, to_checksum_address(contract),
        ],
    ))


def reading_struct_hash(r: dict) -> bytes:
    return keccak(encode(
        ["bytes32", "address", "uint64", "uint64", "uint64"],
        [READING_TYPEHASH, to_checksum_address(r["device"]), int(r["hourStart"]), int(r["energyWh"]), int(r["nonce"])],
    ))


def attestation_struct_hash(a: dict) -> bytes:
    return keccak(encode(
        ["bytes32", "bytes32", "uint64", "uint16", "bytes32", "uint64"],
        [ATTESTATION_TYPEHASH, _b32(a["readingHash"]), int(a["expectedWh"]), int(a["scoreBps"]),
         _b32(a["modelHash"]), int(a["issuedAt"])],
    ))


def digest(chain_id: int, contract: str, struct_hash: bytes) -> bytes:
    return keccak(b"\x19\x01" + domain_separator(chain_id, contract) + struct_hash)


def _b32(v) -> bytes:
    if isinstance(v, (bytes, bytearray)):
        return bytes(v)
    return bytes.fromhex(v[2:] if v.startswith("0x") else v)


def _full(chain_id: int, contract: str, primary: str, fields: list, message: dict) -> dict:
    return {
        "types": {"EIP712Domain": DOMAIN_FIELDS, primary: fields},
        "primaryType": primary,
        "domain": domain(chain_id, contract),
        "message": message,
    }


def sign_reading(private_key: str, chain_id: int, contract: str, r: dict) -> str:
    msg = {"device": to_checksum_address(r["device"]), "hourStart": int(r["hourStart"]),
           "energyWh": int(r["energyWh"]), "nonce": int(r["nonce"])}
    signed = Account.sign_message(encode_typed_data(full_message=_full(chain_id, contract, "Reading", READING_FIELDS, msg)), private_key)
    return "0x" + signed.signature.hex().removeprefix("0x")


def sign_attestation(private_key: str, chain_id: int, contract: str, a: dict) -> str:
    msg = {"readingHash": _b32(a["readingHash"]), "expectedWh": int(a["expectedWh"]), "scoreBps": int(a["scoreBps"]),
           "modelHash": _b32(a["modelHash"]), "issuedAt": int(a["issuedAt"])}
    signed = Account.sign_message(encode_typed_data(full_message=_full(chain_id, contract, "Attestation", ATTESTATION_FIELDS, msg)), private_key)
    return "0x" + signed.signature.hex().removeprefix("0x")


def recover_reading_signer(chain_id: int, contract: str, r: dict, signature: str) -> str:
    """Recover the signer. Accepts 65-byte (r,s,v) signatures, or 64-byte (r,s) from
    constrained devices — in which case v is derived by matching the claimed device."""
    d = digest(chain_id, contract, reading_struct_hash(r))
    sig = _b32(signature)
    if len(sig) == 64:
        for v in (27, 28):
            try:
                addr = Account._recover_hash(d, signature=sig + bytes([v]))
            except Exception:
                continue
            if addr.lower() == r["device"].lower():
                return addr
        return "0x" + "00" * 20
    return Account._recover_hash(d, signature=sig)


SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


def normalize_signature(chain_id: int, contract: str, r: dict, signature: str) -> str:
    """Return a 65-byte, low-s signature the contract accepts (adds v for 64-byte inputs)."""
    sig = _b32(signature)
    if len(sig) == 65:
        return "0x" + sig.hex()
    s = int.from_bytes(sig[32:], "big")
    if s > SECP256K1_N // 2:  # OpenZeppelin ECDSA rejects malleable high-s signatures
        sig = sig[:32] + (SECP256K1_N - s).to_bytes(32, "big")
    d = digest(chain_id, contract, reading_struct_hash(r))
    for v in (27, 28):
        try:
            if Account._recover_hash(d, signature=sig + bytes([v])).lower() == r["device"].lower():
                return "0x" + (sig + bytes([v])).hex()
        except Exception:
            pass
    return "0x" + (sig + b"\x1b").hex()
