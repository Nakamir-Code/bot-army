#!/usr/bin/env bun
/**
 * CLI for bot army — sends commands to the running proxy.
 */

import { createInterface } from "readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const port = process.env.CLI_PORT ?? "3100";
const base = `http://localhost:${port}`;

// Load API token
const tokenPath = join(homedir(), ".bot-army", "api-token");
const apiToken = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";

/** Parse args into flags (--key=val or --key val or --bool) and positional args */
function parseFlags(args: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eqIdx = a.indexOf("=");
      if (eqIdx !== -1) {
        flags[a.slice(2, eqIdx)] = a.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        // --backend copilot (space-separated, next arg is not a flag)
        flags[a.slice(2)] = args[++i];
      } else {
        // --new (boolean flag)
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// Persistent CLI history
const historyDir = join(homedir(), ".bot-army");
const historyPath = join(historyDir, "cli_history");
const MAX_HISTORY = 500;

function loadHistory(): string[] {
  try {
    if (existsSync(historyPath)) {
      return readFileSync(historyPath, "utf8").split("\n").filter(Boolean);
    }
  } catch {}
  return [];
}

function saveHistory(history: string[]): void {
  try {
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(historyPath, history.slice(-MAX_HISTORY).join("\n") + "\n");
  } catch {}
}

async function run(cmd: string, args: string[]): Promise<void> {
  let url: string;
  switch (cmd) {
    case "status":
      url = `${base}/status`;
      break;
    case "spawn":
      if (!args[0]) { console.log("Usage: spawn <name> [branch] [mode] [--new] [--backend copilot]"); return; }
      { const { flags, positional } = parseFlags(args);
        url = `${base}/spawn?name=${positional[0]}${positional[1] ? `&branch=${positional[1]}` : ""}${positional[2] ? `&mode=${positional[2]}` : ""}${flags.new ? "&new=true" : ""}${flags.backend ? `&backend=${flags.backend}` : ""}`;
      }
      break;
    case "spawn-all":
      { const { flags, positional } = parseFlags(args);
        url = `${base}/spawn-all?${positional[0] ? `count=${positional[0]}` : ""}${positional[1] ? `&branch=${positional[1]}` : ""}${positional[2] ? `&mode=${positional[2]}` : ""}${flags.new ? "&new=true" : ""}${flags.backend ? `&backend=${flags.backend}` : ""}`;
      }
      break;
    case "kill":
      if (!args[0]) { console.log("Usage: kill <name>"); return; }
      url = `${base}/kill?name=${args[0]}`;
      break;
    case "kill-all":
      url = `${base}/kill-all`;
      break;
    case "new":
      if (!args[0]) { console.log("Usage: new <name> [branch] [mode]"); return; }
      url = `${base}/new?name=${args[0]}${args[1] ? `&branch=${args[1]}` : ""}${args[2] ? `&mode=${args[2]}` : ""}`;
      break;
    case "purge":
      if (!args[0]) { console.log("Usage: purge <name|commander>"); return; }
      url = `${base}/purge?name=${args[0]}`;
      break;
    case "role":
      if (!args[0] || !args[1]) { console.log("Usage: role <name> <role>"); return; }
      url = `${base}/role?name=${args[0]}&role=${encodeURIComponent(args.slice(1).join(" "))}`;
      break;
    case "roles":
      url = `${base}/roles`;
      break;
    case "model":
      if (!args[0] || !args[1]) { console.log("Usage: model <name> <model-id>"); return; }
      url = `${base}/model?name=${args[0]}&model=${encodeURIComponent(args[1])}`;
      break;
    case "models":
      url = `${base}/models`;
      break;
    case "repo":
      if (!args[0] || !args[1]) { console.log("Usage: repo <name> <path>"); return; }
      url = `${base}/repo?name=${args[0]}&repo=${encodeURIComponent(args.slice(1).join(" "))}`;
      break;
    case "repos":
      url = `${base}/repos`;
      break;
    case "terminal":
      if (!args[0]) { console.log("Usage: terminal <show|hide> [name]"); return; }
      url = `${base}/terminal?action=${args[0]}${args[1] && args[1] !== "all" ? `&name=${args[1]}` : ""}`;
      break;
    case "help":
      console.log(`
  Instances
    spawn <name> [branch] [mode]           Spawn a bot (resumes by default)
      [--new] [--backend copilot]
    spawn-all [count] [branch] [mode]      Spawn multiple bots
      [--new] [--backend copilot]
    kill <name>                            Stop a bot
    kill-all                               Stop all bots
    new <name> [branch] [mode]             Kill + purge + spawn fresh
    status                                 Show all running instances

  Configuration
    role <name> <role>                     Assign a role to a bot
    roles                                  Show all role assignments
    model <name> <model-id>                Set model (live, no respawn needed)
    models                                 Show assigned models + available presets
    repo <name> <path>                     Set target repo for a bot
    repos                                  Show all repo assignments

  Channels
    purge <name|commander>                 Clear messages in a channel

  Terminal
    terminal show [name|all]               Open interactive terminal (all if omitted)
    terminal hide [name|all]               Close terminal window

  exit / quit                              Quit CLI
`);
      return;
    case "exit":
    case "quit":
      process.exit(0);
    default:
      console.log(`Unknown: ${cmd}. Type 'help' for commands.`);
      return;
  }

  try {
    const res = await fetch(url, {
      headers: apiToken ? { "Authorization": `Bearer ${apiToken}` } : {},
    });
    const data = await res.json();
    if (res.status === 401) {
      console.log("Unauthorized — API token mismatch. Check ~/.bot-army/api-token");
      return;
    }
    console.log(JSON.stringify(data, null, 2));
  } catch {
    console.log("Failed to connect — is the proxy running? (bun run start)");
  }
}

// One-off mode: bun run cli spawn alpha
const [cmd, ...args] = process.argv.slice(2);
if (cmd) {
  await run(cmd, args);
  process.exit(0);
}

// Interactive mode: bun run cli
console.log("Bot Army CLI — type 'help' for commands, 'exit' to quit\n");
const history = loadHistory();
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "army> ",
  history,
  historySize: MAX_HISTORY,
});
rl.prompt();
const sessionHistory: string[] = [];
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (trimmed) {
    sessionHistory.push(trimmed);
    const parts = trimmed.split(/\s+/);
    await run(parts[0], parts.slice(1));
  }
  rl.prompt();
});
rl.on("close", () => {
  saveHistory([...history, ...sessionHistory]);
  process.exit(0);
});
