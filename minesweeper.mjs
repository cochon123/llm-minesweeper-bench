/** In-memory Minesweeper. The mine map never goes to disk or to the LLM. */

const DIRS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function defaultMineCount(width, height) {
  const cells = width * height;
  if (width === 9 && height === 9) return 10;
  if (width === 16 && height === 16) return 40;
  if ((width === 30 && height === 16) || (width === 16 && height === 30)) return 99;
  return Math.max(1, Math.round(cells * 0.16));
}

export class Minesweeper {
  constructor({ width = 9, height = 9, mines, seed } = {}) {
    this.width = width;
    this.height = height;
    this.mineCount = mines ?? defaultMineCount(width, height);
    this.seed = (seed ?? (Math.random() * 2 ** 32)) >>> 0;
    this.rng = mulberry32(this.seed);
    const n = width * height;
    this._mines = new Uint8Array(n);
    this.revealed = new Uint8Array(n);
    this.flagged = new Uint8Array(n);
    this.placed = false;
    this.status = "ready";
    this.hit = null;
    this.startedAt = null;
    this.endedAt = null;
    this.actionCount = 0;
    this.revealCount = 0;
    this.flagActions = 0;
    this.invalidActions = 0;
    this.lastEvents = [];
  }

  clone() {
    const copy = new Minesweeper({
      width: this.width,
      height: this.height,
      mines: this.mineCount,
      seed: this.seed,
    });
    copy._mines = this._mines.slice();
    copy.revealed = this.revealed.slice();
    copy.flagged = this.flagged.slice();
    copy.placed = this.placed;
    copy.status = this.status === "won" || this.status === "lost" ? this.status : (this.placed ? "playing" : "ready");
    copy.hit = this.hit ? [...this.hit] : null;
    copy.revealCount = this.revealCount;
    copy.actionCount = 0;
    copy.flagActions = 0;
    copy.invalidActions = 0;
    copy.startedAt = null;
    copy.endedAt = null;
    copy.lastEvents = [];
    return copy;
  }

