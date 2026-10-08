/**
 * Tests for full-page screenshot geometry.
 *
 * The invariants a stitched capture must satisfy, whatever the page does:
 *  - every row of content appears exactly once, in order;
 *  - a page that did not actually scroll produces one screen, not the same
 *    screen repeated down the image;
 *  - the canvas is never taller than what was really photographed;
 *  - furniture outside the scrolling column is repeated only when it has been
 *    shown to be static.
 *
 * Run with `npm run test`.
 */

import {
  coveredExtent,
  looksTiled,
  marginsLookStatic,
  placeFixedOnPage,
  planPageCanvas,
  planScrollPositions,
  planStrips,
  scrollerAxes,
  tileDraw,
  tileVerdict,
} from './.build/fullPagePlan.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`ok   ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error(`${m ?? ''} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
const ok = (cond, m) => { if (!cond) throw new Error(m ?? 'expected true'); };

/** A whole window that scrolls: no sidebar, no offset. */
const page = (contentHeight, over = {}) => ({
  viewportWidth: 1000,
  viewportHeight: 800,
  clipX: 0,
  clipY: 0,
  clipWidth: 1000,
  clipHeight: 800,
  contentHeight,
  dprX: 1,
  dprY: 1,
  ...over,
});

/** Tiles as a capture run would produce them for these scroll offsets. */
const tilesAt = (...offsets) => offsets.map((y, i) => ({ actualScrollY: y, key: `frame-${i}` }));

// ── Where to scroll ──
t('positions step by a viewport and end exactly at the bottom', () => {
  eq(planScrollPositions(2000, 800), [0, 800, 1200]);
  eq(planScrollPositions(1600, 800), [0, 800]);
});

t('content that fits needs one position', () => {
  eq(planScrollPositions(500, 800), [0]);
  eq(planScrollPositions(800, 800), [0]);
});

// ── A page that will not scroll ──
t('a tile that did not move stops the run', () => {
  const first = { actualScrollY: 0, key: 'a' };
  eq(tileVerdict(null, first), 'keep');
  eq(tileVerdict(first, { actualScrollY: 0, key: 'a' }), 'stop');
  eq(tileVerdict(first, { actualScrollY: 1, key: 'b' }), 'stop', 'a one-pixel move is no move');
  eq(tileVerdict(first, { actualScrollY: 800, key: 'b' }), 'keep');
});

t('an identical picture stops the run even if the scroll claims it moved', () => {
  const first = { actualScrollY: 0, key: 'same' };
  eq(tileVerdict(first, { actualScrollY: 800, key: 'same' }), 'stop');
});

t('a page that never scrolls yields exactly one screen, not a repeated one', () => {
  // What the broken capture did: every photograph identical, all stitched.
  const geometry = page(4000);
  const kept = [];
  for (const y of planScrollPositions(4000, 800)) {
    const candidate = { actualScrollY: 0, key: 'the-same-screen' }; // nothing moved
    if (tileVerdict(kept[kept.length - 1] ?? null, candidate) === 'stop') break;
    kept.push(candidate);
  }
  eq(kept.length, 1, 'kept more than one identical screen');
  const { strips, canvasHeight } = planStrips(kept, geometry, { marginsStatic: true });
  eq(strips.length, 1);
  eq(canvasHeight, 800, 'the canvas claims more than was photographed');
});

// ── Stitching ──
t('each row of content is drawn exactly once, in order', () => {
  const geometry = page(2000);
  const { strips, canvasHeight } = planStrips(tilesAt(0, 800, 1200), geometry, {
    marginsStatic: false,
  });
  eq(canvasHeight, 2000);
  // Rows covered by each strip, in destination order.
  const covered = strips.map((s) => [s.destY, s.destY + s.srcH]);
  eq(covered, [[0, 800], [800, 1600], [1600, 2000]]);
  // The third tile sat at 1200 and only its last 400 rows were new.
  eq(strips[2].srcY, 400, 'the overlap was not skipped');
});

t('an overlapping tile contributes only its new rows', () => {
  const geometry = page(1000);
  const { strips } = planStrips(tilesAt(0, 200), geometry, { marginsStatic: false });
  eq(strips.length, 2);
  eq(strips[1].destY, 800, 'drawn over content already there');
  eq(strips[1].srcY, 600, 'did not skip the rows already captured');
  eq(strips[1].srcH, 200);
});

t('a tile wholly inside what is already drawn is dropped', () => {
  // A page that snapped backwards between photographs: the third tile shows
  // rows 300–1100, every one of which is already on the canvas.
  const geometry = page(2000);
  const { strips, coveredCssHeight } = planStrips(tilesAt(0, 800, 300), geometry, {
    marginsStatic: false,
  });
  eq(strips.length, 2, 'drew a tile that added nothing');
  eq(coveredCssHeight, 1600);
});

