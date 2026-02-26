# Wake / Sleep / Shutdown on LAN (Node + Bash)

Simple project to:
- **Wake** a machine via Wake-on-LAN.
- **Sleep/Shutdown** a machine via SSH command.

## How it works
- The Node server exposes a UI with three buttons: **Wake**, **Sleep** and **Shutdown**.
- Sleep and shutdown actions run remote commands over SSH on Proxmox.
- You can also create schedules (cron-style or one-time) directly in the UI.

## Requirements
- Node.js 18+ (for the scripts in `src/`)
- SSH access to the target host with permission to run the sleep command

## Install
```bash
npm install
```

## Run the server (UI)
```bash
PORT=8080 \
WAKE_MAC=00:11:22:33:44:55 \
WAKE_BROADCAST=255.255.255.255 \
WAKE_PORT=9 \
SLEEP_HOST=192.168.1.50 \
SSH_PORT=22 \
SSH_USER=root \
SSH_PASS="YOUR_PASSWORD" \
SLEEP_COMMAND="/usr/sbin/ethtool -s nic0 wol g && /bin/systemctl suspend" \
SHUTDOWN_COMMAND="/bin/systemctl poweroff" \
npm run server
```

Open in your browser: `http://YOUR_IP:8080`

The UI status uses `ping` to detect if the server is online.

## Security
- Use a strong SSH password or switch to a private key.
- Keep SSH restricted to your internal network.
