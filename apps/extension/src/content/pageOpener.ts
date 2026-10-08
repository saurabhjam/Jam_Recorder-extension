/**
 * Full-page screenshots — laying the page out at full size.
 *
 * Most applications do not scroll the document. The document is exactly one
 * window tall, and the content scrolls inside a panel — often inside panels
 * inside panels, some of them sideways. Photographing the window while
 * scrolling one of those panels can only ever capture that one panel; whatever
 * is inside the others stays hidden, and anything pinned to the window repeats
 * in every photograph.
 *
 * So before anything is photographed, the page is opened out:
 *  - every scroll container — the main panel, the panels nested in it, the
 *    sideways ones — is given the size of its content and stops clipping it;
 *  - the boxes around each one are released from their fixed heights, so the
 *    content reaches the document instead of overflowing a box one window tall;
 *  - `position: sticky` elements return to their place in the flow, and
 *    `position: fixed` ones are moved onto the page where a window as large as
 *    the page would show them, so each appears exactly once.
 *
 * The document then holds the whole page, and the window scrolling over it is
 * an ordinary long document to photograph. Every change is an inline style,
 * recorded before it is made and put back exactly afterwards, along with every
 * scroll position.
 *
 * No `chrome.*` here: this is plain DOM, so it can be exercised in any browser.
 */

import { placeFixedOnPage, scrollerAxes, type Box, type Size } from '@/utils/fullPagePlan';

export interface OpenedPage {
  ok: boolean;
  /** Why the page could not be opened out, when it could not. */
  reason?: string;
  /** The whole page, CSS px. */
  width: number;
  height: number;
  /** How much of the page one photograph of the window shows, CSS px. */
  viewportWidth: number;
  viewportHeight: number;
  /** The window itself, scrollbars included — what a photograph's pixels span. */
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  /** Scroll containers opened; how many of those sat inside another; how many sideways. */
  opened: number;
  nested: number;
  sideways: number;
  /** Sideways scrollers too wide to open, left scrolling as they were. */
  tooWide: number;
  /** `position: fixed` elements moved onto the page. */
  pinned: number;
}

/** Elements whose scrolling is their own business, never page structure. */
const SKIP_TAGS = new Set([
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'IFRAME',
  'VIDEO',
  'CANVAS',
  'OBJECT',
  'EMBED',
]);

/**
 * A sideways scroller wider than this many windows is left alone. A code block
 * with one very long line, or a carousel of fifty slides, would otherwise make
 * the whole image several screens wide for the sake of one strip of it.
 */
const MAX_SIDEWAYS_WINDOWS = 4;

/**
 * In force for the duration of a capture only.
 *  - No scrollbar on the window: it is not part of the page, and on systems with
 *    classic scrollbars it would otherwise be photographed down the right edge.
 *  - No smooth scrolling and no transitions: positions and sizes must be final
 *    the moment they are set, not a quarter of a second later.
 *  - Our own toolbar and overlays are not part of the page either.
 */
const CAPTURE_CSS = `
html { scrollbar-width: none !important; scroll-behavior: auto !important; }
html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
*, *::before, *::after {
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
}
[data-jam], [data-bestq] { display: none !important; }
`;

interface SavedStyle {
  el: HTMLElement;
  /** The `style` attribute exactly as it was, or null when there was none. */
  attribute: string | null;
}

interface OpenedScroller {
  el: HTMLElement;
  vertical: boolean;
  horizontal: boolean;
  /** Where it was scrolled to, put back afterwards. */
  top: number;
  left: number;
  /** How much content it was hiding, CSS px. */
  overflow: number;
}

interface PinnedElement {
  el: HTMLElement;
  /** Where it sat in the window, before anything changed. */
  rect: Box;
  /** Its own layout size, before anything changed. */
  width: number;
  height: number;
  /** CSS `left`/`top` minus the page position they produce, for this element. */
  shiftX: number;
  shiftY: number;
  /** It holds an opened scroller, so its height is the content's, not fixed. */
  inChain: boolean;
  /** It sits inside another pinned element, and moves with that one. */
  follows: boolean;
}

