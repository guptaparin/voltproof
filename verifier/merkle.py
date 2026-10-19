"""Merkle tree over verdicts, compatible with OpenZeppelin's MerkleProof (sorted pairs)."""
from __future__ import annotations

from eth_abi import encode
from eth_utils import keccak, to_checksum_address

STATUS_CODE = {"ACCEPTED": 1, "HELD": 2, "REJECTED": 3, "FAILED_ONCHAIN": 4, "SUSPENDED": 5}


def leaf(v: dict) -> bytes:
    """Commit to everything a verdict decided. Double-hashed to rule out second-preimage
    attacks between leaves and internal nodes (OpenZeppelin convention)."""
    inner = keccak(encode(
        ["uint256", "address", "uint64", "uint64", "uint64", "uint8", "uint16", "bytes32"],
        [v["id"], to_checksum_address(v["device"]), v["hour_start"], v["energy_wh"], v["nonce"],
         STATUS_CODE[v["status"]], v["score_bps"], bytes.fromhex(v["reading_hash"][2:])],
    ))
    return keccak(inner)


def _pair(a: bytes, b: bytes) -> bytes:
    return keccak(a + b) if a < b else keccak(b + a)


def root_and_proofs(leaves: list[bytes]) -> tuple[bytes, list[list[bytes]]]:
    if not leaves:
        return b"\x00" * 32, []
    proofs: list[list[bytes]] = [[] for _ in leaves]
    idx = list(range(len(leaves)))  # position of each original leaf in the current level
    level = list(leaves)
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            if i + 1 < len(level):
                nxt.append(_pair(level[i], level[i + 1]))
            else:
                nxt.append(level[i])  # odd node promoted
        for li, pos in enumerate(idx):
            sib = pos ^ 1
            if sib < len(level):
                proofs[li].append(level[sib])
            idx[li] = pos // 2
        level = nxt
    return level[0], proofs


def verify(proof: list[bytes], root: bytes, lf: bytes) -> bool:
    h = lf
    for p in proof:
        h = _pair(h, p)
    return h == root
