import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBenchTargets } from "./models.mjs";
import { playGame } from "./llm.mjs";
import { ensureGateway } from "./gateway.mjs";
import { writeReport } from "./report.mjs";
import { buildAllFixtures, dealFixture, FIXTURE_SEEDS } from "./fixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "results");
const JSONL = path.join(RESULTS_DIR, "games.jsonl");
const STATUS = path.join(RESULTS_DIR, "status.json");

const MAX_TURNS = Number(process.env.MS_MAX_TURNS || 25);
const MAX_GAME_MS = Number(process.env.MS_MAX_GAME_MS || 4 * 60_000);
const MAX_AGENTS = 4;
const CONCURRENCY = Math.min(MAX_AGENTS, Math.max(1, Number(process.env.MS_CONCURRENCY || MAX_AGENTS)));

const REAL_OUTCOMES = new Set(["won", "lost", "timeout", "max-turns"]);

export function isQuotaError(row) {
  const text = `${row?.error || ""}`.toLowerCase();
  return text.includes("usage limit")
    || text.includes("rate limit")
    || text.includes("resource_exhausted")
    || text.includes("too many requests")
    || text.includes("spend limit");
}

function configId(target) {
  return `${target.model}::${target.effort}`;
}

export const benchState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  current: null,
  completed: 0,
  total: 0,
  error: null,
  targets: [],
  fixtures: [],
};

async function writeStatus() {
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(STATUS, JSON.stringify(benchState, null, 2));
}

function resultKey(row) {
  return `${row.model}::${row.effort}::${row.fixtureId}`;
}

async function loadCompletedKeys() {
  const keys = new Set();
  const quotaConfigs = new Set();
  try {
    const text = await readFile(JSONL, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (!row.fixtureId || !row.model) continue;
      if (isQuotaError(row)) {
        quotaConfigs.add(`${row.model}::${row.effort}`);
        continue;
      }
      if (!REAL_OUTCOMES.has(row.outcome)) continue;
      if (!row.mineFingerprint) continue;
      keys.add(resultKey(row));
    }
  } catch {
    // first run
  }
  return { keys, quotaConfigs };
}

export async function runBench({ limit } = {}) {
  if (benchState.running) throw new Error("bench already running");
  benchState.running = true;
  benchState.startedAt = Date.now();
  benchState.finishedAt = null;
  benchState.error = null;
  benchState.completed = 0;
  await writeStatus();
  try {
    await ensureGateway();
    const fixtures = buildAllFixtures();
    benchState.fixtures = fixtures.map((f) => ({
      id: f.id,
      seed: f.seed,
      opening: f.opening,
      fingerprint: f.fingerprint,
      openedCells: f.openedCells,
    }));
    let targets = await discoverBenchTargets();
    if (limit) targets = targets.slice(0, limit);
    benchState.targets = targets.map((t) => t.label);
    const done = await loadCompletedKeys();
    const jobs = [];
    for (const target of targets) {
      const id = configId(target);
      if (done.quotaConfigs.has(id)) {
        console.error(`[bench] skip ${target.label}: already hit a usage/rate limit`);
        continue;
      }
      for (const fixture of fixtures) {
        const key = `${target.model}::${target.effort}::${fixture.id}`;
        if (!done.keys.has(key)) jobs.push({ target, fixture });
      }
    }
    benchState.total = jobs.length;
    benchState.current = { agents: 0, cap: CONCURRENCY };
    await writeStatus();
    await mkdir(RESULTS_DIR, { recursive: true });
    console.error(`[bench] resuming ${jobs.length} games with ${CONCURRENCY} agents max`);

    const skipped = new Set(done.quotaConfigs);
    const errorCounts = new Map();
    let inFlight = 0;
    let writeChain = Promise.resolve();
    const persist = async (row) => {
      writeChain = writeChain.then(async () => {
        await appendFile(JSONL, JSON.stringify(row) + "\n");
        benchState.completed += 1;
        benchState.current = {
          label: row.label,
          fixtureId: row.fixtureId,
          outcome: row.outcome,
          agents: inFlight,
          cap: CONCURRENCY,
        };
        await writeStatus();
        await writeReport();
      });
      await writeChain;
    };

    const runJob = async (job) => {
      const id = configId(job.target);
      if (skipped.has(id)) return;
      const dealt = dealFixture(job.fixture);
      inFlight += 1;
      benchState.current = { label: job.target.label, fixtureId: dealt.id, agents: inFlight, cap: CONCURRENCY };
      await writeStatus();
      let result;
      try {
        result = await playGame({
          model: job.target.model,
          effort: job.target.effort,
          game: dealt.game,
          maxTurns: MAX_TURNS,
          maxGameMs: MAX_GAME_MS,
        });
      } finally {
        inFlight -= 1;
      }
      if (result.mineFingerprint !== dealt.fingerprint) {
        result.outcome = "error";
        result.error = `fixture mismatch: got ${result.mineFingerprint} expected ${dealt.fingerprint}`;
        result.won = false;
      }
      const row = {
        ...result,
        adapter: job.target.adapter,
        family: job.target.family,
        label: job.target.label,
        fixtureId: dealt.id,
        opening: dealt.opening,
        openedCells: dealt.openedCells,
        gameIndex: dealt.id,
        recordedAt: new Date().toISOString(),
      };
      console.error(`[bench] ${job.target.label} fixture ${dealt.id} → ${row.outcome} progress=${((row.progress || 0) * 100).toFixed(1)}% tokens=${row.totalTokens} ${((row.timeMs || 0) / 1000).toFixed(1)}s agents=${inFlight}/${CONCURRENCY}`);
      if (isQuotaError(row)) {
        skipped.add(id);
        console.error(`[bench] usage/rate limit on ${job.target.label}; pausing that model so we do not burn the rest of the queue`);
        await persist(row);
        return;
      }
      await persist(row);
      if (row.outcome === "error") {
        const n = (errorCounts.get(id) || 0) + 1;
        errorCounts.set(id, n);
        if (n >= 2) skipped.add(id);
      } else {
        errorCounts.set(id, 0);
      }
    };

    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, jobs.length)) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= jobs.length) return;
        await runJob(jobs[index]);
      }
    });
    await Promise.all(workers);
    benchState.current = null;
    benchState.finishedAt = Date.now();
    await writeReport();
  } catch (error) {
    benchState.error = String(error);
    throw error;
  } finally {
    benchState.running = false;
    await writeStatus();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const limit = process.argv.includes("--smoke") ? 1 : undefined;
  await runBench({ limit });
  console.log("bench complete", STATUS, "fixtures", FIXTURE_SEEDS.length);
}
