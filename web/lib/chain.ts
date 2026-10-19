"use client";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import abis from "./abis.json";
import type { Health } from "./api";

export const ABI = abis as unknown as {
  DeviceRegistry: any;
  GranularCertificate: any;
  CertificateMarket: any;
};

export function chainFor(h: Health) {
  const rpc = process.env.NEXT_PUBLIC_RPC_URL || h.rpcUrl;
  return defineChain({
    id: h.chainId,
    name: h.chainId === 31337 ? "Local testnet" : h.chainId === 80002 ? "Polygon Amoy" : `Chain ${h.chainId}`,
    nativeCurrency: { name: h.chainId === 80002 ? "POL" : "ETH", symbol: h.chainId === 80002 ? "POL" : "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

// Untyped on purpose: ABIs are loaded from JSON at runtime.
export function publicClient(h: Health): any {
  return createPublicClient({ chain: chainFor(h), transport: http(undefined, { batch: true }) });
}

export const explorerTx = (h: Health, tx: string) =>
  h.chainId === 80002 ? `https://amoy.polygonscan.com/tx/${tx}` : null;

export type Wallet = { client: WalletClient; account: Account | `0x${string}`; address: `0x${string}`; kind: "demo" | "injected" };

/** Local demo uses a funded test key; on public testnets connect a browser wallet. */
export async function getWallet(h: Health, preferInjected = false): Promise<Wallet> {
  const chain = chainFor(h);
  const demoKey = process.env.NEXT_PUBLIC_DEMO_BUYER_KEY as `0x${string}` | undefined;
  const eth = typeof window !== "undefined" ? (window as any).ethereum : undefined;
  if (demoKey && !(preferInjected && eth)) {
    const account = privateKeyToAccount(demoKey);
    return { client: createWalletClient({ account, chain, transport: http() }), account, address: account.address, kind: "demo" };
  }
  if (!eth) throw new Error("No wallet found. Install a browser wallet, or set NEXT_PUBLIC_DEMO_BUYER_KEY for the local demo.");
  const [address] = (await eth.request({ method: "eth_requestAccounts" })) as `0x${string}`[];
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${h.chainId.toString(16)}` }] });
  } catch {}
  return { client: createWalletClient({ account: address, chain, transport: custom(eth) }), account: address, address, kind: "injected" };
}
