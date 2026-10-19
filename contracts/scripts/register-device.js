// Register a physical meter (e.g. the ESP32) in the on-chain registry.
//   DEVICE=0x... CAPACITY_W=10 LAT=30.35 LON=76.36 NAME="My panel" [OWNER=0x...] \
//     npx hardhat run scripts/register-device.js --network localhost
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../deployments/current.json"), "utf8"));
  const [admin] = await ethers.getSigners();
  const reg = await ethers.getContractAt("DeviceRegistry", dep.contracts.DeviceRegistry.address, admin);
  const { DEVICE, CAPACITY_W, LAT, LON, NAME, OWNER } = process.env;
  if (!DEVICE || !CAPACITY_W || !LAT || !LON) throw new Error("DEVICE, CAPACITY_W, LAT, LON required");
  const tx = await reg.registerDevice(DEVICE, OWNER || admin.address, Math.round(+LAT * 1e6), Math.round(+LON * 1e6), +CAPACITY_W, NAME || "ESP32 meter");
  await tx.wait();
  console.log(`Registered ${DEVICE} (${CAPACITY_W} W) — tx ${tx.hash}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
