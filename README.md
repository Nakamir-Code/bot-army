# Bot Army

Run multiple AI coding agents in parallel, controlled from a chat platform. Each agent gets its own channel, git branch, and role. You message them like teammates.

Supports **Claude Code** and **GitHub Copilot CLI** as coding backends, with a pluggable architecture for adding more. Control everything through chat commands, a local CLI, or the HTTP API.

## What this does

Coding agents work best focused on one task. This tool lets you run a bunch of them at once, each in its own git worktree, and talk to them through a chat platform. You can assign roles (frontend, backend, reviewer), pick models per agent, and drop into any agent's terminal session directly.

## Prerequisites

- [Bun](https://bun.sh)
- [Git](https://git-scm.com)
- At least one coding agent CLI:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) -- `claude` in PATH or `~/.local/bin/`
  - [GitHub Copilot CLI](https://github.com/github/copilot-cli) -- `copilot` in PATH
- A chat platform account (see below)

You only need the CLI(s) you plan to use.

## Chat Platforms

The army uses a chat platform for communication between you and the agents. Each platform has its own setup steps, but the rest (backends, commands, CLI, API) works the same regardless of which platform you use.

### Discord

Currently the only supported platform. Set `platform: "discord"` in config (or omit it, Discord is the default).

**What you need:**
- A Discord server you can add bots to
- A bot token from the Discord Developer Portal

**Setup:**

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) and create a **New Application**
2. Under the **Bot** tab, enable **Message Content Intent** and **Server Members Intent**, then copy the bot token
3. Under **OAuth2 > URL Generator**, select scopes `bot` + `applications.commands` with these permissions: Manage Channels, Manage Roles, Manage Messages, Send Messages, Embed Links, Read Message History, Add Reactions, Attach Files, Use Slash Commands
4. Open the generated URL to invite the bot to your server
5. Fill in `guild_id` and `bot_token` in your `config.yaml`

Commands show up as Discord slash commands with autocomplete. Each bot gets its own text channel. The commander channel shows a live status dashboard.

### Adding a new platform

The chat layer is pluggable. Platform adapters live in `src/platforms/<name>/adapter.ts` and implement the `ChatService` interface. See `src/platforms/discord/adapter.ts` for reference. The shared code (actions, API, backends, instance manager) doesn't depend on any specific platform.

## Setup

```bash
cp config.yaml.template config.yaml
```

Edit `config.yaml` with your settings. The required fields are:
- `army_name` -- identifies this machine's bot army
- `target_repo` -- path to the repo agents will work in
- `user_allowlist` -- your user ID(s) on the chat platform
- Platform-specific fields (e.g. `guild_id` and `bot_token` for Discord)

The template is commented with all available options.

```bash
bun install      # Install dependencies
bun run setup    # Create channels on the chat platform
bun run start    # Start the proxy
```

Go to any bot channel and run `/spawn alpha` to start your first agent.

## Commands

Available as chat commands, CLI (`bun run cli`), and HTTP API (`localhost:3100`). The HTTP API is secured with a bearer token stored in `~/.bot-army/api-token` (auto-generated on first run). The CLI reads it automatically.

| Command | Description |
|---------|-------------|
| `/spawn <name> [branch] [mode] [--backend]` | Start a coding agent (resumes by default) |
| `/spawn-all [count] [branch] [mode] [--backend]` | Start multiple agents |
| `/kill <name>` | Stop an instance |
| `/kill-all` | Stop all instances |
| `/status` | Show all slots with status |
| `/new <name> [branch] [mode]` | Kill + purge channel + spawn fresh |
| `/purge` | Clear all messages in the current channel |
| `/role <name> <role>` | Assign a role/specialization |
| `/roles` | Show all role assignments |
| `/model <name> <model>` | Set model (live switch, no respawn) |
| `/models` | Show assigned models + available presets |
| `/repo <name> <path>` | Set target repository for a bot |
| `/repos` | Show all repository assignments |
| `/terminal show [name\|all]` | Open interactive terminal (omit name or use `all` for all) |
| `/terminal hide [name\|all]` | Close terminal window |

Use `--new` with spawn for a fresh start (no conversation resume).

## Coding Backends

Set the default in `config.yaml` with `backend:`, or override per-bot with `--backend copilot`. Different backends can run side by side.

| Backend | Message Delivery | Permission Bypass | Resume |
|---------|-----------------|-------------------|--------|
| Claude Code | MCP development channel | `--dangerously-skip-permissions` | `--continue` |
| Copilot CLI | Extension SDK (`session.send`) | `--yolo` | `--continue` |

### Permission Modes

Agents spawn in `default` mode (asks for confirmation before running commands). Available modes:

| Mode | What it does |
|------|-------------|
| `default` | Agent asks for confirmation on risky actions |
| `acceptEdits` | Auto-approve file edits, confirm everything else |
| `plan` | Read-only, no file changes |
| `bypassPermissions` | No confirmations (`--dangerously-skip-permissions` / `--yolo`) |

Set per-spawn with `/spawn alpha --mode bypassPermissions`, or set a default for all bots in config with `default_mode: "bypassPermissions"`.

> **Note:** In non-bypass modes, agents will pause and wait for you to accept permission prompts (e.g. allowing access to a folder). Use `terminal show <name>` to open the agent's terminal and approve the prompt.

### Model Presets

Each backend has built-in model presets that show up as dropdown choices. Use `/models` to see what's available.

**Claude Code:** Sonnet 4.6, Opus 4.6, Haiku 4.5, ...

**Copilot CLI:** Sonnet 4.6, Opus 4.6, Haiku 4.5, GPT-5.3 Codex, GPT-5 Mini, Gemini 3 Pro, ...

You can add custom presets in `config.yaml` via `model_presets`.

## CLI

```bash
bun run cli              # Interactive mode (with persistent history)
bun run cli status       # One-off command
bun run cli spawn alpha  # Spawn with default backend
bun run cli spawn alpha --backend copilot  # Spawn with Copilot
```

Supports arrow-key history (persisted across sessions) and all the same commands as the chat interface.

## Terminal Takeover

Connect to a running bot's terminal session:

```
terminal show alpha      # Open terminal for alpha
terminal show            # Open terminals for all running bots
terminal show all        # Same as above
terminal hide alpha      # Close terminal
```

You can type directly into the agent's session. Press **Ctrl+]** or **Ctrl+C** to detach without killing the bot. On Windows Terminal, tabs open in the same window.

## Architecture

```
Chat Platform (1 bot token)
    |
Proxy (proxy.ts) -- platform adapter + message router + HTTP API
    |
    |-- #commander  -- dashboard, status, announcements
    |-- #alpha      <-> Coding Agent (own git worktree + PTY)
    |-- #bravo      <-> Coding Agent (own git worktree + PTY)
    +-- ...
```

- One bot token handles all chat I/O. Agents are headless CLI processes, not separate bots.
- Each agent runs in its own git worktree so they don't conflict.
- Messages route by channel ID. Agents can talk to each other through channel mentions.
- State persists in `state.json` across restarts. Agents auto-restore on startup.
- Use `/new` to wipe an agent's history and start fresh.
- Auto-update polls for new commits and restarts with instances preserved.

## Testing

```bash
bun test                 # Unit + integration tests (67 tests, ~150ms)
bun run test:unit        # Just unit tests
bun run test:integration # Just API tests
bun run test:smoke       # Full lifecycle smoke test (needs config.yaml)
```

The smoke test runs destroy, setup, start, exercises both backends, and reports per-command timings. Use `--skip-setup` if the proxy is already running.

## Advanced

### Multiple Machines

Multiple machines can share one chat server. Each uses a different `army_name` (like `desktop-army`, `laptop-army`), creating separate categories and channels. Each machine manages its own processes; the chat platform ties it all together.

### Adding a New Coding Backend

The backend system is pluggable. Create a folder under `src/backends/your-backend/` with a `backend.ts` implementing `BackendDef` (see `src/backends/types.ts`), then register it in `src/backends/index.ts` and `src/types.ts`. The rest is automatic.

## Cleanup

```bash
bun run destroy
```

Removes all channels, worktrees, and state. Run `bun run setup` to start fresh.
