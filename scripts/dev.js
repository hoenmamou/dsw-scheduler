const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const nextDir = path.join(projectRoot, ".next");

try {
  // OneDrive marks generated files as reparse points, which can make
  // Next.js dev cleanup fail with EINVAL on Windows startup.
  fs.rmSync(nextDir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 150,
  });
} catch (error) {
  console.error("Failed to clear .next before starting Next.js dev mode.");
  console.error(error);
  process.exit(1);
}

const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "dev", ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
