import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Minesweeper, defaultMineCount } from "./minesweeper.mjs";
import { discoverBenchTargets } from "./models.mjs";
import { playGame } from "./llm.mjs";
import { benchState, runBench } from "./bench.mjs";
import { loadGames, writeReport } from "./report.mjs";
import { ensureGateway } from "./gateway.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const games = new Map();

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function publicGame(game, id) {
  const over = game.status === "won" || game.status === "lost";
  return { id, ...game.toPublic({ revealMines: over }) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(path.join(__dirname, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/report.html") {
      await writeReport();
      const html = await readFile(path.join(__dirname, "report.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      const targets = await discoverBenchTargets();
      json(res, 200, { models: targets });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/results") {
      json(res, 200, { games: await loadGames(), bench: benchState });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/bench") {
      json(res, 200, benchState);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/bench") {
      if (benchState.running) {
        json(res, 409, { error: "already running", bench: benchState });
        return;
      }
      ensureGateway()
        .then(() => runBench())
        .catch((error) => { benchState.error = String(error); benchState.running = false; });
      json(res, 202, { ok: true, bench: benchState });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/games") {
      const body = await readBody(req);
      const width = clamp(body.width ?? 9, 2, 50);
      const height = clamp(body.height ?? 9, 2, 50);
      const mines = clamp(body.mines ?? defaultMineCount(width, height), 1, width * height - 9);
      const game = new Minesweeper({ width, height, mines });
      const id = randomUUID();
      games.set(id, game);
      json(res, 200, publicGame(game, id));
      return;
    }
    const gameMatch = url.pathname.match(/^\/api\/games\/([^/]+)(?:\/(reveal|flag|chord|ai))?$/);
    if (gameMatch) {
      const game = games.get(gameMatch[1]);
      if (!game) {
        json(res, 404, { error: "unknown game" });
        return;
      }
      const action = gameMatch[2];
      if (req.method === "GET" && !action) {
        json(res, 200, publicGame(game, gameMatch[1]));
        return;
      }
      if (req.method === "POST" && (action === "reveal" || action === "flag" || action === "chord")) {
        const body = await readBody(req);
        const r = Number(body.r);
        const c = Number(body.c);
        game[action](r, c);
        json(res, 200, publicGame(game, gameMatch[1]));
        return;
      }
      if (req.method === "POST" && action === "ai") {
        const body = await readBody(req);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const send = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        send("start", publicGame(game, gameMatch[1]));
        const result = await playGame({
          model: body.model,
          effort: body.effort || "default",
          game,
          onTurn: ({ turn, game: g }) => send("turn", { turn, ...g.toPublic() }),
        });
        send("done", result);
        res.end();
        return;
      }
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: String(error) });
  }
});

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 1_000_000) req.destroy(); });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AI Minesweeper http://127.0.0.1:${PORT}`);
});