t('a half-viewport step still contributes only its new rows', () => {
  const geometry = page(2000);
  const { strips } = planStrips(tilesAt(0, 400), geometry, { marginsStatic: false });
  eq(strips.length, 2);
  eq(strips[1].destY, 800, 'redrew rows already on the canvas');
  eq(strips[1].srcY, 400);
  eq(strips[1].srcH, 400);
});

t('the canvas stops at the last row actually photographed', () => {
  // Tiles for a 4000px page, but the run gave up after two.
  const geometry = page(4000);
  const { canvasHeight, coveredCssHeight } = planStrips(tilesAt(0, 800), geometry, {
    marginsStatic: false,
  });
  eq(coveredCssHeight, 1600);
  eq(canvasHeight, 1600, 'left empty canvas below the last tile');
});

// ── An inner scroller with furniture beside it ──
const inner = (contentHeight) =>
  page(contentHeight, { clipX: 250, clipY: 60, clipWidth: 750, clipHeight: 740 });

t('tiles after the first redraw only the scrolling column', () => {
  const { strips } = planStrips(tilesAt(0, 740), inner(2000), { marginsStatic: true });
  const second = strips[1];
  eq(second.destX, 250, 'redrew the sidebar column');
  eq(second.srcW, 750);
});

t('a static sidebar appears once, and its background continues below it', () => {
  const geometry = inner(2300);
  const { strips, canvasHeight } = planStrips(tilesAt(0, 740, 1480), geometry, {
    marginsStatic: true,
  });
  const fills = strips.filter((s) => s.destY >= geometry.viewportHeight && s.destX === 0);
  eq(fills.length, 1, 'the sidebar was repeated instead of continued');
  const fill = fills[0];
  eq(fill.srcH, 1, 'a whole screen of sidebar was stamped out again');
  eq(fill.srcY, geometry.viewportHeight - 1, 'did not continue from the sidebar\u2019s last row');
  eq(fill.destH, canvasHeight - geometry.viewportHeight, 'left a gap beside the content');
  eq(fill.srcW, 250, 'a fill spilled into the scrolling column');
});

t('the right-hand margin is continued the same way', () => {
  const geometry = {
    ...inner(2300),
    clipWidth: 600, // leaves 150px of page to the right of the scrolling column
  };
  const { strips } = planStrips(tilesAt(0, 740, 1480), geometry, { marginsStatic: true });
  const right = strips.filter((s) => s.destY >= geometry.viewportHeight && s.destX === 850);
  eq(right.length, 1);
  eq(right[0].srcW, 150);
  eq(right[0].srcH, 1);
});

t('a sidebar that is NOT static is never repeated', () => {
  const withFills = planStrips(tilesAt(0, 740, 1480), inner(2300), { marginsStatic: true });
  const without = planStrips(tilesAt(0, 740, 1480), inner(2300), { marginsStatic: false });
  ok(without.strips.length < withFills.strips.length, 'repeated furniture that moves');
  eq(without.strips.every((s) => s.tile === 0 || s.destX === 250), true);
});

// ── Deciding whether furniture is static ──
t('identical pixels are static; a tenth of them changing is not', () => {
  const size = 400 * 4;
  const base = new Uint8ClampedArray(size).fill(120);
  ok(marginsLookStatic(base, base.slice()));

  const nudged = base.slice();
  nudged[0] = 255; // one pixel: a cursor, a focus ring
  ok(marginsLookStatic(base, nudged));

  const scrolled = base.slice();
  for (let i = 0; i < size / 2; i += 4) scrolled[i] = 10;
  ok(!marginsLookStatic(base, scrolled), 'called a scrolling sidebar static');
});

t('a missing or mismatched sample is never assumed static', () => {
  ok(!marginsLookStatic(new Uint8ClampedArray(0), new Uint8ClampedArray(0)));
  ok(!marginsLookStatic(new Uint8ClampedArray(8), new Uint8ClampedArray(12)));
});

// ── Scaling ──
t('physical pixels follow the measured device ratio', () => {
  const geometry = page(1600, { dprX: 2, dprY: 2 });
  const { strips, canvasWidth, canvasHeight } = planStrips(tilesAt(0, 800), geometry, {
    marginsStatic: false,
  });
  eq(canvasWidth, 2000);
  eq(canvasHeight, 3200);
  eq(strips[1].destY, 1600);
  eq(strips[1].srcH, 1600);
});

