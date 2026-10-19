"""Independent irradiance sources the verifier checks meter claims against.

* ``OpenMeteoProvider`` — real satellite/reanalysis-derived hourly shortwave radiation
  and air temperature from Open-Meteo (free, no API key). Used whenever reachable.
* ``SyntheticProvider`` — deterministic physics-based weather (clear-sky × smooth
  cloud field) used only when the network is unavailable, so the demo still runs
  offline. Every verdict records which source was used.
"""
from __future__ import annotations

import json
import math
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from .solar import HOUR, clear_sky_ghi_hour


@dataclass(frozen=True)
class HourWeather:
    ghi: float  # mean global horizontal irradiance over the hour, W/m²
    temp_c: float
    cloud_cover: float | None  # %
    source: str


class SyntheticProvider:
    name = "synthetic-physics"

    def __init__(self, seed: int = 2026):
        self.seed = seed

    def _noise(self, x: float, key: int) -> float:
        """Smooth 1-D value noise in [0,1]."""
        i = math.floor(x)
        f = x - i
        def h(n: int) -> float:
            v = (n * 374761393 + key * 668265263 + self.seed * 1442695041) & 0xFFFFFFFF
            v = ((v ^ (v >> 13)) * 1274126177) & 0xFFFFFFFF
            return (v & 0xFFFF) / 0xFFFF
        u = f * f * (3 - 2 * f)
        return h(i) * (1 - u) + h(i + 1) * u

    def hour(self, lat: float, lon: float, hour_start: int) -> HourWeather:
        key = int(round(lat * 10)) * 7919 + int(round(lon * 10))
        hrs = hour_start / HOUR
        # cloud cover evolves over ~half a day with faster small-scale variation
        c = 0.65 * self._noise(hrs / 14.0, key) + 0.35 * self._noise(hrs / 3.0, key + 17)
        cloud = max(0.0, min(1.0, (c - 0.35) / 0.6))
        transmittance = 1 - 0.75 * cloud ** 1.6
        ghi = clear_sky_ghi_hour(hour_start, lat, lon) * transmittance

        dt = datetime.fromtimestamp(hour_start + HOUR / 2, tz=timezone.utc)
        doy = dt.timetuple().tm_yday
        local_solar_h = (dt.hour + dt.minute / 60 + lon / 15) % 24
        seasonal = 27 - 0.35 * (abs(lat) - 20) - 6 * math.cos(2 * math.pi * (doy - 15) / 365) * (1 if lat >= 0 else -1)
        diurnal = 6 * math.sin(2 * math.pi * (local_solar_h - 9) / 24)
        return HourWeather(ghi=ghi, temp_c=seasonal + diurnal - 3 * cloud, cloud_cover=cloud * 100, source=self.name)


class OpenMeteoProvider:
    """Hourly data from Open-Meteo. ``shortwave_radiation`` is the mean over the
    *preceding* hour, so the value stamped H+1h describes the hour starting at H."""

    name = "open-meteo"
    FORECAST = "https://api.open-meteo.com/v1/forecast"
    ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"

    def __init__(self, cache_path: str | Path = "weather_cache.sqlite", timeout: float = 8.0):
        self.timeout = timeout
        self._lock = threading.Lock()
        self.db = sqlite3.connect(str(cache_path), check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS wx (k TEXT PRIMARY KEY, v TEXT)")

    def _fetch_day(self, lat: float, lon: float, day: str) -> dict:
        k = f"{lat:.2f},{lon:.2f},{day}"
        with self._lock:
            row = self.db.execute("SELECT v FROM wx WHERE k=?", (k,)).fetchone()
        if row:
            return json.loads(row[0])

        params = {
            "latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}",
            "hourly": "shortwave_radiation,temperature_2m,cloud_cover",
            "start_date": day, "end_date": (datetime.fromisoformat(day) + timedelta(days=1)).date().isoformat(),
            "timezone": "GMT",
        }
        age_days = (datetime.now(timezone.utc).date() - datetime.fromisoformat(day).date()).days
        url = self.ARCHIVE if age_days > 60 else self.FORECAST
        r = httpx.get(url, params=params, timeout=self.timeout)
        r.raise_for_status()
        data = r.json()["hourly"]
        table = {
            t: (sw, tc, cc)
            for t, sw, tc, cc in zip(data["time"], data["shortwave_radiation"], data["temperature_2m"], data["cloud_cover"])
        }
        # Only cache fully past days (today's values may still be revised)
        if age_days >= 2:
            with self._lock:
                self.db.execute("INSERT OR REPLACE INTO wx VALUES (?,?)", (k, json.dumps(table)))
                self.db.commit()
        return table

    def hour(self, lat: float, lon: float, hour_start: int) -> HourWeather:
        stamp = datetime.fromtimestamp(hour_start + HOUR, tz=timezone.utc)
        table = self._fetch_day(lat, lon, datetime.fromtimestamp(hour_start, tz=timezone.utc).date().isoformat())
        key = stamp.strftime("%Y-%m-%dT%H:00")
        if key not in table or table[key][0] is None:
            raise LookupError(f"no Open-Meteo data for {key}")
        sw, tc, cc = table[key]
        return HourWeather(ghi=float(sw), temp_c=float(tc), cloud_cover=None if cc is None else float(cc), source=self.name)


class AutoProvider:
    """Prefer real data; fall back to synthetic physics (and remember the outage briefly)."""

    def __init__(self, cache_path: str | Path = "weather_cache.sqlite", mode: str = "auto"):
        self.mode = mode
        self.real = OpenMeteoProvider(cache_path) if mode in ("auto", "open-meteo") else None
        self.synthetic = SyntheticProvider()
        self._down_until = 0.0

    @property
    def name(self) -> str:
        return {"auto": "auto (open-meteo → synthetic)", "open-meteo": "open-meteo", "synthetic": "synthetic-physics"}[self.mode]

    def hour(self, lat: float, lon: float, hour_start: int) -> HourWeather:
        import time
        if self.real and time.time() >= self._down_until:
            try:
                return self.real.hour(lat, lon, hour_start)
            except Exception:
                if self.mode == "open-meteo":
                    raise
                self._down_until = time.time() + 300
        return self.synthetic.hour(lat, lon, hour_start)
