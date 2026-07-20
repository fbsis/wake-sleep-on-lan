import "dotenv/config";
import express from "express";
import morgan from "morgan";
import dgram from "dgram";
import net from "net";
import { Client as SshClient } from "ssh2";
import { spawn } from "child_process";
import path from "path";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import schedule from "node-schedule";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(morgan("combined"));

const stateDir = path.join(__dirname, "..", "data");
const hibernatedVmsStatePath = path.join(stateDir, "hibernated-vms.json");
const schedulePath = path.join(stateDir, "schedule.json");

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number.parseFloat(value ?? String(fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on", "sim"].includes(value.toLowerCase());
}

function parseProxyPorts(value) {
  const ports = [];
  const errors = [];

  if (!value) {
    return { ports, errors };
  }

  const addPort = (port, token) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      errors.push(`Invalid proxy port "${token}"`);
      return;
    }
    ports.push(port);
  };

  for (const rawToken of value.split(",")) {
    const token = rawToken.trim();
    if (!token) {
      continue;
    }

    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);

      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        errors.push(`Invalid proxy port range "${token}"`);
        continue;
      }

      for (let port = start; port <= end; port += 1) {
        addPort(port, token);
      }
      continue;
    }

    if (!/^\d+$/.test(token)) {
      errors.push(`Invalid proxy port "${token}"`);
      continue;
    }

    addPort(Number.parseInt(token, 10), token);
  }

  return { ports: [...new Set(ports)], errors };
}

const proxyPortsConfig = parseProxyPorts(process.env.PROXY_PORTS || process.env.PROXY_LISTEN_PORT || "");

const config = {
  port: parseInteger(process.env.PORT, 8080),
  wakeMac: process.env.WAKE_MAC || "",
  wakeBroadcast: process.env.WAKE_BROADCAST || "255.255.255.255",
  wakePort: parseInteger(process.env.WAKE_PORT, 9),
  sleepHost: process.env.SLEEP_HOST || "",
  sshPort: parseInteger(process.env.SSH_PORT, 22),
  sshUser: process.env.SSH_USER || "root",
  sshPassword: process.env.SSH_PASS || "",
  sleepCommand: process.env.SLEEP_COMMAND || "/usr/sbin/ethtool -s nic0 wol g && /bin/systemctl suspend",
  shutdownCommand: process.env.SHUTDOWN_COMMAND || "/usr/sbin/ethtool -s nic0 wol g && /bin/systemctl poweroff",
  proxyIdleSleepCommand:
    process.env.PROXY_IDLE_SLEEP_COMMAND ||
    process.env.SLEEP_COMMAND ||
    "/usr/sbin/ethtool -s nic0 wol g && /bin/systemctl suspend",
  proxyEnabled: parseBoolean(process.env.PROXY_ENABLED),
  proxyListenHost: process.env.PROXY_LISTEN_HOST || "0.0.0.0",
  proxyPorts: proxyPortsConfig.ports,
  proxyPortErrors: proxyPortsConfig.errors,
  proxyTargetHost: process.env.PROXY_TARGET_HOST || process.env.SLEEP_HOST || "",
  proxyConnectTimeoutMs: parseInteger(process.env.PROXY_CONNECT_TIMEOUT_MS, 1500),
  proxyWakeTimeoutMs: parseInteger(process.env.PROXY_WAKE_TIMEOUT_MS, 120000),
  proxyRetryDelayMs: parseInteger(process.env.PROXY_RETRY_DELAY_MS, 2000),
  proxyIdleSleepEnabled: parseBoolean(process.env.PROXY_IDLE_SLEEP_ENABLED),
  proxyIdleSleepTimeoutMs: parseInteger(process.env.PROXY_IDLE_SLEEP_TIMEOUT_MS, 1800000),
  proxyIdleSleepRequireNoConnections: parseBoolean(process.env.PROXY_IDLE_SLEEP_REQUIRE_NO_CONNECTIONS, true),
  proxyIdleRemoteCheckEnabled: parseBoolean(process.env.PROXY_IDLE_REMOTE_CHECK_ENABLED, true),
  proxyIdleRemoteCheckSeconds: parseInteger(process.env.PROXY_IDLE_REMOTE_CHECK_SECONDS, 120),
  proxyIdleRemoteCpuMaxPercent: parseNumber(process.env.PROXY_IDLE_REMOTE_CPU_MAX_PERCENT, 10),
  proxyIdleRemoteNetMaxBytesPerSecond: parseNumber(process.env.PROXY_IDLE_REMOTE_NET_MAX_BYTES_PER_SECOND, 4096),
  proxyIdleRemoteNetInterfaces: process.env.PROXY_IDLE_REMOTE_NET_INTERFACES || "",
  proxyIdleRemoteNetExcludeRegex: process.env.PROXY_IDLE_REMOTE_NET_EXCLUDE_REGEX || "^lo$"
};

