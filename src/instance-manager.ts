/**
 * Instance Manager — Spawns and manages coding agent child processes.
 *
 * Each instance runs a CLI backend (Claude Code, Copilot CLI, etc.) with MCP
 * config pointing to a custom bridge server. The bridge connects back to the
 * proxy via TCP for IPC.
 *
 * Uses a Node.js PTY wrapper (pty-wrapper.cjs) to provide a real TTY.
 * This works around Bun's broken node-pty write pipe on Windows ARM64.
 */

import { execSync, spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "net";
import { createInterface } from "readline";
import { join, resolve } from "path";
import treeKill from "tree-kill";
import {
  type Config,
  type ChannelMap,
  type CliBackend,
  type InstanceName,
  type PermissionMode,
  type ChannelNotification,
  type BridgeToolCall,
  type BridgeToolResult,
} from "./types.js";
import { formatUptime } from "./actions.js";

export interface ManagedInstance {
  name: InstanceName;
  channelId: string;
  branch: string;
  mode: PermissionMode;
  backend: CliBackend;
  startedAt: Date;
  worktreePath: string;
  process: ChildProcess;
  /** Connected bridge sockets (MCP bridge + extension can both connect) */
  sockets: Socket[];
  /** Messages queued while waiting for bridge to connect */
  pendingMessages: string[];
  /** Prevents double-kill attempts */
  isKilling: boolean;
  /** Whether a terminal viewer is open (best-effort tracking) */
  terminalOpen: boolean;
}

export type ToolCallHandler = (
  instanceName: InstanceName,
  call: BridgeToolCall
) => Promise<unknown>;

/** Persistent state for roles, models, and running instances — saved to state.json */
let statePath = "";
const roles = new Map<InstanceName, string>();
const models = new Map<InstanceName, string>();
const backends = new Map<InstanceName, CliBackend>();
const repos = new Map<InstanceName, string>();

export interface InstanceSpawnConfig {
  branch: string;
  mode: PermissionMode;
  backend?: CliBackend;
}
const runningState = new Map<InstanceName, InstanceSpawnConfig>();

function saveState(): void {
  if (!statePath) return;
  const data = {
    roles: Object.fromEntries(roles),
    models: Object.fromEntries(models),
    backends: Object.fromEntries(backends),
    repos: Object.fromEntries(repos),
    running: Object.fromEntries(runningState),
  };
  writeFileSync(statePath, JSON.stringify(data, null, 2));
}

export function loadState(path: string): void {
  statePath = path;
  if (!existsSync(path)) return;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data.roles) {
      for (const [name, role] of Object.entries(data.roles)) {
        roles.set(name as InstanceName, role as string);
      }
    }
    if (data.models) {
      for (const [name, model] of Object.entries(data.models)) {
        models.set(name as InstanceName, model as string);
      }
    }
    if (data.backends) {
      for (const [name, backend] of Object.entries(data.backends)) {
        backends.set(name as InstanceName, backend as CliBackend);
      }
    }
    if (data.repos) {
      for (const [name, repo] of Object.entries(data.repos)) {
        repos.set(name as InstanceName, repo as string);
      }
    }
    if (data.running) {
      for (const [name, config] of Object.entries(data.running)) {
        runningState.set(name as InstanceName, config as InstanceSpawnConfig);
      }
    }
    console.log(`Loaded state: ${roles.size} role(s), ${models.size} model(s), ${backends.size} backend(s), ${runningState.size} saved instance(s)`);
  } catch {
    console.error("Failed to load state.json, starting fresh");
  }
}

export function getRole(name: InstanceName): string | undefined {
  return roles.get(name);
}

export function setRole(name: InstanceName, role: string): void {
  roles.set(name, role);
  saveState();
}

export function getAllRoles(): Map<InstanceName, string> {
  return roles;
}

export function getModel(name: InstanceName): string | undefined {
  return models.get(name);
}

export function setModel(name: InstanceName, model: string): void {
  models.set(name, model);
  saveState();
}

export function getAllModels(): Map<InstanceName, string> {
  return models;
}

export function getBackend(name: InstanceName): CliBackend | undefined {
  return backends.get(name);
}

export function setBackend(name: InstanceName, backend: CliBackend): void {
  backends.set(name, backend);
  saveState();
}

export function getAllBackends(): Map<InstanceName, CliBackend> {
  return backends;
}

export function getRepo(name: InstanceName): string | undefined {
  return repos.get(name);
}

export function setRepo(name: InstanceName, repo: string): void {
  repos.set(name, repo);
  saveState();
}

