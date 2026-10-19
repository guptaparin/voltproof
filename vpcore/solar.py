"""Solar geometry, clear-sky irradiance and a PV yield model.

Everything here is deterministic physics (no data, no learning). The verifier uses it
for two things:

* a hard *ceiling*: no panel can produce more than clear-sky irradiance allows, and
  nothing at all once the sun is below the horizon;
* an *expected* yield from measured/satellite irradiance, against which a meter's
  claim is compared.

References: NOAA solar position algorithm (simplified), Haurwitz clear-sky model,
Erbs diffuse decomposition, isotropic-sky plane-of-array transposition,
NOCT cell-temperature model.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone

SOLAR_CONSTANT = 1361.0  # W/m²
HOUR = 3600


@dataclass(frozen=True)
class SunPosition:
    zenith_deg: float
    azimuth_deg: float  # clockwise from north
    extraterrestrial: float  # normal-incidence extraterrestrial irradiance, W/m²

    @property
    def cos_zenith(self) -> float:
        return math.cos(math.radians(self.zenith_deg))


def sun_position(ts: float, lat: float, lon: float) -> SunPosition:
    """Approximate solar position (accurate to ~0.5° — ample for hourly energy)."""
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    doy = dt.timetuple().tm_yday
    hour = dt.hour + dt.minute / 60 + dt.second / 3600
    gamma = 2 * math.pi / 365 * (doy - 1 + (hour - 12) / 24)

    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma)
                       - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma))
    decl = (0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma)
            - 0.006758 * math.cos(2 * gamma) + 0.000907 * math.sin(2 * gamma)
            - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma))

    true_solar_min = hour * 60 + eqtime + 4 * lon
    ha = math.radians(true_solar_min / 4 - 180)
    la = math.radians(lat)

    cos_z = math.sin(la) * math.sin(decl) + math.cos(la) * math.cos(decl) * math.cos(ha)
    cos_z = max(-1.0, min(1.0, cos_z))
    zen = math.acos(cos_z)

    # azimuth, clockwise from north
    sin_z = math.sin(zen)
    if sin_z < 1e-6:
        az = 180.0
    else:
        cos_az = (math.sin(decl) - math.sin(la) * cos_z) / (math.cos(la) * sin_z)
        az = math.degrees(math.acos(max(-1.0, min(1.0, cos_az))))
        if ha > 0:
            az = 360 - az

    e0 = SOLAR_CONSTANT * (1 + 0.033 * math.cos(2 * math.pi * doy / 365))
    return SunPosition(math.degrees(zen), az, e0)


def clear_sky_ghi(ts: float, lat: float, lon: float) -> float:
    """Haurwitz clear-sky global horizontal irradiance (W/m²) at an instant."""
    cz = sun_position(ts, lat, lon).cos_zenith
    if cz <= 0.0:
        return 0.0
    return 1098.0 * cz * math.exp(-0.059 / cz)


def hourly_mean(fn, hour_start: float, samples: int = 12) -> float:
    step = HOUR / samples
    return sum(fn(hour_start + (i + 0.5) * step) for i in range(samples)) / samples


def clear_sky_ghi_hour(hour_start: float, lat: float, lon: float) -> float:
    return hourly_mean(lambda t: clear_sky_ghi(t, lat, lon), hour_start)


def poa_from_ghi(ghi: float, sun: SunPosition, tilt_deg: float, azimuth_deg: float = 180.0,
                 albedo: float = 0.2) -> float:
    """Plane-of-array irradiance from GHI via Erbs decomposition + isotropic sky."""
    cz = sun.cos_zenith
    if ghi <= 0 or cz <= 0.01:
        return 0.0
    kt = min(1.0, ghi / (sun.extraterrestrial * cz))
    if kt <= 0.22:
        df = 1 - 0.09 * kt
    elif kt <= 0.80:
        df = 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4
    else:
        df = 0.165
    dhi = ghi * df
    dni = max(0.0, (ghi - dhi) / cz)

    b = math.radians(tilt_deg)
    z = math.radians(sun.zenith_deg)
    cos_aoi = (math.cos(z) * math.cos(b)
               + math.sin(z) * math.sin(b) * math.cos(math.radians(sun.azimuth_deg - azimuth_deg)))
    beam = dni * max(0.0, cos_aoi)
    sky = dhi * (1 + math.cos(b)) / 2
    ground = ghi * albedo * (1 - math.cos(b)) / 2
    return beam + sky + ground


@dataclass(frozen=True)
class PVSystem:
    capacity_w: float
    lat: float
    lon: float
    tilt_deg: float | None = None  # defaults to |latitude| (typical fixed rooftop)
    azimuth_deg: float | None = None  # south-facing in the northern hemisphere
    performance_ratio: float = 0.86  # inverter, wiring, mismatch, soiling
    temp_coeff: float = -0.0037  # per °C (crystalline Si)
    noct: float = 45.0

    @property
    def tilt(self) -> float:
        return abs(self.lat) if self.tilt_deg is None else self.tilt_deg

    @property
    def azimuth(self) -> float:
        if self.azimuth_deg is not None:
            return self.azimuth_deg
        return 180.0 if self.lat >= 0 else 0.0


def pv_energy_wh(system: PVSystem, hour_start: float, ghi_mean: float, temp_air_c: float,
                 samples: int = 6) -> tuple[float, float]:
    """Expected AC energy (Wh) over the hour and the mean POA irradiance (W/m²).

    The hourly mean GHI is distributed across sub-intervals in proportion to the
    clear-sky shape, so morning/evening hours are handled correctly.
    """
    step = HOUR / samples
    times = [hour_start + (i + 0.5) * step for i in range(samples)]
    cs = [clear_sky_ghi(t, system.lat, system.lon) for t in times]
    cs_mean = sum(cs) / samples
    if cs_mean <= 0 or ghi_mean <= 0:
        return 0.0, 0.0

    energy = 0.0
    poa_total = 0.0
    for t, c in zip(times, cs):
        ghi_t = ghi_mean * (c / cs_mean)
        sun = sun_position(t, system.lat, system.lon)
        poa = poa_from_ghi(ghi_t, sun, system.tilt, system.azimuth)
        t_cell = temp_air_c + (system.noct - 20) / 800 * poa
        dc = system.capacity_w * (poa / 1000) * (1 + system.temp_coeff * (t_cell - 25))
        ac = min(max(dc, 0.0) * system.performance_ratio, system.capacity_w)  # inverter clipping
        energy += ac * (step / HOUR)
        poa_total += poa
    return energy, poa_total / samples


def clear_sky_ceiling_wh(system: PVSystem, hour_start: float, margin: float = 1.15) -> float:
    """Physical upper bound for the hour: clear sky, cold panel, perfect system, plus a
    margin for cloud-edge enhancement. Readings above this are physically impossible."""
    ghi_cs = clear_sky_ghi_hour(hour_start, system.lat, system.lon)
    best = PVSystem(system.capacity_w, system.lat, system.lon, system.tilt_deg,
                    system.azimuth_deg, performance_ratio=1.0, temp_coeff=0.0)
    e, _ = pv_energy_wh(best, hour_start, ghi_cs, 25.0)
    return min(e * margin, system.capacity_w * 11 / 10)  # exactly the on-chain cap (110%)
