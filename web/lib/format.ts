export function energy(wh: number | null | undefined, digits?: number): string {
  if (wh == null || Number.isNaN(wh)) return "—";
  const a = Math.abs(wh);
  if (a >= 1e6) return `${(wh / 1e6).toFixed(digits ?? 2)} MWh`;
  if (a >= 1e3) return `${(wh / 1e3).toFixed(digits ?? 1)} kWh`;
  return `${Math.round(wh).toLocaleString()} Wh`;
}

export function power(w: number): string {
  return w >= 1000 ? `${(w / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kW` : `${w} W`;
}

export function hourLabel(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function hourRange(ts: number): string {
  const a = new Date(ts * 1000);
  const b = new Date((ts + 3600) * 1000);
  const day = a.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day}, ${t(a)}–${t(b)}`;
}

export function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const short = (a?: string | null, n = 6) => (a ? `${a.slice(0, n)}…${a.slice(-4)}` : "—");
export const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
