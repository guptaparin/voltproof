"""SQLite store for every verdict (accepted or not), per-meter risk state and audit batches."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  device TEXT NOT NULL,
  device_name TEXT,
  hour_start INTEGER NOT NULL,
  energy_wh INTEGER NOT NULL,
  nonce INTEGER NOT NULL,
  device_sig TEXT NOT NULL,
  reading_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  score_bps INTEGER NOT NULL,
  expected_wh REAL,
  ceiling_wh REAL,
  ratio REAL,
  ghi REAL, poa REAL, temp_c REAL, cloud_cover REAL, clear_sky_ghi REAL,
  weather_source TEXT,
  components TEXT,
  reasons TEXT,
  features TEXT,
  evidence_z REAL,
  cusum REAL,
  attestation TEXT,
  verifier_sig TEXT,
  cosigners TEXT,
  tx_hash TEXT,
  certificate_id INTEGER,
  label TEXT,
  batch_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_v_device ON verdicts(device, hour_start);
CREATE INDEX IF NOT EXISTS idx_v_batch ON verdicts(batch_id);
CREATE TABLE IF NOT EXISTS meter_state (
  device TEXT PRIMARY KEY,
  cusum REAL NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  suspended_reason TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_batches (
  id INTEGER PRIMARY KEY,
  onchain_id INTEGER,
  root TEXT NOT NULL,
  from_verdict INTEGER NOT NULL,
  to_verdict INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  rejected INTEGER NOT NULL,
  tx_hash TEXT,
  created_at INTEGER
);
"""

JSON_COLS = ("components", "reasons", "features", "attestation", "cosigners")


