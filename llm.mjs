import { randomUUID } from "node:crypto";
import { Minesweeper, PLAY_TOOL, parseActionsFromText, extractActions, systemPrompt, userPrompt } from "./minesweeper.mjs";

const DEFAULT_BASE = process.env.OPENAI_BASE_URL || "http://127.0.0.1:3927/v1";
const DEFAULT_KEY = process.env.OPENAI_API_KEY || process.env.CLI2API_TOKEN || "minesweeper-local";

export async function chat({
  model,
  messages,
  effort,
  sessionId,
  timeoutMs = 180_000,
  baseUrl = DEFAULT_BASE,
  apiKey = DEFAULT_KEY,
} = {}) {
  const body = {
    model,
    messages,
    tools: [PLAY_TOOL],
    tool_choice: "auto",
    session_id: sessionId,
    include_reasoning: false,
  };
  if (effort && effort !== "default") {
    body.reasoning = { effort };
    body.reasoning_effort = effort;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const json = await response.json();
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      const message = json?.error?.message || JSON.stringify(json).slice(0, 400);
      return { ok: false, error: message, elapsedMs, usage: json?.usage };
    }
    const choice = json.choices?.[0]?.message ?? {};
    const usage = json.usage ?? {};
    return {
      ok: true,
      content: choice.content ?? "",
      toolCalls: choice.tool_calls ?? [],
      usage,
      elapsedMs,
      sessionId: json.session_id || sessionId,
      raw: json,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(error),
      elapsedMs: Date.now() - started,
      usage: {},
    };
  } finally {
    clearTimeout(timer);
  }
}

function actionsFromCompletion(result) {
  for (const call of result.toolCalls ?? []) {
    if (call?.function?.name && call.function.name !== "play") continue;
    let args = call?.function?.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { continue; }
    }
    const extracted = extractActions(args);
    if (extracted) return extracted;
  }
  return parseActionsFromText(result.content);
}

function tokensOf(usage = {}) {
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const total = Number(usage.total_tokens) || prompt + completion;
  return { prompt, completion, total };
}

export async function playGame({
  model,
  effort = "default",
  width = 50,
  height = 50,
  mines,
  game: existing,
  maxTurns = 80,
  maxGameMs = 12 * 60_000,
  turnTimeoutMs = 180_000,
  onTurn,
} = {}) {
  const game = existing ?? new Minesweeper({ width, height, mines });
  const sessionId = randomUUID();
  const started = Date.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let llmMs = 0;
  let lastError = null;
  const messages = [
    { role: "system", content: systemPrompt(game.width, game.height, game.mineCount) },
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (Date.now() - started > maxGameMs) {
      return finish(game, {
        outcome: "timeout",
        error: "game wall-clock limit",
        turns: turn - 1,
        promptTokens,
        completionTokens,
        llmMs,
        started,
        model,
        effort,
      });
    }
    messages.push({
      role: "user",
      content: userPrompt(
        game,
        turn === 1
          ? (game.placed
            ? "The board is already opened at a shared starting cell. Continue from this identical position. Do not try to inspect files, seeds, or hidden mines."
            : "Open a starting cell now.")
          : "",
      ),
    });
    const result = await chat({
      model,
      messages,
      effort,
      sessionId,
      timeoutMs: turnTimeoutMs,
    });
    llmMs += result.elapsedMs || 0;
    const tok = tokensOf(result.usage);
    promptTokens += tok.prompt;
    completionTokens += tok.completion;
    if (!result.ok) {
      lastError = result.error;
      return finish(game, {
        outcome: "error",
        error: result.error,
        turns: turn,
        promptTokens,
        completionTokens,
        llmMs,
        started,
        model,
        effort,
      });
    }
    const actions = actionsFromCompletion(result);
    if (!actions) {
      lastError = "unparseable move";
      messages.push({
        role: "assistant",
        content: result.content || "",
        tool_calls: result.toolCalls,
      });
      messages.push({
        role: "user",
        content: "That was not a valid play JSON object. Call play with at least one reveal or flag.",
      });
      if (onTurn) onTurn({ turn, game, result, actions: null });
      continue;
    }
    const applied = game.applyActions(actions);
    if (onTurn) onTurn({ turn, game, result, actions, applied });
    messages.push({
      role: "assistant",
      content: result.content || "",
      tool_calls: result.toolCalls,
    });
    if (game.status === "won" || game.status === "lost") {
      return finish(game, {
        outcome: game.status,
        error: null,
        turns: turn,
        promptTokens,
        completionTokens,
        llmMs,
        started,
        model,
        effort,
      });
    }
    if (applied.applied === 0) {
      messages.push({
        role: "user",
        content: "No legal actions were applied. Hidden cells are '.'. Do not re-open revealed cells or flag them.",
      });
    }
    // Keep prompt bounded: drop old user boards, keep system + last few turns.
    if (messages.length > 9) {
      const sys = messages[0];
      messages.splice(0, messages.length, sys, ...messages.slice(-6));
    }
  }

  return finish(game, {
    outcome: "max-turns",
    error: lastError,
    turns: maxTurns,
    promptTokens,
    completionTokens,
    llmMs,
    started,
    model,
    effort,
  });
}

function finish(game, info) {
  const audit = game.audit();
  const pub = game.toPublic();
  return {
    model: info.model,
    effort: info.effort,
    width: game.width,
    height: game.height,
    mines: game.mineCount,
    seed: game.seed,
    mineFingerprint: game.mineFingerprint(),
    outcome: info.outcome,
    won: info.outcome === "won",
    error: info.error,
    turns: info.turns,
    timeMs: Date.now() - info.started,
    llmMs: info.llmMs,
    promptTokens: info.promptTokens,
    completionTokens: info.completionTokens,
    totalTokens: info.promptTokens + info.completionTokens,
    revealed: pub.revealed,
    safeTotal: pub.safeTotal,
    progress: pub.progress,
    hit: pub.hit,
    ...audit,
    actionCount: game.actionCount,
    invalidActions: game.invalidActions,
  };
}
