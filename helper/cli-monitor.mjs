#!/usr/bin/env node
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const DATA_DIR = path.join(HOME, ".coding-cli-monitor");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
const PORT = 31274;
const CLIS = ["claude", "codex", "opencode"];
const ATTENTION_RE = /(press enter|continue\?|approve|permission|confirm|y\/n|select|choose|do you want|waiting for|input required|requires approval|need[s]? attention)/i;
const WORKING_RE = /\b(working|thinking|analyzing|reading|editing|searching|running tool|running command|applying patch|executing|processing)\b/i;
const WORKING_IDLE_MS = 12000;
const ATTENTION_HOLD_MS = 15000;
const IDLE_ATTENTION_MS = 30000;

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function readState() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { sessions: {}, events: [] };
  }
}

function writeState(state) {
  ensureDirs();
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, STATE_FILE);
}

function notify(title, message) {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  spawn("osascript", ["-e", script], { stdio: "ignore", detached: true }).unref();
}

function addEvent(type, message, data = {}) {
  const state = readState();
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    message,
    createdAt: new Date().toISOString(),
    ...data,
  };
  state.events = [...(state.events || []), event].slice(-100);
  writeState(state);
  notify("Coding CLI Monitor", message);
  return event;
}

function updateSession(id, patch) {
  const state = readState();
  state.sessions ||= {};
  state.sessions[id] = {
    ...(state.sessions[id] || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeState(state);
}

function commandExists(command) {
  return spawnSync("zsh", ["-lc", `command -v ${command}`], { encoding: "utf8" }).status === 0;
}

function installedMap() {
  return Object.fromEntries(CLIS.map((cli) => [cli, commandExists(cli)]));
}

function basename(value) {
  return path.basename(value || "").toLowerCase();
}

function psList() {
  return new Promise((resolve) => {
    try {
      execFile("ps", ["-axo", "pid=,ppid=,comm=,args="], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve([]);
        const rows = stdout.split("\n").flatMap((line) => {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
          if (!match) return [];
          return [{ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3], args: match[4] }];
        });
        resolve(rows);
      });
    } catch {
      resolve([]);
    }
  });
}

async function detectedProcesses() {
  const rows = await psList();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return rows.flatMap((row) => {
    const cli = CLIS.find((name) => basename(row.comm) === name);
    if (!cli) return [];
    const parent = byPid.get(row.ppid);
    if (basename(parent?.comm) === "script") return [];
    if (row.args.includes("cli-monitor.mjs")) return [];
    return [{ pid: row.pid, cli, command: row.args }];
  });
}

async function statusPayload(external = null) {
  const state = readState();
  const now = Date.now();
  const sessions = Object.values(state.sessions || {})
    .filter((session) => !["finished", "failed"].includes(session.status))
    .map((session) => ({
      ...session,
      status: effectiveSessionStatus(session, now),
    }));
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    installed: installedMap(),
    sessions: sessions.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 20),
    external: external || await detectedProcesses(),
    events: state.events || [],
  };
}

function timestampMs(value) {
  const time = value ? Date.parse(value) : 0;
  return Number.isFinite(time) ? time : 0;
}

function effectiveSessionStatus(session, now = Date.now()) {
  if (session.status === "attention") return "attention";

  const lastActivityAt = Math.max(
    timestampMs(session.lastOutputAt),
    timestampMs(session.lastWorkingAt),
    timestampMs(session.updatedAt),
    timestampMs(session.startedAt),
  );

  if (lastActivityAt && now - lastActivityAt > IDLE_ATTENTION_MS) {
    return "attention";
  }

  return "working";
}

async function daemon() {
  ensureDirs();
  const known = new Map();

  async function scan() {
    const current = await detectedProcesses();
    const currentPids = new Set(current.map((proc) => proc.pid));
    for (const proc of current) {
      if (!known.has(proc.pid)) known.set(proc.pid, proc);
    }
    for (const [pid, proc] of known.entries()) {
      if (!currentPids.has(pid)) {
        known.delete(pid);
        addEvent("finished", `${proc.cli} process ${pid} finished`, { cli: proc.cli, pid });
      }
    }
    return current;
  }

  let latestExternal = await scan();
  setInterval(async () => {
    latestExternal = await scan();
  }, 2500);

  const server = http.createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    if (request.url === "/status") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(await statusPayload(latestExternal)));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Coding CLI Monitor daemon listening on http://127.0.0.1:${PORT}/status`);
  });
}

