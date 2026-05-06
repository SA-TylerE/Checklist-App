# SA Onboarding Checklist

Internal web app for tracking MSP client onboarding progress across organisation setup and per-device deployment.

## Stack

- **Backend**: Node.js + Express, serving static files and a JSON REST API
- **Frontend**: Single-file vanilla JS/HTML (`public/index.html`)
- **Data**: JSON files written to `data/` (not tracked in git)
- **Reverse proxy**: Apache (or nginx) in front of Node on port 3000

## Features

- Multi-client onboarding checklists with phase/step tracking
- Per-device deployment guide with installer URL auto-resolution from Syncro API
- TinyURL auto-shortening and QR code generation per device
- Guide panel with collapsible sections
- SSE live sync — multiple techs can work simultaneously with change pulse highlighting
- Reference view for browsing procedures without a client open
- Settings: Syncro config, RMM URL templates, stale threshold, due date defaults
- Procedure and guide editors
- Daily auto-backup of client data (last 30 days retained)
- Light / System / Dark theme

## Setup

```bash
# Install dependencies
npm install

# Start the server
node server.js
# Runs on 127.0.0.1:3000 by default
```

## Data files (not in repo)

The following are created automatically at runtime and excluded from git:

| Path | Contents |
|---|---|
| `data/clients.json` | All client checklist data |
| `data/config.json` | Syncro API token and subdomain |
| `data/settings.json` | App settings (thresholds, URL templates) |
| `data/backups/` | Daily client data backups |

## Public files (in repo)

| Path | Contents |
|---|---|
| `public/index.html` | Full frontend application |
| `public/steps.json` | Onboarding procedure definitions |
| `public/guides.json` | Guide panel content |

## Apache reverse proxy (example)

```apache
<VirtualHost *:443>
    ServerName checklist.yourdomain.com

    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/
    ProxyPreserveHost On

    # SSE — disable buffering
    SetEnv proxy-nokeepalive 1
    SetEnv proxy-sendchunked 1
</VirtualHost>
```

## Systemd service (example)

```ini
[Unit]
Description=SA Onboarding Checklist
After=network.target

[Service]
WorkingDirectory=/opt/checklist
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
```
