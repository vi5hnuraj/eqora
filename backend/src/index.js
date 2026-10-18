import { startReporter } from "./reporter.js";
import { startServer } from "./server.js";

startServer();
startReporter({ onTick: () => console.log("[reporter] cycle complete") });
