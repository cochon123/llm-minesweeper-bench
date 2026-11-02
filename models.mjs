import { spawn } from "node:child_process";

const EFFORT_RE = /-(none|minimal|low|medium|high|xhigh|extra-high|max)$/;
const SKIP_EFFORTS = new Set(["none", "minimal", "max"]);
const KEEP_EFFORTS = new Set(["low", "medium", "high", "xhigh", "default"]);

function run(command, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(error) });
    });
  });
}

export function parseCursorModel(id) {
  let rest = id.trim();
  let fast = false;
  if (rest.endsWith("-fast")) {
    fast = true;
    rest = rest.slice(0, -5);
  }
  const match = rest.match(EFFORT_RE);
  let effort = "default";
  let family = rest;
  if (match) {
    effort = match[1] === "extra-high" ? "xhigh" : match[1];
    family = rest.slice(0, -match[0].length);
  }
  return { id, family, effort, fast };
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function listCursorModels() {
  const result = await run("cursor-agent", ["--list-models"]);
  if (result.code !== 0) return [];
  const models = [];
  for (const line of result.stdout.split("\n")) {
    const id = line.split(" - ")[0]?.trim();
    if (!id || id === "Available models" || id.startsWith("Tip:")) continue;
    models.push(parseCursorModel(id));
  }
  return models.filter((m) => m.id && m.id !== "auto");
}

const FAMILY_PRIORITY = [
  "composer-2.5",
  "cursor-grok-4.6",
  "gpt-5.6-luna",
  "gpt-5.3-codex",
  "muse-spark-1.3",
  "gemini-3.8-flash",
  "claude-sonnet-5-thinking",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "claude-opus-5-thinking",
  "kimi-k3",
  "glm-5.2",
];

export function selectCursorBenchMatrix(all) {
  const usable = all.filter((m) => !m.fast && KEEP_EFFORTS.has(m.effort) && !SKIP_EFFORTS.has(m.effort));
  const byFamily = new Map();
  for (const model of usable) {
    const list = byFamily.get(model.family) ?? [];
    list.push(model);
    byFamily.set(model.family, list);
  }
  const selected = [];
  for (const [, list] of byFamily) {
    const have = new Map(list.map((m) => [m.effort, m]));
    const efforts = ["low", "medium", "high"].filter((effort) => have.has(effort));
    if (!efforts.length && have.has("default")) efforts.push("default");
    if (!efforts.length && have.has("xhigh")) efforts.push("xhigh");
    for (const effort of efforts) selected.push(have.get(effort));
  }
  const rank = (family) => {
    const i = FAMILY_PRIORITY.indexOf(family);
    return i === -1 ? 1000 : i;
  };
  selected.sort((a, b) => rank(a.family) - rank(b.family) || a.family.localeCompare(b.family) || ["low", "medium", "high", "default", "xhigh"].indexOf(a.effort) - ["low", "medium", "high", "default", "xhigh"].indexOf(b.effort));
  return uniqueBy(selected, (m) => m.id).map((m) => ({
    adapter: "cursor",
    model: `cursor/${m.id}`,
    localModel: m.id,
    family: m.family,
    effort: m.effort,
    label: `${m.family} / ${m.effort}`,
  }));
}

export async function listOpenCodeModels() {
  const result = await run("opencode", ["models"]);
  if (result.code !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function selectOpenCodeBenchMatrix(ids, { includeOllama = false } = {}) {
  const keep = ids.filter((id) => {
    if (id.startsWith("opencode/")) return true;
    if (includeOllama && id.startsWith("ollama/")) return true;
    return false;
  });
  return uniqueBy(keep, (id) => id).map((id) => {
    const local = id.startsWith("opencode/") ? id.slice("opencode/".length) : id;
    return {
      adapter: "opencode",
      model: `opencode/${local}`,
      localModel: local,
      family: id,
      effort: "default",
      label: `${id} / default`,
    };
  });
}

export function selectCodexBenchMatrix() {
  const efforts = ["low", "medium", "high"];
  return efforts.map((effort) => ({
    adapter: "codex",
    model: "codex/gpt-5.6-luna",
    localModel: "gpt-5.6-luna",
    family: "gpt-5.6-luna",
    effort,
    label: `codex gpt-5.6-luna / ${effort}`,
  }));
}

export async function discoverBenchTargets() {
  const [cursorAll, openCodeIds] = await Promise.all([
    listCursorModels(),
    listOpenCodeModels(),
  ]);
  let includeOllama = false;
  try {
    const ping = await run("ollama", ["list"], { timeoutMs: 4000 });
    includeOllama = ping.code === 0;
  } catch {
    includeOllama = false;
  }
  return [
    ...selectCursorBenchMatrix(cursorAll),
    ...selectCodexBenchMatrix(),
    ...selectOpenCodeBenchMatrix(openCodeIds, { includeOllama }),
  ];
}
