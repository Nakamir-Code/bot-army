/**
 * Command handler -- platform-neutral command definitions and execution.
 * Platform adapters convert these into slash commands, text commands, etc.
 */

import type { InstanceManager } from "./instance-manager.js";
import { setBackend, setModel, getAllModels, getModelPresets, setRepo, getAllRepos } from "./instance-manager.js";
import { getBackendChoices } from "./backends/index.js";
import type { Config, InstanceName, PermissionMode, CliBackend } from "./types.js";
import type { ChatService, RichContent } from "./chat-service.js";
import type { Actions } from "./actions.js";

export interface CommandOption {
  name: string;
  description: string;
  type: "string" | "integer" | "boolean";
  required: boolean;
  choices?: Array<{ name: string; value: string }>;
  autocomplete?: boolean;
}

export interface CommandDefinition {
  name: string;
  description: string;
  options: CommandOption[];
}

export interface CommandContext {
  command: string;
  options: Record<string, string | number | boolean | null>;
  userId: string;
  channelId: string;
  defer(): Promise<void>;
  reply(content: string): Promise<void>;
  replyRich(content: RichContent): Promise<void>;
  editReply(content: string): Promise<void>;
}

export function getCommandDefinitions(config: Config): CommandDefinition[] {
  const presets = getModelPresets(config);
  const backendChoices = getBackendChoices();
  const modeChoices = [
    { name: "bypassPermissions", value: "bypassPermissions" },
    { name: "plan (read-only)", value: "plan" },
    { name: "acceptEdits", value: "acceptEdits" },
    { name: "default", value: "default" },
  ];

  return [
    {
      name: "spawn",
      description: "Start a coding agent instance (resumes by default)",
      options: [
        { name: "name", description: "Instance name", type: "string", required: true, autocomplete: true },
        { name: "branch", description: "Git branch (default: dev)", type: "string", required: false },
        { name: "mode", description: "Permission mode", type: "string", required: false, choices: modeChoices },
        { name: "backend", description: "CLI backend", type: "string", required: false, choices: backendChoices },
        { name: "new", description: "Fresh start", type: "boolean", required: false },
      ],
    },
    {
      name: "spawn-all",
      description: "Start multiple coding agent instances (resumes by default)",
      options: [
        { name: "count", description: "How many to spawn (default: all)", type: "integer", required: false },
        { name: "branch", description: "Git branch", type: "string", required: false },
        { name: "mode", description: "Permission mode", type: "string", required: false, choices: modeChoices },
        { name: "backend", description: "CLI backend", type: "string", required: false, choices: backendChoices },
        { name: "new", description: "Fresh start", type: "boolean", required: false },
      ],
    },
    { name: "kill", description: "Stop a coding agent instance", options: [
      { name: "name", description: "Instance name", type: "string", required: true, autocomplete: true },
    ]},
    { name: "kill-all", description: "Stop all running coding agent instances", options: [] },
    { name: "status", description: "Show status of all bot army slots", options: [] },
    { name: "purge", description: "Clear all messages in the current channel", options: [] },
    {
      name: "new",
      description: "Kill and respawn a bot with new context (purges channel)",
      options: [
        { name: "name", description: "Instance name", type: "string", required: true, autocomplete: true },
        { name: "branch", description: "Git branch", type: "string", required: false },
        { name: "mode", description: "Permission mode", type: "string", required: false, choices: modeChoices },
      ],
    },
    {
      name: "role",
      description: "Assign a role/specialization to a bot",
      options: [
        { name: "name", description: "Instance name", type: "string", required: true, autocomplete: true },
        { name: "role", description: "Role description", type: "string", required: true },
      ],
    },
    { name: "roles", description: "Show all bot role assignments", options: [] },
    {
      name: "model",
      description: "Set the model for a bot",
      options: [
        { name: "name", description: "Instance name", type: "string", required: true, autocomplete: true },
        { name: "model", description: "Model to use", type: "string", required: true,
          choices: presets.length > 0 ? presets.map((p) => ({ name: p.label, value: p.id })) : undefined },
      ],
    },
    { name: "models", description: "Show all bot model assignments", options: [] },
    {
      name: "repo",
      description: "Set the target repository for a bot",
      options: [
        { name: "name", description: "Instance name", type: "string", required: true, autocomplete: true },
        { name: "path", description: "Path to the repository", type: "string", required: true },
      ],
    },
    { name: "repos", description: "Show all bot repository assignments", options: [] },
    {
      name: "terminal",
      description: "Show or hide a bot's terminal window",
      options: [
        { name: "action", description: "show or hide", type: "string", required: true,
          choices: [{ name: "show", value: "show" }, { name: "hide", value: "hide" }] },
        { name: "name", description: "Instance name (omit for all)", type: "string", required: false, autocomplete: true },
      ],
    },
  ];
}

