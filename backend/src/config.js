import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, "..", "..");

dotenv.config({ path: path.join(repoRoot, "backend", ".env") });

function loadDeployment() {
  const preferred = path.join(repoRoot, "contracts", "deployments", "polygonAmoy.json");
  const fallback = path.join(repoRoot, "contracts", "deployments", "local-hardhat.json");
  for (const file of [preferred, fallback]) {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  }
  return null;
}

export const config = {
  privateKey: process.env.PRIVATE_KEY,
  amoyRpcUrl: process.env.AMOY_RPC_URL || "https://polygon-amoy-bor-rpc.publicnode.com",
  amoyOracleAddress: process.env.AMOY_ORACLE_ADDRESS || null,
  tiramisuRpcUrl: process.env.TIRAMISU_RPC_URL || null,
  tiramisuAccessKey: process.env.TIRAMISU_ACCESS_KEY || null,
  port: Number(process.env.PORT || 8787),
  deployment: loadDeployment(),
  repoRoot,
};

export function oracleAddress() {
  if (config.amoyOracleAddress) return config.amoyOracleAddress;
  const dep = config.deployment;
  if (dep?.contracts?.EqoraPriceOracle) return dep.contracts.EqoraPriceOracle;
  throw new Error("No oracle address: set AMOY_ORACLE_ADDRESS or run contracts deploy first");
}