  mineFingerprint() {
    let hash = 2166136261;
    for (const bit of this._mines) {
      hash ^= bit;
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  idx(r, c) {
    return r * this.width + c;
  }

  inBounds(r, c) {
    return Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0 && r < this.height && c < this.width;
  }

  neighbors(r, c) {
    const out = [];
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (this.inBounds(nr, nc)) out.push([nr, nc]);
    }
    return out;
  }

  placeMines(safeR, safeC) {
    const forbidden = new Set([this.idx(safeR, safeC)]);
    for (const [nr, nc] of this.neighbors(safeR, safeC)) forbidden.add(this.idx(nr, nc));
    const pool = [];
    for (let i = 0; i < this.width * this.height; i++) {
      if (!forbidden.has(i)) pool.push(i);
    }
    const n = Math.min(this.mineCount, pool.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(this.rng() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      this._mines[pool[i]] = 1;
    }
    this.mineCount = n;
    this.placed = true;
  }

  adjacentMines(r, c) {
    let n = 0;
    for (const [nr, nc] of this.neighbors(r, c)) n += this._mines[this.idx(nr, nc)];
    return n;
  }

  flood(r, c) {
    const stack = [[r, c]];
    while (stack.length) {
      const [cr, cc] = stack.pop();
      const i = this.idx(cr, cc);
      if (this.revealed[i] || this.flagged[i] || this._mines[i]) continue;
      this.revealed[i] = 1;
      this.revealCount += 1;
      if (this.adjacentMines(cr, cc) !== 0) continue;
      for (const [nr, nc] of this.neighbors(cr, cc)) {
        const ni = this.idx(nr, nc);
        if (!this.revealed[ni] && !this.flagged[ni] && !this._mines[ni]) stack.push([nr, nc]);
      }
    }
  }

  checkWin() {
    const safe = this.width * this.height - this.mineCount;
    if (this.revealCount >= safe) {
      this.status = "won";
      this.endedAt = Date.now();
      for (let i = 0; i < this._mines.length; i++) {
        if (this._mines[i]) this.flagged[i] = 1;
      }
    }
  }

  begin() {
    if (!this.startedAt) this.startedAt = Date.now();
    if (this.status === "ready") this.status = "playing";
  }

  finishLoss(r, c) {
    this.hit = [r, c];
    this.status = "lost";
    this.endedAt = Date.now();
    this.revealed[this.idx(r, c)] = 1;
  }

  reveal(r, c) {
    if (this.status === "won" || this.status === "lost") return { ok: false, reason: "game-over" };
    if (!this.inBounds(r, c)) return { ok: false, reason: "oob" };
    this.begin();
    if (!this.placed) this.placeMines(r, c);
    const i = this.idx(r, c);
    if (this.flagged[i]) return { ok: false, reason: "flagged" };
    if (this.revealed[i]) return { ok: false, reason: "already" };
    this.actionCount += 1;
    if (this._mines[i]) {
      this.finishLoss(r, c);
      return { ok: true, mine: true };
    }
    this.flood(r, c);
    this.checkWin();
    return { ok: true, mine: false };
  }

  flag(r, c) {
    if (this.status === "won" || this.status === "lost") return { ok: false, reason: "game-over" };
    if (!this.inBounds(r, c)) return { ok: false, reason: "oob" };
    const i = this.idx(r, c);
    if (this.revealed[i] || this.flagged[i]) return { ok: false, reason: "blocked" };
    this.flagged[i] = 1;
    this.flagActions += 1;
    this.actionCount += 1;
    return { ok: true };
  }

  unflag(r, c) {
    if (this.status === "won" || this.status === "lost") return { ok: false, reason: "game-over" };
    if (!this.inBounds(r, c)) return { ok: false, reason: "oob" };
    const i = this.idx(r, c);
    if (!this.flagged[i]) return { ok: false, reason: "not-flagged" };
    this.flagged[i] = 0;
    this.actionCount += 1;
    return { ok: true };
  }

  chord(r, c) {
    if (this.status === "won" || this.status === "lost") return { ok: false, reason: "game-over" };
    if (!this.inBounds(r, c)) return { ok: false, reason: "oob" };
    const i = this.idx(r, c);
    if (!this.revealed[i]) return { ok: false, reason: "hidden" };
    const n = this.adjacentMines(r, c);
    if (n === 0) return { ok: false, reason: "empty" };
    let flags = 0;
    const hidden = [];
    for (const [nr, nc] of this.neighbors(r, c)) {
      const ni = this.idx(nr, nc);
      if (this.flagged[ni]) flags += 1;
      else if (!this.revealed[ni]) hidden.push([nr, nc]);
    }
    if (flags !== n) return { ok: false, reason: "flags-mismatch" };
    this.actionCount += 1;
    for (const [nr, nc] of hidden) {
      const result = this.reveal(nr, nc);
      if (result.mine) return result;
    }
    return { ok: true, mine: false };
  }

  applyActions(actions, { maxActions = 250 } = {}) {
    if (this.status === "won" || this.status === "lost") {
      return { applied: 0, events: [], status: this.status };
    }
    const events = [];
    let applied = 0;
    const run = (kind, cells) => {
      if (!Array.isArray(cells)) return;
      for (const cell of cells) {
        if (applied >= maxActions) return;
        if (this.status === "won" || this.status === "lost") return;
        if (!Array.isArray(cell) || cell.length < 2) {
          this.invalidActions += 1;
          events.push({ kind, ok: false, reason: "bad-coord" });
          continue;
        }
        const r = Number(cell[0]);
        const c = Number(cell[1]);
        let result;
        if (kind === "unflag") result = this.unflag(r, c);
        else if (kind === "flag") result = this.flag(r, c);
        else if (kind === "reveal") result = this.reveal(r, c);
        else if (kind === "chord") result = this.chord(r, c);
        else continue;
        if (!result.ok) this.invalidActions += 1;
        else applied += 1;
        events.push({ kind, r, c, ...result });
      }
    };
    run("unflag", actions.unflag);
    run("flag", actions.flag);
    run("reveal", actions.reveal);
    run("chord", actions.chord);
    this.lastEvents = events.slice(-40);
    return { applied, events, status: this.status };
  }

  minesLeft() {
    let flags = 0;
    for (const f of this.flagged) flags += f;
    return this.mineCount - flags;
  }

  safeTotal() {
    return this.width * this.height - this.mineCount;
  }

  /** Visible board only. Mines are never included while the game is running. */
  renderGrid() {
    const rows = [];
    for (let r = 0; r < this.height; r++) {
      let line = "";
      for (let c = 0; c < this.width; c++) {
        const i = this.idx(r, c);
        if (this.flagged[i] && !this.revealed[i]) line += "F";
        else if (!this.revealed[i]) line += ".";
        else if (this._mines[i]) line += "*";
        else {
          const n = this.adjacentMines(r, c);
          line += n === 0 ? "0" : String(n);
        }
      }
      rows.push(line);
    }
    return rows;
  }

  constraints(limit = 180) {
    const items = [];
    for (let r = 0; r < this.height && items.length < limit; r++) {
      for (let c = 0; c < this.width && items.length < limit; c++) {
        const i = this.idx(r, c);
        if (!this.revealed[i] || this._mines[i]) continue;
        const n = this.adjacentMines(r, c);
        if (n === 0) continue;
        const hidden = [];
        let flags = 0;
        for (const [nr, nc] of this.neighbors(r, c)) {
          const ni = this.idx(nr, nc);
          if (this.flagged[ni] && !this.revealed[ni]) flags += 1;
          else if (!this.revealed[ni]) hidden.push([nr, nc]);
        }
        if (hidden.length === 0) continue;
        items.push({ r, c, n, flags, hidden });
      }
    }
    return items;
  }

  mineListIfOver() {
    if (this.status !== "won" && this.status !== "lost") return null;
    const mines = [];
    for (let i = 0; i < this._mines.length; i++) {
      if (this._mines[i]) mines.push([Math.floor(i / this.width), i % this.width]);
    }
    return mines;
  }

  toPublic({ revealMines = false } = {}) {
    return {
      width: this.width,
      height: this.height,
      mines: this.mineCount,
      minesLeft: this.minesLeft(),
      status: this.status,
      board: this.renderGrid(),
      revealed: this.revealCount,
      safeTotal: this.safeTotal(),
      progress: this.safeTotal() === 0 ? 0 : this.revealCount / this.safeTotal(),
      hit: this.status === "lost" ? this.hit : null,
      actionCount: this.actionCount,
      mineMap: revealMines ? this.mineListIfOver() : null,
    };
  }

  /** Scoring only — never sent to the model. */
  audit() {
    let correctFlags = 0;
    let wrongFlags = 0;
    let missedMines = 0;
    for (let i = 0; i < this._mines.length; i++) {
      if (this.flagged[i] && this._mines[i]) correctFlags += 1;
      else if (this.flagged[i] && !this._mines[i]) wrongFlags += 1;
      else if (!this.flagged[i] && this._mines[i]) missedMines += 1;
    }
    return {
      correctFlags,
      wrongFlags,
      missedMines,
      flagPrecision: correctFlags + wrongFlags === 0 ? 0 : correctFlags / (correctFlags + wrongFlags),
    };
  }
}

export const PLAY_TOOL = {
  type: "function",
  function: {
    name: "play",
    description:
      "Submit Minesweeper actions for this turn. Coordinates are [row, col], 0-indexed. You may batch many cells. Flag only cells that must be mines; reveal only cells that must be safe.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        reveal: {
          type: "array",
          description: "Safe cells to open.",
          items: {
            type: "array",
            items: { type: "integer" },
            minItems: 2,
            maxItems: 2,
          },
        },
        flag: {
          type: "array",
          description: "Cells that are definitely mines.",
          items: {
            type: "array",
            items: { type: "integer" },
            minItems: 2,
            maxItems: 2,
          },
        },
        unflag: {
          type: "array",
          items: {
            type: "array",
            items: { type: "integer" },
            minItems: 2,
            maxItems: 2,
          },
        },
        chord: {
          type: "array",
          description: "Chord a revealed number whose adjacent flags already equal that number.",
          items: {
            type: "array",
            items: { type: "integer" },
            minItems: 2,
            maxItems: 2,
          },
        },
      },
    },
  },
};