let captureStyle: HTMLStyleElement | null = null;
let windowScroll: { x: number; y: number } | null = null;
let baseline: Size = { width: 0, height: 0 };
let viewport: Size = { width: 0, height: 0 };

let saved: SavedStyle[] = [];
let savedEls = new WeakSet<HTMLElement>();
let scrollers: OpenedScroller[] = [];
let scrollerEls = new WeakSet<HTMLElement>();
let chainEls = new WeakSet<HTMLElement>();
let pinned: PinnedElement[] = [];
let pinnedEls = new WeakSet<HTMLElement>();
let stuckEls = new WeakSet<HTMLElement>();
let hiddenEls = new WeakSet<HTMLElement>();
/** Everything that was on the page when it was opened out. */
let seenEls = new WeakSet<HTMLElement>();
let tooWideEls = new WeakSet<HTMLElement>();
let tooWide = 0;

// ─── Small helpers ────────────────────────────────────────────────────────────

function nextFrame(): Promise<void> {
  // A frame, or a moment if the tab is not painting frames at all.
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 120);
  });
}

function isOwnUi(el: Element): boolean {
  return el.closest('[data-bestq], [data-jam]') !== null;
}

/** The parent, crossing out of a shadow root to its host. */
function parentOf(el: Element): HTMLElement | null {
  if (el.parentElement) {
    return el.parentElement;
  }
  const node = el.parentNode;
  return node instanceof ShadowRoot && node.host instanceof HTMLElement ? node.host : null;
}

/** Every element on the page, including inside open shadow roots, minus our own UI. */
function pageElements(): HTMLElement[] {
  const out: HTMLElement[] = [];
  const visit = (scope: Document | ShadowRoot): void => {
    scope.querySelectorAll('*').forEach((node) => {
      if (!(node instanceof HTMLElement) || isOwnUi(node)) {
        return;
      }
      out.push(node);
      if (node.shadowRoot) {
        visit(node.shadowRoot);
      }
    });
  };
  visit(document);
  return out;
}

function computed(el: Element): CSSStyleDeclaration | null {
  try {
    return window.getComputedStyle(el);
  } catch {
    return null;
  }
}

/** Remember an element's inline style the first time it is touched. */
function keepStyle(el: HTMLElement): void {
  if (savedEls.has(el)) {
    return;
  }
  savedEls.add(el);
  saved.push({ el, attribute: el.getAttribute('style') });
}

function important(el: HTMLElement, property: string, value: string): void {
  el.style.setProperty(property, value, 'important');
}

/**
 * A child of a column flexbox is sized by its flex basis, not its height:
 * `flex: 1 1 0` holds it to its share of a parent one window tall, and to zero
 * once that parent's height is released. Basing it on its content instead lets
 * it grow. Only for columns — in a row the basis is a width, and touching it
 * would rearrange the row.
 */
function letGrowInColumn(el: HTMLElement): void {
  const parent = parentOf(el);
  const style = parent ? computed(parent) : null;
  if (!style || !style.display.includes('flex') || !style.flexDirection.startsWith('column')) {
    return;
  }
  important(el, 'flex-basis', 'auto');
  important(el, 'flex-shrink', '0');
}

/** The mirror of letGrowInColumn for a sideways scroller in a flex row. */
function keepWidthInRow(el: HTMLElement): void {
  const parent = parentOf(el);
  const style = parent ? computed(parent) : null;
  if (!style || !style.display.includes('flex') || !style.flexDirection.startsWith('row')) {
    return;
  }
  important(el, 'flex-shrink', '0');
}

/**
 * Let the content of an opened scroller reach the document.
 *
 * Opening the scroller is not enough while any box around it still clips, or
 * still has a height of its own — `height: 100vh`, `height: 100%`, a flex child
 * with a fixed basis. The content would simply overflow that box, invisibly. So
 * every ancestor stops clipping, and — for a scroller that was opened downwards —
 * stops holding a height of its own.
 */
