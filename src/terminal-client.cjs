/**
 * Terminal Client — Connects to a running bot's named pipe for interactive access.
 *
 * Opens a bidirectional connection to the PTY wrapper's named pipe, puts the
 * local terminal in raw mode, and relays I/O. This gives full interactive
 * control of the coding agent session.
 *
 * Sends terminal size on connect and on resize so the PTY matches the client
 * window. Size messages use a \x00 prefix to distinguish from regular input:
 *   \x00{"cols":120,"rows":40}\n
 *
 * Usage: node terminal-client.cjs <instance-name>
 *
 * Press Ctrl+] to detach without killing the bot.
 */

const net = require("net");

const instanceName = process.argv[2];
if (!instanceName) {
  console.error("Usage: node terminal-client.cjs <instance-name>");
  process.exit(1);
}

const pipePath = process.platform === "win32"
  ? `\\\\.\\pipe\\bot-army-${instanceName}`
  : `/tmp/bot-army-${instanceName}.sock`;

console.log(`Connecting to ${instanceName}...`);
console.log("Press Ctrl+] to detach.\n");

function sendSize() {
  if (!process.stdout.columns || !process.stdout.rows) return;
  const msg = `\x00${JSON.stringify({ cols: process.stdout.columns, rows: process.stdout.rows })}\n`;
  try { socket.write(msg); } catch {}
}

const socket = net.connect(pipePath, () => {
  // Raw mode disables local echo and line buffering — essential to avoid
  // double-display (local echo + PTY echo).
  try {
    process.stdin.setRawMode(true);
  } catch {}
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  // Send terminal size so PTY matches this window
  sendSize();
});

// Resize PTY when client window is resized
process.stdout.on("resize", sendSize);

// Pipe PTY output → local terminal
socket.on("data", (data) => {
  process.stdout.write(data);
});

// Pipe local input → PTY (with Ctrl+] to detach)
process.stdin.on("data", (data) => {
  // Ctrl+] = 0x1D (group separator)
  for (let i = 0; i < data.length; i++) {
    if ((typeof data === "string" ? data.charCodeAt(i) : data[i]) === 0x1d) {
      console.log("\nDetached from session.");
      cleanup();
      return;
    }
  }
  socket.write(data);
});

socket.on("error", (err) => {
  console.error(`Connection failed: ${err.message}`);
  console.error(`Is ${instanceName} running?`);
  process.exit(1);
});

socket.on("close", () => {
  console.log("\nConnection closed.");
  cleanup();
});

function cleanup() {
  try { process.stdin.setRawMode(false); } catch {}
  process.exit(0);
}

process.on("SIGINT", () => {
  // Detach instead of forwarding Ctrl+C (which would kill the bot)
  console.log("\nDetached from session.");
  cleanup();
});
