import "dotenv/config";
import express from "express";
import morgan from "morgan";
import dgram from "dgram";
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

const config = {
  port: Number.parseInt(process.env.PORT || "8080", 10),
  wakeMac: process.env.WAKE_MAC || "",
  wakeBroadcast: process.env.WAKE_BROADCAST || "255.255.255.255",
  wakePort: Number.parseInt(process.env.WAKE_PORT || "9", 10),
  sleepHost: process.env.SLEEP_HOST || "",
  sshPort: Number.parseInt(process.env.SSH_PORT || "22", 10),
  sshUser: process.env.SSH_USER || "root",
  sshPassword: process.env.SSH_PASS || "",
  sleepCommand: process.env.SLEEP_COMMAND || "/usr/sbin/ethtool -s nic0 wol g && /bin/systemctl suspend",
  shutdownCommand: process.env.SHUTDOWN_COMMAND || "/usr/sbin/ethtool -s nic0 wol g && /bin/systemctl poweroff"
};

function logInfo(message, extra = {}) {
  const payload = { level: "info", message, ...extra, ts: new Date().toISOString() };
  console.log(JSON.stringify(payload));
}

function logError(message, extra = {}) {
  const payload = { level: "error", message, ...extra, ts: new Date().toISOString() };
  console.error(JSON.stringify(payload));
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
  res.json({ ok: true, online });
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
  app.listen(config.port, () => {
    logInfo("server_listening", { port: config.port });
  });
} catch (err) {
  logError("server_config_error", { error: err.message });
  process.exit(1);
}