function releaseAncestors(el: HTMLElement, vertical: boolean): void {
  const root = document.documentElement;
  for (let p = parentOf(el); p && p !== root && p !== document.body; p = parentOf(p)) {
    if (isOwnUi(p)) {
      return;
    }
    const style = computed(p);
    if (!style) {
      continue;
    }
    keepStyle(p);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      important(p, 'overflow', 'visible');
    }
    if (/paint|strict|content|size/.test(style.contain)) {
      important(p, 'contain', 'none');
    }
    if (!vertical) {
      continue;
    }
    chainEls.add(p);
    important(p, 'height', 'auto');
    important(p, 'max-height', 'none');
    // Pinned to both the top and the bottom of something, a box is exactly that
    // tall whatever its height says. It keeps its top and grows downwards.
    if (style.position === 'absolute' || style.position === 'fixed') {
      important(p, 'bottom', 'auto');
    }
    letGrowInColumn(p);
  }
}

/** How wide the page is that a person could actually scroll across. */
function reachableWidth(): number {
  const root = document.documentElement;
  const rootStyle = computed(root);
  const bodyStyle = document.body ? computed(document.body) : null;
  // The window takes its overflow from <html>, or from <body> when <html> leaves
  // it visible. Content past a hidden edge — an off-canvas menu — is not part of
  // the page anyone sees.
  const overflowX =
    rootStyle?.overflowX === 'visible' ? (bodyStyle?.overflowX ?? 'visible') : rootStyle?.overflowX;
  if (overflowX === 'hidden' || overflowX === 'clip') {
    return root.clientWidth;
  }
  return Math.max(root.clientWidth, root.scrollWidth);
}

/**
 * Put an element in the flow where it would sit if it had never been stuck —
 * by `position: sticky`, or by a script that pins it once the page scrolls.
 */
function putInFlow(el: HTMLElement): void {
  if (stuckEls.has(el)) {
    return;
  }
  stuckEls.add(el);
  keepStyle(el);
  // `relative`, not `static`: a stuck element is the containing block of any
  // absolutely positioned children, and they must stay where they were on it.
  important(el, 'position', 'relative');
  for (const side of ['top', 'right', 'bottom', 'left']) {
    important(el, side, 'auto');
  }
}

function hasPinnedAncestor(el: HTMLElement): boolean {
  for (let p = parentOf(el); p; p = parentOf(p)) {
    if (pinnedEls.has(p)) {
      return true;
    }
  }
  return false;
}

/** Move a fixed element onto the page, where it first appeared in the window. */
function pin(el: HTMLElement, rect: Box, width: number, height: number): void {
  pinnedEls.add(el);
  keepStyle(el);
  const inChain = chainEls.has(el) || scrollerEls.has(el);
  const follows = hasPinnedAncestor(el);
  important(el, 'position', 'absolute');
  important(el, 'right', 'auto');
  important(el, 'bottom', 'auto');
  important(el, 'box-sizing', 'border-box');
  important(el, 'width', `${width}px`);
  if (!inChain) {
    important(el, 'height', `${height}px`);
  }
  important(el, 'top', `${rect.top}px`);
  important(el, 'left', `${rect.left}px`);
  // `top`/`left` now measure from whatever positioned box contains it, and any
  // transform or margin still applies on top. Where it actually landed says how
  // far off that is, once, for good.
  const landed = el.getBoundingClientRect();
  const entry: PinnedElement = {
    el,
    rect,
    width,
    height,
    shiftX: rect.left - (landed.left + window.scrollX),
    shiftY: rect.top - (landed.top + window.scrollY),
    inChain,
    follows,
  };
  pinned.push(entry);
  placePinned(entry, viewport);
}