export interface CommandHandlerDeps {
  manager: InstanceManager;
  actions: Actions;
  chatService: ChatService;
  config: Config;
  instanceNames: string[];
  /** Build a rich status view (platform-specific formatting) */
  buildStatusContent: () => RichContent;
  /** Purge the channel the command was invoked in (platform-specific) */
  purgeCurrentChannel: (channelId: string) => Promise<number>;
}

export async function handleCommand(ctx: CommandContext, deps: CommandHandlerDeps): Promise<void> {
  const { manager, actions, config, instanceNames, buildStatusContent, purgeCurrentChannel } = deps;
  const DEFAULT_BRANCH = actions.DEFAULT_BRANCH;

  if (
    config.user_allowlist?.length &&
    !config.user_allowlist.includes(ctx.userId)
  ) {
    await ctx.reply("You are not authorized to use bot army commands.");
    return;
  }

  switch (ctx.command) {
    case "spawn": {
      const name = ctx.options.name as InstanceName;
      const branch = (ctx.options.branch as string) ?? DEFAULT_BRANCH;
      const mode = (ctx.options.mode as PermissionMode) ?? deps.actions.DEFAULT_MODE;
      const backend = ctx.options.backend as CliBackend | null;
      if (backend) setBackend(name, backend);
      const resume = !(ctx.options.new ?? false);

      await ctx.defer();
      try {
        const result = await actions.actionSpawn(name, branch, mode, resume);
        if (result.ok) {
          await ctx.editReply(`Spawned **${name}** on branch \`${branch}\` (${mode})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.editReply(`Failed to spawn **${name}**: ${msg}`);
      }
      break;
    }

    case "spawn-all": {
      const count = (ctx.options.count as number) ?? 26;
      const branch = (ctx.options.branch as string) ?? DEFAULT_BRANCH;
      const mode = (ctx.options.mode as PermissionMode) ?? deps.actions.DEFAULT_MODE;
      const backend = ctx.options.backend as CliBackend | null;
      const resume = !(ctx.options.new ?? false);

      if (instanceNames.filter((n) => !manager.isRunning(n)).length === 0) {
        await ctx.reply("All requested instances are already running.");
        return;
      }

      await ctx.defer();
      await ctx.editReply(`Spawning up to ${count} instance(s) on \`${branch}\` (${mode})...`);

      if (backend) {
        const available = instanceNames.filter((n) => !manager.isRunning(n)).slice(0, count);
        for (const n of available) setBackend(n as InstanceName, backend);
      }

      const { toSpawn, results } = await actions.actionSpawnAll(count, branch, mode, resume);

      const succeeded = [...results.values()].filter((r) => r === "ok").length;
      const failed = [...results.values()].filter((r) => r !== "ok").length;
      const lines = toSpawn.map((n) => {
        const r = results.get(n);
        return r === "ok" ? `ok ${n}` : `fail ${n}: ${r}`;
      });
      await ctx.editReply(`Spawn complete: ${succeeded} started, ${failed} failed.\n${lines.join("\n")}`);
      break;
    }

    case "kill": {
      const name = ctx.options.name as string;
      await ctx.defer();
      const { killed, uptime } = await actions.actionKill(name);
      if (!killed) {
        await ctx.editReply(`**${name}** is not running.`);
      } else {
        await ctx.editReply(`Killed **${name}** (was running for ${uptime ?? "unknown"}).`);
      }
      break;
    }

    case "kill-all": {
      await ctx.defer();
      const killed = await actions.actionKillAll();
      if (killed.length === 0) {
        await ctx.editReply("No instances are running.");
      } else {
        await ctx.editReply(`Killed ${killed.length} instance(s): ${killed.join(", ")}`);
      }
      break;
    }

    case "status": {
      await ctx.replyRich(buildStatusContent());
      break;
    }

    case "purge": {
      await ctx.defer();
      const count = await purgeCurrentChannel(ctx.channelId);
      await ctx.editReply(`Purged ${count} message(s).`);
      break;
    }

    case "new": {
      const name = ctx.options.name as InstanceName;
      const branch = (ctx.options.branch as string) ?? DEFAULT_BRANCH;
      const mode = (ctx.options.mode as PermissionMode) ?? deps.actions.DEFAULT_MODE;

      await ctx.defer();
      try {
        await actions.actionNew(name, branch, mode);
        await ctx.editReply(`Fresh start for **${name}** on branch \`${branch}\` (${mode})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.editReply(`Failed to start new **${name}**: ${msg}`);
      }
      break;
    }

    case "role": {
      const name = ctx.options.name as InstanceName;
      const role = ctx.options.role as string;
      await actions.actionSetRole(name, role);
      await ctx.reply(`Set **${name}**'s role to: \`${role}\``);
      break;
    }

    case "roles": {
      const allRoles = actions.actionGetRoles();
      if (Object.keys(allRoles).length === 0) {
        await ctx.reply("No roles assigned. Use `/role <name> <role>` to assign roles.");
        return;
      }
      const lines = Object.entries(allRoles).map(([name, role]) => {
        const running = manager.isRunning(name as InstanceName) ? "🟢" : "⚫";
        return `${running} **${name}**: ${role}`;
      });
      await ctx.reply(lines.join("\n"));
      break;
    }

    case "model": {
      const name = ctx.options.name as InstanceName;
      const model = ctx.options.model as string;
      setModel(name, model);
      if (manager.isRunning(name)) {
        manager.sendInput(name, `/model ${model}\r`);
        await ctx.reply(`Switched **${name}** to \`${model}\`.`);
      } else {
        await ctx.reply(`Set **${name}**'s model to \`${model}\`. Will apply on next spawn.`);
      }
      await actions.updateDashboard();
      break;
    }

    case "models": {
      const sections: string[] = [];

      const allModels = Object.fromEntries(getAllModels());
      if (Object.keys(allModels).length > 0) {
        const lines = Object.entries(allModels).map(([name, model]) => {
          const running = manager.isRunning(name as InstanceName) ? "🟢" : "⚫";
          return `${running} **${name}**: \`${model}\``;
        });
        sections.push("**Assigned:**\n" + lines.join("\n"));
      }

      const presets = getModelPresets(config);
      if (presets.length > 0) {
        const presetLines = presets.map((p) => `\`${p.id}\` — ${p.label}`);
        sections.push("**Available:**\n" + presetLines.join("\n"));
      }

      await ctx.reply(sections.length > 0 ? sections.join("\n\n") : "No models configured.");
      break;
    }

    case "repo": {
      const name = ctx.options.name as InstanceName;
      const repoPath = ctx.options.path as string;
      setRepo(name, repoPath);
      await ctx.reply(`Set **${name}**'s repo to \`${repoPath}\`. Will apply on next spawn.`);
      break;
    }

    case "repos": {
      const allRepos = Object.fromEntries(getAllRepos());
      const defaultRepo = config.target_repo;
      if (Object.keys(allRepos).length === 0) {
        await ctx.reply(`All bots use the default repo: \`${defaultRepo}\``);
      } else {
        const lines = Object.entries(allRepos).map(([name, repo]) => {
          const running = manager.isRunning(name as InstanceName) ? "🟢" : "⚫";
          return `${running} **${name}**: \`${repo}\``;
        });
        await ctx.reply(`**Default:** \`${defaultRepo}\`\n\n**Overrides:**\n${lines.join("\n")}`);
      }
      break;
    }

    case "terminal": {
      const action = ctx.options.action as string;
      const name = ctx.options.name as string | null;
      const targets = name ? [name] : instanceNames.filter((n) => manager.isRunning(n));
      if (targets.length === 0) {
        await ctx.reply("No instances are running.");
        break;
      }
      const results: string[] = [];
      for (const t of targets) {
        try {
          if (action === "show") {
            manager.showTerminal(t);
            results.push(`Opened **${t}**`);
          } else {
            manager.hideTerminal(t);
            results.push(`Closed **${t}**`);
          }
        } catch (err) {
          results.push(`**${t}**: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await ctx.reply(results.join("\n"));
      break;
    }
  }
}
