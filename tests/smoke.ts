#!/usr/bin/env bun
/**
 * Smoke test — full lifecycle: destroy, setup, start, test, stop.
 * Tests both backends if available.
 *
 * Usage:
 *   bun run test:smoke                 # full lifecycle
 *   bun run test:smoke --skip-setup    # skip destroy/setup/start (proxy already running)
 *   CLI_PORT=4000 bun tests/smoke.ts   # custom port
 */

import { execSync, spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";

const PORT = process.env.CLI_PORT ?? "3100";
const BASE = `http://127.0.0.1:${PORT}`;
const SKIP_SETUP = process.argv.includes("--skip-setup");
const ROOT = resolve(import.meta.dir, "..");

// Load API token
const tokenPath = join(homedir(), ".bot-army", "api-token");
let apiToken = "";
try { apiToken = readFileSync(tokenPath, "utf8").trim(); } catch {}

let pass = 0;
let fail = 0;
const timings: Array<{ label: string; ms: number }> = [];
const suiteStart = performance.now();
let proxyProcess: ChildProcess | null = null;

const red = (s: string) => console.log(`\x1b[31m${s}\x1b[0m`);
const green = (s: string) => console.log(`\x1b[32m${s}\x1b[0m`);
const bold = (s: string) => console.log(`\x1b[1m${s}\x1b[0m`);

async function api(path: string, label?: string): Promise<any> {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: apiToken ? { "Authorization": `Bearer ${apiToken}` } : {},
    });
    const data = await res.json();
    const ms = Math.round(performance.now() - start);
    if (label) timings.push({ label, ms });
    return data;
  } catch {
    const ms = Math.round(performance.now() - start);
    if (label) timings.push({ label, ms });
    return { error: "connection failed" };
  }
}

function assertEq(description: string, data: any, field: string, expected: any) {
  const keys = field.split(".");
  let val: any = data;
  for (const k of keys) val = val?.[k];
  if (String(val) === String(expected)) {
    green(`  PASS: ${description}`);
    pass++;
  } else {
    red(`  FAIL: ${description}`);
    red(`    expected ${field} = '${expected}', got '${val}'`);
    fail++;
  }
}

function assertNotEmpty(description: string, data: any, field: string) {
  const keys = field.split(".");
  let val: any = data;
  for (const k of keys) val = val?.[k];
  if (val != null && val !== "" && val !== undefined) {
    green(`  PASS: ${description}`);
    pass++;
  } else {
    red(`  FAIL: ${description} (${field} is empty or null)`);
    fail++;
  }
}

