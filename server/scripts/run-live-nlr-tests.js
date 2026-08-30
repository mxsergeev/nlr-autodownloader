import { spawn } from "node:child_process";
import path from "node:path";

if (process.env.RUN_LIVE_NLR_TESTS !== "1") {
  console.error("Live NLR tests are disabled. Set RUN_LIVE_NLR_TESTS=1 to run them.");
  process.exit(1);
}

const vitest = path.resolve("node_modules/vitest/vitest.mjs");
const config = path.resolve("vitest.live.config.js");

const child = spawn(process.execPath, [vitest, "run", "--config", config], {
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Unable to start the live NLR test gate: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`The live NLR test gate terminated with signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