function stripControlChars(text) {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function parseRunArgs(argv) {
  const rest = [...argv];
  let name = "";

  for (let index = 0; index < rest.length;) {
    const arg = rest[index];
    if (arg === "--name" || arg === "-n") {
      name = rest[index + 1] || "";
      rest.splice(index, 2);
      continue;
    }
    if (arg?.startsWith("--name=")) {
      name = arg.slice("--name=".length);
      rest.splice(index, 1);
      continue;
    }
    index += 1;
  }

  return {
    name: name.trim(),
    command: rest[0],
    args: rest.slice(1),
  };
}

function runWrapped(argv) {
  const { name, command, args } = parseRunArgs(argv);
  if (!command) {
    console.error("Usage: cli-monitor run [--name <name>] <claude|codex|opencode> [args...]");
    process.exit(2);
  }

  ensureDirs();
  const id = `${Date.now()}-${command}-${Math.random().toString(16).slice(2)}`;
  const logPath = path.join(LOG_DIR, `${id}.log`);
  const startedAt = new Date().toISOString();
  updateSession(id, { id, name, command, args, status: "working", startedAt, logPath });

  const child = spawn("script", ["-q", logPath, command, ...args], { stdio: ["inherit", "pipe", "pipe"] });
  updateSession(id, { pid: child.pid });

  let lastAttention = 0;
  let lastWorking = 0;
  let lastOutputStateUpdate = 0;
  let currentStatus = "working";
  const workingIdleTimer = setInterval(() => {
    if (lastWorking && Date.now() - lastWorking > WORKING_IDLE_MS) {
      lastWorking = 0;
      if (currentStatus !== "attention") {
        updateSession(id, { status: "working" });
      }
    }
  }, 5000);

  function handleOutput(buffer, output) {
    output.write(buffer);
    const now = Date.now();
    if (now - lastOutputStateUpdate > 2000) {
      lastOutputStateUpdate = now;
      updateSession(id, { lastOutputAt: new Date(now).toISOString() });
    }
    const chunk = stripControlChars(buffer.toString("utf8"));
    if (ATTENTION_RE.test(chunk) && now - lastAttention > 60000) {
      lastAttention = now;
      lastWorking = 0;
      currentStatus = "attention";
      updateSession(id, { status: "attention", lastAttentionAt: new Date(now).toISOString() });
      addEvent("attention", `${name || command} may need attention`, { sessionId: id, cli: command, name });
      return;
    }
    if (WORKING_RE.test(chunk)) {
      if (currentStatus === "attention" && now - lastAttention < ATTENTION_HOLD_MS) {
        return;
      }
      currentStatus = "working";
      lastWorking = now;
      updateSession(id, { status: "working", lastWorkingAt: new Date(now).toISOString() });
    }
  }

  child.stdout.on("data", (buffer) => handleOutput(buffer, process.stdout));
  child.stderr.on("data", (buffer) => handleOutput(buffer, process.stderr));

  child.on("exit", (code, signal) => {
    clearInterval(workingIdleTimer);
    const exitCode = code ?? null;
    const status = exitCode === 0 ? "finished" : "failed";
    updateSession(id, { status, exitCode, signal, finishedAt: new Date().toISOString() });
    addEvent("finished", `${name || command} finished${exitCode === null ? "" : ` with exit code ${exitCode}`}`, { sessionId: id, cli: command, name, exitCode });
    process.exit(exitCode ?? 1);
  });
}

async function printStatus() {
  console.log(JSON.stringify(await statusPayload(), null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "daemon") daemon();
else if (cmd === "run") runWrapped(rest);
else if (cmd === "status") printStatus();
else {
  console.log(`Usage:
  cli-monitor daemon
  cli-monitor run [--name <name>] <claude|codex|opencode> [args...]
  cli-monitor status`);
  process.exit(cmd ? 2 : 0);
}
