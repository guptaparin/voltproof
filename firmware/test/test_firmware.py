"""Builds the firmware crypto core for the host and checks it bit-for-bit against the
Python reference (which itself matches the Solidity contract's tests).

    python firmware/test/test_firmware.py
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))

from eth_account import Account  # noqa: E402

from vpcore import eip712  # noqa: E402

UECC = HERE.parent / "third_party" / "micro-ecc"
BUILD = HERE / "build"
BUILD.mkdir(exist_ok=True)
exe = BUILD / "host_test"
subprocess.run(["gcc", "-O2", "-std=c11", "-DuECC_SUPPORTS_secp256k1=1", f"-I{UECC}",
                str(HERE / "host_test.c"), str(HERE.parent / "voltproof_meter" / "voltproof_crypto.c"), str(UECC / "uECC.c"),
                "-o", str(exe)], check=True)

CONTRACT = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
fails = 0
for i in range(25):
    acct = Account.create()
    hour, energy, nonce = 1792000800 + i * 3600, 1234 + i * 97, i + 1
    out = json.loads(subprocess.run([str(exe), acct.key.hex(), "31337", CONTRACT, str(hour), str(energy), str(nonce)],
                                    capture_output=True, text=True, check=True).stdout)
    r = {"device": acct.address, "hourStart": hour, "energyWh": energy, "nonce": nonce}
    ok_addr = out["address"].lower() == acct.address.lower()
    ok_dom = out["domainSeparator"] == "0x" + eip712.domain_separator(31337, CONTRACT).hex()
    ok_dig = out["digest"] == "0x" + eip712.digest(31337, CONTRACT, eip712.reading_struct_hash(r)).hex()
    signer = eip712.recover_reading_signer(31337, CONTRACT, r, out["signature"])
    s = int(out["signature"][66:], 16)
    ok_low_s = s <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
    ok_sig = signer.lower() == acct.address.lower()
    if not all([ok_addr, ok_dom, ok_dig, ok_sig, ok_low_s]):
        fails += 1
        print("FAIL", i, ok_addr, ok_dom, ok_dig, ok_sig, ok_low_s)
print(f"firmware crypto: {25 - fails}/25 vectors match Python/Solidity (address, domain, digest, signature, low-s)")
sys.exit(1 if fails else 0)
