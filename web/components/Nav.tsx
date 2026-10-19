"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Network" },
  { href: "/lab", label: "Attack lab" },
  { href: "/market", label: "Market" },
  { href: "/ledger", label: "Ledger" },
  { href: "/model", label: "How it's verified" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <header className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-8 gap-y-3 px-4 py-5 sm:px-6">
      <Link href="/" className="flex items-center gap-2.5" aria-label="VoltProof home">
        <Mark />
        <span className="wide text-[19px] font-bold tracking-tight">VoltProof</span>
      </Link>
      <nav className="flex flex-wrap gap-x-5 gap-y-1 text-[15px]">
        {LINKS.map((l) => {
          const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={active ? "font-semibold text-ink" : "text-muted hover:text-ink"}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

/** A sun arc under its clear-sky ceiling: the product in one glyph. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M3 25 C 9 3, 23 3, 29 25" fill="none" stroke="rgb(var(--ceiling))" strokeWidth="2" strokeDasharray="2.5 2.5" />
      <path d="M7 25 C 11 11, 21 11, 25 25 Z" fill="rgb(var(--sun))" />
      <path d="M3 25.5 H29" stroke="rgb(var(--ink))" strokeWidth="2" />
    </svg>
  );
}
