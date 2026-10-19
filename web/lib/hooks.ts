"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Health } from "./api";

export function usePoll<T>(path: string | null, intervalMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e: any) {
      if (alive.current) setError(e.message || String(e));
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    load();
    if (!intervalMs) return () => { alive.current = false; };
    const t = setInterval(load, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load, intervalMs]);
  return { data, error, reload: load };
}

let healthPromise: Promise<Health> | null = null;
export function useHealth() {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    healthPromise ??= api<Health>("/v1/health");
    healthPromise.then(setH).catch((e) => {
      healthPromise = null;
      setErr(e.message);
    });
  }, []);
  return { health: h, error: err };
}
