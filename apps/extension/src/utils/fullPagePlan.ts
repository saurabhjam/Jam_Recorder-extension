/**
 * Full-page screenshots — the geometry, with no DOM and no canvas.
 *
 * A full-page capture is a sequence of viewport photographs taken while the page
 * is scrolled underneath, stitched into one image. The page is first laid out at
 * full size (see "Opening the page out" below); the panel-scrolling helpers that
 * follow serve the fallback for a page that cannot be. Everything that can go
 * wrong with either is arithmetic:
 *
 *  - the page did not actually scroll, so every photograph is the same one and
 *    the result repeats the same screen down the image;
 *  - a tile is drawn at the wrong offset, so content overlaps or a seam appears;
 *  - the part of the window that does NOT scroll (a sidebar) is assumed static
 *    and painted down the whole image, when in fact it was scrolling too;
 *  - a tile is missing and the canvas keeps its empty remainder.
 *
 * So the rules live here, as pure functions over measurements, and the parts
 * that touch Chrome do as they are told. The invariants the tests hold to:
 * every row of content appears exactly once, in order, and the canvas is never
 * taller than what was actually photographed.
 */

export interface TileGeometry {
  /** Full window, CSS px — the canvas spans this so sidebars are kept. */
  viewportWidth: number;
  viewportHeight: number;
  /** The scrolling element's box on screen, CSS px. */
  clipX: number;
  clipY: number;
  clipWidth: number;
  clipHeight: number;
  /** How tall the scrolling element's content is, CSS px. */
  contentHeight: number;
  /** Physical pixels per CSS pixel, measured from a real captured frame. */
  dprX: number;
  dprY: number;
}

export interface CapturedTile {
  /** Where the scroller really was when this was taken (not where it was asked to be). */
  actualScrollY: number;
  /** Something that differs when the picture differs — a data URL, or a hash of one. */
  key?: string;
}

export interface Strip {
  tile: number;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  destX: number;
  destY: number;
  /** Drawn at this size instead of the source's, for a stretched fill. */
  destW?: number;
  destH?: number;
}

/** Scroll offsets covering the content, each a viewport apart, ending at the bottom. */
export function planScrollPositions(contentHeight: number, clipHeight: number): number[] {
  if (!(clipHeight > 0)) {
    return [0];
  }
  const maxScrollY = Math.max(0, Math.round(contentHeight - clipHeight));
  const positions: number[] = [];
  for (let y = 0; y < maxScrollY; y += clipHeight) {
    positions.push(Math.round(y));
  }
  if (positions.length === 0 || positions[positions.length - 1] !== maxScrollY) {
    positions.push(maxScrollY);
  }
  return positions;
}

/**
 * Is this tile worth keeping, or has the capture stopped making progress?
 *
 * The page may refuse to scroll — an inner container that was mistaken for the
 * page scroller, a layout that pins itself, a scroll handler that snaps back.
 * Every photograph after that is the same screen, and stitching them is what
 * produces an image repeating one viewport over and over. Two signals catch it:
 * the scroll position did not move, or the picture is byte-for-byte the one
 * before it.
 */
export function tileVerdict(
  previous: CapturedTile | null,
  next: CapturedTile,
  options: { expectedAdvance: number; toleranceCssPx?: number } = { expectedAdvance: 0 },
): 'keep' | 'stop' {
  if (!previous) {
    return 'keep';
  }
  const tolerance = options.toleranceCssPx ?? 2;
  const moved = next.actualScrollY - previous.actualScrollY;
  if (moved <= tolerance) {
    return 'stop';
  }
  if (next.key !== undefined && next.key === previous.key) {
    return 'stop';
  }
  return 'keep';
}

/**
 * Where each photograph's new content belongs on the final canvas.
 *
 * The first tile is drawn whole: it carries everything outside the scrolling
 * column — the header, the sidebar — as well as the first screen of content.
 * Every tile after it contributes only the rows that are new, and only within
 * the scrolling column, so nothing is drawn twice.
 */
