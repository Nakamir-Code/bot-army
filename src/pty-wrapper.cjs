/**
 * PTY Wrapper — Node.js process that wraps a coding agent in a real PTY.
 *
 * Bun's node-pty has a broken write pipe on Windows ARM64. This wrapper
 * runs under Node.js where node-pty works correctly, and forwards
 * stdin/stdout/stderr so the parent process can communicate via pipes.
 *
 * Also exposes a named pipe (\\.\pipe\bot-army-<name> on Windows, or
 * /tmp/bot-army-<name>.sock on Unix) so a terminal client can attach
 * for interactive "takeover" mode.
 *
 * Control protocol: messages prefixed with \x00 are parsed as JSON commands
 * (from both stdin and pipe clients) rather than forwarded to the PTY.
 *
 * Usage: node pty-wrapper.cjs <command> [args...]
 *
 * Environment:
 *   PTY_CWD              — working directory for the child process
 *   BRIDGE_INSTANCE_NAME — instance name (used for named pipe path)
 *
 * stdin  → PTY input (forwarded to the child process)
 * stdout → PTY output (raw data from the child process)
 * stderr → wrapper logs
 * Exit code is forwarded from the child process.
 */

const pty = require("node-pty");
const net = require("net");
const fs = require("fs");

const [command, ...args] = process.argv.slice(2);
const cwd = process.env.PTY_CWD || process.cwd();
const instanceName = process.env.BRIDGE_INSTANCE_NAME || "unknown";

if (!command) {
  process.stderr.write("Usage: node pty-wrapper.cjs <command> [args...]\n");
  process.exit(1);
}

const proc = pty.spawn(command, args, {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd,
  env: process.env,
});

// --- Named pipe for interactive terminal clients ---

const pipePath = process.platform === "win32"
  ? `\\\\.\\pipe\\bot-army-${instanceName}`
  : `/tmp/bot-army-${instanceName}.sock`;

const terminalClients = new Set();

/** Handle a \x00-prefixed control message (JSON after the prefix) */
function handleControlMessage(json) {
  if (json.cols && json.rows) {
    proc.resize(json.cols, json.rows);
    process.stderr.write(`[pty-wrapper] resized PTY to ${json.cols}x${json.rows}\n`);
  } else if (json.action === "disconnect_clients") {
    process.stderr.write(`[pty-wrapper] disconnecting ${terminalClients.size} terminal client(s)\n`);
    for (const client of terminalClients) {
      try { client.end(); } catch {}
    }
    terminalClients.clear();
  }
}

/**
 * Process incoming data — if it starts with \x00, parse as control message;
 * otherwise forward to the PTY as regular input.
 */
function handleInput(data) {
  const str = data.toString();
  if (str.charCodeAt(0) === 0x00) {
    try { handleControlMessage(JSON.parse(str.slice(1).trim())); } catch {}
    return;
  }
  proc.write(str);
}

const pipeServer = net.createServer((socket) => {
  process.stderr.write(`[pty-wrapper] terminal client connected to ${instanceName}\n`);
  terminalClients.add(socket);

  // Clear the client's screen — the client will send its size which triggers
  // a PTY resize, causing the coding agent to fully redraw for the correct dimensions
  try { socket.write("\x1b[?25l\x1b[2J\x1b[H"); } catch {} // Hide cursor + clear screen

  socket.on("data", handleInput);
  socket.on("error", () => {});
  socket.on("close", () => {
    terminalClients.delete(socket);
    process.stderr.write(`[pty-wrapper] terminal client disconnected from ${instanceName}\n`);
  });
});

// Clean up stale socket file on Unix
if (process.platform !== "win32") {
  try { fs.unlinkSync(pipePath); } catch {}
}

pipeServer.listen(pipePath, () => {
  process.stderr.write(`[pty-wrapper] named pipe ready: ${pipePath}\n`);
});
pipeServer.on("error", (err) => {
  process.stderr.write(`[pty-wrapper] pipe server error: ${err.message}\n`);
});

// --- PTY I/O forwarding ---

// PTY output → stdout (for proxy) + all terminal clients
proc.onData((data) => {
  process.stdout.write(data);
  for (const client of terminalClients) {
    try { client.write(data); } catch {}
  }
});

// stdin (from proxy) → PTY input / control messages
process.stdin.setEncoding("utf8");
process.stdin.on("data", handleInput);
process.stdin.on("end", () => {
  // Don't kill the process when stdin closes — it should keep running
});

// Forward exit code + cleanup
proc.onExit(({ exitCode }) => {
  pipeServer.close();
  if (process.platform !== "win32") {
    try { fs.unlinkSync(pipePath); } catch {}
  }
  process.exit(exitCode ?? 1);
});

process.on("SIGTERM", () => proc.kill());
process.on("SIGINT", () => proc.kill());
