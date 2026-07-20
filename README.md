# Wake / Sleep / Shutdown on LAN (Node + Bash)

Simple project to:
- **Wake** a machine via Wake-on-LAN.
- **Sleep/Shutdown** a machine via SSH command.
- **Proxy TCP ports and wake the target on demand**.
- **Preserve and restore running Proxmox VMs** (Em construção/Desativado).

## How it works
- The Node server exposes a UI with three buttons: **Wake**, **Sleep** and **Shutdown**.
- Sleep and shutdown actions run remote commands over SSH on Proxmox.
- Optional TCP proxy mode listens on configured local ports, checks the same port on the remote target, sends Wake-on-LAN if the target is down, waits until that remote TCP port is available, then forwards all traffic to it.
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

## Persistence
When running with Docker Compose, the app persists runtime state in the host `data/` folder:

- `data/schedule.json`: UI schedule settings.
- `data/config.json`: last effective environment configuration used by the app.
- `data/logs.jsonl`: persistent application logs shown in the UI.
- `data/proxy-usage.jsonl`: persistent proxy usage table, including accessed ports and wake/cache decisions.
- `data/hibernated-vms.json`: temporary VM resume state, when used.

`docker-compose.yml` mounts this folder into the container as `/app/data`, so rebuilding or recreating the container does not erase these files.

`data/config.json` may contain secrets such as `SSH_PASS`. Keep it private and do not commit it. The app still prefers `.env`; the persisted config is used as a fallback when a variable is missing from `.env`.

Log persistence can be adjusted with:

```bash
STATE_DIR=./data
LOG_PERSIST_ENABLED=true
LOG_MAX_ENTRIES=200
PROXY_USAGE_LOG_ENABLED=true
PROXY_USAGE_LOG_MAX_ENTRIES=200
```

## TCP wake proxy
To make the app behave like a local redirector where each local port maps to the same remote port, enable the proxy:

```bash
PROXY_ENABLED=true \
PROXY_LISTEN_HOST=0.0.0.0 \
PROXY_PORTS=2222,6790,9000 \
PROXY_TARGET_HOST=192.168.1.50 \
PROXY_IDLE_SLEEP_ENABLED=true \
PROXY_IDLE_SLEEP_TIMEOUT_MS=1800000 \
PROXY_IDLE_REMOTE_CHECK_SECONDS=120 \
npm run server
```

With this enabled:
- A client connecting to `localhost:2222` is forwarded to `192.168.1.50:2222`.
- A client connecting to `localhost:6790` is forwarded to `192.168.1.50:6790`.
- A client connecting to `localhost:9000` is forwarded to `192.168.1.50:9000`.

For each connection, the app first tries the matching remote port. If it cannot connect, it sends the Wake-on-LAN packet, waits up to `PROXY_WAKE_TIMEOUT_MS`, and then starts forwarding bytes between the client and the remote service.

Wake-on-LAN sends are cached for 5 minutes by default so repeated failed connection attempts do not keep sending magic packets:

```bash
PROXY_WAKE_CACHE_MS=300000
```

Set `PROXY_WAKE_CACHE_MS=0` to disable the cache. The UI shows proxy usage in a separate table, including the accessed port, target, whether Wake-on-LAN was sent, skipped by cache, joined to another wake attempt, or not needed because the remote port was already available.

To automatically put the remote host to sleep after proxy traffic stops, enable idle sleep:

```bash
PROXY_IDLE_SLEEP_ENABLED=true
PROXY_IDLE_SLEEP_TIMEOUT_MS=1800000
PROXY_IDLE_SLEEP_REQUIRE_NO_CONNECTIONS=true
PROXY_IDLE_SLEEP_COMMAND="/usr/sbin/ethtool -s nic0 wol g && /bin/systemctl suspend"
PROXY_IDLE_REMOTE_CHECK_ENABLED=true
PROXY_IDLE_REMOTE_CHECK_SECONDS=120
PROXY_IDLE_REMOTE_CPU_MAX_PERCENT=10
PROXY_IDLE_REMOTE_NET_MAX_BYTES_PER_SECOND=4096
PROXY_IDLE_REMOTE_NET_INTERFACES=
PROXY_IDLE_REMOTE_NET_EXCLUDE_REGEX=^lo$
```

`PROXY_IDLE_SLEEP_TIMEOUT_MS=1800000` means 30 minutes. By default, the app only considers sleeping when there are no active proxy connections and no proxy traffic has passed during the timeout. Set `PROXY_IDLE_SLEEP_REQUIRE_NO_CONNECTIONS=false` only if you want open but idle TCP connections to be ignored.

Before sending the sleep command, the app SSHes into the remote host and samples `/proc/stat` and `/proc/net/dev` for `PROXY_IDLE_REMOTE_CHECK_SECONDS`. It only runs `PROXY_IDLE_SLEEP_COMMAND` when both checks are below the configured limits:
- CPU busy percent <= `PROXY_IDLE_REMOTE_CPU_MAX_PERCENT`
- network bytes per second <= `PROXY_IDLE_REMOTE_NET_MAX_BYTES_PER_SECOND`

If `PROXY_IDLE_SLEEP_COMMAND` is empty, it falls back to `SLEEP_COMMAND`. You can use the same mechanism for shutdown or any other safe command:

```bash
PROXY_IDLE_SLEEP_COMMAND="/bin/systemctl poweroff"
```

By default, network activity is counted on every interface except `lo`. To check only specific interfaces, set a comma-separated list:

```bash
PROXY_IDLE_REMOTE_NET_INTERFACES=eth0,enp3s0,vmbr0
```

To keep checking all interfaces but ignore some, set a regex:

```bash
PROXY_IDLE_REMOTE_NET_EXCLUDE_REGEX='^(lo|docker.*|veth.*)$'
```

`PROXY_PORTS` accepts comma-separated ports and ranges:

```bash
PROXY_PORTS=2222,6790,9000,10000-10010
```

The app can only receive connections on ports it is listening on, so include every local port you want to support.

For Docker on Linux, `network_mode: "host"` is recommended so Wake-on-LAN broadcast and the proxy listeners work directly on the LAN. If you cannot use host networking, publish the UI port and every selected proxy port:

```yaml
ports:
  - "8080:8080"
  - "2222:2222"
  - "6790:6790"
  - "9000:9000"
  - "10000-10010:10000-10010"
```

Do not use `ports:` together with `network_mode: "host"`. Choose one mode:
- Linux server: keep `network_mode: "host"` and do not publish ports manually.
- Docker Desktop or bridge networking: remove `network_mode: "host"` and publish every port or range listed in `PROXY_PORTS`.

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

This preserves `data/` because it is mounted as a host volume. If this is the first run on a server, create the folder before starting:

```bash
mkdir -p data
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
