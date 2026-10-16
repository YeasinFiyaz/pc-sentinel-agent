/**
 * PC Sentinel — Session 1 (Interactive Desktop) Companion & Cloud Listener
 *
 * Runs inside the logged-in user's desktop session (Session 1) to:
 * 1. Immediately execute LockWorkStation in Session 1 when triggered from Mobile (ntfy cloud) or Localhost.
 * 2. Maintain a redundant, auto-reconnecting listener to the ntfy command stream.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');

const BASE_DIR = __dirname;
const LOG_PATH = path.join(BASE_DIR, 'agent.log');
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const HELPER_PORT = 4849;

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

let lastLockTime = 0;
function lockInteractiveDesktop(source) {
  const now = Date.now();
  if (now - lastLockTime < 1500) return;
  lastLockTime = now;
  exec('rundll32.exe user32.dll,LockWorkStation');
}

// 1. Local loopback trigger on port 4849
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/lock') {
    lockInteractiveDesktop('http-4849');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200);
  res.end('PCSentinel Session-1 Helper Active');
});

server.on('error', () => {
  process.exit(0);
});

server.listen(HELPER_PORT, '127.0.0.1');

// 2. Watch agent.log for verified [LOCK] commands from Session 0 (NT AUTHORITY\SYSTEM)
let lastSize = 0;
try {
  if (fs.existsSync(LOG_PATH)) {
    lastSize = fs.statSync(LOG_PATH).size;
  }
} catch (_) {}

setInterval(() => {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > lastSize) {
      const fd = fs.openSync(LOG_PATH, 'r');
      const len = stat.size - lastSize;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, lastSize);
      fs.closeSync(fd);
      lastSize = stat.size;

      const newLines = buf.toString('utf8');
      if (newLines.includes('Executing verified command [LOCK]')) {
        lockInteractiveDesktop('agent-log');
      }
    } else if (stat.size < lastSize) {
      lastSize = stat.size;
    }
  } catch (_) {}
}, 200);

// 3. Direct Session-1 subscription to ntfy command stream (ensures instant mobile response!)
function listenNtfyCommands() {
  const streamUrl = `${config.ntfyServer}/${config.cmdTopic}/json`;
  let reconnecting = false;
  function reconnect() {
    if (reconnecting) return;
    reconnecting = true;
    setTimeout(listenNtfyCommands, 3000);
  }

  try {
    const req = https.get(streamUrl, { timeout: 75000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reconnect();
        return;
      }
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.event === 'message' && evt.message) {
              const parsed = JSON.parse(evt.message);
              if (parsed && parsed.token === config.secretToken) {
                const cmd = (parsed.cmd || '').toUpperCase();
                if (cmd === 'LOCK') {
                  lockInteractiveDesktop('ntfy-direct');
                }
              }
            }
          } catch (_) {}
        }
      });
      res.on('end', reconnect);
      res.on('close', reconnect);
      res.on('error', reconnect);
    });
    req.on('error', reconnect);
    req.on('timeout', () => {
      req.destroy();
      reconnect();
    });
  } catch (_) {
    reconnect();
  }
}

listenNtfyCommands();