// ── Catching a tiled render after the fact ──
const band = (fill) => {
  const data = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < data.length; i += 4) {
    const value = fill(i / 4);
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  return data;
};

t('two identical bands a screen apart mean the render was tiled', () => {
  const content = band((i) => (i * 37) % 255);
  ok(looksTiled(content, content.slice()));
});

t('bands showing different content are not a tiled render', () => {
  ok(!looksTiled(band((i) => (i * 37) % 255), band((i) => (i * 11 + 40) % 255)));
});

t('a blank or flat band proves nothing either way', () => {
  const blank = band(() => 255);
  ok(!looksTiled(blank, blank.slice()), 'called a plain white page a tiled render');
});

t('a sample with only a little structure still counts as evidence', () => {
  // A page that is mostly whitespace with a card in it: thin bands land in the
  // white and abstain, which is why whole regions are compared as thumbnails.
  // Two per cent of the sample carrying content is enough to judge.
  const sparse = band((i) => (i > 250 ? 20 : 255));
  ok(looksTiled(sparse, sparse.slice(), { minVariance: 0.01 }),
    'abstained on a sample that plainly had content in it');
  const shifted = band((i) => (i > 200 ? 20 : 255));
  ok(!looksTiled(sparse, shifted, { minVariance: 0.01 }), 'called two different screens the same');
});

t('a mismatched or empty sample is never called tiled', () => {
  ok(!looksTiled(new Uint8ClampedArray(0), new Uint8ClampedArray(0)));
  ok(!looksTiled(new Uint8ClampedArray(8), new Uint8ClampedArray(16)));
});

// ── Opening the page out: which boxes are scrollers ──
const box = (over = {}) => ({
  overflowX: 'visible',
  overflowY: 'visible',
  scrollWidth: 500,
  clientWidth: 500,
  scrollHeight: 300,
  clientHeight: 300,
  ...over,
});

t('a panel that scrolls down is opened downwards', () => {
  eq(scrollerAxes(box({ overflowY: 'auto', scrollHeight: 2000 })), { vertical: true, horizontal: false });
  eq(scrollerAxes(box({ overflowY: 'scroll', scrollHeight: 2000 })), { vertical: true, horizontal: false });
  eq(scrollerAxes(box({ overflowY: 'overlay', scrollHeight: 2000 })), { vertical: true, horizontal: false });
});

t('a table that scrolls sideways is opened sideways', () => {
  eq(scrollerAxes(box({ overflowX: 'auto', scrollWidth: 1400 })), { vertical: false, horizontal: true });
});

t('a box that scrolls both ways is opened both ways', () => {
  eq(
    scrollerAxes(box({ overflowX: 'auto', overflowY: 'auto', scrollWidth: 900, scrollHeight: 900 })),
    { vertical: true, horizontal: true },
  );
});

t('a box that clips on purpose is left closed', () => {
  // A collapsed accordion or a carousel: nobody can scroll to what it hides.
  eq(scrollerAxes(box({ overflowY: 'hidden', scrollHeight: 2000 })), { vertical: false, horizontal: false });
  eq(scrollerAxes(box({ overflowX: 'clip', scrollWidth: 2000 })), { vertical: false, horizontal: false });
});

t('a scroller with nothing hidden, or a rounding pixel, is left alone', () => {
  eq(scrollerAxes(box({ overflowY: 'auto' })), { vertical: false, horizontal: false });
  eq(scrollerAxes(box({ overflowY: 'auto', scrollHeight: 302 })), { vertical: false, horizontal: false });
});

t('a scroller that is not on screen is left alone', () => {
  eq(scrollerAxes(box({ overflowY: 'auto', clientHeight: 0, scrollHeight: 400 })), {
    vertical: false,
    horizontal: false,
  });
});

// ── Opening the page out: fixed elements, placed once ──
const windowSize = { width: 1000, height: 800 };
const fullPage = { width: 1000, height: 3000 };

t('a header stays at the top of the page', () => {
  const header = { left: 0, top: 0, width: 1000, height: 60 };
  eq(placeFixedOnPage(header, windowSize, fullPage), header);
});

t('a sidebar running down the window runs down the whole page', () => {
  const sidebar = { left: 0, top: 0, width: 60, height: 800 };
  eq(placeFixedOnPage(sidebar, windowSize, fullPage), { left: 0, top: 0, width: 60, height: 3000 });
});

t('a sidebar below a header keeps its top and reaches the bottom', () => {
  const sidebar = { left: 0, top: 60, width: 240, height: 740 };
  eq(placeFixedOnPage(sidebar, windowSize, fullPage).height, 2940);
});

