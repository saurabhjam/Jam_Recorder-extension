/**
 * Choosing an image quality that meets a byte budget.
 *
 * Kept separate from the capture code, and free of any canvas or chrome.*
 * dependency, so the search itself can be tested: the failure modes here are
 * an off-by-one in the bisection and the "nothing fits" path, neither of which
 * is observable by looking at a screenshot.
 *
 * The quality is searched per frame rather than configured once because the
 * right quality is a property of the picture. An idle desktop and a full IDE
 * differ several-fold at identical settings, so a fixed number tuned to
 * average 25 KB still emits 80 KB frames on the busy screens — which are
 * exactly the ones worth capturing.
 */

export interface Encoded {
  readonly size: number;
}

export interface BudgetOptions {
  /** Largest acceptable result, in bytes. */
  targetBytes: number;
  /** Never encode below this — a floor on legibility. */
  minQuality: number;
  /** Never encode above this; higher rarely helps a screenshot. */
  maxQuality: number;
  /** Encode passes. Each one is a real encode, so this is the CPU budget too. */
  passes: number;
}

/**
 * Highest-quality encode that fits the budget.
 *
 * Probes the quality floor first to learn whether anything can fit, then
 * bisects upward keeping the largest result that fits — largest, because among
 * frames under the budget the biggest is the best-looking one.
 *
 * When even the floor overshoots, that floor frame is returned rather than
 * failing: it is both the smallest achievable and the caller's signal to
 * re-render at fewer pixels. An oversized screenshot is worth far more than a
 * missing one, and the server's own size limit sits orders of magnitude above
 * any sane budget.
 */
export async function encodeWithinBudget<T extends Encoded>(
  encode: (quality: number) => Promise<T>,
  options: BudgetOptions,
): Promise<T> {
  const { targetBytes, minQuality, maxQuality, passes } = options;

  if (!(targetBytes > 0)) throw new Error('targetBytes must be positive');
  if (!(minQuality > 0) || minQuality > maxQuality || maxQuality > 1) {
    throw new Error('quality bounds must satisfy 0 < min <= max <= 1');
  }
  if (!Number.isInteger(passes) || passes < 1) {
    throw new Error('passes must be a positive integer');
  }

  let smallest: T | null = null;
  const record = (candidate: T): T => {
    if (!smallest || candidate.size < smallest.size) smallest = candidate;
    return candidate;
  };

  // The floor is probed FIRST, to answer "can this fit at all".
  //
  // Bisecting alone does not answer it: the search converges *towards* the
  // floor without ever evaluating it, so an image that fits only at the floor
  // was reported as unfittable and the caller shrank it for no reason. One
  // probe also makes the hopeless case cheap — a dense screen moves to fewer
  // pixels after a single encode instead of four.
  const floor = record(await encode(minQuality));
  if (floor.size > targetBytes) return floor;

  // The floor fits, so the best-looking frame that fits is above it. Bisect
  // upward, keeping the largest that still fits.
  let fitting: T = floor;
  let low = minQuality;
  let high = maxQuality;

  for (let pass = 0; pass < passes; pass += 1) {
    const quality = (low + high) / 2;
    // eslint-disable-next-line no-await-in-loop
    const candidate = record(await encode(quality));

    if (candidate.size <= targetBytes) {
      if (candidate.size > fitting.size) fitting = candidate;
      low = quality;
    } else {
      high = quality;
    }
  }

  return fitting;
}
