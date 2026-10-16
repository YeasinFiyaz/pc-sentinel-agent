const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BASE_DIR = __dirname;
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const PWA_TEMPLATE = path.join(BASE_DIR, 'pwa.html');
const STANDALONE_APP = path.join(BASE_DIR, 'PC-Sentinel-Phone-App.html');

let cfg;
if (fs.existsSync(CONFIG_PATH)) {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} else {
  const randomId = crypto.randomBytes(6).toString('hex');
  const secretToken = crypto.randomBytes(8).toString('hex');
  cfg = {
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
}

// Generate standalone mobile HTML file that can be opened from anywhere (even 4G/5G without local Wi-Fi)
let html = fs.readFileSync(PWA_TEMPLATE, 'utf8');
html = html
  .replace(/__NTFY_SERVER__/g, cfg.ntfyServer)
  .replace(/__ALERT_TOPIC__/g, cfg.alertTopic)
  .replace(/__CMD_TOPIC__/g, cfg.cmdTopic)
  .replace(/__STATUS_TOPIC__/g, cfg.statusTopic)
  .replace(/__SECRET_TOKEN__/g, cfg.secretToken)
  .replace(/__PC_NAME__/g, cfg.pcName)
  .replace(/__LOCAL_PORT__/g, String(cfg.localPort));

fs.writeFileSync(STANDALONE_APP, html, 'utf8');
console.log('Initialized config:', JSON.stringify(cfg, null, 2));
