import { marketOpenIST, pushPrices, reporterIntervalMs } from "./market.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function runOnce() {
  const market = marketOpenIST();
  const hashes = await pushPrices();
  for (const entry of hashes) {
    if (entry.skipped) {
      console.log(`[reporter] ${entry.symbol} skipped: ${entry.reason}`);
      continue;
    }
    console.log(
      `[reporter] ${entry.symbol} ₹${entry.price} → ${entry.txHash} (${entry.status})`
    );
  }
  console.log(`[reporter] market=${market.open ? "open" : "closed"} ${market.at ?? ""}`);
  return hashes;
}

export function startReporter({ onTick } = {}) {
  let timer = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce();
      onTick?.();
    } catch (error) {
      console.error("[reporter]", error.message);
    } finally {
      running = false;
      timer = setTimeout(tick, reporterIntervalMs());
    }
  };

  timer = setTimeout(tick, 0);
  return () => clearTimeout(timer);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runOnce()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("[reporter] failed:", error.message);
      process.exit(1);
    });
}
