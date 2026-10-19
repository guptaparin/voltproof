// Deploys VoltProof, grants the verifier role, registers the meter fleet and funds
// producer wallets. Writes ../deployments/<chainId>.json for the verifier and web app.
//
//   npx hardhat run scripts/deploy.js --network localhost
//   VERIFIER_ADDRESSES=0xA,0xB THRESHOLD=2 npx hardhat run scripts/deploy.js --network amoy
const fs = require("fs");
const path = require("path");
const { ethers, network, artifacts } = require("hardhat");

const ROOT = path.resolve(__dirname, "..", "..");
const FLEET_FILE = path.join(ROOT, "simulator", "fleet.json");

async function main() {
  const [deployer, ...rest] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const isLocal = Number(chainId) === 31337;
  console.log(`Network ${network.name} (${chainId}) — deployer ${deployer.address}`);

  // On the local chain, Hardhat accounts #1 and #2 run two independent verifiers (2-of-2).
  const verifierList = (process.env.VERIFIER_ADDRESSES || process.env.VERIFIER_ADDRESS || (isLocal ? `${rest[0].address},${rest[1].address}` : ""))
    .split(",").map((x) => x.trim()).filter(Boolean);
  if (!verifierList.length) throw new Error("Set VERIFIER_ADDRESSES for non-local networks");
  const threshold = Number(process.env.THRESHOLD || verifierList.length);
  const verifierAddress = verifierList[0];

  const registry = await ethers.deployContract("DeviceRegistry", [deployer.address]);
  await registry.waitForDeployment();
  const certs = await ethers.deployContract("GranularCertificate", [
    await registry.getAddress(),
    deployer.address,
    process.env.CERT_URI || "https://voltproof.app/api/certificate/{id}.json",
  ]);
  await certs.waitForDeployment();
  const market = await ethers.deployContract("CertificateMarket", [await certs.getAddress()]);
  await market.waitForDeployment();

  for (const v of verifierList) await (await certs.grantRole(await certs.VERIFIER_ROLE(), v)).wait();
  if (threshold > 1) await (await certs.setAttestationThreshold(threshold)).wait();
  const startBlock = await ethers.provider.getBlockNumber();
  console.log(`DeviceRegistry      ${await registry.getAddress()}`);
  console.log(`GranularCertificate ${await certs.getAddress()}`);
  console.log(`CertificateMarket   ${await market.getAddress()}`);
  console.log(`Verifiers           ${verifierList.join(", ")}  (${threshold}-of-${verifierList.length} required)`);

  // Register the fleet produced by `python -m simulator init`
  if (fs.existsSync(FLEET_FILE)) {
    const fleet = JSON.parse(fs.readFileSync(FLEET_FILE, "utf8"));
    const producerFunding = ethers.parseEther(isLocal ? "10" : process.env.PRODUCER_FUNDING || "0.05");
    const funded = new Set();
    for (const d of fleet.devices) {
      await (
        await registry.registerDevice(
          d.address,
          d.producer,
          Math.round(d.lat * 1e6),
          Math.round(d.lon * 1e6),
          d.capacityW,
          d.name
        )
      ).wait();
      if (!funded.has(d.producer)) {
        await (await deployer.sendTransaction({ to: d.producer, value: producerFunding })).wait();
        funded.add(d.producer);
      }
      console.log(`  registered ${d.name.padEnd(28)} ${d.address}  ${d.capacityW} W`);
    }
  } else {
    console.log("No simulator/fleet.json yet — run `python -m simulator init` first to register meters.");
  }

  const abi = async (name) => (await artifacts.readArtifact(name)).abi;
  const out = {
    chainId: Number(chainId),
    network: network.name,
    rpcUrl: isLocal ? "http://127.0.0.1:8545" : network.config.url,
    startBlock,
    deployedAt: new Date().toISOString(),
    verifier: verifierAddress,
    verifiers: verifierList,
    attestationThreshold: threshold,
    contracts: {
      DeviceRegistry: { address: await registry.getAddress(), abi: await abi("DeviceRegistry") },
      GranularCertificate: { address: await certs.getAddress(), abi: await abi("GranularCertificate") },
      CertificateMarket: { address: await market.getAddress(), abi: await abi("CertificateMarket") },
    },
  };
  const dir = path.join(ROOT, "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${Number(chainId)}.json`), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(dir, "current.json"), JSON.stringify(out, null, 2));
  console.log(`\nWrote deployments/${Number(chainId)}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