function assertGte(description: string, data: any, field: string, min: number) {
  const keys = field.split(".");
  let val: any = data;
  for (const k of keys) val = val?.[k];
  if (typeof val === "number" && val >= min) {
    green(`  PASS: ${description}`);
    pass++;
  } else {
    red(`  FAIL: ${description} (expected >= ${min}, got ${val})`);
    fail++;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function detectBackends(): string[] {
  const backends: string[] = [];
  try { execSync("where claude", { stdio: "pipe" }); backends.push("claude"); } catch {}
  try { execSync("where copilot", { stdio: "pipe" }); backends.push("copilot"); } catch {}
  return backends;
}

function runCmd(label: string, cmd: string, args: string[] = []) {
  const start = performance.now();
  bold(label);
  try {
    execSync(`bun ${cmd} ${args.join(" ")}`, { cwd: ROOT, stdio: "inherit" });
    const ms = Math.round(performance.now() - start);
    timings.push({ label, ms });
    green(`  done (${ms}ms)`);
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    timings.push({ label, ms });
    red(`  FAILED: ${err instanceof Error ? err.message : err}`);
    fail++;
  }
}

async function waitForProxy(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Reload token each attempt (proxy may have just generated it)
    try { apiToken = readFileSync(tokenPath, "utf8").trim(); } catch {}
    try {
      const res = await fetch(`${BASE}/status`, {
        headers: apiToken ? { "Authorization": `Bearer ${apiToken}` } : {},
      });
      if (res.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function cleanup() {
  if (proxyProcess) {
    bold("Stopping proxy");
    proxyProcess.kill("SIGTERM");
    await sleep(2000);
    proxyProcess = null;
  }
  // Clean up test config
  const testConfigPath = resolve(ROOT, "config.test.yaml");
  try { (await import("fs")).unlinkSync(testConfigPath); } catch {}
}

// Handle unexpected exits
process.on("SIGINT", async () => { await cleanup(); process.exit(1); });
process.on("SIGTERM", async () => { await cleanup(); process.exit(1); });

// --- Main ---

const backends = detectBackends();
if (backends.length === 0) {
  red("No backends found. Install claude or copilot CLI.");
  process.exit(1);
}

bold(`Smoke test — port ${PORT}, backends: ${backends.join(", ")}, setup: ${SKIP_SETUP ? "skipped" : "full"}`);
console.log();

// --- Setup phase ---
if (!SKIP_SETUP) {
  // Destroy existing setup
  if (existsSync(resolve(ROOT, "channels.json"))) {
    runCmd("Destroy", "run destroy -- --yes --keep-worktrees");
  } else {
    bold("Destroy");
    console.log("  skipped (no channels.json)");
  }

  // Setup
  runCmd("Setup", "run setup");

  // Create a test config from the real one, with auto_spawn disabled
  const { readFileSync, writeFileSync, unlinkSync } = await import("fs");
  const { parse: parseYaml, stringify: stringifyYaml } = await import("yaml");

  const configPath = resolve(ROOT, "config.yaml");
  const testConfigPath = resolve(ROOT, "config.test.yaml");
  const configObj = parseYaml(readFileSync(configPath, "utf8"));
  configObj.auto_spawn = false;
  configObj.auto_update = false;
  configObj.cli_port = parseInt(PORT, 10);
  writeFileSync(testConfigPath, stringifyYaml(configObj));

  // Start proxy in background with test config
  bold("Starting proxy");
  const start = performance.now();
  proxyProcess = spawn("bun", ["run", "src/proxy.ts", "--config", testConfigPath], {
    cwd: ROOT,
    stdio: "pipe",
  });

  // Pipe proxy output so errors are visible
  proxyProcess.stdout?.on("data", (d) => process.stdout.write(`  [proxy] ${d}`));
  proxyProcess.stderr?.on("data", (d) => process.stderr.write(`  [proxy:err] ${d}`));

  proxyProcess.on("exit", (code) => {
    if (code !== null && code !== 0) {
      red(`  Proxy exited with code ${code}`);
    }
  });

  const ready = await waitForProxy();
  const ms = Math.round(performance.now() - start);
  timings.push({ label: "proxy startup", ms });
  if (!ready) {
    red("  Proxy did not start within 30s");
    await cleanup();
    process.exit(1);
  }
  green(`  Proxy ready (${ms}ms)`);
  // Reload token (proxy generates it on first run)
  try { apiToken = readFileSync(tokenPath, "utf8").trim(); } catch {}
  console.log();
} else {
  // Verify proxy is running
  const probe = await api("/status");
  if (probe.error) {
    red(`Proxy is not running on port ${PORT}. Start it with: bun run start`);
    process.exit(1);
  }
}

// --- Test phase ---

// Clean slate
bold("Kill all (clean slate)");
await api("/kill-all", "kill-all (cleanup)");
await sleep(1000);

// Status
bold("Status");
let result = await api("/status", "status");
assertGte("status returns total count", result, "total", 1);
assertNotEmpty("status has instances", result, "instances");

// Role + Model (pre-spawn)
bold("Roles & Models (pre-spawn)");
result = await api("/role?name=alpha&role=smoke%20tester", "set role");
assertEq("set role", result, "ok", true);
assertEq("role name matches", result, "name", "alpha");

result = await api("/roles", "get roles");
assertEq("roles includes alpha", result, "alpha", "smoke tester");

result = await api("/model?name=alpha&model=claude-sonnet-4-6", "set model");
assertEq("set model", result, "ok", true);
assertEq("model not live (not spawned)", result, "live", false);

result = await api("/models", "get models");
assertNotEmpty("models has assigned", result, "assigned");
assertNotEmpty("models has available presets", result, "available");

// Per-backend lifecycle
for (const backend of backends) {
  console.log();
  bold(`=== Backend: ${backend} ===`);

  // Spawn
  bold(`Spawn (${backend})`);
  result = await api(`/spawn?name=alpha&branch=dev&backend=${backend}`, `spawn (${backend})`);
  assertEq("spawn ok", result, "ok", true);
  assertEq("spawn name", result, "name", "alpha");
  assertNotEmpty("spawn channelId", result, "channelId");

  await sleep(3000);

  // Status while running
  bold("Status (running)");
  result = await api("/status", `status (${backend} running)`);
  assertGte("at least 1 active instance", result, "active", 1);

  // Model switch (live)
  bold("Model switch (live)");
  result = await api("/model?name=alpha&model=claude-sonnet-4-6", `model switch (${backend})`);
  assertEq("model switch ok", result, "ok", true);
  assertEq("model switch is live", result, "live", true);

  // Kill
  bold("Kill");
  result = await api("/kill?name=alpha", `kill (${backend})`);
  assertEq("kill ok", result, "ok", true);

  await sleep(2000);

  // Verify stopped
  result = await api("/status", `status after kill (${backend})`);
  const alpha = result.instances?.find((i: any) => i.name === "alpha");
  if (!alpha?.running) {
    green("  PASS: alpha is stopped after kill");
    pass++;
  } else {
    red("  FAIL: alpha still running after kill");
    fail++;
  }
}

// Final cleanup
console.log();
bold("Final cleanup");
await api("/kill-all", "kill-all (final)");
await sleep(1000);

// --- Teardown ---
await cleanup();

// Timing report
const totalMs = Math.round(performance.now() - suiteStart);
console.log();
bold("Timings");
for (const { label, ms } of timings) {
  const color = ms > 10000 ? "\x1b[31m" : ms > 5000 ? "\x1b[33m" : "\x1b[32m";
  console.log(`  ${color}${String(ms).padStart(6)}ms\x1b[0m  ${label}`);
}
console.log(`  \x1b[2m──────────────\x1b[0m`);
console.log(`  ${String(totalMs).padStart(6)}ms  total`);

// Summary
console.log();
bold(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  red("SMOKE TEST FAILED");
  process.exit(1);
} else {
  green("SMOKE TEST PASSED");
}
