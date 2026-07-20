import "dotenv/config";
import express from "express";
import morgan from "morgan";
import dgram from "dgram";
import net from "net";
import { Client as SshClient } from "ssh2";
import { spawn } from "child_process";
import { constants as fsConstants } from "fs";
import path from "path";
import { access, appendFile, mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import schedule from "node-schedule";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(morgan("combined"));

const stateDir = process.env.STATE_DIR
  ? path.resolve(process.env.STATE_DIR)
  : path.join(__dirname, "..", "data");
const hibernatedVmsStatePath = path.join(stateDir, "hibernated-vms.json");
const persistentConfigPath = path.join(stateDir, "config.json");
const persistentLogsPath = path.join(stateDir, "logs.jsonl");
const persistentProxyUsagePath = path.join(stateDir, "proxy-usage.jsonl");
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
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return ["1", "true", "yes", "on", "sim"].includes(String(value).trim().toLowerCase());
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

  for (const rawToken of String(value).split(",")) {
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

function parseList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePort(value, label) {
  if (!/^\d+$/.test(String(value).trim())) {
    throw new Error(`${label} must be a TCP port`);
  }

  const port = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }

  return port;
}

function parseTargetAddress(value, fallbackPort, label = "target") {
  const target = String(value || "").trim();
  if (!target) {
    throw new Error(`${label} is empty`);
  }

  const bracketIpv6Match = target.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracketIpv6Match) {
    if (!bracketIpv6Match[1].trim()) {
      throw new Error(`${label} host is empty`);
    }
    return {
      host: bracketIpv6Match[1],
      port: bracketIpv6Match[2]
        ? parsePort(bracketIpv6Match[2], `${label} port`)
        : parsePort(fallbackPort, `${label} fallback port`)
    };
  }

  const lastColonIndex = target.lastIndexOf(":");
  if (lastColonIndex > 0 && /^\d+$/.test(target.slice(lastColonIndex + 1))) {
    const host = target.slice(0, lastColonIndex).trim();
    if (!host) {
      throw new Error(`${label} host is empty`);
    }
    return {
      host,
      port: parsePort(target.slice(lastColonIndex + 1), `${label} port`)
    };
  }

  if (fallbackPort !== undefined && fallbackPort !== null && fallbackPort !== "") {
    if (!target) {
      throw new Error(`${label} host is empty`);
    }
    return {
      host: target,
      port: parsePort(fallbackPort, `${label} fallback port`)
    };
  }

  throw new Error(`${label} must be host:port`);
}

function normalizeGuestKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (["vm", "qemu", "qm"].includes(kind)) {
    return "vm";
  }
  if (["lxc", "ct", "container", "pct"].includes(kind)) {
    return "lxc";
  }
  return "";
}

