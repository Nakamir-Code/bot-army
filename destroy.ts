#!/usr/bin/env bun
/**
 * Destroy script — Removes all Discord channels/category and cleans up local state.
 *
 * Usage: bun run destroy
 *
 * This will:
 *   1. Delete all worker channels (#alpha through #zulu)
 *   2. Delete the #commander channel
 *   3. Delete the bot army category
 *   4. Remove channels.json
 *   5. Remove worktrees and PID files
 *
 * Run `bun run setup` to recreate everything from scratch.
 */

import { readFileSync, existsSync, unlinkSync, rmSync } from "fs";
import { resolve } from "path";
import { createInterface } from "readline";
import { parse as parseYaml } from "yaml";
import { homedir } from "os";
import type { Config, ChannelMap } from "./src/types.js";

const configPath = resolve(
  process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : "config.yaml"
);

if (!existsSync(configPath)) {
  console.error("Config not found. Nothing to destroy.");
  process.exit(1);
}

const config: Config = parseYaml(readFileSync(configPath, "utf8"));
const channelsPath = resolve(configPath, "..", "channels.json");

if (!existsSync(channelsPath)) {
  console.error("channels.json not found. Nothing to destroy. Run `bun run setup` first.");
  process.exit(1);
}

const channelMap: ChannelMap = JSON.parse(readFileSync(channelsPath, "utf8"));
const workerCount = Object.keys(channelMap.workers).length;

const keepWorktrees = process.argv.includes("--keep-worktrees");
const skipConfirm = process.argv.includes("--yes");

// Confirmation prompt
if (!skipConfirm) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    const items = [
      `  - ${workerCount} worker channels`,
      `  - #commander channel`,
      `  - "${config.army_name}-bot-army" category`,
      `  - channels.json`,
    ];
    if (!keepWorktrees) {
      items.push(`  - All worktrees in ${config.worktree_base}`);
    }
    rl.question(
      `\nThis will PERMANENTLY DELETE:\n${items.join("\n")}\n` +
      (keepWorktrees ? `\n(Worktrees will be kept)\n` : "") +
      `\nType "destroy" to confirm: `,
      resolve
    );
  });
  rl.close();

  if (answer.trim().toLowerCase() !== "destroy") {
    console.log("Aborted.");
    process.exit(0);
  }
}

const API = "https://discord.com/api/v10";
const headers = {
  Authorization: `Bot ${config.bot_token}`,
  "Content-Type": "application/json",
};

async function api(method: string, path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { method, headers });
  if (res.status === 429) {
    const data = (await res.json()) as { retry_after: number };
    console.log(`  Rate limited, waiting ${data.retry_after}s...`);
    await new Promise((r) => setTimeout(r, data.retry_after * 1000 + 500));
    return api(method, path);
  }
  if (res.status === 404) return null; // Already deleted
  if (!res.ok) {
    const text = await res.text();
    console.error(`  API error ${res.status}: ${text}`);
    return null;
  }
  if (res.status === 204) return null;
  return res.json();
}

console.log("\nDeleting worker channels...");
const workerEntries = Object.entries(channelMap.workers);
const BATCH_SIZE = 5;
for (let i = 0; i < workerEntries.length; i += BATCH_SIZE) {
  const batch = workerEntries.slice(i, i + BATCH_SIZE);
  await Promise.all(batch.map(async ([name, channelId]) => {
    await api("DELETE", `/channels/${channelId}`);
    process.stdout.write(`  Deleted #${name}\n`);
  }));
  if (i + BATCH_SIZE < workerEntries.length) await new Promise((r) => setTimeout(r, 500));
}

console.log("Deleting #commander...");
await api("DELETE", `/channels/${channelMap.commander_id}`);

console.log("Deleting category...");
await api("DELETE", `/channels/${channelMap.category_id}`);

console.log("Removing channels.json and state.json...");
try { unlinkSync(channelsPath); } catch {}
try { unlinkSync(resolve(configPath, "..", "state.json")); } catch {}

if (!keepWorktrees) {
  const worktreeBase = resolve(config.worktree_base.replace("~", homedir()));
  if (existsSync(worktreeBase)) {
    const { execSync } = await import("child_process");

    // Kill orphan processes using PID files (only kills processes we spawned)
    console.log("Killing orphan processes...");
    try {
      const { readdirSync } = await import("fs");
      const { join } = await import("path");
      const treeKill = (await import("tree-kill")).default;
      const entries = readdirSync(worktreeBase);
      let killed = 0;
      for (const entry of entries) {
        const pidFile = join(worktreeBase, entry, ".bot-army.pid");
        if (!existsSync(pidFile)) continue;
        const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
        try { unlinkSync(pidFile); } catch {}
        if (isNaN(pid)) continue;
        try {
          process.kill(pid, 0); // Check if alive
          await new Promise<void>((resolve) => {
            treeKill(pid, "SIGTERM", () => resolve());
          });
          killed++;
          console.log(`  Killed orphan process for ${entry} (PID ${pid})`);
        } catch {
          // Process already dead
        }
      }
      if (killed > 0) {
        // Give OS time to release file handles
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch {}

    console.log(`Removing worktrees at ${worktreeBase}...`);
    try {
      const repoPath = resolve(config.target_repo.replace("~", homedir()));
      if (existsSync(repoPath)) {
        try { execSync("git worktree prune", { cwd: repoPath, stdio: "pipe" }); } catch {}
      }
      rmSync(worktreeBase, { recursive: true, force: true });
    } catch (err) {
      console.error(`  Failed to remove worktrees: ${err}`);
      console.error(`  Try closing any editors/terminals using those files, then retry.`);
    }
  }
} else {
  console.log("Keeping worktrees (--keep-worktrees).");
}

console.log("\nDone! Run `bun run setup` to start fresh.");
