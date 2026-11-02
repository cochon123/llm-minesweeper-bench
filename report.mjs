import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSONL = path.join(__dirname, "results", "games.jsonl");
const OUT = path.join(__dirname, "report.html");

export async function loadGames() {
  try {
    const text = await readFile(JSONL, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function group(games) {
  const map = new Map();
  for (const game of games) {
    const key = game.label || `${game.model} / ${game.effort}`;
    const bucket = map.get(key) ?? [];
    bucket.push(game);
    map.set(key, bucket);
  }
  return [...map.entries()].map(([label, rows]) => {
    const wins = rows.filter((r) => r.won).length;
    const times = rows.map((r) => (r.timeMs || 0) / 1000);
    const tokens = rows.map((r) => r.totalTokens || 0);
    const progress = rows.map((r) => (r.progress || 0) * 100);
    return {
      label,
      adapter: rows[0].adapter,
      family: rows[0].family,
      effort: rows[0].effort,
      n: rows.length,
      wins,
      winRate: rows.length ? wins / rows.length : 0,
      times,
      tokens,
      progress,
      meanTime: mean(times),
      meanTokens: mean(tokens),
      meanProgress: mean(progress),
    };
  }).sort((a, b) => b.winRate - a.winRate || b.meanProgress - a.meanProgress);
}

function fixtureAudit(games) {
  const map = new Map();
  for (const game of games) {
    if (!game.fixtureId) continue;
    const bucket = map.get(game.fixtureId) ?? {
      id: game.fixtureId,
      seed: game.seed,
      opening: game.opening,
      openedCells: game.openedCells,
      n: 0,
      fingerprints: new Set(),
    };
    bucket.n += 1;
    if (game.mineFingerprint) bucket.fingerprints.add(game.mineFingerprint);
    map.set(game.fixtureId, bucket);
  }
  return [...map.values()]
    .sort((a, b) => a.id - b.id)
    .map((bucket) => ({
      id: bucket.id,
      seed: bucket.seed,
      opening: bucket.opening,
      openedCells: bucket.openedCells,
      n: bucket.n,
      fingerprint: [...bucket.fingerprints][0] || "",
      identical: bucket.fingerprints.size <= 1,
    }));
}

function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function isQuotaError(row) {
  const text = `${row?.error || ""}`.toLowerCase();
  return text.includes("usage limit")
    || text.includes("rate limit")
    || text.includes("resource_exhausted")
    || text.includes("too many requests")
    || text.includes("spend limit");
}

export function reportHtml(games) {
  const fair = games.filter((game) => game.fixtureId && game.mineFingerprint && !isQuotaError(game) && (game.outcome === "won" || game.outcome === "lost" || game.outcome === "timeout" || game.outcome === "max-turns"));
  const groups = group(fair);
  const fixtures = fixtureAudit(fair);
  const data = { games: fair, groups, fixtures, generatedAt: new Date().toISOString() };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LLM Minesweeper — 50×50 results</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&family=Newsreader:opsz,wght@6..72,600&display=swap" rel="stylesheet" />
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    :root {
      --bg: #10140f;
      --card: #171d16;
      --ink: #e7f0e2;
      --muted: #8aa08a;
      --line: #2a3528;
      --accent: #c6f04d;
      --win: #5ddea8;
      --lose: #ff7a6b;
      --serif: "Newsreader", Georgia, serif;
      --sans: "DM Sans", system-ui, sans-serif;
      --mono: "IBM Plex Mono", ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      background:
        radial-gradient(900px 420px at 10% -10%, #1d2a18 0%, transparent 55%),
        var(--bg);
      color: var(--ink);
    }
    header {
      max-width: 1180px;
      margin: 0 auto;
      padding: 3rem 1.5rem 1.5rem;
    }
    .eyebrow { font-family: var(--mono); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); }
    h1 { font-family: var(--serif); font-size: clamp(2rem, 5vw, 3.2rem); margin: .4rem 0 0; letter-spacing: -.03em; }
    .lede { color: var(--muted); max-width: 46rem; font-size: 1.05rem; }
    main { max-width: 1180px; margin: 0 auto; padding: 0 1.5rem 4rem; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 1.5rem 0 2rem; }
    .kpi { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
    .kpi b { display: block; font-size: 1.6rem; }
    .kpi span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .plot { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 8px 8px 16px; margin: 0 0 18px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; }
    th { color: var(--muted); font-weight: 600; }
    .win { color: var(--win); }
    .lose { color: var(--lose); }
    .note { color: var(--muted); font-size: 13px; line-height: 1.55; }
    @media (max-width: 800px) { .kpis { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">cli2api · isolated sandbox · no mine map in prompts</div>
    <h1>Can local CLIs clear a 50×50 board?</h1>
    <p class="lede">Every model/effort plays the <strong>same ten 50×50 boards</strong>: identical seeds, identical mine maps, identical forced opening at (24,24). Only later moves differ. Mines stay in RAM; the CLI never sees the map.</p>
  </header>
  <main>
    <div class="kpis" id="kpis"></div>
    <div class="plot" style="overflow:auto"><table id="fixtures"></table></div>
    <div class="plot"><div id="box-progress"></div></div>
    <div class="plot"><div id="box-tokens"></div></div>
    <div class="plot"><div id="box-time"></div></div>
    <div class="plot" style="overflow:auto">
      <table id="tbl"></table>
    </div>
    <p class="note">Protocol: 10 shared fixtures, 400 mines, opening always (24,24). Each result stores a mine-map fingerprint so a config cannot silently play a different board. Anti-cheat: mines never leave process memory, never go in prompts, CLI cwd is an empty sandbox. Win is verified by the engine.</p>
  </main>
  <script>
    const DATA = ${JSON.stringify(data)};
    const groups = DATA.groups;
    const games = DATA.games;
    const fixtures = DATA.fixtures || [];
    const shared = fixtures.length && fixtures.every(f => f.identical);
    const wins = games.filter(g => g.won).length;
    const kpis = [
      ["Shared boards", fixtures.length || 10],
      ["Configs", groups.length],
      ["Identical maps", shared ? "yes" : "check"],
      ["Wins", wins],
    ];
    document.getElementById("kpis").innerHTML = kpis.map(([k,v]) =>
      \`<div class="kpi"><span>\${k}</span><b>\${v}</b></div>\`).join("");
    document.getElementById("fixtures").innerHTML = "<tr><th>Board</th><th>Seed</th><th>Opening</th><th>Cells opened</th><th>Fingerprint</th><th>Same for all AIs</th><th>Plays</th></tr>" +
      fixtures.map(f => \`<tr>
        <td>\${f.id}</td><td>\${f.seed}</td>
        <td>(\${f.opening ? f.opening.r : 24},\${f.opening ? f.opening.c : 24})</td>
        <td>\${f.openedCells ?? ""}</td>
        <td style="font-family:var(--mono)">\${f.fingerprint}</td>
        <td class="\${f.identical ? "win" : "lose"}">\${f.identical ? "yes" : "NO"}</td>
        <td>\${f.n}</td>
      </tr>\`).join("");

    const layoutBase = {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: "#cfe0c8", family: "DM Sans, sans-serif", size: 12 },
      margin: { l: 220, r: 30, t: 48, b: 40 },
      height: Math.max(360, groups.length * 28 + 90),
      xaxis: { gridcolor: "#2a3528", zeroline: false },
      yaxis: { automargin: true },
    };

    function box(id, title, field, unit) {
      const traces = groups.map(g => ({
        type: "box",
        x: g[field],
        y: Array(g[field].length).fill(g.label),
        name: g.label,
        orientation: "h",
        boxmean: true,
        marker: { color: "#c6f04d" },
        line: { color: "#9ccc3a" },
        hovertemplate: "%{x:.2f} " + unit + "<extra>" + g.label + "</extra>",
        showlegend: false,
      }));
      Plotly.newPlot(id, traces, { ...layoutBase, title: { text: title, font: { size: 16 } } }, { displayModeBar: false, responsive: true });
    }
    box("box-progress", "Progress (% of safe cells revealed)", "progress", "%");
    box("box-tokens", "Tokens used per game", "tokens", "tok");
    box("box-time", "Wall-clock seconds per game", "times", "s");

    const tbl = document.getElementById("tbl");
    tbl.innerHTML = "<tr><th>Model / effort</th><th>n</th><th>Win rate</th><th>Mean progress</th><th>Mean tokens</th><th>Mean time</th></tr>" +
      groups.map(g => \`<tr>
        <td>\${g.label}</td>
        <td>\${g.n}</td>
        <td class="\${g.winRate ? "win" : "lose"}">\${(g.winRate*100).toFixed(0)}%</td>
        <td>\${g.meanProgress.toFixed(1)}%</td>
        <td>\${Math.round(g.meanTokens).toLocaleString()}</td>
        <td>\${g.meanTime.toFixed(1)}s</td>
      </tr>\`).join("");
  </script>
</body>
</html>`;
}

export async function writeReport() {
  await mkdir(path.dirname(OUT), { recursive: true });
  const games = await loadGames();
  await writeFile(OUT, reportHtml(games));
  return OUT;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await writeReport();
  console.log(out);
}