const logsList = [];
const MAX_LOGS = 50;

function addLogEntry(level, message, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...extra
  };
  logsList.unshift(entry);
  if (logsList.length > MAX_LOGS) {
    logsList.pop();
  }
}

function logInfo(message, extra = {}) {
  const payload = { level: "info", message, ...extra, ts: new Date().toISOString() };
  console.log(JSON.stringify(payload));
  addLogEntry("info", message, extra);
}

function logError(message, extra = {}) {
  const payload = { level: "error", message, ...extra, ts: new Date().toISOString() };
  console.error(JSON.stringify(payload));
  addLogEntry("error", message, extra);
}

function validateConfig() {
  if (!config.wakeMac) {
    throw new Error("WAKE_MAC is required");
  }
  if (!config.sleepHost) {
    throw new Error("SLEEP_HOST is required");
  }
  if (!Number.isFinite(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error("PORT is invalid");
  }
  if (!Number.isFinite(config.wakePort) || config.wakePort <= 0 || config.wakePort > 65535) {
    throw new Error("WAKE_PORT is invalid");
  }
  if (!Number.isFinite(config.sshPort) || config.sshPort <= 0 || config.sshPort > 65535) {
    throw new Error("SSH_PORT is invalid");
  }
  if (!config.sshPassword) {
    throw new Error("SSH_PASS is required");
  }
  if (config.proxyEnabled) {
    if (!config.proxyTargetHost) {
      throw new Error("PROXY_TARGET_HOST or SLEEP_HOST is required when PROXY_ENABLED=true");
    }
    if (config.proxyPortErrors.length > 0) {
      throw new Error(config.proxyPortErrors.join("; "));
    }
    if (config.proxyPorts.length === 0) {
      throw new Error("PROXY_PORTS is required when PROXY_ENABLED=true");
    }
    if (config.proxyPorts.includes(config.port)) {
      throw new Error("PROXY_PORTS must not include PORT");
    }
    if (!Number.isFinite(config.proxyConnectTimeoutMs) || config.proxyConnectTimeoutMs <= 0) {
      throw new Error("PROXY_CONNECT_TIMEOUT_MS is invalid");
    }
    if (!Number.isFinite(config.proxyWakeTimeoutMs) || config.proxyWakeTimeoutMs <= 0) {
      throw new Error("PROXY_WAKE_TIMEOUT_MS is invalid");
    }
    if (!Number.isFinite(config.proxyRetryDelayMs) || config.proxyRetryDelayMs <= 0) {
      throw new Error("PROXY_RETRY_DELAY_MS is invalid");
    }
    if (config.proxyIdleSleepEnabled) {
      if (!config.proxyIdleSleepCommand) {
        throw new Error("PROXY_IDLE_SLEEP_COMMAND or SLEEP_COMMAND is required when PROXY_IDLE_SLEEP_ENABLED=true");
      }
      if (!Number.isFinite(config.proxyIdleSleepTimeoutMs) || config.proxyIdleSleepTimeoutMs <= 0) {
        throw new Error("PROXY_IDLE_SLEEP_TIMEOUT_MS is invalid");
      }
      if (config.proxyIdleRemoteCheckEnabled) {
        if (!Number.isFinite(config.proxyIdleRemoteCheckSeconds) || config.proxyIdleRemoteCheckSeconds <= 0) {
          throw new Error("PROXY_IDLE_REMOTE_CHECK_SECONDS is invalid");
        }
        if (
          !Number.isFinite(config.proxyIdleRemoteCpuMaxPercent) ||
          config.proxyIdleRemoteCpuMaxPercent < 0 ||
          config.proxyIdleRemoteCpuMaxPercent > 100
        ) {
          throw new Error("PROXY_IDLE_REMOTE_CPU_MAX_PERCENT is invalid");
        }
        if (
          !Number.isFinite(config.proxyIdleRemoteNetMaxBytesPerSecond) ||
          config.proxyIdleRemoteNetMaxBytesPerSecond < 0
        ) {
          throw new Error("PROXY_IDLE_REMOTE_NET_MAX_BYTES_PER_SECOND is invalid");
        }
      }
    }
  }
}

function sendWakePacket(mac, broadcast, port) {
  return new Promise((resolve, reject) => {
    const cleanMac = mac.replace(/[^a-fA-F0-9]/g, "");
    if (cleanMac.length !== 12) {
      reject(new Error("Invalid MAC address"));
      return;
    }

    const macBytes = Buffer.from(cleanMac, "hex");
    const packet = Buffer.alloc(6 + 16 * 6, 0xff);
    for (let i = 0; i < 16; i++) {
      macBytes.copy(packet, 6 + i * 6);
    }

    const socket = dgram.createSocket("udp4");
    socket.on("error", (err) => {
      socket.close();
      reject(err);
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, broadcast, (err) => {
        socket.close();
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });
}

function runCommandOverSsh(command) {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let stderr = "";
    let stdout = "";

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }
          stream
            .on("close", (code) => {
              conn.end();
              if (code === 0) {
                resolve({ stdout, stderr });
              } else {
                reject(new Error(`SSH command failed (code ${code})`));
              }
            })
            .on("data", (data) => {
              stdout += data.toString();
            });
          stream.stderr.on("data", (data) => {
            stderr += data.toString();
          });
        });
      })
      .on("error", (err) => {
        reject(err);
      })
      .connect({
        host: config.sleepHost,
        port: config.sshPort,
        username: config.sshUser,
        password: config.sshPassword,
        readyTimeout: 5000
      });
  });
}

