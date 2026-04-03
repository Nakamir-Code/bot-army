/**
 * Action functions — shared between chat commands and the HTTP API.
 */

import type {
  Config,
  ChannelMap,
  InstanceName,
  PermissionMode,
  ChannelNotification,
} from "./types.js";

import type { InstanceManager } from "./instance-manager.js";
import {
  getRole,
  setRole,
  getAllRoles,
  getModel,
  getBackend,
  getRepo,
  setRunningState,
  removeRunningState,
  clearRunningState,
} from "./instance-manager.js";
import type { ChatService } from "./chat-service.js";

export interface ActionDeps {
  manager: InstanceManager;
  chat: ChatService;
  config: Config;
  channelMap: ChannelMap;
  instanceNames: string[];
  onDashboardUpdate?: () => Promise<void>;
}

export type SpawnResult =
  | { ok: true; name: InstanceName; branch: string; mode: PermissionMode; channelId: string }
  | { ok: false; name: InstanceName; error: string };

/** Track intentional kills so death handler can distinguish crash vs command */
const killedByCommand = new Set<InstanceName>();

/** Track the spawn message ID per instance */
const dutyMessageIds = new Map<InstanceName, string>();

export function createActions(deps: ActionDeps) {
  const { manager, chat, config, channelMap, instanceNames, onDashboardUpdate } = deps;
  const DEFAULT_BRANCH = config.default_branch ?? "dev";
  const DEFAULT_MODE = config.default_mode ?? "default";
  const PURGE_CHANNELS = config.purge_channels ?? false;

  function buildDutyMessage(name: InstanceName, branch: string, mode: PermissionMode): string {
    const role = getRole(name);
    const model = getModel(name);
    const backend = getBackend(name) ?? config.backend ?? "claude";
    const repo = getRepo(name);
    const extras = [
      role ? `Role: \`${role}\`` : "",
      model ? `Model: \`${model}\`` : "",
      `Backend: \`${backend}\``,
      repo ? `Repo: \`${repo}\`` : "",
    ].filter(Boolean).join(" | ");
    return `**${capitalize(name)}, reporting for duty!**\nBranch: \`${branch}\` | Mode: \`${mode}\`${extras ? `\n${extras}` : ""}`;
  }

  async function announceSpawn(name: InstanceName, branch: string, mode: PermissionMode, channelId: string): Promise<void> {
    const dutyMsgId = await chat.sendToChannel(channelId, buildDutyMessage(name, branch, mode));
    dutyMessageIds.set(name, dutyMsgId);
    await logToCommander(`**${capitalize(name)}** is now online.\n${buildDutyMessage(name, branch, mode).split("\n").slice(1).join("\n")}`);
    await updateDashboard();
  }

  async function logToCommander(text: string): Promise<void> {
    try {
      await chat.sendToChannel(channelMap.commander_id, text);
    } catch (err) {
      console.error("Failed to log to commander:", err);
    }
  }

  async function updateDashboard(): Promise<void> {
    if (onDashboardUpdate) {
      try { await onDashboardUpdate(); } catch (err) {
        console.error("Failed to update dashboard:", err);
      }
    }
  }

  async function actionSpawn(name: InstanceName, branch: string, mode: PermissionMode, resume: boolean): Promise<SpawnResult> {
    killedByCommand.add(name);
    const channelId = channelMap.workers[name];
    if (!resume) await chat.purgeChannel(channelId);

    await manager.spawn(name, branch, mode, resume);
    setRunningState(name, { branch, mode });
    await announceSpawn(name, branch, mode, channelId);
    return { ok: true, name, branch, mode, channelId };
  }

  async function actionSpawnAll(
    count: number, branch: string, mode: PermissionMode, resume: boolean,
    onProgress?: (done: number, total: number, results: Map<string, string>) => void
  ): Promise<{ toSpawn: string[]; results: Map<string, string> }> {
    const available = instanceNames.filter((n) => !manager.isRunning(n));
    const toSpawn = available.slice(0, count);
    const results = new Map<string, string>();

    if (toSpawn.length === 0) return { toSpawn, results };

    if (!resume) {
      await Promise.all(toSpawn.map(async (name) => {
        const channelId = channelMap.workers[name];
        await chat.purgeChannel(channelId);
      }));
    }

    let done = 0;
    await Promise.all(toSpawn.map(async (name) => {
      try {
        await manager.spawn(name as InstanceName, branch, mode, resume);
        setRunningState(name as InstanceName, { branch, mode });
        const channelId = channelMap.workers[name];
        await announceSpawn(name as InstanceName, branch, mode, channelId);
        results.set(name, `ok`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.set(name, msg);
      }
      done++;
      onProgress?.(done, toSpawn.length, results);
    }));

    await updateDashboard();
    return { toSpawn, results };
  }

  async function actionKill(name: string): Promise<{ killed: boolean; uptime?: string }> {
    killedByCommand.add(name as InstanceName);
    removeRunningState(name as InstanceName);
    const status = manager.getStatus().find((s) => s.name === name);
    const uptime = status?.uptime;
    const killed = await manager.kill(name);
    // Post "stood down" in the bot's own channel
    const channelId = channelMap.workers[name];
    if (killed && channelId && !PURGE_CHANNELS) {
      await chat.sendToChannel(channelId, `**${capitalize(name)}** stood down.${uptime ? ` (was up ${uptime})` : ""}`).catch(() => {});
    }
    if (PURGE_CHANNELS && channelId) {
      try { await chat.purgeChannel(channelId); } catch {}
    }
    await updateDashboard();
    return { killed, uptime };
  }

  async function actionKillAll(): Promise<string[]> {
    const names = [...manager.running.keys()];
    for (const n of names) killedByCommand.add(n as InstanceName);
    clearRunningState();
    const killed = await manager.killAll();
    if (PURGE_CHANNELS) {
      await Promise.all(names.map(async (name) => {
        const channelId = channelMap.workers[name];
        if (channelId) {
          try { await chat.purgeChannel(channelId); } catch {}
        }
      }));
    }
    await updateDashboard();
    // Return in config order, not completion order
    return instanceNames.filter((n) => killed.includes(n));
  }

  async function actionNew(name: InstanceName, branch: string, mode: PermissionMode): Promise<SpawnResult> {
    killedByCommand.add(name);
    const channelId = channelMap.workers[name];
    await chat.purgeChannel(channelId);

    await manager.spawn(name, branch, mode);
    await announceSpawn(name, branch, mode, channelId);
    return { ok: true, name, branch, mode, channelId };
  }

  async function actionSetRole(name: InstanceName, role: string): Promise<void> {
    setRole(name, role);

    if (manager.isRunning(name)) {
      const instance = manager.running.get(name);
      if (instance) {
        const notification: ChannelNotification = {
          method: manager.getNotificationMethod(name),
          params: {
            content:
              `[System] Your role has been updated. You are ${name}, a bot army instance. ` +
              `Your specialization: ${role}. Remember this as your identity.`,
            meta: {
              chat_id: instance.channelId,
              message_id: `role-${Date.now()}`,
              user: "system",
              user_id: "bot-army-system",
              ts: new Date().toISOString(),
            },
          },
        };
        manager.sendNotification(name, notification);

        const dutyMsgId = dutyMessageIds.get(name);
        if (dutyMsgId) {
          try {
            await chat.editMessage(instance.channelId, dutyMsgId, buildDutyMessage(name, instance.branch, instance.mode));
          } catch {}
        }
      }
    }

    await updateDashboard();
  }

  function actionGetRoles(): Record<string, string> {
    return Object.fromEntries(getAllRoles());
  }

  function handleDeath(name: InstanceName, code: number | null, signal: string | null): void {
    dutyMessageIds.delete(name);
    const wasIntentional = killedByCommand.delete(name);

    let publicReason: string;
    if (wasIntentional) {
      publicReason = "has been stood down.";
    } else if (code === 0) {
      publicReason = "has finished and signed off.";
    } else if (code !== null) {
      publicReason = `is offline (crashed, exit code: ${code}).`;
    } else if (signal) {
      publicReason = `is offline (signal: ${signal}).`;
    } else {
      publicReason = "is offline.";
    }
    void logToCommander(`**${capitalize(name)}** ${publicReason}`);
    void updateDashboard();
  }

  return {
    actionSpawn,
    actionSpawnAll,
    actionKill,
    actionKillAll,
    actionNew,
    actionSetRole,
    actionGetRoles,
    handleDeath,
    logToCommander,
    updateDashboard,
    DEFAULT_BRANCH,
    DEFAULT_MODE,
  };
}

export type Actions = ReturnType<typeof createActions>;

// --- Helpers ---

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let breakAt = remaining.lastIndexOf("\n", limit);
    if (breakAt < limit * 0.5) {
      breakAt = remaining.lastIndexOf(" ", limit);
    }
    if (breakAt < limit * 0.3) {
      breakAt = limit;
    }

    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }

  return chunks;
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