export function extractActions(payload) {
  if (!payload || typeof payload !== "object") return null;
  const src = payload.arguments && typeof payload.arguments === "object"
    ? payload.arguments
    : payload;
  const pick = (key) => (Array.isArray(src[key]) ? src[key] : []);
  const actions = {
    reveal: pick("reveal"),
    flag: pick("flag"),
    unflag: pick("unflag"),
    chord: pick("chord"),
  };
  const total = actions.reveal.length + actions.flag.length + actions.unflag.length + actions.chord.length;
  return total ? actions : null;
}

export function parseActionsFromText(text) {
  if (!text) return null;
  const trimmed = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [trimmed];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const actions = extractActions(parsed);
      if (actions) return actions;
      if (Array.isArray(parsed.tool_calls) && parsed.tool_calls[0]) {
        const call = parsed.tool_calls[0];
        const nested = call.function || call;
        let args = nested.arguments ?? call.arguments;
        if (typeof args === "string") args = JSON.parse(args);
        const fromCall = extractActions(args);
        if (fromCall) return fromCall;
      }
    } catch {
      // try next
    }
  }
  return null;
}

export function systemPrompt(width, height, mines) {
  return [
    "You are an expert Minesweeper player.",
    `Board: ${height} rows × ${width} cols, ${mines} mines.`,
    "Coordinates are [row, col], 0-indexed, row 0 is the top.",
    "Legend: '.' hidden, 'F' flagged, '0' empty revealed, '1'-'8' adjacent-mine counts.",
    "You never see mines. Opening a mine loses. A number N means exactly N mines in the 8 neighbors.",
    "First click is guaranteed safe, including its neighbors.",
    "Play perfectly when a deduction exists. Flag only certain mines. Reveal only certain safe cells.",
    "If several cells are jointly constrained, use that. Chord a number only when flags around it equal N.",
    "If you must guess, pick one lowest-risk frontier cell — never spray-reveal the board.",
    "Each turn, call the play function (or output only that JSON object).",
    "Do not explain. Do not mention files, seeds, or hidden state. You cannot inspect the host machine.",
  ].join(" ");
}

export function userPrompt(game, extra = "") {
  const pub = game.toPublic();
  const constraints = game.constraints();
  const compact = constraints.map((item) => {
    const cells = item.hidden.map(([r, c]) => `${r},${c}`).join(" ");
    return `${item.r},${item.c} n=${item.n} flags=${item.flags} hidden=${item.hidden.length} [${cells}]`;
  });
  return [
    `status=${pub.status} mines_left=${pub.minesLeft} revealed=${pub.revealed}/${pub.safeTotal} progress=${(pub.progress * 100).toFixed(1)}%`,
    "BOARD:",
    pub.board.join("\n"),
    "FRONTIER (revealed numbers with hidden neighbors):",
    compact.length ? compact.join("\n") : "(none yet — open a cell to start)",
    extra,
  ].filter(Boolean).join("\n");
}
