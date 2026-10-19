import "@fontsource-variable/archivo/standard.css";
import "./globals.css";
import type { Metadata } from "next";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "VoltProof — hourly solar certificates you can verify",
  description:
    "Meter-signed, AI-verified, double-claim-proof renewable energy certificates for small solar producers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Nav />
        <main className="mx-auto max-w-[1180px] px-4 pb-24 sm:px-6">{children}</main>
        <footer className="mx-auto max-w-[1180px] px-4 pb-10 text-sm text-muted sm:px-6">
          VoltProof · built for the IEEE ClimateChain Global Hackathon 2026 · Renewable Energy &amp; Energy Trading track
        </footer>
      </body>
    </html>
  );
}