t('something pinned to the bottom corner sits at the bottom corner of the page', () => {
  const chat = { left: 940, top: 740, width: 40, height: 40 };
  const wide = { width: 1600, height: 3000 };
  eq(placeFixedOnPage(chat, windowSize, wide), { left: 1540, top: 2940, width: 40, height: 40 });
});

t('a drawer rising from the bottom moves down, it is not stretched', () => {
  const drawer = { left: 0, top: 320, width: 1000, height: 480 };
  const placed = placeFixedOnPage(drawer, windowSize, fullPage);
  eq(placed.height, 480, 'stretched a drawer as if it were a sidebar');
  eq(placed.top, 2520);
});

t('a centred dialog stays where it was', () => {
  const dialog = { left: 300, top: 160, width: 400, height: 480 };
  eq(placeFixedOnPage(dialog, windowSize, fullPage), dialog);
});

t('a page no larger than the window changes nothing', () => {
  for (const rect of [
    { left: 0, top: 0, width: 60, height: 800 },
    { left: 940, top: 740, width: 40, height: 40 },
    { left: 0, top: 0, width: 1000, height: 60 },
  ]) {
    eq(placeFixedOnPage(rect, windowSize, windowSize), rect);
  }
});

// ── Opening the page out: the finished image ──
t('a page drawn at the screen density, with no zoom', () => {
  // The broken capture rendered a 2x screen at 2x again: four pixels per CSS
  // pixel, showing only the top-left quarter of the page.
  eq(planPageCanvas({ width: 1710, height: 1871 }, 2), { scale: 2, width: 3420, height: 3742 });
});

t('a page too tall for a canvas is drawn smaller, not dropped', () => {
  const plan = planPageCanvas({ width: 1000, height: 40000 }, 2);
  ok(plan.height <= 32000, `canvas ${plan.height}px tall`);
  ok(plan.width * plan.height <= 160_000_000, 'canvas area over the limit');
  ok(plan.scale < 2 && plan.scale > 0);
});

t('each photograph is drawn where the window really was', () => {
  const draw = tileDraw({ x: 0, y: 800 }, { width: 1000, height: 800 }, 2, 2);
  eq(draw, { srcX: 0, srcY: 0, srcW: 2000, srcH: 1600, destX: 0, destY: 1600, destW: 2000, destH: 1600 });
});

t('only the window content is taken, not a scrollbar beside it', () => {
  // The photograph is 1015px wide (a classic scrollbar); the page area is 1000.
  const draw = tileDraw({ x: 0, y: 0 }, { width: 1000, height: 800 }, 1, 1);
  eq(draw.srcW, 1000);
});

t('photographs that meet on the page meet in the image, with no hairline', () => {
  // At a fractional density the edges are rounded from page coordinates, so
  // where one ends the next begins.
  const view = { width: 1000, height: 801 };
  const a = tileDraw({ x: 0, y: 0 }, view, 1.25, 1.25);
  const b = tileDraw({ x: 0, y: 801 }, view, 1.25, 1.25);
  eq(a.destY + a.destH, b.destY);
});

t('coverage runs unbroken from the top, column by column', () => {
  const view = { width: 1000, height: 800 };
  const page2 = { width: 1000, height: 2000 };
  eq(coveredExtent([
    { x: 0, y: 0, column: 0 },
    { x: 0, y: 800, column: 0 },
    { x: 0, y: 1200, column: 0 },
  ], view, page2), { width: 1000, height: 2000 });
});

t('a missing photograph cuts the image where the gap starts', () => {
  const view = { width: 1000, height: 800 };
  const page3 = { width: 1000, height: 3000 };
  eq(coveredExtent([
    { x: 0, y: 0, column: 0 },
    { x: 0, y: 1600, column: 0 },
    { x: 0, y: 2200, column: 0 },
  ], view, page3).height, 800);
});

t('a page that would not scroll is one screen tall, not a repeated one', () => {
  const view = { width: 1000, height: 800 };
  eq(coveredExtent([
    { x: 0, y: 0, column: 0 },
    { x: 0, y: 0, column: 0 },
  ], view, { width: 1000, height: 4000 }).height, 800);
});

t('a hole down one column of a wide page counts', () => {
  const view = { width: 1000, height: 800 };
  const wide = { width: 1800, height: 1600 };
  const extent = coveredExtent([
    { x: 0, y: 0, column: 0 },
    { x: 800, y: 0, column: 1 },
    { x: 0, y: 800, column: 0 },
    // column 1 never reached the second row
  ], view, wide);
  eq(extent, { width: 1800, height: 800 });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
