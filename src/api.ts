/**
 * HTTP API server — JSON endpoints for bot army commands.
 * Secured with a bearer token stored in ~/.bot-army/api-token.
 */

import { createServer as createHttpServer, type Server } from "http";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import type { Config, ChannelMap, CliBackend, InstanceName, PermissionMode } from "./types.js";
import type { InstanceManager } from "./instance-manager.js";
import type { ChatService } from "./chat-service.js";
import { setBackend, setModel, getModelPresets, getAllModels, setRepo, getAllRepos } from "./instance-manager.js";
import type { Actions } from "./actions.js";

/** Load or generate the API token. Stored in ~/.bot-army/api-token */
export function loadApiToken(): string {
  const dir = join(homedir(), ".bot-army");
  const tokenPath = join(dir, "api-token");
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, "utf8").trim();
  }
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  console.log(`Generated API token at ${tokenPath}`);
  return token;
}

export interface ApiDeps {
  manager: InstanceManager;
  chat: ChatService;
  actions: Actions;
  config: Config;
  channelMap: ChannelMap;
  instanceNames: string[];
  apiToken: string;
}

export function createApiServer(deps: ApiDeps, port: number): Server {
  const { manager, chat, actions, config, channelMap, instanceNames, apiToken } = deps;

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;
    const params = Object.fromEntries(url.searchParams);
    res.setHeader("Content-Type", "application/json");

    // Check auth -- accept as Bearer token, query param, or X-API-Token header
    const authHeader = req.headers.authorization;
    const tokenFromHeader = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.headers["x-api-token"] as string | undefined;
    const token = tokenFromHeader ?? params.token;
    if (token !== apiToken) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Unauthorized. Pass token as Bearer header, X-API-Token header, or ?token= param." }));
      return;
    }

    try {
      if (path === "/status") {
        const statuses = manager.getStatus();
        const running = statuses.filter((s) => s.running);
        res.end(JSON.stringify({ active: running.length, total: statuses.length, instances: statuses }));

      } else if (path === "/spawn") {
        const name = params.name as InstanceName;
        const branch = params.branch ?? actions.DEFAULT_BRANCH;
        const mode = (params.mode ?? actions.DEFAULT_MODE) as PermissionMode;
        const resume = params.new !== "true";
        if (params.backend) setBackend(name, params.backend as any);
        if (!name || !instanceNames.includes(name)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Usage: /spawn?name=alpha[&branch=dev][&mode=plan][&new=true][&backend=copilot]" }));
          return;
        }
        const result = await actions.actionSpawn(name, branch, mode, resume);
        res.end(JSON.stringify(result));

      } else if (path === "/kill") {
        const name = params.name;
        if (!name) { res.statusCode = 400; res.end(JSON.stringify({ error: "Usage: /kill?name=alpha" })); return; }
        const { killed } = await actions.actionKill(name);
        res.end(JSON.stringify({ ok: killed, killed: name }));

      } else if (path === "/kill-all") {
        const killed = await actions.actionKillAll();
        res.end(JSON.stringify({ ok: true, killed }));

      } else if (path === "/spawn-all") {
        const count = parseInt(params.count ?? "26", 10);
        const branch = params.branch ?? actions.DEFAULT_BRANCH;
        const mode = (params.mode ?? actions.DEFAULT_MODE) as PermissionMode;
        const resume = params.new !== "true";
        if (params.backend) {
          const available = instanceNames.filter((n) => !manager.isRunning(n)).slice(0, count);
          for (const n of available) setBackend(n as InstanceName, params.backend as CliBackend);
        }
        const { toSpawn, results } = await actions.actionSpawnAll(count, branch, mode, resume);
        const out: Record<string, string> = {};
        // Output in config order, not completion order
        for (const name of toSpawn) {
          out[name] = results.get(name) === "ok" ? "ok" : (results.get(name) ?? "unknown");
        }
        res.end(JSON.stringify({ results: out }));

      } else if (path === "/new") {
        const name = params.name as InstanceName;
        const branch = params.branch ?? actions.DEFAULT_BRANCH;
        const mode = (params.mode ?? actions.DEFAULT_MODE) as PermissionMode;
        if (!name) { res.statusCode = 400; res.end(JSON.stringify({ error: "Usage: /new?name=alpha" })); return; }
        const result = await actions.actionNew(name, branch, mode);
        res.end(JSON.stringify(result));

      } else if (path === "/role") {
        const name = params.name as InstanceName;
        const role = params.role;
        if (!name || !role) { res.statusCode = 400; res.end(JSON.stringify({ error: "Usage: /role?name=alpha&role=code reviewer" })); return; }
        await actions.actionSetRole(name, role);
        res.end(JSON.stringify({ ok: true, name, role }));

      } else if (path === "/roles") {
        res.end(JSON.stringify(actions.actionGetRoles()));

      } else if (path === "/model") {
        const name = params.name as InstanceName;
        const model = params.model;
        if (!name || !model) { res.statusCode = 400; res.end(JSON.stringify({ error: "Usage: /model?name=alpha&model=claude-sonnet-4-6" })); return; }
        setModel(name, model);
        if (manager.isRunning(name)) {
          manager.sendInput(name, `/model ${model}\r`);
        }
        res.end(JSON.stringify({ ok: true, name, model, live: manager.isRunning(name) }));

      } else if (path === "/models") {
        const presets = getModelPresets(config);
        res.end(JSON.stringify({
          assigned: Object.fromEntries(getAllModels()),
          available: presets,
        }));

      } else if (path === "/repo") {
        const name = params.name as InstanceName;
        const repo = params.repo ?? params.path;
        if (!name || !repo) { res.statusCode = 400; res.end(JSON.stringify({ error: "Usage: /repo?name=alpha&repo=~/projects/other-repo" })); return; }
        setRepo(name, repo);
        res.end(JSON.stringify({ ok: true, name, repo }));

      } else if (path === "/repos") {
        res.end(JSON.stringify({
          default: config.target_repo,
          assigned: Object.fromEntries(getAllRepos()),
        }));

      } else if (path === "/terminal") {
        const name = params.name;
        const action = params.action;
        if (!action) { res.statusCode = 400; res.end(JSON.stringify({ error: "Usage: /terminal?action=show[&name=alpha]" })); return; }
        const targets = name ? [name] : instanceNames.filter((n) => manager.isRunning(n));
        if (targets.length === 0) { res.end(JSON.stringify({ ok: true, targets: [] })); return; }
        const results: Record<string, string> = {};
        for (const t of targets) {
          try {
            if (action === "show") { manager.showTerminal(t); }
            else { manager.hideTerminal(t); }
            results[t] = "ok";
          } catch (err) {
            results[t] = err instanceof Error ? err.message : String(err);
          }
        }
        res.end(JSON.stringify({ ok: true, action, results }));

      } else if (path === "/purge") {
        const name = params.name;
        if (!name) { res.statusCode = 400; res.end(JSON.stringify({ error: "Usage: /purge?name=alpha or /purge?name=commander" })); return; }
        const channelId = name === "commander" ? channelMap.commander_id : channelMap.workers[name];
        if (!channelId) { res.statusCode = 400; res.end(JSON.stringify({ error: `Unknown channel: ${name}` })); return; }
        const count = await chat.purgeChannel(channelId);
        res.end(JSON.stringify({ ok: true, name, purged: count }));

      } else {
        res.end(JSON.stringify({
          commands: [
            "/status", "/spawn?name=alpha&branch=dev",
            "/kill?name=alpha", "/kill-all", "/spawn-all?count=3&branch=dev",
            "/new?name=alpha", "/purge?name=alpha", "/purge?name=commander",
            "/role?name=alpha&role=code reviewer", "/roles",
            "/model?name=alpha&model=claude-sonnet-4-6", "/models",
            "/repo?name=alpha&repo=~/projects/other-repo", "/repos",
            "/terminal?action=show", "/terminal?action=show&name=alpha", "/terminal?action=hide",
          ]
        }));
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  return server;
}