export function getAllRepos(): Map<InstanceName, string> {
  return repos;
}

export function setRunningState(name: InstanceName, config: InstanceSpawnConfig): void {
  runningState.set(name, config);
  saveState();
}

export function removeRunningState(name: InstanceName): void {
  runningState.delete(name);
  saveState();
}

export function clearRunningState(): void {
  runningState.clear();
  saveState();
}

export function getRunningState(): Map<InstanceName, InstanceSpawnConfig> {
  return new Map(runningState);
}

// Import backend utilities — also re-export for use by proxy.ts etc.
import { getBackendDef, getModelPresets, buildCliInvocation, resolveHome, shortenHome } from "./backends/index.js";
export { getBackendDef, getModelPresets, buildCliInvocation };

export class InstanceManager {
  private instances = new Map<string, ManagedInstance>();
  private locks = new Map<string, Promise<void>>();
  private config: Config;
  private channelMap: ChannelMap;
  private onToolCall: ToolCallHandler;
  private onDeath: (name: InstanceName, code: number | null, signal: string | null) => void;
  private tcpServer: NetServer;
  private tcpPort: number = 0;

  constructor(
    config: Config,
    channelMap: ChannelMap,
    onToolCall: ToolCallHandler,
    onDeath: (name: InstanceName, code: number | null, signal: string | null) => void
  ) {
    this.config = config;
    this.channelMap = channelMap;
    this.onToolCall = onToolCall;
    this.onDeath = onDeath;

    this.tcpServer = createServer((socket) =>
      this.handleBridgeConnection(socket)
    );
  }

