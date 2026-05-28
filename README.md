# Wake / Sleep / Shutdown on LAN (Node + Bash)

Simple project to:
- **Wake** a machine via Wake-on-LAN.
- **Sleep/Shutdown** a machine via SSH command.
- **Preserve and restore running Proxmox VMs** (Em construção/Desativado).

## How it works
- The Node server exposes a UI with three buttons: **Wake**, **Sleep** and **Shutdown**.
- Sleep and shutdown actions run remote commands over SSH on Proxmox.
- *(Funcionalidade sob desenvolvimento)*: Opção de hibernar as VMs Proxmox em execução antes de desligar (com `qm suspend`) e restaurá-las no próximo wake está desativada no momento por estar em construção.

## Requirements
- Node.js 18+ (for the scripts in `src/`)
- SSH access to the target host with permission to run the sleep command
- Proxmox `qm` available for the SSH user used by the app

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

## Update with Docker Compose
Use this flow whenever you change code and want to reload the newest version:

1. Go to the project folder:
```bash
cd /path/to/Wake-sleep-on-lan
```

2. (Optional, if using git) get the latest code:
```bash
git pull
```

3. Rebuild and recreate the service container:
```bash
docker compose up -d --build --force-recreate wake-sleep
```

4. Check if the service is up:
```bash
docker compose ps
```

5. Follow logs to confirm startup and test one action in the UI:
```bash
docker compose logs -f wake-sleep
```

If needed, restart without rebuild:
```bash
docker compose restart wake-sleep
```

## Security
- Use a strong SSH password or switch to a private key.
- Keep SSH restricted to your internal network.
