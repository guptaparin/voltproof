"""Model of what a real, honest meter measures.

Satellite/reanalysis irradiance is never a perfect match for one rooftop: passing clouds,
local haze, panel soiling, shading and system ageing all make the true output differ from
the estimate. This module generates realistic honest readings with those effects, and is
used (a) by the fleet simulator and (b) to train the verifier's anomaly detector on what
"normal" disagreement between a meter and the satellite looks like.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from .solar import PVSystem, clear_sky_ghi_hour, pv_energy_wh
from .weather import HourWeather


@dataclass
class MeterProfile:
    system: PVSystem
    health: float = 0.95  # soiling / ageing / mismatch multiplier on top of the PR
    shading_utc_hours: tuple[int, ...] = field(default_factory=tuple)  # e.g. tree shade
    shading_factor: float = 0.55


def local_irradiance_error_sigma(cloud_cover_pct: float | None) -> float:
    """Log-normal sigma of rooftop-vs-satellite irradiance mismatch. Largest under
    broken cloud (~50%), small under clear or fully overcast skies."""
    if cloud_cover_pct is None:
        return 0.15
    c = max(0.0, min(1.0, cloud_cover_pct / 100))
    return 0.05 + 0.22 * 4 * c * (1 - c)


def honest_energy_wh(meter: MeterProfile, hour_start: int, wx: HourWeather, rng: random.Random) -> int:
    sigma = local_irradiance_error_sigma(wx.cloud_cover)
    local_ghi = wx.ghi * math.exp(rng.gauss(-sigma ** 2 / 2, sigma))
    # hourly-mean irradiance cannot meaningfully exceed clear sky (cloud enhancement ≲ 8 %)
    local_ghi = min(local_ghi, clear_sky_ghi_hour(hour_start, meter.system.lat, meter.system.lon) * 1.08)
    e, _ = pv_energy_wh(meter.system, hour_start, local_ghi, wx.temp_c)
    e *= meter.health * rng.gauss(1.0, 0.025)
    utc_hour = (hour_start // 3600) % 24
    if utc_hour in meter.shading_utc_hours:
        e *= meter.shading_factor
    e = min(max(e, 0.0), meter.system.capacity_w * 1.0)
    return int(round(e))
