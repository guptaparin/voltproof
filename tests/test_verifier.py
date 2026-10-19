"""Unit tests for the verifier's physics, cryptography, audit log and model.

    pip install pytest && pytest -q
"""
import calendar
import random

import pytest
from eth_account import Account

from verifier import merkle
from verifier.model import CUSUM_H, VerificationModel, cusum_update
from vpcore import eip712
from vpcore.production import MeterProfile, honest_energy_wh
from vpcore.solar import PVSystem, clear_sky_ceiling_wh, clear_sky_ghi_hour, pv_energy_wh, sun_position
from vpcore.weather import HourWeather, SyntheticProvider

PATIALA = (30.3525, 76.3616)
OCT18 = calendar.timegm((2026, 10, 18, 0, 0, 0))
CONTRACT = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"


@pytest.fixture(scope="module")
def model():
    return VerificationModel().train(6000)


# ── physics ─────────────────────────────────────────────────────────────────
def test_no_sun_at_night_and_peak_near_local_noon():
    lat, lon = PATIALA
    by_hour = {h: clear_sky_ghi_hour(OCT18 + h * 3600, lat, lon) for h in range(24)}
    assert by_hour[18] == 0 and by_hour[20] == 0  # 23:30 and 01:30 IST
    peak = max(by_hour, key=by_hour.get)
    assert peak in (6, 7)  # 11:30–13:30 IST
    assert 650 < by_hour[peak] < 900  # October clear-sky GHI at 30°N


def test_sun_position_solar_noon_zenith():
    lat, lon = PATIALA
    # solar noon ≈ 06:45 UTC; zenith ≈ latitude − declination (~ −9.6° on 18 Oct)
    z = min(sun_position(OCT18 + m * 60, lat, lon).zenith_deg for m in range(300, 500))
    assert 38 < z < 41


def test_expected_energy_scales_with_capacity_and_is_capped():
    lat, lon = PATIALA
    h = OCT18 + 6 * 3600
    e3, _ = pv_energy_wh(PVSystem(3000, lat, lon), h, 700, 25)
    e6, _ = pv_energy_wh(PVSystem(6000, lat, lon), h, 700, 25)
    assert e6 == pytest.approx(2 * e3, rel=1e-6)
    assert clear_sky_ceiling_wh(PVSystem(3000, lat, lon), h) <= 3300


def test_honest_meter_never_exceeds_ceiling():
    rng = random.Random(1)
    wx = SyntheticProvider()
    lat, lon = PATIALA
    m = MeterProfile(PVSystem(5000, lat, lon), health=1.02)
    for k in range(300):
        h = OCT18 + k * 3600
        assert honest_energy_wh(m, h, wx.hour(lat, lon, h), rng) <= clear_sky_ceiling_wh(m.system, h) + 1


# ── EIP-712 ─────────────────────────────────────────────────────────────────
def test_sign_and_recover_reading():
    acct = Account.create()
    r = {"device": acct.address, "hourStart": OCT18, "energyWh": 1234, "nonce": 7}
    sig = eip712.sign_reading(acct.key.hex(), 31337, CONTRACT, r)
    assert eip712.recover_reading_signer(31337, CONTRACT, r, sig) == acct.address
    tampered = dict(r, energyWh=1235)
    assert eip712.recover_reading_signer(31337, CONTRACT, tampered, sig) != acct.address


def test_64_byte_signatures_are_normalised_to_low_s():
    acct = Account.create()
    r = {"device": acct.address, "hourStart": OCT18, "energyWh": 99, "nonce": 1}
    full = bytes.fromhex(eip712.sign_reading(acct.key.hex(), 31337, CONTRACT, r)[2:])
    rr, s = full[:32], int.from_bytes(full[32:64], "big")
    high = rr + (eip712.SECP256K1_N - s).to_bytes(32, "big")  # malleable twin
    norm = bytes.fromhex(eip712.normalize_signature(31337, CONTRACT, r, "0x" + high.hex())[2:])
    assert int.from_bytes(norm[32:64], "big") <= eip712.SECP256K1_N // 2
    assert eip712.recover_reading_signer(31337, CONTRACT, r, "0x" + norm.hex()) == acct.address


# ── Merkle audit log ────────────────────────────────────────────────────────
@pytest.mark.parametrize("n", [1, 2, 3, 7, 60, 61])
def test_every_verdict_has_a_valid_proof(n):
    leaves = [merkle.leaf({"id": i, "device": CONTRACT, "hour_start": OCT18, "energy_wh": i, "nonce": i,
                           "status": "ACCEPTED" if i % 3 else "REJECTED", "score_bps": 9000,
                           "reading_hash": "0x" + "ab" * 32}) for i in range(n)]
    root, proofs = merkle.root_and_proofs(leaves)
    assert all(merkle.verify(p, root, lf) for p, lf in zip(proofs, leaves))
    if n > 1:  # editing one verdict breaks its proof
        forged = merkle.leaf({"id": 0, "device": CONTRACT, "hour_start": OCT18, "energy_wh": 999, "nonce": 0,
                              "status": "ACCEPTED", "score_bps": 9000, "reading_hash": "0x" + "ab" * 32})
        assert not merkle.verify(proofs[0], root, forged)


# ── model ───────────────────────────────────────────────────────────────────
def _hour(model, energy, hour_offset=6, ghi=650, cloud=10, history=None):
    lat, lon = PATIALA
    system = PVSystem(5000, lat, lon)
    h = OCT18 + hour_offset * 3600
    return model.assess(energy, system, h, HourWeather(ghi, 26, cloud, "test"), history or [0.95] * 20), system, h


def test_honest_claim_is_accepted(model):
    lat, lon = PATIALA
    exp, _ = pv_energy_wh(PVSystem(5000, lat, lon), OCT18 + 6 * 3600, 650, 26)
    a, _, _ = _hour(model, int(exp * 0.95), ghi=650)
    assert a.status == "ACCEPTED" and a.score_bps >= 7000


def test_night_claim_is_rejected(model):
    a, _, _ = _hour(model, 1500, hour_offset=20, ghi=0)
    assert a.status == "REJECTED" and a.reasons[0]["code"] == "NIGHT_GENERATION"


def test_above_physical_ceiling_is_rejected(model):
    lat, lon = PATIALA
    ceiling = clear_sky_ceiling_wh(PVSystem(5000, lat, lon), OCT18 + 3 * 3600)
    a, _, _ = _hour(model, int(ceiling) + 50, hour_offset=3)
    assert a.status == "REJECTED" and any(r["code"] == "ABOVE_CLEAR_SKY_CEILING" for r in a.reasons)


def test_full_sun_claim_under_heavy_cloud_is_not_certified(model):
    lat, lon = PATIALA
    clear, _ = pv_energy_wh(PVSystem(5000, lat, lon), OCT18 + 6 * 3600, 780, 26)
    a, _, _ = _hour(model, int(clear), ghi=180, cloud=90)
    assert a.status != "ACCEPTED"


def test_under_reporting_is_not_punished(model):
    a, _, _ = _hour(model, 300, ghi=650)  # heavy shading or a fault
    assert a.status == "ACCEPTED"


def test_cusum_suspends_persistent_overclaiming_but_not_noise():
    s = 0.0
    for z in [0.8, -0.5, 1.1, 0.2, -1.0] * 40:  # honest-looking noise
        s = cusum_update(s, z)
    assert s < CUSUM_H
    for _ in range(12):
        s = cusum_update(s, 2.8)  # steady over-claiming
    assert s > CUSUM_H