  /** Serialize operations on the same instance name to prevent race conditions */
  private withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    // Chain onto any existing operation — no TOCTOU gap since we set the new
    // lock synchronously before awaiting
    const prev = this.locks.get(name) ?? Promise.resolve();
    let releaseLock!: () => void;
    const lock = new Promise<void>((r) => { releaseLock = r; });
    this.locks.set(name, lock);
    return prev.then(fn).finally(() => {
      this.locks.delete(name);
      releaseLock();
    });
  }

  /** Kill orphan processes from previous sessions */
  private async cleanupOrphans(): Promise<number> {
    const worktreeBase = resolve(
      resolveHome(this.config.worktree_base)
    );
    if (!existsSync(worktreeBase)) return 0;

    let killed = 0;
    let entries: string[];
    try {
      entries = readdirSync(worktreeBase);
    } catch {
      return 0;
    }

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
        console.log(`Killed orphan process for ${entry} (PID ${pid})`);
      } catch {
        // Process already dead
      }
    }
    return killed;
  }

  async start(): Promise<number> {
    const orphans = await this.cleanupOrphans();
    if (orphans > 0) console.log(`Cleaned up ${orphans} orphan process(es)`);

    return new Promise((resolve, reject) => {
      this.tcpServer.listen(0, "127.0.0.1", () => {
        const addr = this.tcpServer.address();
        if (addr && typeof addr === "object") {
          this.tcpPort = addr.port;
          console.log(
            `Bridge TCP server listening on 127.0.0.1:${this.tcpPort}`
          );
          resolve(this.tcpPort);
        } else {
          reject(new Error("Failed to bind TCP server"));
        }
      });
      this.tcpServer.on("error", reject);
    });
  }

  private handleBridgeConnection(socket: Socket): void {
    const reader = createInterface({ input: socket, crlfDelay: Infinity });

    reader.on("line", (line: string) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      if (parsed.type === "register") {
        const name = parsed.name as string;
        const instance = this.instances.get(name);
        if (instance) {
          instance.sockets.push(socket);
          console.log(`Bridge registered for ${name} (${instance.sockets.length} connection(s))`);
          // Flush any messages queued while waiting for the bridge
          if (instance.pendingMessages.length > 0) {
            console.log(`[${name}] flushing ${instance.pendingMessages.length} queued message(s)`);
            for (const msg of instance.pendingMessages) {
              socket.write(msg + "\n");
            }
            instance.pendingMessages = [];
          }
        }
        return;
      }

      if (parsed.type === "tool_call") {
        const call = parsed as unknown as BridgeToolCall;
        const instance = [...this.instances.values()].find(
          (i) => i.sockets.includes(socket)
        );
        if (!instance) return;

        void this.onToolCall(instance.name, call).then((result) => {
          const response: BridgeToolResult = {
            type: "tool_result",
            id: call.id,
            result,
          };
          // Send result back to the socket that made the call
          socket.write(JSON.stringify(response) + "\n");
        });
      }
    });

    socket.on("error", () => {});
    socket.on("close", () => {
      for (const instance of this.instances.values()) {
        const idx = instance.sockets.indexOf(socket);
        if (idx !== -1) {
          instance.sockets.splice(idx, 1);
          break;
        }
      }
    });
  }

  get running(): Map<string, ManagedInstance> {
    return this.instances;
  }

  isRunning(name: string): boolean {
    return this.instances.has(name);
  }

  async spawn(
    name: InstanceName,
    branch: string = "dev",
    mode: PermissionMode = "default",
    resume: boolean = false
  ): Promise<ManagedInstance> {
    return this.withLock(name, () => this.spawnInternal(name, branch, mode, resume));
  }

  private async spawnInternal(
    name: InstanceName,
    branch: string,
    mode: PermissionMode,
    resume: boolean
  ): Promise<ManagedInstance> {
    // Validate branch name to prevent shell injection via git commands
    if (!/^[a-zA-Z0-9._\-\/]+$/.test(branch)) {
      throw new Error(`invalid branch name: ${branch}`);
    }

    if (this.instances.has(name)) {
      // Clean up stale instance from a previous failed spawn
      await this.killInternal(name);
    }
    if (this.tcpPort === 0) {
      throw new Error("TCP server not started — call start() first");
    }

    const channelId = this.channelMap.workers[name];
    if (!channelId) {
      throw new Error(`no channel mapped for ${name}`);
    }

    const worktreeBase = resolve(
      resolveHome(this.config.worktree_base)
    );
    const worktreePath = join(worktreeBase, name);
    const repoPath = resolve(resolveHome(repos.get(name) ?? this.config.target_repo));

    // Clean up stale worktree if it exists
    if (existsSync(worktreePath)) {
      try {
        execSync(`git worktree remove "${worktreePath}" --force`, { cwd: repoPath, stdio: "pipe" });
      } catch {
        // Force remove the directory if git worktree remove fails
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
      }
    }

    // Prune stale worktree references so git doesn't think the branch is still checked out
    try { execSync("git worktree prune", { cwd: repoPath, stdio: "pipe" }); } catch {}

    mkdirSync(worktreeBase, { recursive: true });

    // Check if the branch already exists (may have work from a previous session)
    let branchExists = false;
    try {
      execSync(`git rev-parse --verify "bot-army/${name}"`, { cwd: repoPath, stdio: "pipe" });
      branchExists = true;
    } catch {}

    if (branchExists) {
      // Reuse existing branch to preserve previous work
      execSync(
        `git worktree add "${worktreePath}" "bot-army/${name}"`,
        { cwd: repoPath, stdio: "pipe" }
      );
    } else {
      // Create fresh branch from the base
      execSync(
        `git worktree add "${worktreePath}" -b "bot-army/${name}" "${branch}"`,
        { cwd: repoPath, stdio: "pipe" }
      );
    }
    // Initialize submodules only for fresh worktrees
    if (!branchExists) {
      cpSpawn("git", ["submodule", "update", "--init", "--recursive"], {
        cwd: worktreePath,
        stdio: "ignore",
      }).on("exit", (code) => {
        if (code === 0) console.log(`[${name}] submodules ready`);
      });
    }

    const backend = backends.get(name) ?? this.config.backend ?? "claude";
    const backendDef = getBackendDef(backend);
    // Let the backend set up its bridge (MCP config, extension loader, etc.)
    const bridgeEnv = {
      BRIDGE_PROXY_HOST: "127.0.0.1",
      BRIDGE_PROXY_PORT: String(this.tcpPort),
      BRIDGE_INSTANCE_NAME: name,
    };
    const mcpConfigPath = backendDef.prepareBridge(worktreePath, bridgeEnv);

    const model = models.get(name) ?? this.config.default_model;
    const role = roles.get(name);
    const { command: cliCommand, args: cliArgs } = buildCliInvocation(backend, {
      mcpConfigPath, mode, model, resume, name, role, worktreePath,
    });

    // Use Node.js PTY wrapper for a real TTY (Bun's node-pty write pipe is broken)
    const wrapperPath = join(import.meta.dir, "pty-wrapper.cjs");
    console.log(`[${name}] spawning (${backend}): node ${shortenHome(wrapperPath)} ${shortenHome(cliCommand)} ${cliArgs.map(a => shortenHome(a)).join(" ")}`);
    const child = cpSpawn(
      "node",
      [wrapperPath, cliCommand, ...cliArgs],
      {
        cwd: worktreePath,
        env: { ...process.env, PTY_CWD: worktreePath, ...bridgeEnv },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Write PID file for orphan cleanup
    if (child.pid) {
      writeFileSync(join(worktreePath, ".bot-army.pid"), String(child.pid));
    }

    const instance: ManagedInstance = {
      name,
      channelId,
      branch,
      mode,
      backend,
      startedAt: new Date(),
      worktreePath,
      process: child,
      sockets: [],
      pendingMessages: [],
      isKilling: false,
      terminalOpen: false,
    };

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.log(`[${name}:err] ${text}`);
    });

    // Run backend-specific post-spawn hook (e.g. Claude's dev channel auto-confirm)
    const cleanupHook = backendDef.onSpawned?.(child, name, bridgeEnv);

    child.on("exit", (code, signal) => {
      cleanupHook?.();
      console.log(`[${name}] process exited: code=${code}, signal=${signal}`);
      // Clean up PID file
      try { unlinkSync(join(worktreePath, ".bot-army.pid")); } catch {}
      // Only clean up if this is still the active instance — a stale exit handler
      // from an old process must not delete a newer instance with the same name
      const current = this.instances.get(name);
      if (current && current.process === child) {
        this.instances.delete(name);
        this.onDeath(name, code, signal);
      }
    });

    this.instances.set(name, instance);

    // Wait for bridge to connect (up to 30s)
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (instance.sockets.length === 0) {
            reject(new Error(`bridge for ${name} did not connect within 30s`));
          }
        }, 30_000);

        const check = setInterval(() => {
          if (instance.sockets.length > 0) {
            clearInterval(check);
            clearTimeout(timeout);
            resolve();
          }
          if (!this.instances.has(name)) {
            clearInterval(check);
            clearTimeout(timeout);
            reject(new Error(`${backend} process for ${name} exited early`));
          }
        }, 200);
      });
    } catch (err) {
      // Clean up on spawn failure so the instance doesn't stay "running"
      cleanupHook?.();
      this.instances.delete(name);
      const pid = child.pid;
      if (pid) {
        treeKill(pid, "SIGTERM", () => {});
      }
      try { unlinkSync(join(worktreePath, ".bot-army.pid")); } catch {}
      throw err;
    }

    return instance;
  }

  /** Write directly to an instance's PTY stdin (e.g. to inject /model commands) */
  sendInput(name: string, text: string): boolean {
    const instance = this.instances.get(name);
    if (!instance) return false;
    instance.process.stdin?.write(text);
    return true;
  }

  /** Get the MCP notification method for an instance's backend */
  getNotificationMethod(name: string): string {
    const backend = backends.get(name as InstanceName) ?? this.config.backend ?? "claude";
    return getBackendDef(backend).notificationMethod;
  }

  sendNotification(name: string, notification: ChannelNotification): boolean {
    const instance = this.instances.get(name);
    if (!instance) return false;

    const msg = JSON.stringify({ type: "notification", data: notification });
    if (instance.sockets.length > 0) {
      for (const s of instance.sockets) {
        try { s.write(msg + "\n"); } catch {}
      }
    } else {
      // Bridge not connected yet — queue for delivery
      instance.pendingMessages.push(msg);
      console.log(`[${name}] bridge not ready, queued message (${instance.pendingMessages.length} pending)`);
    }
    return true;
  }

  async kill(name: string): Promise<boolean> {
    return this.withLock(name, () => this.killInternal(name));
  }

  private async killInternal(name: string): Promise<boolean> {
    const instance = this.instances.get(name);
    if (!instance) return false;
    if (instance.isKilling) return false;
    instance.isKilling = true;

    instance.terminalOpen = false;

    for (const s of instance.sockets) { try { s.end(); } catch {} }

    const pid = instance.process.pid;

    // Helper: wait for exit event with timeout
    const waitForExit = (timeoutMs: number): Promise<boolean> =>
      new Promise((resolve) => {
        if (!this.instances.has(name)) { resolve(true); return; }
        const timeout = setTimeout(() => resolve(false), timeoutMs);
        instance.process.on("exit", () => {
          clearTimeout(timeout);
          resolve(true);
        });
      });

    if (pid) {
      // Step 1: graceful SIGTERM
      await new Promise<void>((resolve) => {
        treeKill(pid, "SIGTERM", () => resolve());
      });

      const exited = await waitForExit(5_000);

      if (!exited) {
        // Step 2: force kill — taskkill /F /T on Windows, SIGKILL elsewhere
        console.log(`[${name}] process did not exit after SIGTERM, force killing (PID ${pid})`);
        try {
          if (process.platform === "win32") {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: "pipe" });
          } else {
            await new Promise<void>((resolve) => {
              treeKill(pid, "SIGKILL", () => resolve());
            });
          }
        } catch {
          // Process may already be dead
        }
        await waitForExit(3_000);
      }
    } else {
      instance.process.kill();
      await waitForExit(5_000);
    }

    this.instances.delete(name);
    return true;
  }

  async killAll(): Promise<string[]> {
    const names = [...this.instances.keys()];
    const results = await Promise.all(names.map((name) => this.kill(name)));
    return names.filter((_, i) => results[i]);
  }

  showTerminal(name: string): void {
    const instance = this.instances.get(name);
    if (!instance) throw new Error(`${name} is not running`);

    const clientPath = join(import.meta.dir, "terminal-client.cjs");
    const viewer = this.openTerminalWindow(name, clientPath);
    viewer.unref();
    instance.terminalOpen = true;
    console.log(`[${name}] interactive terminal opened`);
  }

  /** Open a new terminal window/tab running the terminal client — cross-platform */
  private openTerminalWindow(name: string, clientPath: string): ChildProcess {
    const title = name.charAt(0).toUpperCase() + name.slice(1); // "alpha" → "Alpha"
    const spawnOpts = { detached: true, stdio: "ignore" as const };

    if (process.platform === "win32") {
      // Prefer Windows Terminal (wt) — opens as a tab in the same window
      try {
        execSync("where wt", { stdio: "pipe" });
        return cpSpawn("wt", [
          "-w", "0", "new-tab", "--title", title, "node", clientPath, name,
        ], spawnOpts);
      } catch {}
      // Fallback to cmd.exe start (separate window)
      return cpSpawn("cmd.exe", [
        "/c", "start", `"${title}"`, "node", clientPath, name,
      ], spawnOpts);
    }

    if (process.platform === "darwin") {
      // Open a new tab in Terminal.app with the title set
      const script = [
        `tell application "Terminal"`,
        `  activate`,
        `  do script "node '${clientPath}' ${name}"`,
        `  set custom title of front window to "${title}"`,
        `end tell`,
      ].join("\n");
      return cpSpawn("osascript", ["-e", script], spawnOpts);
    }

    // Linux: try common terminal emulators with title support
    const terminals = [
      { cmd: "x-terminal-emulator", args: ["-T", title, "-e", `node '${clientPath}' ${name}`] },
      { cmd: "gnome-terminal", args: [`--title=${title}`, "--", "node", clientPath, name] },
      { cmd: "konsole", args: ["-p", `tabtitle=${title}`, "-e", "node", clientPath, name] },
      { cmd: "xfce4-terminal", args: [`--title=${title}`, "-e", `node '${clientPath}' ${name}`] },
      { cmd: "xterm", args: ["-T", title, "-e", "node", clientPath, name] },
    ];

    for (const { cmd, args } of terminals) {
      try {
        execSync(`which ${cmd}`, { stdio: "pipe" });
        return cpSpawn(cmd, args, spawnOpts);
      } catch { continue; }
    }
    throw new Error("no terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, xterm)");
  }

  hideTerminal(name: string): void {
    const instance = this.instances.get(name);
    if (!instance) return;
    // Send control message to PTY wrapper to disconnect all terminal clients
    instance.process.stdin?.write(`\x00{"action":"disconnect_clients"}\n`);
    instance.terminalOpen = false;
    console.log(`[${name}] terminal clients disconnected`);
  }

  getStatus(): Array<{
    name: string;
    running: boolean;
    branch?: string;
    mode?: PermissionMode;
    backend?: CliBackend;
    uptime?: string;
    channelId?: string;
    role?: string;
    model?: string;
    worktreePath?: string;
  }> {
    const allNames = Object.keys(this.channelMap.workers);
    return allNames.map((name) => {
      const instance = this.instances.get(name);
      if (!instance) {
        return { name, running: false, role: roles.get(name), model: models.get(name), backend: backends.get(name) };
      }
      const uptime = formatUptime(Date.now() - instance.startedAt.getTime());
      return {
        name,
        running: true,
        branch: instance.branch,
        mode: instance.mode,
        backend: instance.backend,
        uptime,
        channelId: instance.channelId,
        role: roles.get(name),
        model: models.get(name),
        worktreePath: instance.worktreePath,
      };
    });
  }

  async shutdown(): Promise<void> {
    await this.killAll();
    this.tcpServer.close();
  }
}