export function planStrips(
  tiles: CapturedTile[],
  geometry: TileGeometry,
  options: { marginsStatic: boolean },
): { strips: Strip[]; canvasWidth: number; canvasHeight: number; coveredCssHeight: number } {
  const { clipX, clipY, clipWidth, clipHeight, viewportWidth, viewportHeight, dprX, dprY } =
    geometry;
  const canvasWidth = Math.round(viewportWidth * dprX);
  const colSrcX = Math.round(clipX * dprX);
  const colW = Math.round(clipWidth * dprX);
  const strips: Strip[] = [];

  if (tiles.length === 0) {
    return { strips, canvasWidth, canvasHeight: 0, coveredCssHeight: 0 };
  }

  // Tile 0, whole.
  strips.push({
    tile: 0,
    srcX: 0,
    srcY: 0,
    srcW: canvasWidth,
    srcH: Math.round(viewportHeight * dprY),
    destX: 0,
    destY: 0,
  });
  let coveredCssHeight = clipHeight;

  for (let i = 1; i < tiles.length; i++) {
    const tile = tiles[i];
    const newStart = Math.max(coveredCssHeight, tile.actualScrollY);
    const newEnd = Math.min(tile.actualScrollY + clipHeight, geometry.contentHeight);
    if (newEnd <= newStart) {
      continue;
    }

    strips.push({
      tile: i,
      srcX: colSrcX,
      srcY: Math.round((clipY + (newStart - tile.actualScrollY)) * dprY),
      srcW: colW,
      srcH: Math.round((newEnd - newStart) * dprY),
      destX: colSrcX,
      destY: Math.round((clipY + newStart) * dprY),
    });
    coveredCssHeight = newEnd;
  }

  const canvasHeight = Math.round((clipY + coveredCssHeight) * dprY);

  // Everything to the left and right of the scrolling column was only ever
  // drawn from tile 0, so below one viewport it would be bare canvas. Filling
  // it with tile 0's own columns is right ONLY when that furniture really is
  // static — a sidebar that stays put. When it is not, repeating it would
  // manufacture content that never existed, which is exactly how a capture ends
  // up showing the same page four times over.
  const frameHeight = Math.round(viewportHeight * dprY);
  if (options.marginsStatic && canvasHeight > frameHeight) {
    const rightX = colSrcX + colW;
    const rightW = canvasWidth - rightX;
    const remaining = canvasHeight - frameHeight;
    // The sidebar's LAST row, stretched down the rest of the page — not the
    // sidebar itself repeated.
    //
    // A fixed sidebar is one viewport tall and belongs at the top of the image,
    // exactly once; stamping the whole column out every screen reproduces its
    // icons again and again down the capture, which is plainly not what the
    // page looks like. Its bottom row is the background it fades into, so
    // continuing that gives an unbroken strip beside the content.
    const fill = (srcX: number, width: number) => {
      if (width <= 0) {
        return;
      }
      strips.push({
        tile: 0,
        srcX,
        srcY: frameHeight - 1,
        srcW: width,
        srcH: 1,
        destX: srcX,
        destY: frameHeight,
        destW: width,
        destH: remaining,
      });
    };
    fill(0, colSrcX);
    fill(rightX, rightW);
  }

  return { strips, canvasWidth, canvasHeight, coveredCssHeight };
}

/**
 * Do two frames show the same thing outside the scrolling column?
 *
 * Answered from sampled pixels rather than assumed. `sample` returns the bytes
 * of a region, so the caller decides how to read them.
 */
export function marginsLookStatic(
  first: Uint8ClampedArray | number[],
  later: Uint8ClampedArray | number[],
  tolerance = 8,
): boolean {
  if (first.length === 0 || first.length !== later.length) {
    return false;
  }
  let differing = 0;
  for (let i = 0; i < first.length; i += 4) {
    if (
      Math.abs(first[i] - later[i]) > tolerance ||
      Math.abs(first[i + 1] - later[i + 1]) > tolerance ||
      Math.abs(first[i + 2] - later[i + 2]) > tolerance
    ) {
      differing += 1;
    }
  }
  const pixels = first.length / 4;
  // A cursor, a hover state or a scrollbar thumb moving is not the sidebar
  // scrolling; a tenth of it changing is.
  return differing / pixels < 0.1;
}

