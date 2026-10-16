/**
 * PC Sentinel — Pre-Login Boot Tracker & Remote Shutdown Agent
 * Runs as NT AUTHORITY\SYSTEM before Windows login (at the lock/password screen).
 *
 * Features:
 * 1. Instant Phone Alert via ntfy.sh the moment the PC boots OR wakes from Fast Startup / Sleep / Hibernate.
 * 2. Waits intelligently for Wi-Fi / Internet connection at boot before sending the alert.
 * 3. Listens 24/7 in the background for 1-Tap Remote Commands from the owner's phone:
 *    - SHUTDOWN_30S : Initiates forced shutdown in 30 seconds (shutdown.exe /s /f /t 30)
 *    - SHUTDOWN_NOW : Immediate shutdown (shutdown.exe /s /f /t 3)
 *    - ABORT        : Cancels pending 30-second shutdown (shutdown.exe /a)
 *    - LOCK         : Locks workstation immediately
 *    - PING / STATUS: Reports live uptime, login state (Locked vs Logged In), battery, IP
 * 4. Serves the installable Mobile PWA (Progressive Web App) on port 4848 with Service Worker
 *    so once installed on your phone, the app works from ANYWHERE in the world (Wi-Fi or 4G/5G)!
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const BASE_DIR = __dirname;
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const LOG_PATH = path.join(BASE_DIR, 'agent.log');
const STATE_PATH = path.join(BASE_DIR, 'state.json');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (_) {}
}

// Load or auto-create secure config
function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      log(`Error reading config.json: ${e.message}`);
    }
  }
  const randomId = crypto.randomBytes(6).toString('hex');
  const secretToken = crypto.randomBytes(8).toString('hex');
  const cfg = {
    ntfyServer: 'https://ntfy.sh',
    alertTopic: `dfit-pc-alert-${randomId}`,
    cmdTopic: `dfit-pc-cmd-${randomId}`,
    statusTopic: `dfit-pc-status-${randomId}`,
    secretToken: secretToken,
    localPort: 4848,
    pcName: os.hostname() || 'DFIT-Laptop',
    shutdownDelaySeconds: 30,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  log(`Created new config at ${CONFIG_PATH}`);
  return cfg;
}

const config = loadConfig();

let shutdownPending = false;
let shutdownTimer = null;
let lastBootAlertTime = 0;

// Check if a user is currently logged in interactively or if PC is still at the password/lock screen
function getLoginStatus() {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq explorer.exe" /NH', { timeout: 4000 }, (err, stdoutExp) => {
      const hasExplorer = stdoutExp && stdoutExp.toLowerCase().includes('explorer.exe');
      exec('tasklist /FI "IMAGENAME eq LogonUI.exe" /NH', { timeout: 4000 }, (err2, stdoutLogon) => {
        const atLockScreen = stdoutLogon && stdoutLogon.toLowerCase().includes('logonui.exe');
        if (!hasExplorer) {
          resolve('At Password Screen (Before Login)');
        } else if (atLockScreen) {
          resolve('Locked (At Password Screen)');
        } else {
          resolve('User Logged In (Unlocked)');
        }
      });
    });
  });
}

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results;
}

// Wait until internet (ntfy.sh) is reachable (up to maxWaitSeconds)
function waitForInternet(maxWaitSeconds = 120) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      const req = https.get(`${config.ntfyServer}/v1/health`, { timeout: 4000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          retry();
        }
      });
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    }
    function retry() {
      if ((Date.now() - start) / 1000 >= maxWaitSeconds) {
        resolve(false);
      } else {
        setTimeout(check, 2500);
      }
    }
    check();
  });
}

// Send push notification via ntfy.sh JSON API with interactive 1-tap buttons
function sendNtfyNotification({ title, message, priority = 5, tags = ['warning', 'computer'], includeActions = true }) {
  return new Promise((resolve) => {
    try {
      const url = new URL(config.ntfyServer);
      const payload = {
        topic: config.alertTopic,
        title,
        message,
        priority: typeof priority === 'number' ? priority : 5,
        tags: Array.isArray(tags) ? tags : String(tags).split(',').map((s) => s.trim())
      };

      if (includeActions) {
        const cmdUrl = `${config.ntfyServer}/${config.cmdTopic}`;
        payload.actions = [
          {
            action: 'http',
            label: '🛑 Shut Down (30s)',
            url: cmdUrl,
            method: 'POST',
            body: JSON.stringify({ cmd: 'SHUTDOWN_30S', token: config.secretToken })
          },
          {
            action: 'http',
            label: '🔒 Lock Screen',
            url: cmdUrl,
            method: 'POST',
            body: JSON.stringify({ cmd: 'LOCK', token: config.secretToken })
          },
          {
            action: 'http',
            label: '❌ Cancel Shutdown',
            url: cmdUrl,
            method: 'POST',
            body: JSON.stringify({ cmd: 'ABORT', token: config.secretToken })
          }
        ];
      }

      const bodyStr = JSON.stringify(payload);
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(bodyStr)
        },
        timeout: 10000
      }, (res) => {
        res.resume();
        log(`Sent ntfy alert [${title}] -> HTTP ${res.statusCode}`);
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });

      req.on('error', (err) => {
        log(`Failed to send ntfy alert: ${err.message}`);
        resolve(false);
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.write(bodyStr);
      req.end();
    } catch (e) {
      log(`Exception in sendNtfyNotification: ${e.message}`);
      resolve(false);
    }
  });
}

// Publish real-time status update for the Custom Mobile PWA
async function publishStatus(extra = {}) {
  const loginState = await getLoginStatus();
  const payload = {
    pcName: config.pcName,
    online: true,
    timestamp: Date.now(),
    timeFormatted: new Date().toLocaleTimeString(),
    uptimeSeconds: Math.floor(os.uptime()),
    loginState,
    localIPs: getLocalIPs(),
    shutdownPending,
    ...extra
  };

  try {
    const url = new URL(`${config.ntfyServer}/${config.statusTopic}`);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 6000
    }, (res) => res.resume());
    req.on('error', () => {});
    req.write(JSON.stringify(payload));
    req.end();
  } catch (_) {}

  return payload;
}

// Send Boot / Wake Alert
async function sendBootOrWakeAlert(reason = 'System Boot / Power On') {
  const now = Date.now();
  // Avoid duplicate alerts within 25 seconds
  if (now - lastBootAlertTime < 25000) {
    log(`Skipping duplicate boot alert (${reason})`);
    return;
  }
  lastBootAlertTime = now;

  log(`Preparing boot alert (${reason}). Waiting for network...`);
  const online = await waitForInternet(180);
  if (!online) {
    log('Could not reach internet within 180s for boot alert.');
    return;
  }

  const loginState = await getLoginStatus();
  const ips = getLocalIPs().join(', ') || 'Connecting...';
  const timeStr = new Date().toLocaleString();

  const webAppUrl = `https://gist.githack.com/YeasinFiyaz/ab8805797e7fad7fd9eac2e9dfc5a083/raw/pwa.html#alert=${config.alertTopic}&cmd=${config.cmdTopic}&status=${config.statusTopic}&token=${config.secretToken}&pc=${encodeURIComponent(config.pcName)}`;

  const message = [
    `⚡ Your PC (${config.pcName}) just turned ON!`,
    `🕒 Time: ${timeStr}`,
    `🔒 State: ${loginState}`,
    `📡 Trigger: ${reason}`,
    `🌐 Local IP: ${ips}`,
    ``,
    `📲 Open Full Mobile App (4G/5G & Wi-Fi):`,
    webAppUrl,
    ``,
    `Or tap a 1-click action button right below:`
  ].join('\n');

  await sendNtfyNotification({
    title: `🚨 PC TURNED ON: ${config.pcName}`,
    message,
    priority: 'max',
    tags: 'rotating_light,laptop',
    includeActions: true
  });

  await publishStatus({ event: 'BOOT_ALERT', reason });
}

// Execute Remote Commands
async function executeCommand(cmdObj, source = 'remote') {
  if (!cmdObj || cmdObj.token !== config.secretToken) {
    log(`Rejected unauthorized command from ${source}`);
    return { ok: false, error: 'Unauthorized token' };
  }

  const cmd = (cmdObj.cmd || '').toUpperCase();
  log(`Executing verified command [${cmd}] from ${source}`);

  if (cmd === 'SHUTDOWN_30S') {
    const delay = Number(cmdObj.delay) || config.shutdownDelaySeconds || 30;
    shutdownPending = true;
    // Run Windows shutdown command (works even at Lock Screen as SYSTEM!)
    exec(`shutdown.exe /s /f /t ${delay} /c "PC Sentinel: Remote Shutdown Activated by Owner (${delay}s)"`, (err) => {
      if (err) {
        log(`shutdown.exe error: ${err.message}`);
      }
    });

    // Fallback timer in case a process blocks shutdown
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = setTimeout(() => {
      if (shutdownPending) {
        exec('shutdown.exe /s /f /t 0');
      }
    }, (delay + 2) * 1000);

    await sendNtfyNotification({
      title: `🛑 Shutdown Activated (${delay}s)`,
      message: `${config.pcName} will force shut down in ${delay} seconds!\nTap "Cancel Shutdown" below if you want to abort.`,
      priority: 'high',
      tags: 'octagonal_sign,timer_clock',
      includeActions: true
    });
    await publishStatus({ event: 'SHUTDOWN_STARTED', delay });
    return { ok: true, message: `Shutdown initiated (${delay}s countdown)` };
  }

  if (cmd === 'SHUTDOWN_NOW') {
    shutdownPending = true;
    await sendNtfyNotification({
      title: `🛑 Immediate Shutdown Activated`,
      message: `${config.pcName} is shutting down right now!`,
      priority: 'high',
      tags: 'octagonal_sign',
      includeActions: false
    });
    await publishStatus({ event: 'SHUTDOWN_NOW' });
    setTimeout(() => {
      exec('shutdown.exe /s /f /t 0');
    }, 800);
    return { ok: true, message: 'Immediate shutdown initiated' };
  }

  if (cmd === 'ABORT') {
    shutdownPending = false;
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    exec('shutdown.exe /a', () => {});
    await sendNtfyNotification({
      title: `✅ Shutdown Cancelled`,
      message: `The pending shutdown on ${config.pcName} has been aborted.`,
      priority: 'default',
      tags: 'white_check_mark',
      includeActions: false
    });
    await publishStatus({ event: 'SHUTDOWN_ABORTED' });
    return { ok: true, message: 'Shutdown cancelled' };
  }

  if (cmd === 'LOCK') {
    exec('rundll32.exe user32.dll,LockWorkStation');
    exec('schtasks.exe /Run /TN "PCSentinel_LockHelper"', () => {});
    http.get('http://127.0.0.1:4849/lock', () => {}).on('error', () => {});
    await publishStatus({ event: 'LOCKED' });
    return { ok: true, message: 'Lock signal sent' };
  }

  if (cmd === 'STATUS' || cmd === 'PING') {
    const st = await publishStatus({ event: 'PONG' });
    return { ok: true, status: st };
  }

  if (cmd === 'TEST_ALERT') {
    await sendNtfyNotification({
      title: `🔔 Test Alert: ${config.pcName} is Online`,
      message: `Your PC Sentinel agent is active and connected!\nTap "Shut Down (30s)" below to test 1-tap shutdown, or "Cancel Shutdown" to abort it.`,
      priority: 'high',
      tags: 'white_check_mark,laptop',
      includeActions: true
    });
    return { ok: true, message: 'Test alert sent to your phone' };
  }

  return { ok: false, error: `Unknown command: ${cmd}` };
}

// Subscribe to ntfy.sh command stream so the phone can control the PC from ANYWHERE (even on 4G/5G!)
let streamReq = null;
function startCommandStreamListener() {
  const streamUrl = `${config.ntfyServer}/${config.cmdTopic}/json`;
  log(`Connecting to remote command stream: ${streamUrl}`);

  try {
    streamReq = https.get(streamUrl, { timeout: 90000 }, (res) => {
      if (res.statusCode !== 200) {
        log(`Command stream returned HTTP ${res.statusCode}, reconnecting in 5s...`);
        res.resume();
        setTimeout(startCommandStreamListener, 5000);
        return;
      }
      log(`Connected to remote command stream successfully.`);
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
              let parsed = null;
              try {
                parsed = JSON.parse(evt.message);
              } catch (_) {
                // Also support plain text format: SHUTDOWN_30S:<token>
                const parts = evt.message.trim().split(':');
                if (parts.length === 2) {
                  parsed = { cmd: parts[0], token: parts[1] };
                }
              }
              if (parsed) {
                executeCommand(parsed, 'ntfy-cloud');
              }
            }
          } catch (e) {
            log(`Stream parse error: ${e.message}`);
          }
        }
      });

      res.on('end', () => {
        log('Command stream ended, reconnecting in 3s...');
        setTimeout(startCommandStreamListener, 3000);
      });

      res.on('error', (err) => {
        log(`Command stream error: ${err.message}, reconnecting in 5s...`);
        setTimeout(startCommandStreamListener, 5000);
      });
    });

    streamReq.on('error', (err) => {
      log(`Stream connection error: ${err.message}, retrying in 5s...`);
      setTimeout(startCommandStreamListener, 5000);
    });

    streamReq.on('timeout', () => {
      // ntfy sends keepalive newlines every ~45s; if timeout hits, reconnect
      streamReq.destroy();
    });
  } catch (e) {
    setTimeout(startCommandStreamListener, 5000);
  }
}

// Detect Wake from Sleep / Hibernate / Fast Startup via wall-clock jump detector
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastTick;
  lastTick = now;
  // If a 4-second interval took more than 20 seconds, the laptop just woke up from Sleep / Hibernate / Fast Startup!
  if (elapsed > 20000) {
    log(`Detected system wake / resume from sleep or fast startup (clock jumped ${Math.round(elapsed / 1000)}s)`);
    sendBootOrWakeAlert('Wake from Sleep / Fast Startup');
  }
}, 4000);

// Serve the Custom Mobile App (PWA) & Local API
function startLocalServer() {
  const pwaHtmlPath = path.join(BASE_DIR, 'pwa.html');

  const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (reqUrl.pathname === '/api/status' && req.method === 'GET') {
      const loginState = await getLoginStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        pcName: config.pcName,
        uptimeSeconds: Math.floor(os.uptime()),
        loginState,
        localIPs: getLocalIPs(),
        shutdownPending
      }));
      return;
    }

    if (reqUrl.pathname === '/api/cmd' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const result = await executeCommand(data, 'local-http');
          res.writeHead(result.ok ? 200 : 403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (reqUrl.pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
      res.end(JSON.stringify({
        name: `PC Sentinel — ${config.pcName}`,
        short_name: 'PC Sentinel',
        start_url: '/',
        display: 'standalone',
        background_color: '#090d16',
        theme_color: '#ef4444',
        icons: [
          {
            src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="%23111827"/><circle cx="50" cy="50" r="32" fill="none" stroke="%23ef4444" stroke-width="8"/><line x1="50" y1="14" x2="50" y2="48" stroke="%23ef4444" stroke-width="8" stroke-linecap="round"/></svg>',
            sizes: '192x192',
            type: 'image/svg+xml'
          }
        ]
      }));
      return;
    }

    // Serve the PWA HTML with injected config
    if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
      try {
        let html = fs.readFileSync(pwaHtmlPath, 'utf8');
        html = html
          .replace(/__NTFY_SERVER__/g, config.ntfyServer)
          .replace(/__ALERT_TOPIC__/g, config.alertTopic)
          .replace(/__CMD_TOPIC__/g, config.cmdTopic)
          .replace(/__STATUS_TOPIC__/g, config.statusTopic)
          .replace(/__SECRET_TOKEN__/g, config.secretToken)
          .replace(/__PC_NAME__/g, config.pcName)
          .replace(/__LOCAL_PORT__/g, String(config.localPort));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(500);
        res.end('Error loading PWA HTML: ' + e.message);
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(config.localPort, '0.0.0.0', () => {
    log(`Local PWA & Control Server listening on http://0.0.0.0:${config.localPort}`);
  });
}

// Check if an instance of PC Sentinel is already running on localPort
function checkAlreadyRunning() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${config.localPort}/api/status`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Main entry point
async function main() {
  const args = process.argv.slice(2);
  log(`=== PC Sentinel Agent Starting (PID ${process.pid}, Args: ${args.join(' ')}) ===`);

  if (args.includes('--wake-only')) {
    // Triggered by Windows Event ID 1 / 107 task on wake
    await sendBootOrWakeAlert('System Wake / Fast Startup Resume');
    process.exit(0);
    return;
  }

  const alreadyRunning = await checkAlreadyRunning();
  if (alreadyRunning) {
    log(`PC Sentinel is already running on port ${config.localPort}. Exiting duplicate instance.`);
    process.exit(0);
    return;
  }

  startLocalServer();
  startCommandStreamListener();

  // Send immediate boot alert (waits automatically for Wi-Fi to connect first)
  await sendBootOrWakeAlert('System Boot / Power On (Pre-Login)');

  // Publish heartbeat every 60 seconds
  setInterval(() => {
    publishStatus({ event: 'HEARTBEAT' });
  }, 60000);
}

main();