async function ensureStateDir() {
  await mkdir(stateDir, { recursive: true });
}

async function saveHibernatedVms(vmIds) {
  await ensureStateDir();
  await writeFile(
    hibernatedVmsStatePath,
    JSON.stringify({ vmIds, savedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

async function clearHibernatedVms() {
  await rm(hibernatedVmsStatePath, { force: true });
}

async function loadHibernatedVms() {
  try {
    const raw = await readFile(hibernatedVmsStatePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.vmIds)) {
      return [];
    }
    return parsed.vmIds.filter((vmId) => Number.isInteger(vmId));
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function listRunningVmIds() {
  const result = await runCommandOverSsh(`qm list | awk 'NR>1 && $3 == "running" { print $1 }'`);
  return result.stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((vmId) => Number.isInteger(vmId));
}

async function hibernateRunningVms() {
  const vmIds = await listRunningVmIds();

  for (const vmId of vmIds) {
    await runCommandOverSsh(`qm suspend ${vmId} --todisk 1`);
  }

  await saveHibernatedVms(vmIds);
  return vmIds;
}

async function waitForHostOnline(host, attempts = 24, delayMs = 5000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await pingHost(host)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

async function resumeSavedVmsAfterWake() {
  const vmIds = await loadHibernatedVms();
  if (vmIds.length === 0) {
    return;
  }

  const online = await waitForHostOnline(config.sleepHost);
  if (!online) {
    throw new Error("Host did not come back online in time to resume VMs");
  }

  for (const vmId of vmIds) {
    await runCommandOverSsh(`qm resume ${vmId}`);
  }

  await clearHibernatedVms();
}

function pingHost(host) {
  return new Promise((resolve) => {
    const platform = process.platform;
    let args = [];

    if (platform === "win32") {
      args = ["-n", "1", "-w", "1000", host];
    } else if (platform === "darwin") {
      args = ["-c", "1", "-W", "1000", host];
    } else {
      args = ["-c", "1", "-W", "1", host];
    }

    const proc = spawn("ping", args, { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectToTcpPort(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const cleanup = () => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      socket.setTimeout(0);
    };

    const fail = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };

    const onConnect = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(socket);
    };

    const onError = (err) => fail(err);
    const onTimeout = () => fail(new Error(`TCP connect timeout after ${timeoutMs}ms`));

    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.setTimeout(timeoutMs);
  });
}

const proxyWakeInFlightByPort = new Map();
let proxyActiveConnections = 0;
let proxyLastTrafficAt = null;
let proxyIdleSleepTimer = null;
let proxyIdleSleepInFlight = null;

function createProxyRoute(listenPort) {
  return {
    listenHost: config.proxyListenHost,
    listenPort,
    targetHost: config.proxyTargetHost,
    targetPort: listenPort
  };
}

function getProxyRouteKey(route) {
  return `${route.targetHost}:${route.targetPort}`;
}

function clearProxyIdleSleepTimer() {
  if (proxyIdleSleepTimer) {
    clearTimeout(proxyIdleSleepTimer);
    proxyIdleSleepTimer = null;
  }
}

function scheduleProxyIdleSleepCheck() {
  clearProxyIdleSleepTimer();

  if (!config.proxyIdleSleepEnabled || !proxyLastTrafficAt) {
    return;
  }
  if (config.proxyIdleSleepRequireNoConnections && proxyActiveConnections > 0) {
    return;
  }

  const idleMs = Date.now() - proxyLastTrafficAt;
  const waitMs = Math.max(config.proxyIdleSleepTimeoutMs - idleMs, 0);
  proxyIdleSleepTimer = setTimeout(() => {
    proxyIdleSleepTimer = null;
    triggerProxyIdleSleepIfIdle().catch((err) => {
      logError("proxy_idle_sleep_unhandled_error", { error: err.message });
    });
  }, waitMs);
}

function markProxyTraffic(bytes) {
  if (bytes <= 0) {
    return;
  }

  proxyLastTrafficAt = Date.now();
  scheduleProxyIdleSleepCheck();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function buildRemoteIdleCheckCommand() {
  const interval = config.proxyIdleRemoteCheckSeconds;
  const cpuMaxPercent = config.proxyIdleRemoteCpuMaxPercent;
  const netMaxBytesPerSecond = config.proxyIdleRemoteNetMaxBytesPerSecond;
  const includedInterfaces = shellQuote(config.proxyIdleRemoteNetInterfaces);
  const excludedInterfacesRegex = shellQuote(config.proxyIdleRemoteNetExcludeRegex);

  return `
INTERVAL=${interval}
CPU_MAX_PERCENT=${cpuMaxPercent}
NET_MAX_BPS=${netMaxBytesPerSecond}
INCLUDED_INTERFACES=${includedInterfaces}
EXCLUDED_INTERFACES_REGEX=${excludedInterfacesRegex}

read_cpu() {
  awk '/^cpu / {
    total = 0
    for (i = 2; i <= NF; i++) total += $i
    idle = $5 + $6
    printf "%.0f %.0f\\n", total, idle
    exit
  }' /proc/stat
}

read_net() {
  awk -v include="$INCLUDED_INTERFACES" -v exclude="$EXCLUDED_INTERFACES_REGEX" '
    function trim(value) {
      gsub(/^[ \\t]+|[ \\t]+$/, "", value)
      return value
    }
    function selected(iface, parts, count, i) {
      if (include != "") {
        count = split(include, parts, ",")
        for (i = 1; i <= count; i++) {
          if (iface == trim(parts[i])) return 1
        }
        return 0
      }
      if (exclude != "" && iface ~ exclude) return 0
      return 1
    }
    NR > 2 {
      iface = $1
      sub(":", "", iface)
      if (selected(iface)) total += $2 + $10
    }
    END { printf "%.0f\\n", total + 0 }
  ' /proc/net/dev
}

set -- $(read_cpu)
cpu_total_start=$1
cpu_idle_start=$2
net_total_start=$(read_net)

sleep "$INTERVAL"

set -- $(read_cpu)
cpu_total_end=$1
cpu_idle_end=$2
net_total_end=$(read_net)

cpu_total_delta=$((cpu_total_end - cpu_total_start))
cpu_idle_delta=$((cpu_idle_end - cpu_idle_start))
net_total_delta=$((net_total_end - net_total_start))

if [ "$cpu_total_delta" -lt 0 ]; then cpu_total_delta=0; fi
if [ "$cpu_idle_delta" -lt 0 ]; then cpu_idle_delta=0; fi
if [ "$net_total_delta" -lt 0 ]; then net_total_delta=0; fi

awk \\
  -v cpu_total_delta="$cpu_total_delta" \\
  -v cpu_idle_delta="$cpu_idle_delta" \\
  -v net_total_delta="$net_total_delta" \\
  -v interval="$INTERVAL" \\
  -v cpu_max="$CPU_MAX_PERCENT" \\
  -v net_max="$NET_MAX_BPS" \\
  'BEGIN {
    cpu_busy = cpu_total_delta > 0 ? ((cpu_total_delta - cpu_idle_delta) * 100 / cpu_total_delta) : 100
    net_bps = interval > 0 ? (net_total_delta / interval) : 0
    idle = (cpu_busy <= cpu_max && net_bps <= net_max) ? "true" : "false"
    printf "{\\"idle\\":%s,\\"cpuBusyPercent\\":%.2f,\\"networkBytesPerSecond\\":%.2f,\\"sampleSeconds\\":%d,\\"cpuMaxPercent\\":%.2f,\\"networkMaxBytesPerSecond\\":%.2f,\\"networkBytesDelta\\":%.0f}\\n", idle, cpu_busy, net_bps, interval, cpu_max, net_max, net_total_delta
  }'
`.trim();
}

function parseRemoteIdleCheckResult(stdout) {
  const jsonLine = stdout
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith("{"));

  if (!jsonLine) {
    throw new Error("Remote idle check did not return JSON");
  }

  const parsed = JSON.parse(jsonLine);
  return {
    idle: parsed.idle === true,
    cpuBusyPercent: Number(parsed.cpuBusyPercent),
    networkBytesPerSecond: Number(parsed.networkBytesPerSecond),
    sampleSeconds: Number(parsed.sampleSeconds),
    cpuMaxPercent: Number(parsed.cpuMaxPercent),
    networkMaxBytesPerSecond: Number(parsed.networkMaxBytesPerSecond),
    networkBytesDelta: Number(parsed.networkBytesDelta)
  };
}

async function checkRemoteIdleOverSsh() {
  logInfo("proxy_idle_remote_check_started", {
    host: config.sleepHost,
    sampleSeconds: config.proxyIdleRemoteCheckSeconds,
    cpuMaxPercent: config.proxyIdleRemoteCpuMaxPercent,
    networkMaxBytesPerSecond: config.proxyIdleRemoteNetMaxBytesPerSecond,
    networkInterfaces: config.proxyIdleRemoteNetInterfaces || "all_except_excluded",
    networkExcludeRegex: config.proxyIdleRemoteNetExcludeRegex
  });

  const result = await runCommandOverSsh(buildRemoteIdleCheckCommand());
  const parsed = parseRemoteIdleCheckResult(result.stdout);

  logInfo("proxy_idle_remote_check_result", {
    host: config.sleepHost,
    ...parsed
  });

  return parsed;
}

async function triggerProxyIdleSleepIfIdle() {
  if (!config.proxyIdleSleepEnabled || !proxyLastTrafficAt || proxyIdleSleepInFlight) {
    return;
  }
  if (config.proxyIdleSleepRequireNoConnections && proxyActiveConnections > 0) {
    scheduleProxyIdleSleepCheck();
    return;
  }

  const idleMs = Date.now() - proxyLastTrafficAt;
  if (idleMs < config.proxyIdleSleepTimeoutMs) {
    scheduleProxyIdleSleepCheck();
    return;
  }

  const checkedTrafficAt = proxyLastTrafficAt;
  const idleSince = new Date(proxyLastTrafficAt).toISOString();
  proxyIdleSleepInFlight = (async () => {
    try {
      let remoteIdleCheck = { idle: true };

      if (config.proxyIdleRemoteCheckEnabled) {
        remoteIdleCheck = await checkRemoteIdleOverSsh();

        if (!remoteIdleCheck.idle) {
          proxyLastTrafficAt = Date.now();
          logInfo("proxy_idle_sleep_skipped_remote_busy", {
            host: config.sleepHost,
            idleSince,
            cpuBusyPercent: remoteIdleCheck.cpuBusyPercent,
            cpuMaxPercent: remoteIdleCheck.cpuMaxPercent,
            networkBytesPerSecond: remoteIdleCheck.networkBytesPerSecond,
            networkMaxBytesPerSecond: remoteIdleCheck.networkMaxBytesPerSecond
          });
          return;
        }
      }

      if (proxyLastTrafficAt !== checkedTrafficAt) {
        logInfo("proxy_idle_sleep_skipped_local_activity", {
          host: config.sleepHost,
          idleSince
        });
        return;
      }
      if (config.proxyIdleSleepRequireNoConnections && proxyActiveConnections > 0) {
        logInfo("proxy_idle_sleep_skipped_active_connections", {
          host: config.sleepHost,
          idleSince,
          activeConnections: proxyActiveConnections
        });
        return;
      }

      proxyLastTrafficAt = null;
      const result = await runCommandOverSsh(config.proxyIdleSleepCommand);
      logInfo("proxy_idle_sleep_sent", {
        host: config.sleepHost,
        idleMs,
        idleSince,
        remoteIdleCheck,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim()
      });
    } catch (err) {
      proxyLastTrafficAt = Date.now();
      logError("proxy_idle_sleep_failed", {
        host: config.sleepHost,
        idleMs,
        idleSince,
        error: err.message
      });
    } finally {
      proxyIdleSleepInFlight = null;
      scheduleProxyIdleSleepCheck();
    }
  })();

  await proxyIdleSleepInFlight;
}

async function waitForProxyTargetPort(route) {
  const deadline = Date.now() + config.proxyWakeTimeoutMs;
  let attempt = 0;
  let lastError = null;

  while (Date.now() < deadline) {
    attempt += 1;

    try {
      const probeSocket = await connectToTcpPort(
        route.targetHost,
        route.targetPort,
        config.proxyConnectTimeoutMs
      );
      probeSocket.end();
      logInfo("proxy_target_port_available", {
        host: route.targetHost,
        port: route.targetPort,
        attempt
      });
      return;
    } catch (err) {
      lastError = err;
      await delay(Math.min(config.proxyRetryDelayMs, Math.max(deadline - Date.now(), 0)));
    }
  }

  throw new Error(
    `Remote port ${route.targetHost}:${route.targetPort} did not become available` +
      (lastError ? ` (${lastError.message})` : "")
  );
}

async function wakeAndWaitForProxyTarget(route) {
  const routeKey = getProxyRouteKey(route);
  const existingWake = proxyWakeInFlightByPort.get(routeKey);

  if (existingWake) {
    logInfo("proxy_wake_wait_joined", {
      targetHost: route.targetHost,
      targetPort: route.targetPort
    });
    return existingWake;
  }

  const wakePromise = (async () => {
    await sendWakePacket(config.wakeMac, config.wakeBroadcast, config.wakePort);
    logInfo("proxy_wake_sent", {
      mac: config.wakeMac,
      broadcast: config.wakeBroadcast,
      port: config.wakePort,
      targetHost: route.targetHost,
      targetPort: route.targetPort
    });
    await waitForProxyTargetPort(route);
  })().finally(() => {
    proxyWakeInFlightByPort.delete(routeKey);
  });

  proxyWakeInFlightByPort.set(routeKey, wakePromise);
  return wakePromise;
}

async function openProxyTargetSocket(route) {
  try {
    return await connectToTcpPort(route.targetHost, route.targetPort, config.proxyConnectTimeoutMs);
  } catch (err) {
    logInfo("proxy_target_unavailable_waking", {
      host: route.targetHost,
      port: route.targetPort,
      error: err.message
    });
    await wakeAndWaitForProxyTarget(route);
    return connectToTcpPort(route.targetHost, route.targetPort, config.proxyConnectTimeoutMs);
  }
}

async function handleProxyConnection(clientSocket, route) {
  const client = `${clientSocket.remoteAddress || "unknown"}:${clientSocket.remotePort || "unknown"}`;
  let targetSocket = null;
  let clientClosed = false;

  proxyActiveConnections += 1;
  clearProxyIdleSleepTimer();

  clientSocket.pause();
  clientSocket.setKeepAlive(true);
  clientSocket.on("error", (err) => {
    logError("proxy_client_error", { client, error: err.message });
  });
  clientSocket.once("close", () => {
    clientClosed = true;
    proxyActiveConnections = Math.max(proxyActiveConnections - 1, 0);
    if (targetSocket && !targetSocket.destroyed) {
      targetSocket.destroy();
    }
    scheduleProxyIdleSleepCheck();
  });

  try {
    logInfo("proxy_client_connected", {
      client,
      listenPort: route.listenPort,
      targetHost: route.targetHost,
      targetPort: route.targetPort
    });

    targetSocket = await openProxyTargetSocket(route);
    if (clientClosed || clientSocket.destroyed) {
      targetSocket.destroy();
      logInfo("proxy_client_disconnected_before_target_ready", { client });
      return;
    }

    targetSocket.setKeepAlive(true);

    targetSocket.on("error", (err) => {
      logError("proxy_target_error", {
        client,
        targetHost: route.targetHost,
        targetPort: route.targetPort,
        error: err.message
      });
    });

    targetSocket.once("close", () => {
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
    });

    clientSocket.pipe(targetSocket);
    targetSocket.pipe(clientSocket);
    clientSocket.on("data", (chunk) => {
      markProxyTraffic(chunk.length);
    });
    targetSocket.on("data", (chunk) => {
      markProxyTraffic(chunk.length);
    });
    clientSocket.resume();

    logInfo("proxy_connection_established", {
      client,
      listenPort: route.listenPort,
      targetHost: route.targetHost,
      targetPort: route.targetPort
    });
  } catch (err) {
    logError("proxy_connection_failed", {
      client,
      listenPort: route.listenPort,
      targetHost: route.targetHost,
      targetPort: route.targetPort,
      error: err.message
    });
    clientSocket.destroy();
  }
}

function startWakeProxyListener(route) {
  const proxyServer = net.createServer((clientSocket) => {
    handleProxyConnection(clientSocket, route).catch((err) => {
      logError("proxy_unhandled_connection_error", {
        listenPort: route.listenPort,
        targetHost: route.targetHost,
        targetPort: route.targetPort,
        error: err.message
      });
      clientSocket.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      proxyServer.removeListener("listening", onListening);
      reject(err);
    };

    const onListening = () => {
      proxyServer.removeListener("error", onError);
      logInfo("proxy_listening", {
        listenHost: route.listenHost,
        listenPort: route.listenPort,
        targetHost: route.targetHost,
        targetPort: route.targetPort
      });
      resolve(proxyServer);
    };

    proxyServer.once("error", onError);
    proxyServer.once("listening", onListening);
    proxyServer.listen(route.listenPort, route.listenHost);
  });
}

async function startWakeProxy() {
  if (!config.proxyEnabled) {
    return [];
  }

  return Promise.all(config.proxyPorts.map((port) => startWakeProxyListener(createProxyRoute(port))));
}

async function executeAction(action) {
  logInfo("executing_scheduled_action", { action });
  try {
    if (action === "wake") {
      await sendWakePacket(config.wakeMac, config.wakeBroadcast, config.wakePort);
      logInfo("wake_sent", { mac: config.wakeMac, broadcast: config.wakeBroadcast, port: config.wakePort });
      resumeSavedVmsAfterWake()
        .then(() => {
          logInfo("hibernated_vms_resumed", { host: config.sleepHost });
        })
        .catch((err) => {
          logError("hibernated_vms_resume_failed", { error: err.message });
        });
    } else if (action === "sleep") {
      const result = await runCommandOverSsh(config.sleepCommand);
      logInfo("sleep_sent", {
        host: config.sleepHost,
        port: config.sshPort,
        user: config.sshUser,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim()
      });
    } else if (action === "shutdown") {
      const shouldHibernateVms = false;
      await clearHibernatedVms();
      const result = await runCommandOverSsh(config.shutdownCommand);
      logInfo("shutdown_sent", {
        host: config.sleepHost,
        port: config.sshPort,
        user: config.sshUser,
        hibernateVms: shouldHibernateVms,
        hibernatedVmIds: [],
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim()
      });
    } else {
      logError("unknown_scheduled_action", { action });
    }
  } catch (err) {
    logError("scheduled_action_failed", { action, error: err.message });
  }
}

let activeSchedule = {
  schedule1: { enabled: false, time: "08:00", action: "wake" },
  schedule2: { enabled: false, time: "22:00", action: "shutdown" }
};

const activeJobs = {
  schedule1: null,
  schedule2: null
};

function scheduleTask(key, taskConfig) {
  if (activeJobs[key]) {
    activeJobs[key].cancel();
    activeJobs[key] = null;
  }

  if (taskConfig && taskConfig.enabled && taskConfig.time) {
    const [hourStr, minuteStr] = taskConfig.time.split(":");
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    if (Number.isInteger(hour) && Number.isInteger(minute)) {
      const rule = new schedule.RecurrenceRule();
      rule.hour = hour;
      rule.minute = minute;

      logInfo("scheduling_task", { key, hour, minute, action: taskConfig.action });

      activeJobs[key] = schedule.scheduleJob(rule, () => {
        logInfo("triggering_scheduled_task", { key, action: taskConfig.action });
        executeAction(taskConfig.action);
      });
    }
  }
}

async function loadSchedule() {
  try {
    const raw = await readFile(schedulePath, "utf8");
    activeSchedule = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") {
      logError("failed_to_load_schedule", { error: err.message });
    }
  }
  scheduleTask("schedule1", activeSchedule.schedule1);
  scheduleTask("schedule2", activeSchedule.schedule2);
}

async function saveSchedule(newSchedule) {
  await ensureStateDir();
  await writeFile(schedulePath, JSON.stringify(newSchedule, null, 2), "utf8");
  activeSchedule = newSchedule;
  scheduleTask("schedule1", activeSchedule.schedule1);
  scheduleTask("schedule2", activeSchedule.schedule2);
}

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/schedule", (req, res) => {
  res.json({ ok: true, schedule: activeSchedule });
});

app.post("/api/schedule", async (req, res) => {
  try {
    const { schedule1, schedule2 } = req.body || {};
    
    const validateTask = (t) => {
      if (!t) return { enabled: false, time: "08:00", action: "wake" };
      const enabled = !!t.enabled;
      const time = typeof t.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t.time) ? t.time : "08:00";
      const action = ["wake", "sleep", "shutdown"].includes(t.action) ? t.action : "wake";
      return { enabled, time, action };
    };

    const newSchedule = {
      schedule1: validateTask(schedule1),
      schedule2: validateTask(schedule2)
    };

    await saveSchedule(newSchedule);
    logInfo("schedule_updated", newSchedule);
    res.json({ ok: true });
  } catch (err) {
    logError("schedule_update_failed", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/trigger/:action", async (req, res) => {
  const inputAction = req.params.action?.toLowerCase();
  let action;

  if (["wake", "ligar", "acordar"].includes(inputAction)) {
    action = "wake";
  } else if (["sleep", "dormir"].includes(inputAction)) {
    action = "sleep";
  } else if (["shutdown", "desligar"].includes(inputAction)) {
    action = "shutdown";
  }

  if (!action) {
    return res.status(400).json({ ok: false, error: "Ação inválida. Use: wake/ligar/acordar, sleep/dormir, ou shutdown/desligar." });
  }

  try {
    if (action === "wake") {
      await sendWakePacket(config.wakeMac, config.wakeBroadcast, config.wakePort);
      logInfo("public_trigger_wake_sent", { mac: config.wakeMac });
      resumeSavedVmsAfterWake()
        .then(() => logInfo("public_trigger_hibernated_vms_resumed"))
        .catch((err) => logError("public_trigger_hibernated_vms_resume_failed", { error: err.message }));
      
      return res.json({ ok: true, message: "Wake-on-LAN enviado com sucesso." });
    } else if (action === "sleep") {
      const result = await runCommandOverSsh(config.sleepCommand);
      logInfo("public_trigger_sleep_sent", { host: config.sleepHost });
      return res.json({ ok: true, message: "Comando de dormir enviado.", stdout: result.stdout.trim() });
    } else if (action === "shutdown") {
      const shouldHibernateVms = false;
      await clearHibernatedVms();
      const result = await runCommandOverSsh(config.shutdownCommand);
      logInfo("public_trigger_shutdown_sent", { host: config.sleepHost });
      return res.json({ ok: true, message: "Comando de desligamento enviado.", stdout: result.stdout.trim() });
    }
  } catch (err) {
    logError("public_trigger_failed", { action, error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/status", async (_req, res) => {
  const online = await pingHost(config.sleepHost);
  const now = new Date();
  const serverTime = now.toLocaleString("pt-BR");
  const tzOffset = -now.getTimezoneOffset() / 60;
  const tzString = `UTC${tzOffset >= 0 ? "+" : ""}${tzOffset}`;
  res.json({ ok: true, online, serverTime: `${serverTime} (${tzString})` });
});

app.get("/api/logs", (req, res) => {
  res.json({ ok: true, logs: logsList });
});

app.post("/api/wake", async (_req, res) => {
  try {
    await sendWakePacket(config.wakeMac, config.wakeBroadcast, config.wakePort);
    logInfo("wake_sent", { mac: config.wakeMac, broadcast: config.wakeBroadcast, port: config.wakePort });
    resumeSavedVmsAfterWake()
      .then(() => {
        logInfo("hibernated_vms_resumed", { host: config.sleepHost });
      })
      .catch((err) => {
        logError("hibernated_vms_resume_failed", { error: err.message });
      });
    res.json({ ok: true });
  } catch (err) {
    logError("wake_failed", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/sleep", async (_req, res) => {
  try {
    const result = await runCommandOverSsh(config.sleepCommand);
    logInfo("sleep_sent", {
      host: config.sleepHost,
      port: config.sshPort,
      user: config.sshUser,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim()
    });
    res.json({ ok: true });
  } catch (err) {
    logError("sleep_failed", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/shutdown", async (req, res) => {
  try {
    // Funcionalidade em construção, mantida sempre desabilitada
    const shouldHibernateVms = false;

    let hibernatedVmIds = [];
    if (shouldHibernateVms) {
      hibernatedVmIds = await hibernateRunningVms();
    } else {
      await clearHibernatedVms();
    }

    const result = await runCommandOverSsh(config.shutdownCommand);
    logInfo("shutdown_sent", {
      host: config.sleepHost,
      port: config.sshPort,
      user: config.sshUser,
      hibernateVms: shouldHibernateVms,
      hibernatedVmIds,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim()
    });
    res.json({ ok: true });
  } catch (err) {
    logError("shutdown_failed", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

try {
  validateConfig();
  await loadSchedule();
  await startWakeProxy();
  app.listen(config.port, () => {
    logInfo("server_listening", { port: config.port });
  });
} catch (err) {
  logError("server_config_error", { error: err.message });
  process.exit(1);
}