function parseGuestId(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseProxyTargetSpecs(value) {
  const routes = [];
  const errors = [];

  if (!value) {
    return { routes, errors };
  }

  for (const rawToken of String(value).split(",")) {
    const token = rawToken.trim();
    if (!token) {
      continue;
    }

    const separatorIndex = token.indexOf("=");
    if (separatorIndex <= 0) {
      errors.push(`Invalid PROXY_TARGETS entry "${token}". Use listenPort=host:targetPort`);
      continue;
    }

    try {
      const listenPort = parsePort(token.slice(0, separatorIndex), "PROXY_TARGETS listen port");
      const target = parseTargetAddress(
        token.slice(separatorIndex + 1),
        listenPort,
        "PROXY_TARGETS target"
      );

      routes.push({
        listenPort,
        targetHost: target.host,
        targetPort: target.port,
        source: "env"
      });
    } catch (err) {
      errors.push(`Invalid PROXY_TARGETS entry "${token}": ${err.message}`);
    }
  }

  return { routes, errors };
}

async function loadPersistentConfig() {
  try {
    const raw = await readFile(persistentConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") {
      return {};
    }
    console.error(JSON.stringify({
      level: "error",
      message: "persistent_config_load_failed",
      error: err.message,
      ts: new Date().toISOString()
    }));
    return {};
  }
}

const persistentConfig = await loadPersistentConfig();

function getConfigValue(name, fallback) {
  return process.env[name] ?? persistentConfig[name] ?? fallback;
}

const proxyPortsSource = getConfigValue("PROXY_PORTS", getConfigValue("PROXY_LISTEN_PORT", ""));
const proxyPortsConfig = parseProxyPorts(proxyPortsSource);
const proxyTargetsSource = getConfigValue("PROXY_TARGETS", "");
const proxyTargetsConfig = parseProxyTargetSpecs(proxyTargetsSource);

const config = {
  port: parseInteger(getConfigValue("PORT"), 8080),
  wakeMac: getConfigValue("WAKE_MAC", ""),
  wakeBroadcast: getConfigValue("WAKE_BROADCAST", "255.255.255.255"),
  wakePort: parseInteger(getConfigValue("WAKE_PORT"), 9),
  sleepHost: getConfigValue("SLEEP_HOST", ""),
  sshPort: parseInteger(getConfigValue("SSH_PORT"), 22),
  sshUser: getConfigValue("SSH_USER", "root"),
  sshPassword: getConfigValue("SSH_PASS", ""),
  sleepCommand: getConfigValue("SLEEP_COMMAND", "/usr/sbin/ethtool -s nic0 wol g && /bin/systemctl suspend"),
  shutdownCommand: getConfigValue("SHUTDOWN_COMMAND", "/usr/sbin/ethtool -s nic0 wol g && /bin/systemctl poweroff"),
  proxyIdleSleepCommand:
    getConfigValue("PROXY_IDLE_SLEEP_COMMAND") ||
    getConfigValue("SLEEP_COMMAND") ||
    "/usr/sbin/ethtool -s nic0 wol g && /bin/systemctl suspend",
  proxyEnabled: parseBoolean(getConfigValue("PROXY_ENABLED")),
  proxyListenHost: getConfigValue("PROXY_LISTEN_HOST", "0.0.0.0"),
  proxyPortsSource,
  proxyPorts: proxyPortsConfig.ports,
  proxyPortErrors: proxyPortsConfig.errors,
  proxyTargetsSource,
  proxyTargetRoutes: proxyTargetsConfig.routes,
  proxyTargetErrors: proxyTargetsConfig.errors,
  proxyTargetHost: getConfigValue("PROXY_TARGET_HOST") || getConfigValue("SLEEP_HOST", ""),
  proxyConnectTimeoutMs: parseInteger(getConfigValue("PROXY_CONNECT_TIMEOUT_MS"), 1500),
  proxyWakeCacheMs: parseInteger(getConfigValue("PROXY_WAKE_CACHE_MS"), 300000),
  proxyWakeTimeoutMs: parseInteger(getConfigValue("PROXY_WAKE_TIMEOUT_MS"), 120000),
  proxyRetryDelayMs: parseInteger(getConfigValue("PROXY_RETRY_DELAY_MS"), 2000),
  proxyGuestStartEnabled: parseBoolean(getConfigValue("PROXY_GUEST_START_ENABLED")),
  proxyGuestStartTimeoutMs: parseInteger(getConfigValue("PROXY_GUEST_START_TIMEOUT_MS"), 120000),
  proxyGuestStartRetryDelayMs: parseInteger(getConfigValue("PROXY_GUEST_START_RETRY_DELAY_MS"), 3000),
  proxyIdleSleepEnabled: parseBoolean(getConfigValue("PROXY_IDLE_SLEEP_ENABLED")),
  proxyIdleSleepTimeoutMs: parseInteger(getConfigValue("PROXY_IDLE_SLEEP_TIMEOUT_MS"), 1800000),
  proxyIdleSleepRequireNoConnections: parseBoolean(getConfigValue("PROXY_IDLE_SLEEP_REQUIRE_NO_CONNECTIONS"), true),
  proxyIdleRemoteCheckEnabled: parseBoolean(getConfigValue("PROXY_IDLE_REMOTE_CHECK_ENABLED"), true),
  proxyIdleRemoteCheckSeconds: parseInteger(getConfigValue("PROXY_IDLE_REMOTE_CHECK_SECONDS"), 120),
  proxyIdleRemoteCpuMaxPercent: parseNumber(getConfigValue("PROXY_IDLE_REMOTE_CPU_MAX_PERCENT"), 10),
  proxyIdleRemoteNetMaxBytesPerSecond: parseNumber(getConfigValue("PROXY_IDLE_REMOTE_NET_MAX_BYTES_PER_SECOND"), 4096),
  proxyIdleRemoteNetInterfaces: getConfigValue("PROXY_IDLE_REMOTE_NET_INTERFACES", ""),
  proxyIdleRemoteNetExcludeRegex: getConfigValue("PROXY_IDLE_REMOTE_NET_EXCLUDE_REGEX", "^lo$"),
  proxyUsageLogEnabled: parseBoolean(getConfigValue("PROXY_USAGE_LOG_ENABLED"), true),
  proxyUsageLogMaxEntries: parseInteger(getConfigValue("PROXY_USAGE_LOG_MAX_ENTRIES"), 200),
  npmDiscoveryEnabled: parseBoolean(getConfigValue("NPM_DISCOVERY_ENABLED")),
  npmSqlitePath: getConfigValue("NPM_SQLITE_PATH", ""),
  npmSqliteCommand: getConfigValue("NPM_SQLITE_COMMAND", "sqlite3"),
  npmDiscoveryForwardHosts: parseList(getConfigValue("NPM_DISCOVERY_FORWARD_HOSTS", "")),
  npmDiscoveryCommentPrefix: getConfigValue("NPM_DISCOVERY_COMMENT_PREFIX", "wake-sleep"),
  logMaxEntries: parseInteger(getConfigValue("LOG_MAX_ENTRIES"), 200),
  logPersistEnabled: parseBoolean(getConfigValue("LOG_PERSIST_ENABLED"), true)
};

const logsList = [];
const MAX_LOGS = config.logMaxEntries;
const proxyUsageList = [];
const MAX_PROXY_USAGE_LOGS = config.proxyUsageLogMaxEntries;

function getPersistentConfigPayload() {
  return {
    savedAt: new Date().toISOString(),
    PORT: config.port,
    WAKE_MAC: config.wakeMac,
    WAKE_BROADCAST: config.wakeBroadcast,
    WAKE_PORT: config.wakePort,
    SLEEP_HOST: config.sleepHost,
    SSH_PORT: config.sshPort,
    SSH_USER: config.sshUser,
    SSH_PASS: config.sshPassword,
    SLEEP_COMMAND: config.sleepCommand,
    SHUTDOWN_COMMAND: config.shutdownCommand,
    PROXY_ENABLED: config.proxyEnabled,
    PROXY_LISTEN_HOST: config.proxyListenHost,
    PROXY_PORTS: config.proxyPortsSource,
    PROXY_TARGETS: config.proxyTargetsSource,
    PROXY_TARGET_HOST: config.proxyTargetHost,
    PROXY_CONNECT_TIMEOUT_MS: config.proxyConnectTimeoutMs,
    PROXY_WAKE_CACHE_MS: config.proxyWakeCacheMs,
    PROXY_WAKE_TIMEOUT_MS: config.proxyWakeTimeoutMs,
    PROXY_RETRY_DELAY_MS: config.proxyRetryDelayMs,
    PROXY_GUEST_START_ENABLED: config.proxyGuestStartEnabled,
    PROXY_GUEST_START_TIMEOUT_MS: config.proxyGuestStartTimeoutMs,
    PROXY_GUEST_START_RETRY_DELAY_MS: config.proxyGuestStartRetryDelayMs,
    PROXY_IDLE_SLEEP_ENABLED: config.proxyIdleSleepEnabled,
    PROXY_IDLE_SLEEP_TIMEOUT_MS: config.proxyIdleSleepTimeoutMs,
    PROXY_IDLE_SLEEP_REQUIRE_NO_CONNECTIONS: config.proxyIdleSleepRequireNoConnections,
    PROXY_IDLE_SLEEP_COMMAND: config.proxyIdleSleepCommand,
    PROXY_IDLE_REMOTE_CHECK_ENABLED: config.proxyIdleRemoteCheckEnabled,
    PROXY_IDLE_REMOTE_CHECK_SECONDS: config.proxyIdleRemoteCheckSeconds,
    PROXY_IDLE_REMOTE_CPU_MAX_PERCENT: config.proxyIdleRemoteCpuMaxPercent,
    PROXY_IDLE_REMOTE_NET_MAX_BYTES_PER_SECOND: config.proxyIdleRemoteNetMaxBytesPerSecond,
    PROXY_IDLE_REMOTE_NET_INTERFACES: config.proxyIdleRemoteNetInterfaces,
    PROXY_IDLE_REMOTE_NET_EXCLUDE_REGEX: config.proxyIdleRemoteNetExcludeRegex,
    PROXY_USAGE_LOG_ENABLED: config.proxyUsageLogEnabled,
    PROXY_USAGE_LOG_MAX_ENTRIES: config.proxyUsageLogMaxEntries,
    NPM_DISCOVERY_ENABLED: config.npmDiscoveryEnabled,
    NPM_SQLITE_PATH: config.npmSqlitePath,
    NPM_SQLITE_COMMAND: config.npmSqliteCommand,
    NPM_DISCOVERY_FORWARD_HOSTS: config.npmDiscoveryForwardHosts.join(","),
    NPM_DISCOVERY_COMMENT_PREFIX: config.npmDiscoveryCommentPrefix,
    LOG_MAX_ENTRIES: config.logMaxEntries,
    LOG_PERSIST_ENABLED: config.logPersistEnabled
  };
}

async function savePersistentConfig() {
  await ensureStateDir();
  await writeFile(persistentConfigPath, JSON.stringify(getPersistentConfigPayload(), null, 2), "utf8");
}

async function persistLogEntry(entry) {
  if (!config.logPersistEnabled) {
    return;
  }

  await ensureStateDir();
  await appendFile(persistentLogsPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function compactPersistentLogs(entries) {
  if (!config.logPersistEnabled) {
    return;
  }

  await ensureStateDir();
  const chronologicalEntries = [...entries].reverse();
  const content = chronologicalEntries.map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(persistentLogsPath, content ? `${content}\n` : "", "utf8");
}

async function loadPersistentLogs() {
  if (!config.logPersistEnabled) {
    return;
  }

  try {
    const raw = await readFile(persistentLogsPath, "utf8");
    const entries = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-MAX_LOGS)
      .reverse();

    logsList.length = 0;
    logsList.push(...entries);
    await compactPersistentLogs(entries);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(JSON.stringify({
        level: "error",
        message: "persistent_logs_load_failed",
        error: err.message,
        ts: new Date().toISOString()
      }));
    }
  }
}

async function persistProxyUsageEntry(entry) {
  if (!config.proxyUsageLogEnabled) {
    return;
  }

  await ensureStateDir();
  await appendFile(persistentProxyUsagePath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function compactPersistentProxyUsage(entries) {
  if (!config.proxyUsageLogEnabled) {
    return;
  }

  await ensureStateDir();
  const chronologicalEntries = [...entries].reverse();
  const content = chronologicalEntries.map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(persistentProxyUsagePath, content ? `${content}\n` : "", "utf8");
}

async function loadPersistentProxyUsage() {
  if (!config.proxyUsageLogEnabled) {
    return;
  }

  try {
    const raw = await readFile(persistentProxyUsagePath, "utf8");
    const entries = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-MAX_PROXY_USAGE_LOGS)
      .reverse();

    proxyUsageList.length = 0;
    proxyUsageList.push(...entries);
    await compactPersistentProxyUsage(entries);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(JSON.stringify({
        level: "error",
        message: "persistent_proxy_usage_load_failed",
        error: err.message,
        ts: new Date().toISOString()
      }));
    }
  }
}

function addProxyUsageEntry(entry) {
  const normalizedEntry = {
    ts: new Date().toISOString(),
    ...entry
  };

  proxyUsageList.unshift(normalizedEntry);
  if (proxyUsageList.length > MAX_PROXY_USAGE_LOGS) {
    proxyUsageList.pop();
  }

  persistProxyUsageEntry(normalizedEntry).catch((err) => {
    console.error(JSON.stringify({
      level: "error",
      message: "persistent_proxy_usage_write_failed",
      error: err.message,
      ts: new Date().toISOString()
    }));
  });
}

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
  persistLogEntry(entry).catch((err) => {
    console.error(JSON.stringify({
      level: "error",
      message: "persistent_log_write_failed",
      error: err.message,
      ts: new Date().toISOString()
    }));
  });
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

function validateConfig(proxyRoutes = []) {
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
  if (!Number.isFinite(config.logMaxEntries) || config.logMaxEntries <= 0) {
    throw new Error("LOG_MAX_ENTRIES is invalid");
  }
  if (!Number.isFinite(config.proxyUsageLogMaxEntries) || config.proxyUsageLogMaxEntries <= 0) {
    throw new Error("PROXY_USAGE_LOG_MAX_ENTRIES is invalid");
  }
  if (config.proxyEnabled) {
    if (config.proxyPortErrors.length > 0) {
      throw new Error(config.proxyPortErrors.join("; "));
    }
    if (config.proxyTargetErrors.length > 0) {
      throw new Error(config.proxyTargetErrors.join("; "));
    }
    if (config.npmDiscoveryEnabled && !config.npmSqlitePath) {
      throw new Error("NPM_SQLITE_PATH is required when NPM_DISCOVERY_ENABLED=true");
    }
    if (proxyRoutes.length === 0) {
      throw new Error("No proxy routes configured. Use PROXY_TARGETS, NPM discovery, or PROXY_PORTS with PROXY_TARGET_HOST");
    }
    if (proxyRoutes.some((route) => route.listenPort === config.port)) {
      throw new Error("Proxy listen ports must not include PORT");
    }
    if (!Number.isFinite(config.proxyConnectTimeoutMs) || config.proxyConnectTimeoutMs <= 0) {
      throw new Error("PROXY_CONNECT_TIMEOUT_MS is invalid");
    }
    if (!Number.isFinite(config.proxyWakeCacheMs) || config.proxyWakeCacheMs < 0) {
      throw new Error("PROXY_WAKE_CACHE_MS is invalid");
    }
    if (!Number.isFinite(config.proxyWakeTimeoutMs) || config.proxyWakeTimeoutMs <= 0) {
      throw new Error("PROXY_WAKE_TIMEOUT_MS is invalid");
    }
    if (!Number.isFinite(config.proxyRetryDelayMs) || config.proxyRetryDelayMs <= 0) {
      throw new Error("PROXY_RETRY_DELAY_MS is invalid");
    }
    if (!Number.isFinite(config.proxyGuestStartTimeoutMs) || config.proxyGuestStartTimeoutMs <= 0) {
      throw new Error("PROXY_GUEST_START_TIMEOUT_MS is invalid");
    }
    if (!Number.isFinite(config.proxyGuestStartRetryDelayMs) || config.proxyGuestStartRetryDelayMs <= 0) {
      throw new Error("PROXY_GUEST_START_RETRY_DELAY_MS is invalid");
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

function runProcess(command, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      proc.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

function parseKeyValueMetadata(input) {
  const metadata = {};
  const tokenRegex = /([a-zA-Z0-9_-]+)=("[^"]*"|'[^']*'|[^\s#]+)/g;
  let match;

  while ((match = tokenRegex.exec(input)) !== null) {
    const key = match[1].trim().toLowerCase();
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    metadata[key] = value;
  }

  return metadata;
}

function parseNpmWakeMetadata(advancedConfig, fallbackTargetPort, markerPrefix) {
  const marker = String(markerPrefix || "wake-sleep").trim();
  const markerRegex = new RegExp(`^#\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const line = String(advancedConfig || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => markerRegex.test(item));

  if (!line) {
    return null;
  }

  const metadata = parseKeyValueMetadata(line.replace(markerRegex, "").trim());
  const targetValue = metadata.target || metadata.to;
  if (!targetValue) {
    throw new Error(`NPM Advanced marker "${marker}" requires target=host:port`);
  }

  const target = parseTargetAddress(targetValue, fallbackTargetPort, "NPM Advanced target");
  const guestKind = normalizeGuestKind(metadata.kind || metadata.type || metadata.guest);
  const guestId = parseGuestId(metadata.id || metadata.vmid || metadata.ctid);

  if ((guestKind && !guestId) || (!guestKind && guestId)) {
    throw new Error("NPM Advanced guest metadata requires both kind=vm|lxc and id=<number>");
  }

  return {
    targetHost: target.host,
    targetPort: target.port,
    guestKind,
    guestId,
    rawMetadata: metadata
  };
}

function parseNpmDomainNames(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item)).filter(Boolean);
    }
  } catch {
    // Nginx Proxy Manager usually stores JSON here, but keep plain strings usable.
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function assertNpmSqliteAvailable() {
  if (!config.npmSqlitePath) {
    logError("npm_sqlite_path_missing", {
      requiredWhen: "NPM_DISCOVERY_ENABLED=true"
    });
    throw new Error("NPM_SQLITE_PATH is required when NPM_DISCOVERY_ENABLED=true");
  }

  let fileStat;
  try {
    fileStat = await stat(config.npmSqlitePath);
  } catch (err) {
    logError("npm_sqlite_not_found", {
      sqlitePath: config.npmSqlitePath,
      error: err.message,
      code: err.code
    });
    throw new Error(`NPM SQLite database not found at ${config.npmSqlitePath}`);
  }

  if (!fileStat.isFile()) {
    logError("npm_sqlite_not_file", {
      sqlitePath: config.npmSqlitePath,
      type: fileStat.isDirectory() ? "directory" : "other"
    });
    throw new Error(`NPM SQLite path is not a file: ${config.npmSqlitePath}`);
  }

  try {
    await access(config.npmSqlitePath, fsConstants.R_OK);
  } catch (err) {
    logError("npm_sqlite_not_readable", {
      sqlitePath: config.npmSqlitePath,
      error: err.message,
      code: err.code
    });
    throw new Error(`NPM SQLite database is not readable at ${config.npmSqlitePath}`);
  }

  logInfo("npm_sqlite_found", {
    sqlitePath: config.npmSqlitePath,
    sizeBytes: fileStat.size,
    mtime: fileStat.mtime.toISOString()
  });
}

async function queryNpmProxyHosts() {
  const sql = `
SELECT id, domain_names, forward_host, forward_port, advanced_config, enabled, is_deleted
FROM proxy_host
WHERE COALESCE(enabled, 1) = 1
  AND COALESCE(is_deleted, 0) = 0;
`.trim();

  const result = await runProcess(
    config.npmSqliteCommand,
    ["-readonly", "-json", config.npmSqlitePath, sql],
    15000
  );

  const output = result.stdout.trim() || "[]";
  const rows = JSON.parse(output);
  if (!Array.isArray(rows)) {
    throw new Error("NPM SQLite query did not return a JSON array");
  }

  return rows;
}

async function discoverNpmProxyRoutes() {
  if (!config.npmDiscoveryEnabled) {
    return [];
  }

  await assertNpmSqliteAvailable();
  const rows = await queryNpmProxyHosts();
  const forwardHostFilter = new Set(
    config.npmDiscoveryForwardHosts.map((host) => host.toLowerCase())
  );
  const routes = [];

  for (const row of rows) {
    const listenPort = Number.parseInt(row.forward_port, 10);
    const forwardHost = String(row.forward_host || "").trim();

    if (!Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535) {
      continue;
    }
    if (
      forwardHostFilter.size > 0 &&
      !forwardHostFilter.has(forwardHost.toLowerCase())
    ) {
      continue;
    }

    let metadata;
    try {
      metadata = parseNpmWakeMetadata(
        row.advanced_config,
        listenPort,
        config.npmDiscoveryCommentPrefix
      );
    } catch (err) {
      throw new Error(`NPM proxy_host id=${row.id}: ${err.message}`);
    }

    if (!metadata) {
      continue;
    }

    routes.push({
      listenHost: config.proxyListenHost,
      listenPort,
      targetHost: metadata.targetHost,
      targetPort: metadata.targetPort,
      source: "npm",
      npmProxyHostId: row.id,
      npmForwardHost: forwardHost,
      npmForwardPort: listenPort,
      domains: parseNpmDomainNames(row.domain_names),
      guestKind: metadata.guestKind,
      guestId: metadata.guestId,
      rawMetadata: metadata.rawMetadata
    });
  }

  logInfo("npm_discovery_complete", {
    sqlitePath: config.npmSqlitePath,
    proxyHostsRead: rows.length,
    routesDiscovered: routes.length,
    forwardHostFilter: config.npmDiscoveryForwardHosts.join(",") || "none"
  });

  return routes;
}

function normalizeProxyRoute(route) {
  return {
    listenHost: route.listenHost || config.proxyListenHost,
    listenPort: route.listenPort,
    targetHost: route.targetHost,
    targetPort: route.targetPort,
    source: route.source || "global",
    npmProxyHostId: route.npmProxyHostId,
    npmForwardHost: route.npmForwardHost,
    npmForwardPort: route.npmForwardPort,
    domains: route.domains || [],
    guestKind: route.guestKind || "",
    guestId: route.guestId || null,
    rawMetadata: route.rawMetadata || {}
  };
}

async function buildProxyRoutes() {
  if (!config.proxyEnabled) {
    return [];
  }
  if (config.proxyPortErrors.length > 0) {
    throw new Error(config.proxyPortErrors.join("; "));
  }
  if (config.proxyTargetErrors.length > 0) {
    throw new Error(config.proxyTargetErrors.join("; "));
  }

  const routesByPort = new Map();

  const addRoute = (route) => {
    const normalizedRoute = normalizeProxyRoute(route);
    const existingRoute = routesByPort.get(normalizedRoute.listenPort);
    if (existingRoute) {
      logInfo("proxy_route_skipped_duplicate", {
        listenPort: normalizedRoute.listenPort,
        keptSource: existingRoute.source,
        skippedSource: normalizedRoute.source
      });
      return;
    }
    routesByPort.set(normalizedRoute.listenPort, normalizedRoute);
  };

  for (const route of config.proxyTargetRoutes) {
    addRoute(route);
  }

  for (const route of await discoverNpmProxyRoutes()) {
    addRoute(route);
  }

  for (const listenPort of config.proxyPorts) {
    if (routesByPort.has(listenPort)) {
      continue;
    }
    if (!config.proxyTargetHost) {
      throw new Error(
        `PROXY_TARGET_HOST or PROXY_TARGETS is required for PROXY_PORTS entry ${listenPort}`
      );
    }
    addRoute(createProxyRoute(listenPort));
  }

  const routes = [...routesByPort.values()].sort((a, b) => a.listenPort - b.listenPort);
  logInfo("proxy_routes_ready", {
    count: routes.length,
    routes: routes.map((route) => ({
      listenPort: route.listenPort,
      target: `${route.targetHost}:${route.targetPort}`,
      source: route.source,
      domains: route.domains,
      guest: route.guestKind && route.guestId ? `${route.guestKind}:${route.guestId}` : ""
    }))
  });
  return routes;
}

const proxyWakeInFlightByTarget = new Map();
const proxyLastWakeSentAtByTarget = new Map();
let proxyActiveConnections = 0;
let proxyLastTrafficAt = null;
let proxyIdleSleepTimer = null;
let proxyIdleSleepInFlight = null;
let activeProxyRoutes = [];

function createProxyRoute(listenPort) {
  return {
    listenHost: config.proxyListenHost,
    listenPort,
    targetHost: config.proxyTargetHost,
    targetPort: listenPort
  };
}

function getProxyWakeCacheKey(route) {
  return `${config.wakeMac}|${route.targetHost}`;
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

async function ensureProxyWakeSignal(route) {
  const wakeKey = getProxyWakeCacheKey(route);
  const now = Date.now();
  const lastWakeSentAt = proxyLastWakeSentAtByTarget.get(wakeKey);

  if (
    lastWakeSentAt &&
    config.proxyWakeCacheMs > 0 &&
    now - lastWakeSentAt < config.proxyWakeCacheMs
  ) {
    const wakeCacheAgeMs = now - lastWakeSentAt;
    logInfo("proxy_wake_cache_hit", {
      targetHost: route.targetHost,
      targetPort: route.targetPort,
      wakeCacheAgeMs,
      wakeCacheMs: config.proxyWakeCacheMs
    });
    return {
      wakeStatus: "cached",
      wakeSent: false,
      wakeCacheAgeMs,
      wakeCacheMs: config.proxyWakeCacheMs
    };
  }

  const existingWake = proxyWakeInFlightByTarget.get(wakeKey);
  if (existingWake) {
    logInfo("proxy_wake_wait_joined", {
      targetHost: route.targetHost,
      targetPort: route.targetPort
    });
    await existingWake;
    return {
      wakeStatus: "joined",
      wakeSent: false,
      wakeCacheMs: config.proxyWakeCacheMs
    };
  }

  const wakePromise = (async () => {
    await sendWakePacket(config.wakeMac, config.wakeBroadcast, config.wakePort);
    proxyLastWakeSentAtByTarget.set(wakeKey, Date.now());
    logInfo("proxy_wake_sent", {
      mac: config.wakeMac,
      broadcast: config.wakeBroadcast,
      port: config.wakePort,
      targetHost: route.targetHost,
      targetPort: route.targetPort,
      wakeCacheMs: config.proxyWakeCacheMs
    });
  })().finally(() => {
    proxyWakeInFlightByTarget.delete(wakeKey);
  });

  proxyWakeInFlightByTarget.set(wakeKey, wakePromise);
  await wakePromise;
  return {
    wakeStatus: "sent",
    wakeSent: true,
    wakeCacheMs: config.proxyWakeCacheMs
  };
}

function buildProxyGuestStartCommand(route) {
  if (!route.guestKind || !route.guestId) {
    return "";
  }

  if (route.guestKind === "lxc") {
    return `
if pct status ${route.guestId} 2>/dev/null | grep -q 'status: running'; then
  echo "lxc_${route.guestId}_already_running"
else
  pct start ${route.guestId}
fi
`.trim();
  }

  if (route.guestKind === "vm") {
    return `
status="$(qm status ${route.guestId} 2>/dev/null || true)"
case "$status" in
  *running*) echo "vm_${route.guestId}_already_running" ;;
  *suspended*) qm resume ${route.guestId} ;;
  *) qm start ${route.guestId} ;;
esac
`.trim();
  }

  return "";
}

async function ensureProxyGuestStarted(route) {
  if (!config.proxyGuestStartEnabled || !route.guestKind || !route.guestId) {
    return {
      guestStartStatus: "not_configured"
    };
  }

  const command = buildProxyGuestStartCommand(route);
  if (!command) {
    return {
      guestStartStatus: "not_supported"
    };
  }

  const deadline = Date.now() + config.proxyGuestStartTimeoutMs;
  let attempt = 0;
  let lastError = null;

  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const result = await runCommandOverSsh(command);
      logInfo("proxy_guest_start_checked", {
        targetHost: route.targetHost,
        targetPort: route.targetPort,
        guestKind: route.guestKind,
        guestId: route.guestId,
        attempt,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim()
      });
      return {
        guestStartStatus: "checked",
        guestStartAttempt: attempt,
        guestKind: route.guestKind,
        guestId: route.guestId
      };
    } catch (err) {
      lastError = err;
      await delay(Math.min(
        config.proxyGuestStartRetryDelayMs,
        Math.max(deadline - Date.now(), 0)
      ));
    }
  }

  throw new Error(
    `Guest ${route.guestKind}:${route.guestId} could not be started or checked over SSH` +
      (lastError ? ` (${lastError.message})` : "")
  );
}

async function openProxyTargetSocket(route) {
  try {
    const socket = await connectToTcpPort(route.targetHost, route.targetPort, config.proxyConnectTimeoutMs);
    return {
      socket,
      meta: {
        targetInitiallyAvailable: true,
        wakeStatus: "not_needed",
        wakeSent: false
      }
    };
  } catch (err) {
    logInfo("proxy_target_unavailable_waking", {
      host: route.targetHost,
      port: route.targetPort,
      error: err.message
    });
    let wakeMeta = {
      wakeStatus: "failed",
      wakeSent: false
    };

    try {
      wakeMeta = await ensureProxyWakeSignal(route);
      const guestStartMeta = await ensureProxyGuestStarted(route);
      await waitForProxyTargetPort(route);
      const socket = await connectToTcpPort(route.targetHost, route.targetPort, config.proxyConnectTimeoutMs);
      return {
        socket,
        meta: {
          targetInitiallyAvailable: false,
          initialConnectError: err.message,
          ...guestStartMeta,
          ...wakeMeta
        }
      };
    } catch (wakeErr) {
      wakeErr.proxyUsageMeta = {
        targetInitiallyAvailable: false,
        initialConnectError: err.message,
        ...wakeMeta
      };
      throw wakeErr;
    }
  }
}

async function handleProxyConnection(clientSocket, route) {
  const client = `${clientSocket.remoteAddress || "unknown"}:${clientSocket.remotePort || "unknown"}`;
  let targetSocket = null;
  let clientClosed = false;
  let targetReady = false;
  let usageRecorded = false;
  let bytesClientToTarget = 0;
  let bytesTargetToClient = 0;
  let usageMeta = {
    targetInitiallyAvailable: null,
    wakeStatus: "unknown",
    wakeSent: false
  };
  const startedAt = Date.now();

  const finalizeProxyUsage = (status, extra = {}) => {
    if (usageRecorded) {
      return;
    }
    usageRecorded = true;
    addProxyUsageEntry({
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      client,
      listenPort: route.listenPort,
      targetHost: route.targetHost,
      targetPort: route.targetPort,
      source: route.source,
      domains: route.domains,
      guestKind: route.guestKind,
      guestId: route.guestId,
      status,
      targetReady,
      bytesClientToTarget,
      bytesTargetToClient,
      ...usageMeta,
      ...extra
    });
  };

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
    if (targetReady) {
      finalizeProxyUsage("closed");
    }
    scheduleProxyIdleSleepCheck();
  });

  try {
    logInfo("proxy_client_connected", {
      client,
      listenPort: route.listenPort,
      targetHost: route.targetHost,
      targetPort: route.targetPort,
      source: route.source,
      domains: route.domains,
      guestKind: route.guestKind,
      guestId: route.guestId
    });

    const targetResult = await openProxyTargetSocket(route);
    targetSocket = targetResult.socket;
    usageMeta = {
      ...usageMeta,
      ...targetResult.meta
    };

    if (clientClosed || clientSocket.destroyed) {
      targetSocket.destroy();
      logInfo("proxy_client_disconnected_before_target_ready", { client });
      finalizeProxyUsage("client_disconnected_before_target_ready");
      return;
    }

    targetReady = true;
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
      bytesClientToTarget += chunk.length;
      markProxyTraffic(chunk.length);
    });
    targetSocket.on("data", (chunk) => {
      bytesTargetToClient += chunk.length;
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
    usageMeta = {
      ...usageMeta,
      ...(err.proxyUsageMeta || {})
    };
    finalizeProxyUsage("failed", { error: err.message });
    logError("proxy_connection_failed", {
      client,
      listenPort: route.listenPort,
      targetHost: route.targetHost,
      targetPort: route.targetPort,
      source: route.source,
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
        source: route.source,
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
        targetPort: route.targetPort,
        source: route.source,
        domains: route.domains,
        guestKind: route.guestKind,
        guestId: route.guestId
      });
      resolve(proxyServer);
    };

    proxyServer.once("error", onError);
    proxyServer.once("listening", onListening);
    proxyServer.listen(route.listenPort, route.listenHost);
  });
}

async function startWakeProxy(proxyRoutes) {
  if (!config.proxyEnabled) {
    return [];
  }

  return Promise.all(proxyRoutes.map((route) => startWakeProxyListener(route)));
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

app.get("/api/proxy-usage", (req, res) => {
  res.json({ ok: true, usage: proxyUsageList });
});

app.get("/api/proxy-routes", (req, res) => {
  res.json({
    ok: true,
    routes: activeProxyRoutes.map((route) => ({
      listenHost: route.listenHost,
      listenPort: route.listenPort,
      targetHost: route.targetHost,
      targetPort: route.targetPort,
      source: route.source,
      domains: route.domains,
      guestKind: route.guestKind,
      guestId: route.guestId,
      npmProxyHostId: route.npmProxyHostId,
      npmForwardHost: route.npmForwardHost,
      npmForwardPort: route.npmForwardPort
    }))
  });
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
  await ensureStateDir();
  await loadPersistentLogs();
  await loadPersistentProxyUsage();
  const proxyRoutes = await buildProxyRoutes();
  activeProxyRoutes = proxyRoutes;
  validateConfig(proxyRoutes);
  await savePersistentConfig();
  logInfo("persistence_ready", {
    stateDir,
    configPath: persistentConfigPath,
    logsPath: persistentLogsPath,
    proxyUsagePath: persistentProxyUsagePath,
    logMaxEntries: config.logMaxEntries
  });
  await loadSchedule();
  await startWakeProxy(proxyRoutes);
  app.listen(config.port, () => {
    logInfo("server_listening", { port: config.port });
  });
} catch (err) {
  logError("server_config_error", { error: err.message });
  process.exit(1);
}