// ─── Opening the page out ─────────────────────────────────────────────────────
//
// The primary capture does not scroll a panel and stitch its column. It lays the
// whole page out at full size first — every scroll container, nested ones and
// sideways ones included, opened to show all of its content — so the DOCUMENT
// holds everything, and then photographs the document a screen at a time. These
// are the decisions that makes, as arithmetic.

export interface Size {
  width: number;
  height: number;
}

export interface Box extends Size {
  left: number;
  top: number;
}

export interface ScrollerMeasure {
  overflowX: string;
  overflowY: string;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
}

const SCROLLING_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);

/**
 * Which way does this box hide content a person could scroll to?
 *
 * Only boxes that offer a scrollbar count. `overflow: hidden` clips on purpose —
 * a collapsed accordion, a carousel, a cropped image — and opening those would
 * put things in the capture that nobody can see on the page.
 */
export function scrollerAxes(
  measure: ScrollerMeasure,
  slack = 2,
): { vertical: boolean; horizontal: boolean } {
  const vertical =
    SCROLLING_OVERFLOW.has(measure.overflowY) &&
    measure.clientHeight > 0 &&
    measure.scrollHeight - measure.clientHeight > slack;
  const horizontal =
    SCROLLING_OVERFLOW.has(measure.overflowX) &&
    measure.clientWidth > 0 &&
    measure.scrollWidth - measure.clientWidth > slack;
  return { vertical, horizontal };
}

/**
 * Where a `position: fixed` element belongs once the page is laid out at full
 * size.
 *
 * A fixed element is pinned to the window, so photographing a page a screen at a
 * time repeats it in every photograph. It is moved onto the page instead, where
 * a window as large as the whole page would have shown it:
 *  - a sidebar running to the bottom of the window runs to the bottom of the page;
 *  - something pinned to the bottom (a chat button, a cookie bar) sits at the
 *    bottom of the page, and likewise on the right;
 *  - a header, or anything else near the top-left, stays where it is.
 */
export function placeFixedOnPage(rect: Box, viewport: Size, page: Size): Box {
  const gapBottom = viewport.height - (rect.top + rect.height);
  const gapRight = viewport.width - (rect.left + rect.width);
  let { top, left, width, height } = rect;

  const runsDown =
    rect.top <= viewport.height * 0.25 && rect.height >= viewport.height * 0.5 && gapBottom <= 1;
  if (runsDown) {
    height = Math.max(rect.height, page.height - rect.top - Math.max(0, gapBottom));
  } else if (rect.top + rect.height / 2 > viewport.height / 2) {
    top = page.height - viewport.height + rect.top;
  }

  const runsAcross =
    rect.left <= viewport.width * 0.25 && rect.width >= viewport.width * 0.5 && gapRight <= 1;
  if (runsAcross) {
    width = Math.max(rect.width, page.width - rect.left - Math.max(0, gapRight));
  } else if (rect.left + rect.width / 2 > viewport.width / 2) {
    left = page.width - viewport.width + rect.left;
  }

  return { left, top, width, height };
}

/**
 * How large the finished image can be.
 *
 * Photographs come back at the screen's own density (`ratio` pixels per CSS
 * pixel). A canvas has hard limits on its sides and its area, and past them it
 * silently produces nothing — so a page too large for that is drawn smaller
 * rather than not at all.
 */
