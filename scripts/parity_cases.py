"""Generate verifier cases + Python results for the TypeScript parity test (web/scripts/parity.ts)."""
import json, pickle, random, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from verifier.model import MODEL_VERSION
from vpcore.solar import PVSystem, clear_sky_ghi_hour
from vpcore.weather import HourWeather, SyntheticProvider

model = pickle.loads((ROOT / "verifier" / f".model-{MODEL_VERSION}.pkl").read_bytes())
rng = random.Random(77); wx = SyntheticProvider(seed=5)
cases = []
while len(cases) < 2000:
    lat, lon = rng.uniform(8, 32), rng.uniform(70, 92)
    cap = rng.choice([2000, 3000, 5000, 10000, 50000])
    h = 1790000000 + rng.randrange(0, 4000) * 3600
    w = wx.hour(lat, lon, h)
    cloud = None if rng.random() < 0.05 else w.cloud_cover
    night = clear_sky_ghi_hour(h, lat, lon) < 1
    if night and rng.random() < 0.8: continue
    e = int(cap * rng.uniform(0, 1.15) * (0.05 if night else 1))
    hist = [rng.uniform(0.8, 1.1) for _ in range(rng.choice([0, 3, 10, 48]))]
    a = model.assess(e, PVSystem(cap, lat, lon), h, HourWeather(w.ghi, w.temp_c, cloud, "t"), hist)
    cases.append({"e": e, "sys": {"capacityW": cap, "lat": lat, "lon": lon}, "h": h,
                  "wx": {"ghi": w.ghi, "temp_c": w.temp_c, "cloud_cover": cloud, "source": "t"}, "hist": hist,
                  "py": {"status": a.status, "scoreBps": a.score_bps, "expectedWh": a.expected_wh, "ceilingWh": a.ceiling_wh,
                         "components": a.components, "evidenceZ": a.evidence_z, "codes": [r["code"] for r in a.reasons]}})
out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/parity_cases.json")
out.write_text(json.dumps(cases)); print(f"{len(cases)} cases → {out}")
