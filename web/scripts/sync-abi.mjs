// Copies contract ABIs from ../deployments/current.json into lib/abis.json
import fs from "fs";
const src = new URL("../../deployments/current.json", import.meta.url);
if (fs.existsSync(src)) {
  const dep = JSON.parse(fs.readFileSync(src, "utf8"));
  const abis = Object.fromEntries(Object.entries(dep.contracts).map(([k, v]) => [k, v.abi]));
  fs.writeFileSync(new URL("../lib/abis.json", import.meta.url), JSON.stringify(abis));
  console.log("synced ABIs from deployments/current.json");
}
