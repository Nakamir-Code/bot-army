#!/usr/bin/env bun
/**
 * Proxy entry point -- loads config, starts the platform adapter,
 * instance manager, actions, and HTTP API.
 *
 * Usage: bun run src/proxy.ts [--config path/to/config.yaml]
 */

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import { InstanceManager, loadState, removeRunningState, getRunningState, setRunningState } from "./instance-manager.js";
import { createActions, capitalize } from "./actions.js";
import { createApiServer, loadApiToken } from "./api.js";
import { createToolHandler } from "./tool-handler.js";
import { DiscordAdapter } from "./platforms/discord/adapter.js";
import type { Config, ChannelMap, InstanceName } from "./types.js";

// Load config
const configPath = resolve(
  process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : "config.yaml"
);

if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

const config: Config = parseYaml(readFileSync(configPath, "utf8"));
const CLI_PORT = config.cli_port ?? parseInt(process.env.CLI_PORT ?? "3100", 10);

// Load channel map
const channelsPath = resolve(configPath, "..", "channels.json");
if (!existsSync(channelsPath)) {
  console.error("channels.json not found. Run `bun run setup` first.");
  process.exit(1);
}

const channelMap: ChannelMap = JSON.parse(readFileSync(channelsPath, "utf8"));

// Load persisted state
const statePath = resolve(configPath, "..", "state.json");
loadState(statePath);

// Reverse lookup: channel ID -> instance name
const channelToName = new Map<string, InstanceName>();
const INSTANCE_NAMES = Object.keys(channelMap.workers);
for (const [name, id] of Object.entries(channelMap.workers)) {
  channelToName.set(id, name as InstanceName);
}

// Global error handler
process.on("unhandledRejection", (err: unknown) => {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: number }).code;
    if (code === 10062 || code === 40060) return;
  }
  console.error("Unhandled rejection:", err);
});

// Platform adapter
const platform = new DiscordAdapter({ config, channelMap, instanceNames: INSTANCE_NAMES, channelToName });
const chatService = platform.chatService;

// Use a late-binding wrapper so manager and toolHandler can reference each other
let _actions: ReturnType<typeof createActions>;

const manager = new InstanceManager(
  config,
  channelMap,
  // Tool calls are forwarded to the tool handler
  (instanceName, call) => {
    const handler = createToolHandler({
      chatService,
      manager,
      channelMap,
      channelToName,
      config,
    });
    return handler(instanceName, call);
  },
  // Death handler
  (name, code, signal) => _actions.handleDeath(name, code, signal)
);

const actions = createActions({
  manager,
  chat: chatService,
  config,
  channelMap,
  instanceNames: INSTANCE_NAMES,
  onDashboardUpdate: () => platform.updateDashboard(),
});
_actions = actions;

// Start everything
await manager.start();
await platform.start(manager, actions);

// Restore or auto-spawn
const savedRunning = getRunningState();
if (savedRunning.size > 0) {
  console.log(`Restoring ${savedRunning.size} previously running instance(s) in parallel...`);
  await Promise.all([...savedRunning].map(async ([name, cfg]) => {
    try {
      console.log(`Restoring ${name}...`);
      await actions.actionSpawn(name, cfg.branch, cfg.mode, true);
      console.log(`${capitalize(name)} restored.`);
    } catch (err) {
      console.error(`Failed to restore ${name}:`, err);
      removeRunningState(name);
    }
  }));
} else if (config.auto_spawn) {
  const autoName = (config.auto_spawn?.name ?? "alpha") as InstanceName;
  const autoBranch = config.auto_spawn?.branch ?? actions.DEFAULT_BRANCH;
  const autoMode = config.auto_spawn?.mode ?? actions.DEFAULT_MODE;
  try {
    console.log(`Auto-spawning ${autoName}...`);
    await actions.actionSpawn(autoName, autoBranch, autoMode, false);
    console.log(`${capitalize(autoName)} spawned successfully.`);
  } catch (err) {
    console.error(`Failed to auto-spawn ${autoName}:`, err);
  }
}

// Post initial dashboard after restores/auto-spawn are complete
await platform.updateDashboard();

// Auto-update watcher
startAutoUpdateWatcher();

// HTTP API
const apiToken = loadApiToken();
const apiServer = createApiServer({
  manager,
  chat: chatService,
  actions,
  config,
  channelMap,
  instanceNames: INSTANCE_NAMES,
  apiToken,
}, CLI_PORT);

apiServer.listen(CLI_PORT, "127.0.0.1", () => {
  console.log(`CLI API on http://localhost:${CLI_PORT} (try /status)`);
});
apiServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`CLI API port ${CLI_PORT} is already in use. Is another instance running?`);
  } else {
    console.error("CLI API server error:", err);
  }
});

// Graceful shutdown
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down...");
  // Snapshot running state before killing processes so they auto-restore on next start
  const snapshot = getRunningState();
  await actions.logToCommander(`**${config.army_name} Bot Army** is shutting down.`).catch(() => {});
  await manager.shutdown();
  // Restore the running state so bots are re-spawned on next start
  for (const [name, cfg] of snapshot) setRunningState(name, cfg);
  await platform.shutdown();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

function startAutoUpdateWatcher(): void {
  if (config.auto_update === false) return;
  const intervalMs = ((config.auto_update?.interval_seconds) ?? 60) * 1000;
  const branch = config.auto_update?.branch ?? "main";
  const botArmyRepo = resolve(import.meta.dir, "..");

  console.log(`Auto-update: polling ${branch} every ${intervalMs / 1000}s`);

  setInterval(async () => {
    try {
      // Skip if there are no commits yet or no remote configured
      try {
        execSync("git rev-parse HEAD", { cwd: botArmyRepo, stdio: "pipe" });
      } catch {
        return;
      }
      execSync(`git fetch origin ${branch}`, { cwd: botArmyRepo, stdio: "pipe" });
      const local = execSync("git rev-parse HEAD", { cwd: botArmyRepo, stdio: "pipe" }).toString().trim();
      const remote = execSync(`git rev-parse origin/${branch}`, { cwd: botArmyRepo, stdio: "pipe" }).toString().trim();

      if (local !== remote) {
        console.log(`Update available: ${local.slice(0, 8)} -> ${remote.slice(0, 8)}`);
        await actions.logToCommander(`**Update detected.** Pulling latest changes and restarting...`);
        execSync(`git pull --ff-only origin ${branch}`, { cwd: botArmyRepo, stdio: "pipe" });
        await shutdown();
      }
    } catch (err) {
      console.error("Auto-update check failed:", err instanceof Error ? err.message : err);
    }
  }, intervalMs);
}
