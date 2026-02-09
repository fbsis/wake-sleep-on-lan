import "dotenv/config";
import express from "express";
import morgan from "morgan";
import dgram from "dgram";
import { Client as SshClient } from "ssh2";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(morgan("combined"));

const config = {
  port: Number.parseInt(process.env.PORT || "8080", 10),
  wakeMac: process.env.WAKE_MAC || "",
  wakeBroadcast: process.env.WAKE_BROADCAST || "255.255.255.255",
  wakePort: Number.parseInt(process.env.WAKE_PORT || "9", 10),
  sleepHost: process.env.SLEEP_HOST || "",
  sshPort: Number.parseInt(process.env.SSH_PORT || "22", 10),
  sshUser: process.env.SSH_USER || "root",
  sshPassword: process.env.SSH_PASS || "",
  sleepCommand: process.env.SLEEP_COMMAND || "/usr/sbin/ethtool -s nic0 wol g && /bin/systemctl suspend"
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

function runSleepCommandOverSsh() {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let stderr = "";
    let stdout = "";

    conn
      .on("ready", () => {
        conn.exec(config.sleepCommand, (err, stream) => {
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

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/status", async (_req, res) => {
  const online = await pingHost(config.sleepHost);
  res.json({ ok: true, online });
});

app.post("/api/wake", async (_req, res) => {
  try {
    await sendWakePacket(config.wakeMac, config.wakeBroadcast, config.wakePort);
    logInfo("wake_sent", { mac: config.wakeMac, broadcast: config.wakeBroadcast, port: config.wakePort });
    res.json({ ok: true });
  } catch (err) {
    logError("wake_failed", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/sleep", async (_req, res) => {
  try {
    const result = await runSleepCommandOverSsh();
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

try {
  validateConfig();
  app.listen(config.port, () => {
    logInfo("server_listening", { port: config.port });
  });
} catch (err) {
  logError("server_config_error", { error: err.message });
  process.exit(1);
}