/** Put a pinned element where a window the size of `page` would show it. */
function placePinned(entry: PinnedElement, page: Size): void {
  if (!entry.el.isConnected) {
    return;
  }
  const target = entry.follows ? entry.rect : placeFixedOnPage(entry.rect, viewport, page);
  important(entry.el, 'top', `${target.top + entry.shiftY}px`);
  important(entry.el, 'left', `${target.left + entry.shiftX}px`);
  if (entry.follows) {
    return;
  }
  important(entry.el, 'width', `${entry.width + target.width - entry.rect.width}px`);
  const tall = `${entry.height + target.height - entry.rect.height}px`;
  if (entry.inChain) {
    // Its height is its content's now; a sidebar still reaches the bottom.
    important(entry.el, 'min-height', tall);
  } else {
    important(entry.el, 'height', tall);
  }
}

// ─── Opening and measuring ────────────────────────────────────────────────────

/** Remember where the window was, put the capture styles in force, go to the top. */
function beginCapture(): void {
  if (!captureStyle) {
    windowScroll = { x: window.scrollX, y: window.scrollY };
    const style = document.createElement('style');
    style.setAttribute('data-bestq', 'true');
    style.textContent = CAPTURE_CSS;
    (document.head ?? document.documentElement).appendChild(style);
    captureStyle = style;
  }
  window.scrollTo(0, 0);
}

/**
 * Open everything out. Additive: run again after more content has loaded, it
 * opens what is new and leaves alone what is already open.
 */