class Store:
    def __init__(self, path: str | Path):
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.lock = threading.RLock()

    def _row(self, r: sqlite3.Row | None) -> dict | None:
        if r is None:
            return None
        d = dict(r)
        for c in JSON_COLS:
            if d.get(c):
                d[c] = json.loads(d[c])
        return d

    def insert_verdict(self, v: dict) -> int:
        v = dict(v)
        for c in JSON_COLS:
            if c in v and not isinstance(v[c], str):
                v[c] = json.dumps(v[c])
        v.setdefault("created_at", int(time.time()))
        cols = ",".join(v)
        with self.lock:
            cur = self.db.execute(f"INSERT INTO verdicts ({cols}) VALUES ({','.join('?' * len(v))})", list(v.values()))
            self.db.commit()
            return cur.lastrowid

    def update_verdict(self, vid: int, **fields) -> None:
        for c in JSON_COLS:
            if c in fields and not isinstance(fields[c], str):
                fields[c] = json.dumps(fields[c])
        sets = ",".join(f"{k}=?" for k in fields)
        with self.lock:
            self.db.execute(f"UPDATE verdicts SET {sets} WHERE id=?", [*fields.values(), vid])
            self.db.commit()

    def verdict(self, vid: int) -> dict | None:
        return self._row(self.db.execute("SELECT * FROM verdicts WHERE id=?", (vid,)).fetchone())

    def verdict_by_certificate(self, cid: int) -> dict | None:
        return self._row(self.db.execute("SELECT * FROM verdicts WHERE certificate_id=?", (cid,)).fetchone())

    def verdicts(self, limit: int = 50, device: str | None = None, status: str | None = None,
                 labelled: bool | None = None, before_id: int | None = None) -> list[dict]:
        q, p = "SELECT * FROM verdicts WHERE 1=1", []
        if device:
            q += " AND lower(device)=lower(?)"; p.append(device)
        if status:
            q += " AND status=?"; p.append(status)
        if labelled is True:
            q += " AND label IS NOT NULL"
        if before_id:
            q += " AND id<?"; p.append(before_id)
        q += " ORDER BY id DESC LIMIT ?"; p.append(limit)
        return [self._row(r) for r in self.db.execute(q, p).fetchall()]

    def device_series(self, device: str, since: int) -> list[dict]:
        rows = self.db.execute(
            "SELECT * FROM verdicts WHERE lower(device)=lower(?) AND hour_start>=? ORDER BY hour_start, id",
            (device, since)).fetchall()
        return [self._row(r) for r in rows]

    def history_ratios(self, device: str, n: int = 48) -> list[float]:
        rows = self.db.execute(
            "SELECT ratio FROM verdicts WHERE lower(device)=lower(?) AND status='ACCEPTED' AND label IS NULL "
            "AND expected_wh IS NOT NULL AND ratio IS NOT NULL AND features IS NOT NULL "
            "AND CAST(json_extract(features,'$[2]') AS REAL) > 0.05 ORDER BY hour_start DESC LIMIT ?",
            (device, n)).fetchall()
        return [r[0] for r in rows]

    # ── meter risk state ──
    def meter_state(self, device: str) -> dict:
        r = self.db.execute("SELECT * FROM meter_state WHERE lower(device)=lower(?)", (device,)).fetchone()
        return dict(r) if r else {"device": device, "cusum": 0.0, "suspended": 0, "suspended_reason": None}

    def set_meter_state(self, device: str, cusum: float, suspended: bool, reason: str | None = None) -> None:
        with self.lock:
            self.db.execute(
                "INSERT INTO meter_state(device,cusum,suspended,suspended_reason,updated_at) VALUES (?,?,?,?,?) "
                "ON CONFLICT(device) DO UPDATE SET cusum=excluded.cusum, suspended=excluded.suspended, "
                "suspended_reason=COALESCE(excluded.suspended_reason, meter_state.suspended_reason), updated_at=excluded.updated_at",
                (device, cusum, int(suspended), reason, int(time.time())))
            self.db.commit()

    def all_meter_states(self) -> dict[str, dict]:
        return {r["device"].lower(): dict(r) for r in self.db.execute("SELECT * FROM meter_state").fetchall()}

    # ── stats ──
    def stats(self) -> dict:
        rows = self.db.execute("SELECT status, COUNT(*) n, COALESCE(SUM(energy_wh),0) wh FROM verdicts GROUP BY status").fetchall()
        by = {r["status"]: {"count": r["n"], "wh": r["wh"]} for r in rows}
        blocked = self.db.execute(
            "SELECT COALESCE(SUM(energy_wh - COALESCE(expected_wh,0)),0) FROM verdicts WHERE status IN ('REJECTED','SUSPENDED') "
            "AND expected_wh IS NOT NULL AND energy_wh > expected_wh").fetchone()[0]
        return {"byStatus": by, "blockedExcessWh": round(blocked or 0)}

    def per_device_summary(self) -> dict[str, dict]:
        rows = self.db.execute(
            "SELECT lower(device) d, COUNT(*) n, SUM(status='ACCEPTED') acc, SUM(status='REJECTED') rej, SUM(status='HELD') held, "
            "COALESCE(SUM(CASE WHEN status='ACCEPTED' THEN energy_wh END),0) wh, MAX(hour_start) last FROM verdicts GROUP BY lower(device)"
        ).fetchall()
        return {r["d"]: dict(r) for r in rows}

    # ── audit batches ──
    def count_unbatched(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM verdicts WHERE batch_id IS NULL").fetchone()[0]

    def unbatched(self) -> list[dict]:
        return [self._row(r) for r in self.db.execute("SELECT * FROM verdicts WHERE batch_id IS NULL ORDER BY id").fetchall()]

    def batch_verdicts(self, batch_id: int) -> list[dict]:
        return [self._row(r) for r in self.db.execute("SELECT * FROM verdicts WHERE batch_id=? ORDER BY id", (batch_id,)).fetchall()]

    def insert_batch(self, b: dict, verdict_ids: list[int]) -> int:
        with self.lock:
            cur = self.db.execute(
                "INSERT INTO audit_batches(onchain_id,root,from_verdict,to_verdict,accepted,rejected,tx_hash,created_at) VALUES (?,?,?,?,?,?,?,?)",
                (b["onchain_id"], b["root"], b["from_verdict"], b["to_verdict"], b["accepted"], b["rejected"], b["tx_hash"], int(time.time())))
            bid = cur.lastrowid
            self.db.executemany("UPDATE verdicts SET batch_id=? WHERE id=?", [(bid, i) for i in verdict_ids])
            self.db.commit()
            return bid

    def batches(self) -> list[dict]:
        return [dict(r) for r in self.db.execute("SELECT * FROM audit_batches ORDER BY id DESC").fetchall()]

    def batch(self, bid: int) -> dict | None:
        r = self.db.execute("SELECT * FROM audit_batches WHERE id=?", (bid,)).fetchone()
        return dict(r) if r else None