export function planPageCanvas(
  page: Size,
  ratio: number,
  limits: { maxSide?: number; maxArea?: number } = {},
): { scale: number; width: number; height: number } {
  const maxSide = limits.maxSide ?? 32_000;
  const maxArea = limits.maxArea ?? 160_000_000;
  const width = Math.max(1, page.width);
  const height = Math.max(1, page.height);
  const scale = Math.min(
    ratio,
    maxSide / width,
    maxSide / height,
    Math.sqrt(maxArea / (width * height)),
  );
  return {
    scale,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Where one photograph of the window goes in the finished image.
 *
 * `at` is where the window really was scrolled to, so the photograph lands on
 * the part of the page it shows even when the page did not go where it was
 * asked. Only the window's content area is taken — not a scrollbar beside it.
 * Edges are rounded from page coordinates, so two photographs that meet on the
 * page also meet in the image, with no hairline between them.
 */
export function tileDraw(
  at: { x: number; y: number },
  viewport: Size,
  ratio: number,
  scale: number,
): {
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  destX: number;
  destY: number;
  destW: number;
  destH: number;
} {
  const destX = Math.round(at.x * scale);
  const destY = Math.round(at.y * scale);
  return {
    srcX: 0,
    srcY: 0,
    srcW: Math.round(viewport.width * ratio),
    srcH: Math.round(viewport.height * ratio),
    destX,
    destY,
    destW: Math.round((at.x + viewport.width) * scale) - destX,
    destH: Math.round((at.y + viewport.height) * scale) - destY,
  };
}

/**
 * How much of the page the photographs actually cover, from the top-left
 * corner without a gap.
 *
 * A photograph can fail, or the page can refuse to scroll as far as asked. The
 * image is cut where the unbroken coverage ends rather than handed over with a
 * blank band in it. Height is judged column by column, so a hole anywhere down
 * any column counts.
 */
export function coveredExtent(
  tiles: Array<{ x: number; y: number; column: number }>,
  viewport: Size,
  page: Size,
): Size {
  const reach = (spans: Array<[number, number]>, limit: number): number => {
    let end = 0;
    for (const [start, stop] of [...spans].sort((a, b) => a[0] - b[0])) {
      if (start > end + 1) {
        break;
      }
      end = Math.max(end, stop);
    }
    return Math.min(end, limit);
  };

  if (tiles.length === 0) {
    return { width: 0, height: 0 };
  }

  const columns = new Map<number, Array<[number, number]>>();
  for (const tile of tiles) {
    const spans = columns.get(tile.column) ?? [];
    spans.push([tile.y, tile.y + viewport.height]);
    columns.set(tile.column, spans);
  }
  const height = Math.min(
    ...Array.from(columns.values()).map((spans) => reach(spans, page.height)),
  );
  const width = reach(
    tiles.map((tile) => [tile.x, tile.x + viewport.width] as [number, number]),
    page.width,
  );
  return { width, height };
}

/**
 * Is this image the same screen stamped out repeatedly?
 *
 * Two bands a viewport apart that are pixel-for-pixel the same mean the renderer
 * tiled one screen rather than drawing the page. A blank or flat-coloured region
 * also matches itself, so a band with no variation in it proves nothing and is
 * not treated as evidence either way.
 */
export function looksTiled(
  bandA: Uint8ClampedArray | number[],
  bandB: Uint8ClampedArray | number[],
  options: { tolerance?: number; minVariance?: number } = {},
): boolean {
  const tolerance = options.tolerance ?? 4;
  const minVariance = options.minVariance ?? 0.02;
  if (bandA.length === 0 || bandA.length !== bandB.length) {
    return false;
  }

  // Does the band contain anything at all? Compare each pixel with the first.
  let varied = 0;
  for (let i = 4; i < bandA.length; i += 4) {
    if (
      Math.abs(bandA[i] - bandA[0]) > tolerance ||
      Math.abs(bandA[i + 1] - bandA[1]) > tolerance ||
      Math.abs(bandA[i + 2] - bandA[2]) > tolerance
    ) {
      varied += 1;
    }
  }
  const pixels = bandA.length / 4;
  if (varied / pixels < minVariance) {
    return false;
  } // featureless: says nothing

  let differing = 0;
  for (let i = 0; i < bandA.length; i += 4) {
    if (
      Math.abs(bandA[i] - bandB[i]) > tolerance ||
      Math.abs(bandA[i + 1] - bandB[i + 1]) > tolerance ||
      Math.abs(bandA[i + 2] - bandB[i + 2]) > tolerance
    ) {
      differing += 1;
    }
  }
  return differing / pixels < 0.01;
}