function openPageOut(): void {
  const root = document.documentElement;

  if (viewport.width === 0) {
    viewport = { width: root.clientWidth, height: root.clientHeight };
    baseline = { width: reachableWidth(), height: root.scrollHeight };
  }

  // Everything is measured before anything changes: opening one box changes the
  // sizes of the boxes around it, and those decide what else qualifies.
  const found: Array<{
    el: HTMLElement;
    vertical: boolean;
    horizontal: boolean;
    position: string;
    contentWidth: number;
  }> = [];
  const sticky: HTMLElement[] = [];
  const fixed: Array<{ el: HTMLElement; rect: Box; width: number; height: number }> = [];

  for (const el of pageElements()) {
    if (el === root || SKIP_TAGS.has(el.tagName)) {
      continue;
    }
    seenEls.add(el);
    const style = computed(el);
    if (!style) {
      continue;
    }

    if (style.position === 'sticky' && !stuckEls.has(el)) {
      sticky.push(el);
    }
    if (style.position === 'fixed' && !pinnedEls.has(el)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        fixed.push({
          el,
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          width: el.offsetWidth,
          height: el.offsetHeight,
        });
      }
    }

    if (scrollerEls.has(el)) {
      continue;
    }
    // perfect-scrollbar scrolls a box that is `overflow: hidden`, and marks it.
    const axes = scrollerAxes({
      overflowX: el.classList.contains('ps--active-x') ? 'auto' : style.overflowX,
      overflowY: el.classList.contains('ps--active-y') ? 'auto' : style.overflowY,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    let horizontal = axes.horizontal;
    if (horizontal && el.scrollWidth > viewport.width * MAX_SIDEWAYS_WINDOWS) {
      horizontal = false;
      if (!tooWideEls.has(el)) {
        tooWideEls.add(el);
        tooWide += 1;
      }
    }
    if (!axes.vertical && !horizontal) {
      continue;
    }

    scrollerEls.add(el);
    scrollers.push({
      el,
      vertical: axes.vertical,
      horizontal,
      top: el.scrollTop,
      left: el.scrollLeft,
      overflow: el.scrollHeight - el.clientHeight,
    });
    const borders =
      (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
    found.push({
      el,
      vertical: axes.vertical,
      horizontal,
      position: style.position,
      contentWidth: el.scrollWidth + borders,
    });
  }

  for (const box of found) {
    keepStyle(box.el);
    important(box.el, 'overflow', 'visible');
    if (box.vertical) {
      important(box.el, 'height', 'auto');
      important(box.el, 'max-height', 'none');
      if (box.position === 'absolute' || box.position === 'fixed') {
        // An `inset: 0` pane — the usual custom-scrollbar wrapper — keeps its
        // place and grows downwards; the document's overflow takes it in.
        important(box.el, 'bottom', 'auto');
      }
      letGrowInColumn(box.el);
    }
    if (box.horizontal) {
      important(box.el, 'box-sizing', 'border-box');
      important(box.el, 'width', `${box.contentWidth}px`);
      important(box.el, 'max-width', 'none');
      keepWidthInRow(box.el);
    }
    releaseAncestors(box.el, box.vertical);
  }

  for (const el of sticky) {
    putInFlow(el);
  }

  // Outer before inner, which is document order, so a fixed element inside
  // another is known to follow it.
  for (const item of fixed) {
    pin(item.el, item.rect, item.width, item.height);
  }

  // The window itself must be able to scroll over all of it.
  const openedDown = scrollers.some((s) => s.vertical);
  const openedAcross = scrollers.some((s) => s.horizontal);
  for (const el of [root, document.body]) {
    if (!el) {
      continue;
    }
    keepStyle(el);
    important(el, 'overflow-y', 'visible');
    if (openedAcross) {
      important(el, 'overflow-x', 'visible');
    }
    if (openedDown) {
      important(el, 'height', 'auto');
      important(el, 'max-height', 'none');
    }
  }
}

/** The page's full size as it now stands. */
function pageSize(): Size {
  const root = document.documentElement;
  let width = Math.max(root.clientWidth, baseline.width);
  for (const s of scrollers) {
    if (!s.horizontal || !s.el.isConnected) {
      continue;
    }
    width = Math.max(width, s.el.getBoundingClientRect().right + window.scrollX);
  }
  const height = Math.max(root.scrollHeight, root.clientHeight);
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

function describe(el: HTMLElement): string {
  const id = el.id ? `#${el.id}` : '';
  const cls =
    typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

function measureOpenedPage(): OpenedPage {
  window.scrollTo(0, 0);

  // Pinned elements back where they were in the window, the page measured
  // without them stretched, and only then each one placed for that page — so a
  // sidebar stretched last time never holds the page at its old height.
  for (const entry of pinned) {
    placePinned(entry, viewport);
  }
  const page = pageSize();
  for (const entry of pinned) {
    placePinned(entry, page);
  }
  const size = pageSize();

  const nested = scrollers.filter((s) => {
    for (let p = parentOf(s.el); p; p = parentOf(p)) {
      if (scrollerEls.has(p)) {
        return true;
      }
    }
    return false;
  }).length;

  const result: OpenedPage = {
    ok: true,
    width: size.width,
    height: size.height,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    opened: scrollers.length,
    nested,
    sideways: scrollers.filter((s) => s.horizontal).length,
    tooWide,
    pinned: pinned.length,
  };

  // Opening out must never lose any of the page.
  if (size.height < baseline.height - 4) {
    return {
      ...result,
      ok: false,
      reason: `opening it out made the page shorter (${baseline.height} → ${size.height}px)`,
    };
  }

  // And the main panel's content must now be inside the page. If it is not,
  // something this cannot reach is still clipping it.
  const main = scrollers
    .filter((s) => s.vertical && s.el.isConnected)
    .sort((a, b) => b.overflow - a.overflow)[0];
  if (main) {
    const end = main.el.getBoundingClientRect().top + window.scrollY + main.el.scrollHeight;
    if (end > size.height + 8) {
      return {
        ...result,
        ok: false,
        reason: `${describe(main.el)} still holds ${Math.round(end - size.height)}px the page does not reach`,
      };
    }
  }
  return result;
}

function failed(reason: string): OpenedPage {
  return {
    ok: false,
    reason,
    width: 0,
    height: 0,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    opened: 0,
    nested: 0,
    sideways: 0,
    tooWide: 0,
    pinned: 0,
  };
}

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * Lay the page out at full size and report how large it is. When that cannot
 * be done faithfully, the page is put back as it was and `ok` is false.
 */
export async function openPage(): Promise<OpenedPage> {
  try {
    beginCapture();
  } catch (err) {
    restoreOpenedPage();
    return failed(`starting the capture threw: ${String(err)}`);
  }
  // Whatever the page does when it scrolls — pin a header, let it go — it has
  // done by the next frame, so the page is read as it stands at the top.
  await nextFrame();
  try {
    openPageOut();
  } catch (err) {
    restoreOpenedPage();
    return failed(`opening the page out threw: ${String(err)}`);
  }
  // Pages that size things from a ResizeObserver respond before the next paint.
  await nextFrame();
  await nextFrame();
  let result: OpenedPage;
  try {
    result = measureOpenedPage();
  } catch (err) {
    result = failed(`measuring the opened page threw: ${String(err)}`);
  }
  if (!result.ok) {
    restoreOpenedPage();
  }
  return result;
}

/**
 * Scroll the window over the opened page, and report where it really went.
 *
 * With `hideLate`, anything that has become fixed or sticky since the page was
 * opened — a header a script pins once the page scrolls, a toast — is dealt
 * with before the photograph, so it does not repeat down the image.
 */
export async function scrollOpenedPage(
  x: number,
  y: number,
  hideLate: boolean,
): Promise<{ x: number; y: number }> {
  window.scrollTo(x, y);
  // Scroll handlers run before the next frame; whatever they pin is pinned by then.
  await nextFrame();
  if (hideLate) {
    hideLateArrivals();
  }
  await nextFrame();
  return { x: window.scrollX, y: window.scrollY };
}

function hideLateArrivals(): void {
  for (const el of pageElements()) {
    if (pinnedEls.has(el) || stuckEls.has(el) || hiddenEls.has(el)) {
      continue;
    }
    const position = computed(el)?.position;
    if (position === 'sticky') {
      putInFlow(el);
    } else if (position === 'fixed') {
      if (seenEls.has(el)) {
        // It was part of the page when it was opened, and a script pinned it
        // once the window scrolled. Pinned, it has left the flow and everything
        // below it has moved up; back in the flow, the page is whole again.
        putInFlow(el);
      } else {
        // Something new — a toast, a popup. It takes no room; it just must
        // not appear in every photograph from here on.
        hiddenEls.add(el);
        keepStyle(el);
        important(el, 'visibility', 'hidden');
      }
    }
  }
}

/** Put the page back exactly as it was. Safe to call at any time, any number of times. */
export function restoreOpenedPage(): void {
  if (!captureStyle && saved.length === 0) {
    return;
  }

  // Inline styles first, while transitions are still off, so nothing animates
  // back into place.
  for (let i = saved.length - 1; i >= 0; i--) {
    const { el, attribute } = saved[i]!;
    if (attribute !== null) {
      el.setAttribute('style', attribute);
    } else {
      // Chrome writes inline-style changes back to the attribute lazily; removed
      // before that has happened, the attribute comes back as `style=""`.
      // Reading it first brings it up to date.
      el.getAttribute('style');
      el.removeAttribute('style');
    }
  }
  for (const s of scrollers) {
    if (!s.el.isConnected) {
      continue;
    }
    s.el.scrollTop = s.top;
    s.el.scrollLeft = s.left;
  }
  if (windowScroll) {
    window.scrollTo(windowScroll.x, windowScroll.y);
  }
  captureStyle?.remove();

  captureStyle = null;
  windowScroll = null;
  baseline = { width: 0, height: 0 };
  viewport = { width: 0, height: 0 };
  saved = [];
  savedEls = new WeakSet();
  scrollers = [];
  scrollerEls = new WeakSet();
  chainEls = new WeakSet();
  pinned = [];
  pinnedEls = new WeakSet();
  stuckEls = new WeakSet();
  hiddenEls = new WeakSet();
  seenEls = new WeakSet();
  tooWideEls = new WeakSet();
  tooWide = 0;
}
