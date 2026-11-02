import { Minesweeper, defaultMineCount } from "./minesweeper.mjs";

/** Canonical 50×50 match set. Every model/effort plays these exact boards. */
export const BENCH_WIDTH = 50;
export const BENCH_HEIGHT = 50;
export const BENCH_MINES = defaultMineCount(BENCH_WIDTH, BENCH_HEIGHT);
export const OPENING = Object.freeze({ r: 24, c: 24 });

/**
 * Published seeds. Chosen so the shared opening (24,24) produces a spread of
 * flood sizes instead of ten nearly-identical starts.
 */
export const FIXTURE_SEEDS = Object.freeze([
  1940,  // tight opening (~15)
  8780,
  4345,
  9391,
  1191,  // medium
  2041,
  8910,
  2235,
  11069,
  9889,  // wide opening (~311)
]);

export function buildFixture(index, { width = BENCH_WIDTH, height = BENCH_HEIGHT, mines = BENCH_MINES, opening = OPENING } = {}) {
  if (index < 1 || index > FIXTURE_SEEDS.length) {
    throw new Error(`fixture index ${index} is out of range 1..${FIXTURE_SEEDS.length}`);
  }
  const seed = FIXTURE_SEEDS[index - 1];
  const game = new Minesweeper({ width, height, mines, seed });
  const opened = game.reveal(opening.r, opening.c);
  if (!opened.ok || opened.mine || game.status === "lost") {
    throw new Error(`fixture ${index} seed=${seed} died on the shared opening`);
  }
  return {
    id: index,
    seed,
    opening: { ...opening },
    fingerprint: game.mineFingerprint(),
    openedCells: game.revealCount,
    game,
  };
}

export function buildAllFixtures(opts) {
  return FIXTURE_SEEDS.map((_, i) => buildFixture(i + 1, opts));
}

export function dealFixture(fixture) {
  const game = fixture.game.clone();
  return {
    id: fixture.id,
    seed: fixture.seed,
    opening: fixture.opening,
    fingerprint: fixture.fingerprint,
    openedCells: fixture.openedCells,
    game,
  };
}
