/**
 * Integration tests for the HTTP API server.
 *
 * Starts a real HTTP server with a mock InstanceManager and NoopChatService,
 * then hits the endpoints with fetch() and asserts the JSON responses.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { createApiServer } from "../../src/api.js";
import { createActions } from "../../src/actions.js";
import { NoopChatService } from "../../src/chat-service.js";
import { loadState, setRole, setModel, setBackend, getAllRoles, getAllModels, setRepo, getAllRepos } from "../../src/instance-manager.js";
import type { Config, ChannelMap, InstanceName, PermissionMode, CliBackend } from "../../src/types.js";
import type { Server } from "http";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// --- Mock InstanceManager ---

class MockInstanceManager {
  private instances = new Map<string, {
    name: string;
    channelId: string;
    branch: string;
    mode: PermissionMode;
    backend: CliBackend;
    startedAt: Date;
    worktreePath: string;
    sockets: never[];
    pendingMessages: never[];
    isKilling: boolean;
    terminalOpen: boolean;
  }>();

  private channelMap: ChannelMap;

  constructor(channelMap: ChannelMap) {
    this.channelMap = channelMap;
  }

  get running() {
    return this.instances;
  }

  isRunning(name: string): boolean {
    return this.instances.has(name);
  }

  async spawn(name: InstanceName, branch: string, mode: PermissionMode, resume?: boolean) {
    const channelId = this.channelMap.workers[name];
    if (!channelId) throw new Error(`no channel mapped for ${name}`);
    this.instances.set(name, {
      name,
      channelId,
      branch,
      mode,
      backend: "claude",
      startedAt: new Date(),
      worktreePath: `/tmp/worktrees/${name}`,
      sockets: [],
      pendingMessages: [],
      isKilling: false,
      terminalOpen: false,
    });
    return this.instances.get(name);
  }

  async kill(name: string): Promise<boolean> {
    return this.instances.delete(name);
  }

  async killAll(): Promise<string[]> {
    const names = [...this.instances.keys()];
    this.instances.clear();
    return names;
  }

  sendInput(_name: string, _text: string): boolean {
    return this.instances.has(_name);
  }

  sendNotification(_name: string, _notification: unknown): boolean {
    return this.instances.has(_name);
  }

  getNotificationMethod(_name: string): string {
    return "notifications/claude/channel";
  }

  showTerminal(name: string): void {
    if (!this.instances.has(name)) throw new Error(`${name} is not running`);
  }

  hideTerminal(name: string): void {
    // no-op for tests
  }

  getStatus() {
    const allNames = Object.keys(this.channelMap.workers);
    return allNames.map((name) => {
      const instance = this.instances.get(name);
      if (!instance) {
        return { name, running: false };
      }
      return {
        name,
        running: true,
        branch: instance.branch,
        mode: instance.mode,
        backend: instance.backend,
        uptime: "1m 0s",
        channelId: instance.channelId,
      };
    });
  }

  async shutdown() {
    await this.killAll();
  }
}

// --- Test setup ---

const TEST_CONFIG: Config = {
  army_name: "test-army",
  guild_id: "test-guild",
  bot_token: "test-token",
  target_repo: "/tmp/test-repo",
  worktree_base: "/tmp/test-worktrees",
  user_allowlist: [],
  backend: "claude",
  default_branch: "main",
  default_model: "claude-sonnet-4-6",
};

const CHANNEL_MAP: ChannelMap = {
  category_id: "cat-1",
  commander_id: "cmd-1",
  workers: {
    alpha: "ch-alpha",
    bravo: "ch-bravo",
    charlie: "ch-charlie",
  },
};

const INSTANCE_NAMES = Object.keys(CHANNEL_MAP.workers);

let server: Server;
let port: number;
let chatService: NoopChatService;
let mockManager: MockInstanceManager;
let tmpDir: string;
const TEST_TOKEN = "test-api-token-12345";

function base() {
  return `http://localhost:${port}`;
}

async function get(path: string) {
  const res = await fetch(`${base()}${path}`, {
    headers: { "Authorization": `Bearer ${TEST_TOKEN}` },
  });
  return { status: res.status, data: await res.json() };
}

beforeAll(async () => {
  // Set up temp state file
  tmpDir = join(tmpdir(), `bot-army-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const statePath = join(tmpDir, "state.json");
  writeFileSync(statePath, "{}");
  loadState(statePath);

  chatService = new NoopChatService();
  mockManager = new MockInstanceManager(CHANNEL_MAP);

  const actions = createActions({
    manager: mockManager as any,
    chat: chatService,
    config: TEST_CONFIG,
    channelMap: CHANNEL_MAP,
    instanceNames: INSTANCE_NAMES,
  });

  // Pick a random port
  port = 30000 + Math.floor(Math.random() * 10000);
  server = createApiServer({
    manager: mockManager as any,
    chat: chatService,
    actions,
    apiToken: TEST_TOKEN,
    config: TEST_CONFIG,
    channelMap: CHANNEL_MAP,
    instanceNames: INSTANCE_NAMES,
  }, port);

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });
});

afterAll(async () => {
  server.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// --- Tests ---

describe("GET /status", () => {
  test("returns empty status", async () => {
    const { data } = await get("/status");
    expect(data.active).toBe(0);
    expect(data.total).toBe(3);
    expect(data.instances).toBeArray();
  });
});

describe("GET /spawn", () => {
  test("spawns an instance", async () => {
    const { data } = await get("/spawn?name=alpha&branch=main");
    expect(data.ok).toBe(true);
    expect(data.name).toBe("alpha");
    expect(data.branch).toBe("main");
    expect(data.channelId).toBe("ch-alpha");
  });

  test("status reflects running instance", async () => {
    const { data } = await get("/status");
    expect(data.active).toBeGreaterThanOrEqual(1);
    const alpha = data.instances.find((i: any) => i.name === "alpha");
    expect(alpha?.running).toBe(true);
  });

  test("rejects unknown instance name", async () => {
    const { status } = await get("/spawn?name=unknown");
    expect(status).toBe(400);
  });

  test("missing name returns 400", async () => {
    const { status } = await get("/spawn");
    expect(status).toBe(400);
  });
});

describe("GET /kill", () => {
  test("kills a running instance", async () => {
    // Ensure alpha is running
    await get("/spawn?name=alpha");
    const { data } = await get("/kill?name=alpha");
    expect(data.ok).toBe(true);
    expect(data.killed).toBe("alpha");
  });

  test("missing name returns 400", async () => {
    const { status } = await get("/kill");
    expect(status).toBe(400);
  });
});

describe("GET /kill-all", () => {
  test("kills all running instances", async () => {
    await get("/spawn?name=alpha");
    await get("/spawn?name=bravo");
    const { data } = await get("/kill-all");
    expect(data.ok).toBe(true);
    expect(data.killed).toBeArray();
  });
});

describe("GET /role", () => {
  test("sets a role", async () => {
    const { data } = await get("/role?name=alpha&role=code%20reviewer");
    expect(data.ok).toBe(true);
    expect(data.name).toBe("alpha");
    expect(data.role).toBe("code reviewer");
  });

  test("missing params returns 400", async () => {
    const { status } = await get("/role?name=alpha");
    expect(status).toBe(400);
  });
});

describe("GET /roles", () => {
  test("returns assigned roles", async () => {
    await get("/role?name=bravo&role=frontend%20dev");
    const { data } = await get("/roles");
    expect(data.bravo).toBe("frontend dev");
  });
});

describe("GET /model", () => {
  test("sets a model", async () => {
    const { data } = await get("/model?name=alpha&model=claude-opus-4-6");
    expect(data.ok).toBe(true);
    expect(data.name).toBe("alpha");
    expect(data.model).toBe("claude-opus-4-6");
  });

  test("reports live=true when instance is running", async () => {
    await get("/spawn?name=alpha");
    const { data } = await get("/model?name=alpha&model=claude-opus-4-6");
    expect(data.live).toBe(true);
    await get("/kill?name=alpha");
  });

  test("reports live=false when instance is not running", async () => {
    const { data } = await get("/model?name=charlie&model=claude-opus-4-6");
    expect(data.live).toBe(false);
  });

  test("missing params returns 400", async () => {
    const { status } = await get("/model?name=alpha");
    expect(status).toBe(400);
  });
});

describe("GET /models", () => {
  test("returns assigned models and available presets", async () => {
    await get("/model?name=alpha&model=claude-sonnet-4-6");
    const { data } = await get("/models");
    expect(data.assigned).toBeDefined();
    expect(data.available).toBeArray();
    expect(data.assigned.alpha).toBe("claude-sonnet-4-6");
  });
});

describe("GET /repo", () => {
  test("sets a repo", async () => {
    const { data } = await get("/repo?name=alpha&repo=~/projects/other-repo");
    expect(data.ok).toBe(true);
    expect(data.name).toBe("alpha");
    expect(data.repo).toBe("~/projects/other-repo");
  });

  test("accepts path param as alias", async () => {
    const { data } = await get("/repo?name=bravo&path=~/projects/bravo-repo");
    expect(data.ok).toBe(true);
    expect(data.repo).toBe("~/projects/bravo-repo");
  });

  test("missing params returns 400", async () => {
    const { status } = await get("/repo?name=alpha");
    expect(status).toBe(400);
  });
});

describe("GET /repos", () => {
  test("returns default and assigned repos", async () => {
    await get("/repo?name=charlie&repo=~/projects/charlie-repo");
    const { data } = await get("/repos");
    expect(data.default).toBe("/tmp/test-repo");
    expect(data.assigned.charlie).toBe("~/projects/charlie-repo");
  });
});

describe("GET /purge", () => {
  test("purges a channel", async () => {
    const { data } = await get("/purge?name=alpha");
    expect(data.ok).toBe(true);
    expect(data.name).toBe("alpha");
    expect(typeof data.purged).toBe("number");
  });

  test("purges commander channel", async () => {
    const { data } = await get("/purge?name=commander");
    expect(data.ok).toBe(true);
  });

  test("unknown channel returns 400", async () => {
    const { status } = await get("/purge?name=nonexistent");
    expect(status).toBe(400);
  });

  test("missing name returns 400", async () => {
    const { status } = await get("/purge");
    expect(status).toBe(400);
  });
});

describe("GET /spawn-all", () => {
  test("spawns multiple instances", async () => {
    // Kill all first
    await get("/kill-all");
    const { data } = await get("/spawn-all?count=2&branch=main");
    expect(data.results).toBeDefined();
    const values = Object.values(data.results) as string[];
    expect(values.filter((v) => v === "ok").length).toBe(2);
  });
});

describe("GET /new", () => {
  test("spawns fresh instance", async () => {
    const { data } = await get("/new?name=alpha&branch=dev");
    expect(data.ok).toBe(true);
    expect(data.name).toBe("alpha");
    expect(data.branch).toBe("dev");
    // Should have purged the channel
    expect(chatService.purged.length).toBeGreaterThan(0);
  });

  test("missing name returns 400", async () => {
    const { status } = await get("/new");
    expect(status).toBe(400);
  });
});

describe("GET /terminal", () => {
  test("missing action returns 400", async () => {
    const { status } = await get("/terminal");
    expect(status).toBe(400);
  });

  test("show on running instance returns ok", async () => {
    await get("/spawn?name=alpha");
    const { data } = await get("/terminal?action=show&name=alpha");
    expect(data.ok).toBe(true);
    expect(data.results.alpha).toBe("ok");
    await get("/kill?name=alpha");
  });
});

describe("GET / (root)", () => {
  test("returns command list", async () => {
    const { data } = await get("/");
    expect(data.commands).toBeArray();
    expect(data.commands.length).toBeGreaterThan(0);
  });
});
