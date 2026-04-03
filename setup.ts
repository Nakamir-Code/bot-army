#!/usr/bin/env bun
/**
 * Setup script — Creates Discord category, channels, and permissions.
 *
 * Usage: bun run setup.ts [--config path/to/config.yaml]
 *
 * Requires: bot_token in config.yaml with Manage Channels + Manage Roles permissions.
 * Run once per machine/army. Saves channel map to channels.json.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import { parseChannels, type Config, type ChannelMap } from "./src/types.js";

const configPath = resolve(
  process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : "config.yaml"
);

if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  console.error("Copy config.yaml.template to config.yaml and fill in values.");
  process.exit(1);
}

const config: Config = parseYaml(readFileSync(configPath, "utf8"));

if (!config.army_name) {
  console.error("army_name is required in config.yaml");
  process.exit(1);
}
if (!config.bot_token) {
  console.error("bot_token is required in config.yaml");
  process.exit(1);
}
if (!config.guild_id) {
  console.error("guild_id is required in config.yaml");
  process.exit(1);
}

const API = "https://discord.com/api/v10";
const headers = {
  Authorization: `Bot ${config.bot_token}`,
  "Content-Type": "application/json",
};

async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429) {
    const retry = res.headers.get("Retry-After");
    const wait = retry ? parseFloat(retry) * 1000 : 5000;
    console.log(`Rate limited, waiting ${wait}ms...`);
    await sleep(wait);
    return api(method, path, body);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${method} ${path}: ${res.status} ${text}`);
  }

  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Permission bits
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const ATTACH_FILES = 1n << 15n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const ADD_REACTIONS = 1n << 6n;
const USE_APPLICATION_COMMANDS = 1n << 31n;

const BOT_PERMS =
  VIEW_CHANNEL |
  SEND_MESSAGES |
  ATTACH_FILES |
  READ_MESSAGE_HISTORY |
  ADD_REACTIONS |
  USE_APPLICATION_COMMANDS;

async function main() {
  const categoryName = `${config.army_name}-bot-army`;
  console.log(`Setting up "${categoryName}" in guild ${config.guild_id}...`);

  // Get bot's user ID first (needed for permission overwrites)
  const botUser = (await api("GET", "/users/@me")) as { id: string };
  console.log(`Bot user ID: ${botUser.id}`);

  // Check if category already exists
  const existingChannels = (await api(
    "GET",
    `/guilds/${config.guild_id}/channels`
  )) as Array<{ id: string; name: string; type: number; parent_id?: string }>;

  let category = existingChannels.find(
    (c) => c.name === categoryName && c.type === 4
  );

  // Build permission overwrites for category creation
  const categoryOverwrites = [
    {
      id: config.guild_id, // @everyone role — deny view
      type: 0,
      allow: "0",
      deny: VIEW_CHANNEL.toString(),
    },
    {
      id: botUser.id, // bot — allow full access
      type: 1,
      allow: BOT_PERMS.toString(),
      deny: "0",
    },
    ...(config.user_allowlist ?? []).map((userId) => ({
      id: userId, // allowlisted users — allow view
      type: 1,
      allow: (VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY | ADD_REACTIONS | ATTACH_FILES | USE_APPLICATION_COMMANDS).toString(),
      deny: "0",
    })),
  ];

  if (category) {
    console.log(`Category "${categoryName}" already exists (${category.id})`);
    // Update permissions on existing category
    for (const overwrite of categoryOverwrites) {
      await api(
        "PUT",
        `/channels/${category.id}/permissions/${overwrite.id}`,
        { allow: overwrite.allow, deny: overwrite.deny, type: overwrite.type }
      );
    }
    console.log("Updated category permissions.");
  } else {
    // Create category with all permissions in one shot
    category = (await api("POST", `/guilds/${config.guild_id}/channels`, {
      name: categoryName,
      type: 4, // GUILD_CATEGORY
      permission_overwrites: categoryOverwrites,
    })) as { id: string; name: string; type: number };
    console.log(`Created category: ${category.id}`);
  }

  // Create commander channel
  const commanderName = config.commander_name ?? "commander";
  let commanderChannel = existingChannels.find(
    (c) =>
      c.name === commanderName &&
      c.parent_id === category.id
  );

  if (commanderChannel) {
    console.log(
      `Commander channel #${commanderName} already exists (${commanderChannel.id})`
    );
  } else {
    commanderChannel = (await api(
      "POST",
      `/guilds/${config.guild_id}/channels`,
      {
        name: commanderName,
        type: 0, // GUILD_TEXT
        parent_id: category.id,
        position: 0,
        topic: `Bot army commander for ${config.army_name}`,
      }
    )) as { id: string; name: string; type: number; parent_id: string };
    console.log(`Created #${commanderName}: ${commanderChannel.id}`);
    await sleep(1000);
  }

  // Create worker channels in parallel batches (5 at a time to respect rate limits)
  const workers: Record<string, string> = {};
  const BATCH_SIZE = 5;

  const channelDefs = parseChannels(config.channels);
  const channelNames = channelDefs.map((ch) => ch.name);
  console.log(`Creating ${channelNames.length} worker channel(s)...`);

  for (let i = 0; i < channelNames.length; i += BATCH_SIZE) {
    const batch = channelNames.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (name, batchIdx) => {
      const position = i + batchIdx + 1; // +1 because commander is at 0
      let channel = existingChannels.find(
        (c) => c.name === name && c.parent_id === category.id
      );

      if (channel) {
        console.log(`#${name} already exists (${channel.id})`);
        workers[name] = channel.id;
      } else {
        channel = (await api(
          "POST",
          `/guilds/${config.guild_id}/channels`,
          {
            name,
            type: 0, // GUILD_TEXT
            parent_id: category.id,
            position,
            topic: `Bot army instance: ${name}`,
          }
        )) as { id: string; name: string; type: number; parent_id: string };
        console.log(`Created #${name}: ${channel.id}`);
        workers[name] = channel.id;
      }
    }));
    // Brief pause between batches for rate limits
    if (i + BATCH_SIZE < channelNames.length) await sleep(500);
  }

  // Save channel map
  const channelMap: ChannelMap = {
    category_id: category.id,
    commander_id: commanderChannel.id,
    workers,
  };

  const outPath = resolve(configPath, "..", "channels.json");
  writeFileSync(outPath, JSON.stringify(channelMap, null, 2));
  console.log(`\nChannel map saved to ${outPath}`);

  // Seed state.json with roles, models, and backends from channel config
  const statePath = resolve(configPath, "..", "state.json");
  const state: Record<string, Record<string, string>> = {
    roles: {}, models: {}, backends: {}, running: {},
  };

  // Preserve existing state if present
  if (existsSync(statePath)) {
    try {
      const existing = JSON.parse(readFileSync(statePath, "utf8"));
      if (existing.roles) state.roles = existing.roles;
      if (existing.models) state.models = existing.models;
      if (existing.backends) state.backends = existing.backends;
      if (existing.running) state.running = existing.running;
    } catch {}
  }

  // Apply channel config defaults (don't overwrite existing runtime state)
  let seeded = 0;
  for (const ch of channelDefs) {
    if (ch.role && !state.roles[ch.name]) { state.roles[ch.name] = ch.role; seeded++; }
    if (ch.model && !state.models[ch.name]) { state.models[ch.name] = ch.model; seeded++; }
    if (ch.backend && !state.backends[ch.name]) { state.backends[ch.name] = ch.backend; seeded++; }
  }

  writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (seeded > 0) console.log(`Seeded ${seeded} default(s) from channel config into state.json`);

  console.log("\nSetup complete! Run `bun run start` to launch the proxy bot.");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
