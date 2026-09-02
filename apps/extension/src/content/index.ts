/**
 * BestQ – Content Script
 *
 * Injected into every page. Responsibilities:
 *  - Mount/unmount the floating recording toolbar
 *  - Mount/unmount the annotation canvas overlay
 *  - Listen to messages from the background service worker
 *  - Relay tab-level events back to background
 *  - Capture network requests during recording
 */

import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import type { ExtensionMessage, CaptureConsoleLog, CaptureNetworkEntry } from '@/types';
import { generateId } from '@/utils';
import { FloatingToolbar } from './FloatingToolbar';
import { AnnotationCanvas } from './AnnotationCanvas';
import { ScreenshotSelector } from './ScreenshotSelector';
import { ScreenshotPreview } from './ScreenshotPreview';

declare global {
  interface Window {
    __bestqCaptureInitialized?: boolean;
    __bestqEpoch?: number;
  }
}

// Jira (and most SPAs) don't do a full page reload between our own dev/extension
// reloads or even between soft in-app navigations, so a previous injection of this
// very script can still be alive with its OWN onMessage listener and its OWN stale
// closure state (e.g. a different `screenshotScrollEl`). Multiple listeners then all
// answer the same message, and whichever happens to reply first wins — silently,
// with no error — producing exactly the kind of confidently-wrong capture that's
// impossible to explain from a single instance's logic alone. Claim a fresh epoch on
// every injection; only the CURRENT holder is allowed to act on messages below.
const myEpoch = (window.__bestqEpoch ?? 0) + 1;
window.__bestqEpoch = myEpoch;

// ─── State ────────────────────────────────────────────────────────────────────

let toolbarContainer: HTMLElement | null = null;
let toolbarRoot: Root | null = null;
let annotationContainer: HTMLElement | null = null;
let annotationRoot: Root | null = null;
let screenshotSelectorContainer: HTMLElement | null = null;
let screenshotSelectorRoot: Root | null = null;
let screenshotPreviewContainer: HTMLElement | null = null;
let screenshotPreviewRoot: Root | null = null;
let currentDuration = 0;
let isToolbarVisible = false;
// True pause state, synced from the background (seeded on mount, updated via
// RECORDING_PAUSE_STATE broadcasts) so a remounted toolbar shows the real state.
let isRecordingPaused = false;
let networkCaptures: CaptureNetworkEntry[] = [];
let consoleLogs: CaptureConsoleLog[] = [];

// The element that actually scrolls the page. Resolved on SCREENSHOT_GET_DIMENSIONS
// and reused by the scroll/restore handlers so a full-page capture stays consistent.
// `null` means the window/document itself scrolls.
let screenshotScrollEl: HTMLElement | null = null;

// Fixed/sticky overlays (headers, sidebars, footers, composer bars) captured during a
// full-page screenshot, with the anchor used to decide on which frame each is shown.
// Top-anchored ones show only on the first frame; bottom-anchored only on the last;
// all are hidden on the in-between frames so they never repeat down the stitched image.
type OverlayAnchor = 'top' | 'bottom';
let screenshotOverlays: Array<{ el: HTMLElement; anchor: OverlayAnchor; prevVisibility: string }> =
  [];
// scrollWidth of the scroll target right before any overlay gets hidden. `visibility:
// hidden` keeps an element's own box in the layout, so hiding one shouldn't normally
// change this — but some pages react to a visibility change (CSS `:has()`, a resize
// observer, etc.) and reflow anyway. Comparing against this after hiding catches that
// instead of silently capturing a page whose layout just collapsed.
let screenshotLayoutBaseline = 0;

// Inline styles saved before a full-page capture "flattens" the page — see
// SCREENSHOT_EXPAND_SCROLLERS. Restored verbatim afterwards.
let expandedScrollers: Array<{ el: HTMLElement; cssText: string }> = [];
let flattenedEls = new WeakSet<HTMLElement>();

/**
 * Find the element that actually scrolls the bulk of the page.
 *
 * Plain documents scroll the window, but most SPAs (ChatGPT, Gmail, etc.) keep the
 * document at viewport height and scroll an inner `overflow:auto` container instead.
 * Returns `null` when the window/document is the scroller, otherwise the largest
 * scrollable descendant — so a full-page capture can scroll the right thing.
 */
function findScrollTarget(): HTMLElement | null {
  const doc = document.documentElement;
  // Window/document scrolls — the simple, common case.
  if (doc.scrollHeight > window.innerHeight + 4) return null;

  let best: HTMLElement | null = null;
  let bestOverflow = 0;
  const minWidth = window.innerWidth * 0.5;
  const minHeight = window.innerHeight * 0.5;

  document.querySelectorAll<HTMLElement>('*').forEach((el) => {
    try {
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow <= 4) return; // not vertically scrollable
      if (el.clientWidth < minWidth || el.clientHeight < minHeight) return; // too small to be the page scroller
      const style = window.getComputedStyle(el);
      if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') return;
      if (overflow > bestOverflow) {
        bestOverflow = overflow;
        best = el;
      }
    } catch {
      /* skip elements that throw on getComputedStyle */
    }
  });

  return best;
}

/**
 * Re-resolves `screenshotScrollEl` if it's been detached from the document. Some
 * SPAs (a loading-skeleton → real-content transition, a React `key` change, etc.)
 * replace a container's DOM node outright instead of mutating it in place. A stale
 * reference to the OLD node still has a `scrollHeight`, but it's frozen at whatever
 * it was the instant it got detached — so height-settling logic against it would
 * see almost no growth even while the real (new) container keeps loading content,
 * and every subsequent scroll/measure call would be silently acting on a node
 * nobody can see. Call this before any of that.
 */
function reresolveScrollTargetIfDetached(): void {
  if (screenshotScrollEl && !screenshotScrollEl.isConnected) {
    screenshotScrollEl = findScrollTarget();
  }
}

/** Short human-readable identifier for a scroll target, for diagnostics only. */
function describeScrollTarget(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls =
    el.className && typeof el.className === 'string'
      ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
      : '';
  return `${tag}${id}${cls} (scrollHeight=${el.scrollHeight}, clientHeight=${el.clientHeight})`;
}

// ─── Toolbar Management ───────────────────────────────────────────────────────

// Remembered so the self-heal guard can remount after the page removes our node.
let lastToolbarRecordingId = '';
let toolbarGuardTimer: number | null = null;

/** Watchdog while recording: heavy SPAs (Google Meet et al.) can wipe DOM nodes
 *  they don't own, and fullscreen mode renders nothing outside the fullscreen
 *  element. Remount if our container was removed; re-parent it into the
 *  fullscreen element so the controls stay visible during fullscreen calls. */
function startToolbarGuard(): void {
  if (toolbarGuardTimer !== null) return;
  toolbarGuardTimer = window.setInterval(() => {
    if (!isToolbarVisible) return;
    if (!toolbarContainer || !toolbarContainer.isConnected) {
      if (lastToolbarRecordingId) mountToolbar(lastToolbarRecordingId);
      return;
    }
    reparentToolbarForFullscreen();
  }, 2000);
}

function stopToolbarGuard(): void {
  if (toolbarGuardTimer !== null) {
    clearInterval(toolbarGuardTimer);
    toolbarGuardTimer = null;
  }
}

function reparentToolbarForFullscreen(): void {
  if (!toolbarContainer || !toolbarContainer.isConnected || !document.body) return;
  const fsEl = document.fullscreenElement;
  const desiredParent = fsEl && fsEl !== toolbarContainer ? fsEl : document.body;
  if (toolbarContainer.parentElement !== desiredParent) {
    try {
      desiredParent.appendChild(toolbarContainer);
    } catch {
      /* fullscreen element may not accept children (e.g. <video>) — guard tick retries */
    }
  }
}

// React immediately when the page enters/exits fullscreen instead of waiting
// for the next guard tick.
document.addEventListener('fullscreenchange', reparentToolbarForFullscreen);

function mountToolbar(recordingId: string): void {
  lastToolbarRecordingId = recordingId;

  // Already mounted AND still attached to the live DOM — just keep the id fresh.
  if (toolbarContainer && toolbarContainer.isConnected) {
    toolbarContainer.dataset['recordingId'] = recordingId;
    if (!isToolbarVisible) {
      isToolbarVisible = true;
      renderToolbar(recordingId);
    }
    startToolbarGuard();
    return;
  }

  // A stray container from a re-injected script instance (executeScript fallback
  // runs the file again with fresh module state) — remove it so we never show two.
  const stray = document.getElementById('jam-toolbar-root');
  if (stray && stray !== toolbarContainer) stray.remove();

  // A previous mount left a dangling/detached container (e.g. mountToolbar ran at
  // document_start before <body> existed and threw, or the page removed it). Tear
  // it down so the `isConnected` guard above never traps us into never re-mounting.
  if (toolbarContainer) {
    try {
      toolbarRoot?.unmount();
    } catch {
      /* ignore */
    }
    toolbarRoot = null;
    toolbarContainer = null;
    isToolbarVisible = false;
  }

  // The content script runs at document_start, so <body> may not exist yet when we
  // try to restore. Defer until the DOM is ready rather than throwing.
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => mountToolbar(recordingId), { once: true });
    return;
  }

  // Build fully before touching the module-level ref, so a failure can't leave a
  // non-null-but-unmounted container behind (that was the "toolbar never comes
  // back after refresh" bug).
  const container = document.createElement('div');
  container.id = 'jam-toolbar-root';
  container.setAttribute('data-jam', 'true');
  container.dataset['recordingId'] = recordingId;

  // Prevent site CSS from affecting our toolbar
  const shadow = container.attachShadow?.({ mode: 'open' });

  let root: Root;
  if (shadow) {
    // Inject styles into shadow DOM
    const style = document.createElement('style');
    style.textContent = getToolbarStyles();
    shadow.appendChild(style);

    const inner = document.createElement('div');
    inner.id = 'jam-toolbar-inner';
    shadow.appendChild(inner);

    document.body.appendChild(container);
    root = createRoot(inner);
  } else {
    document.body.appendChild(container);
    root = createRoot(container);
  }

  toolbarContainer = container;
  toolbarRoot = root;
  isToolbarVisible = true;
  renderToolbar(recordingId);
  reparentToolbarForFullscreen();
  startToolbarGuard();
  syncToolbarWithBackground(recordingId);
}

/** Seed timer + pause state from the background after a (re)mount, so the
 *  toolbar never comes back at 0:00 / un-paused when the recording isn't. */
function syncToolbarWithBackground(recordingId: string): void {
  try {
    chrome.runtime.sendMessage(
      { type: 'GET_STATE' } satisfies ExtensionMessage,
      (res: { isRecording?: boolean; isPaused?: boolean; elapsedSeconds?: number } | undefined) => {
        if (chrome.runtime.lastError || !res?.isRecording) return;
        isRecordingPaused = res.isPaused ?? false;
        if (typeof res.elapsedSeconds === 'number') currentDuration = res.elapsedSeconds;
        if (isToolbarVisible) renderToolbar(recordingId);
      },
    );
  } catch {
    /* background unreachable — next UPDATE_TIMER will correct the display */
  }
}

function renderToolbar(recordingId: string): void {
  if (!toolbarRoot) return;

  toolbarRoot.render(
    createElement(FloatingToolbar, {
      recordingId,
      duration: currentDuration,
      isPaused: isRecordingPaused,
      onStop: () => {
        chrome.runtime.sendMessage({ type: 'STOP_RECORDING' } satisfies ExtensionMessage);
      },
      onPause: () => {
        // Optimistic flip; the background's RECORDING_PAUSE_STATE broadcast confirms.
        isRecordingPaused = true;
        renderToolbar(recordingId);
        chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' } satisfies ExtensionMessage);
      },
      onResume: () => {
        isRecordingPaused = false;
        renderToolbar(recordingId);
        chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' } satisfies ExtensionMessage);
      },
      onScreenshot: () => {
        chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT' } satisfies ExtensionMessage);
      },
      onAnnotate: (imageUrl: string) => {
        mountAnnotationCanvas(imageUrl);
      },
    }),
  );
}

function unmountToolbar(): void {
  stopToolbarGuard();
  lastToolbarRecordingId = '';
  isRecordingPaused = false;
  if (toolbarRoot) {
    toolbarRoot.unmount();
    toolbarRoot = null;
  }
  if (toolbarContainer) {
    toolbarContainer.remove();
    toolbarContainer = null;
  }
  isToolbarVisible = false;
}

// ─── Annotation Canvas Management ────────────────────────────────────────────

function mountAnnotationCanvas(imageUrl: string): void {
  if (annotationContainer) {
    unmountAnnotationCanvas();
  }

  annotationContainer = document.createElement('div');
  annotationContainer.id = 'jam-annotation-root';
  annotationContainer.setAttribute('data-jam', 'true');
  annotationContainer.style.cssText = [
    'position: fixed',
    'inset: 0',
    'z-index: 2147483646',
    'pointer-events: all',
  ].join('; ');

  document.body.appendChild(annotationContainer);
  annotationRoot = createRoot(annotationContainer);

  annotationRoot.render(
    createElement(AnnotationCanvas, {
      imageUrl,
      onSave: (annotatedUrl: string) => {
        // Upload annotated screenshot
        chrome.runtime.sendMessage({
          type: 'TAKE_SCREENSHOT',
          payload: { annotatedUrl },
        } satisfies ExtensionMessage);
        unmountAnnotationCanvas();
      },
      onClose: () => {
        unmountAnnotationCanvas();
      },
    }),
  );
}

function unmountAnnotationCanvas(): void {
  if (annotationRoot) {
    annotationRoot.unmount();
    annotationRoot = null;
  }
  if (annotationContainer) {
    annotationContainer.remove();
    annotationContainer = null;
  }
}

// ─── Screenshot Selector Management ──────────────────────────────────────────

function mountScreenshotSelector(): void {
  console.log('[Content Script] mountScreenshotSelector called');
  unmountScreenshotSelector();

  screenshotSelectorContainer = document.createElement('div');
  screenshotSelectorContainer.id = 'bestq-screenshot-selector';
  screenshotSelectorContainer.setAttribute('data-bestq', 'true');
  document.body.appendChild(screenshotSelectorContainer);
  console.log('[Content Script] Screenshot selector container created and appended');
  screenshotSelectorRoot = createRoot(screenshotSelectorContainer);

  screenshotSelectorRoot.render(
    createElement(ScreenshotSelector, {
      onSelect: (bounds: { x: number; y: number; width: number; height: number }) => {
        console.log('[Content Script] Screenshot area selected:', bounds);
        unmountScreenshotSelector();
        chrome.runtime.sendMessage({
          type: 'SCREENSHOT_AREA_SELECTED',
          payload: { ...bounds, devicePixelRatio: window.devicePixelRatio },
        } satisfies ExtensionMessage);
      },
      onCancel: unmountScreenshotSelector,
    }),
  );
}

function unmountScreenshotSelector(): void {
  if (screenshotSelectorRoot) {
    screenshotSelectorRoot.unmount();
    screenshotSelectorRoot = null;
  }
  if (screenshotSelectorContainer) {
    screenshotSelectorContainer.remove();
    screenshotSelectorContainer = null;
  }
}

// ─── Screenshot Preview Management ───────────────────────────────────────────

function mountScreenshotPreview(dataUrl: string, warnings?: string[]): void {
  console.log(
    '[Content Script] mountScreenshotPreview called with dataUrl length:',
    dataUrl.length,
  );
  unmountScreenshotPreview();

  screenshotPreviewContainer = document.createElement('div');
  screenshotPreviewContainer.id = 'bestq-screenshot-preview';
  screenshotPreviewContainer.setAttribute('data-bestq', 'true');
  document.body.appendChild(screenshotPreviewContainer);
  console.log('[Content Script] Screenshot preview container created and appended');
  screenshotPreviewRoot = createRoot(screenshotPreviewContainer);

  screenshotPreviewRoot.render(
    createElement(ScreenshotPreview, {
      dataUrl,
      warnings,
      onClose: unmountScreenshotPreview,
    }),
  );
}

function unmountScreenshotPreview(): void {
  if (screenshotPreviewRoot) {
    screenshotPreviewRoot.unmount();
    screenshotPreviewRoot = null;
  }
  if (screenshotPreviewContainer) {
    screenshotPreviewContainer.remove();
    screenshotPreviewContainer = null;
  }
}

// ─── Network Capture ──────────────────────────────────────────────────────────

function startCapture(): void {
  if (window.__bestqCaptureInitialized) return;

  window.__bestqCaptureInitialized = true;

  networkCaptures = [];
  consoleLogs = [];

  // The main-world XHR/fetch/console patching is injected by the background
  // service worker via chrome.scripting.executeScript({ world: 'MAIN' }),
  // which bypasses page CSP. We only need to listen for the postMessages here.
  window.addEventListener('message', handlePageMessage);
}

function stopCapture(): void {
  window.removeEventListener('message', handlePageMessage);
  window.__bestqCaptureInitialized = false;
}

function handlePageMessage(e: MessageEvent): void {
  if (!e.source || e.source !== window || !e.data?.__st) return;

  if (e.data.kind === 'network') {
    networkCaptures.push({
      id: generateId(12),
      url: e.data.url as string,
      method: e.data.method as string,
      status: e.data.status as number,
      statusText: (e.data.statusText as string) || '',
      duration: e.data.duration as number,
      timestamp: e.data.timestamp as number,
      size: e.data.size as number,
      failed: (e.data.failed as boolean) || false,
      errorText: e.data.errorText as string | undefined,
      requestHeaders: e.data.requestHeaders as Record<string, string> | undefined,
      responseHeaders: e.data.responseHeaders as Record<string, string> | undefined,
      requestBody: e.data.requestBody as string | undefined,
      responseBody: e.data.responseBody as string | undefined,
      source: 'injected',
    });
  } else if (e.data.kind === 'console') {
    consoleLogs.push({
      level: (e.data.level as CaptureConsoleLog['level']) || 'log',
      message: e.data.message as string,
      timestamp: e.data.timestamp as number,
      url: (e.data.url as string) || '',
      source: 'injected',
    });
  }
}

// ─── Pre-recording Countdown ───────────────────────────────────────────────────

/** Show a full-screen 3…2…1 countdown overlay that removes itself at 0. Used
 *  before a recording starts when the user enabled "Show countdown". */
function showCountdown(seconds: number): void {
  document.getElementById('bestq-countdown')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'bestq-countdown';
  overlay.setAttribute('data-bestq', 'true');
  overlay.style.cssText = [
    'position: fixed',
    'inset: 0',
    'z-index: 2147483647',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'background: rgba(0,0,0,0.45)',
    'backdrop-filter: blur(2px)',
    '-webkit-backdrop-filter: blur(2px)',
    'pointer-events: none',
  ].join('; ');

  const circle = document.createElement('div');
  circle.style.cssText = [
    'width: 150px',
    'height: 150px',
    'border-radius: 50%',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'background: rgba(9,9,13,0.92)',
    'border: 3px solid rgba(139,92,246,0.7)',
    'box-shadow: 0 0 60px rgba(139,92,246,0.5)',
    "font-family: 'Inter', -apple-system, sans-serif",
    'font-size: 80px',
    'font-weight: 800',
    'color: white',
    'line-height: 1',
  ].join('; ');
  overlay.appendChild(circle);
  document.body.appendChild(overlay);

  let n = Math.max(1, Math.floor(seconds));
  const render = () => {
    circle.textContent = String(n);
    circle.animate(
      [
        { transform: 'scale(0.6)', opacity: 0 },
        { transform: 'scale(1)', opacity: 1 },
      ],
      { duration: 260, easing: 'ease-out' },
    );
  };
  render();

  const timer = window.setInterval(() => {
    n -= 1;
    if (n <= 0) {
      window.clearInterval(timer);
      overlay.remove();
      return;
    }
    render();
  }, 1000);
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  // A stale prior injection of this same script — see the epoch comment above.
  // Silently ignore; the current instance (the one that set the latest epoch)
  // will handle it.
  if (window.__bestqEpoch !== myEpoch) return false;

  console.log('[Content Script] Received message:', message.type);

  switch (message.type) {
    case 'SHOW_TOOLBAR': {
      const payload = message.payload as { recordingId: string } | undefined;
      if (payload?.recordingId) {
        mountToolbar(payload.recordingId);
        startCapture();
      }
      // Report whether the toolbar truly ended up in the live DOM — "message
      // received" is not "toolbar visible". The background uses this to decide
      // whether the popup may close or must show its in-popup controls instead.
      sendResponse({
        success: true,
        mounted: !!(toolbarContainer && toolbarContainer.isConnected),
      });
      break;
    }

    case 'HIDE_TOOLBAR': {
      stopCapture();
      unmountToolbar();
      sendResponse({ success: true });
      break;
    }

    case 'SHOW_COUNTDOWN': {
      const payload = message.payload as { seconds?: number } | undefined;
      showCountdown(payload?.seconds ?? 3);
      sendResponse({ success: true });
      break;
    }

    case 'CAPTURE_FLUSH': {
      // Background is requesting all accumulated capture data before stopping
      sendResponse({ consoleLogs: [...consoleLogs], networkCaptures: [...networkCaptures] });
      break;
    }

    case 'UPDATE_TIMER': {
      const payload = message.payload as { duration: number } | undefined;
      if (payload?.duration !== undefined) {
        currentDuration = payload.duration;
        // Re-render toolbar with updated duration if visible
        if (isToolbarVisible && toolbarRoot && toolbarContainer) {
          const recordingId = toolbarContainer.dataset['recordingId'] ?? '';
          renderToolbar(recordingId);
        }
      }
      break;
    }

    case 'RECORDING_PAUSE_STATE': {
      const payload = message.payload as { isPaused: boolean } | undefined;
      if (payload) {
        isRecordingPaused = payload.isPaused;
        if (isToolbarVisible && toolbarRoot && toolbarContainer) {
          renderToolbar(toolbarContainer.dataset['recordingId'] ?? '');
        }
      }
      break;
    }

    // ── Screenshot workflow ──────────────────────────────────────────────────

    case 'SCREENSHOT_EXPAND_SCROLLERS': {
      // "Flatten" the page before a full-page capture: every inner scroll container
      // is expanded to its full content height and its clipping removed, so ALL the
      // content lands in normal document flow and the DOCUMENT becomes the scroller.
      //
      // Why this matters: SPAs like Jira keep the document at viewport height and
      // scroll an inner div. Capturing that means scrolling the inner box tile by
      // tile — which fights lazy-loading, re-renders content mid-capture (the page
      // visibly "refreshing"), repeats sticky bars, and leaves gaps wherever the
      // geometry shifted between tiles. Flattened, the page behaves like a plain
      // long document, which is the case that captures reliably.
      // Additive on purpose: an SPA can re-create a scroll container AFTER we've
      // flattened it (a loading-skeleton swap, a route re-render), which silently
      // restores its clipping and collapses the document back to viewport height.
      // So this runs repeatedly during a capture, and only records a node's ORIGINAL
      // cssText the first time it's seen — re-saving later would capture our own
      // flattened styles and make RESTORE a no-op.
      const save = (el: HTMLElement) => {
        if (!flattenedEls.has(el)) {
          flattenedEls.add(el);
          expandedScrollers.push({ el, cssText: el.style.cssText });
        }
      };
      /** Remove clipping only — never touches height, so % chains stay intact. */
      const unclip = (el: HTMLElement) => {
        save(el);
        el.style.setProperty('overflow-y', 'visible', 'important');
        el.style.setProperty('overflow-x', 'visible', 'important');
      };
      /** Expand a scroll container to its full content height AND remove clipping. */
      const expand = (el: HTMLElement) => {
        save(el);
        el.style.setProperty('height', 'auto', 'important');
        el.style.setProperty('max-height', 'none', 'important');
        el.style.setProperty('overflow-y', 'visible', 'important');
        el.style.setProperty('overflow-x', 'visible', 'important');
      };

      // What the page could show BEFORE we touch it. If flattening ends up making the
      // page shorter than this, the layout collapsed (e.g. a `height:100%` chain lost
      // its definite parent height) and we must put everything back — a collapsed page
      // captures far worse than the un-flattened one we started from.
      const before = Math.max(
        document.documentElement.scrollHeight,
        screenshotScrollEl?.scrollHeight ?? 0,
      );

      try {
        // Collect targets BEFORE mutating anything: expanding as we go changes the
        // very geometry (clientHeight/scrollHeight) used to decide what qualifies.
        const targets: HTMLElement[] = [];
        document.querySelectorAll<HTMLElement>('*').forEach((el) => {
          try {
            if (el.hasAttribute('data-bestq')) return; // never touch our own UI
            const style = window.getComputedStyle(el);
            const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
            // A tiny widget (emoji picker, dropdown) that happens to scroll isn't page
            // structure — expanding it would balloon the layout, not reveal content.
            // Only flatten boxes big enough to be holding real page content.
            const bigEnough =
              el.clientHeight >= window.innerHeight * 0.3 &&
              el.clientWidth >= window.innerWidth * 0.3;
            if (scrolls && bigEnough && el.scrollHeight > el.clientHeight + 4) targets.push(el);
          } catch {
            /* skip elements that throw on getComputedStyle */
          }
        });

        for (const el of targets) {
          expand(el);
          // An expanded box still gets clipped by any ancestor that hides overflow, so
          // its new height would never reach the document. Unclip the chain — WITHOUT
          // changing heights, which is what collapses percentage-based layouts.
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const ps = window.getComputedStyle(p);
            if (ps.overflowY !== 'visible' || ps.overflowX !== 'visible') unclip(p);
          }
        }

        // Neutralise `position: sticky`. In a full-page render a stuck element is
        // painted wherever it happens to be pinned, so it lands in the MIDDLE of the
        // image covering real content. As `static` it flows to its natural place and
        // is shown exactly once. (`fixed` is deliberately left alone — it renders once
        // at the top, which is what you want for a page header.)
        document.querySelectorAll<HTMLElement>('*').forEach((el) => {
          try {
            if (el.hasAttribute('data-bestq')) return;
            if (window.getComputedStyle(el).position === 'sticky') {
              save(el);
              el.style.setProperty('position', 'static', 'important');
            }
          } catch {
            /* skip elements that throw on getComputedStyle */
          }
        });

        // Finally let the viewport itself scroll (overflow only — never height).
        unclip(document.documentElement);
        if (document.body) unclip(document.body);
      } catch {
        /* ignore on restricted pages */
      }

      // Let the reflow settle before anyone measures the new document height.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const after = document.documentElement.scrollHeight;
          if (after < before - 4) {
            // Flattening lost content — revert to exactly how we found the page.
            for (const s of expandedScrollers) s.el.style.cssText = s.cssText;
            expandedScrollers = [];
            flattenedEls = new WeakSet<HTMLElement>();
            screenshotScrollEl = findScrollTarget();
            sendResponse({ expanded: 0, scrollHeight: before, reverted: true });
            return;
          }
          screenshotScrollEl = null; // the document scrolls now
          sendResponse({ expanded: expandedScrollers.length, scrollHeight: after });
        });
      });
      return true; // async
    }

    case 'SCREENSHOT_RESTORE_SCROLLERS': {
      for (const s of expandedScrollers) {
        s.el.style.cssText = s.cssText;
      }
      expandedScrollers = [];
      flattenedEls = new WeakSet<HTMLElement>();
      sendResponse({ success: true });
      break;
    }

    case 'SCREENSHOT_GET_DIMENSIONS': {
      // Resolve (once per capture) whether the window or an inner element scrolls.
      screenshotScrollEl = findScrollTarget();

      // viewportWidth/Height is always the FULL viewport: the canvas spans the whole
      // window width (so a left sidebar is kept) and the first frame draws full-width.
      // clip{X,Y,W,H} is the scroll-container's on-screen box — the only region that
      // actually changes between frames, so subsequent frames only redraw that column.
      if (screenshotScrollEl) {
        const el = screenshotScrollEl;
        const rect = el.getBoundingClientRect();
        sendResponse({
          scrollHeight: el.scrollHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          currentScrollX: el.scrollLeft,
          currentScrollY: el.scrollTop,
          devicePixelRatio: window.devicePixelRatio,
          clipX: rect.left,
          clipY: rect.top,
          clipWidth: el.clientWidth,
          clipHeight: el.clientHeight,
          scrollTargetDescription: describeScrollTarget(el),
        });
      } else {
        // Window/document scrolls — the clip column is the full viewport.
        sendResponse({
          scrollHeight: document.documentElement.scrollHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          currentScrollX: window.scrollX,
          currentScrollY: window.scrollY,
          devicePixelRatio: window.devicePixelRatio,
          clipX: 0,
          clipY: 0,
          clipWidth: window.innerWidth,
          clipHeight: window.innerHeight,
          scrollTargetDescription: 'window/document (whole page scrolls)',
        });
      }
      break;
    }

    case 'SCREENSHOT_WAIT_SETTLED': {
      // Lazy-loaded regions (e.g. a comment thread that only fetches once scrolled
      // near) can keep growing well after a fixed timeout would've moved on. Wait
      // until the page has gone quiet — no DOM mutations AND no height change — for
      // `quietMs`, so the caller gets the truly settled height instead of a snapshot
      // mid-load. A page that simply hasn't STARTED its fetch yet also looks "quiet"
      // by this measure, so `minWaitMs` forces an unconditional floor first — without
      // it, a load that starts ~500ms in (typical network latency) never gets caught:
      // nothing has mutated *yet*, so the quiet check fires immediately. `timeoutMs`
      // is a ceiling for pages that never go fully quiet (e.g. a live clock/ticker),
      // so this can't hang the capture forever.
      const {
        timeoutMs = 6000,
        quietMs = 500,
        minWaitMs = 1000,
      } = (message.payload as
        | { timeoutMs?: number; quietMs?: number; minWaitMs?: number }
        | undefined) ?? {};
      const getHeight = () => {
        reresolveScrollTargetIfDetached();
        return screenshotScrollEl
          ? screenshotScrollEl.scrollHeight
          : document.documentElement.scrollHeight;
      };

      const start = Date.now();
      let lastChangeTs = start;
      let lastHeight = getHeight();

      const observer = new MutationObserver(() => {
        lastChangeTs = Date.now();
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      const poll = () => {
        const height = getHeight();
        if (height !== lastHeight) {
          lastHeight = height;
          lastChangeTs = Date.now();
        }
        const now = Date.now();
        const pastFloor = now - start >= minWaitMs;
        const quiet = pastFloor && now - lastChangeTs >= quietMs;
        const timedOut = now - start >= timeoutMs;
        if (quiet || timedOut) {
          observer.disconnect();
          sendResponse({ scrollHeight: getHeight() });
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
      return true; // async
    }

    case 'SCREENSHOT_SCROLL_TO': {
      const { x, y } = message.payload as { x: number; y: number };
      reresolveScrollTargetIfDetached();
      const el = screenshotScrollEl;
      if (el) {
        el.scrollLeft = x;
        el.scrollTop = y;
      } else {
        window.scrollTo(x, y);
      }
      // Double rAF ensures the compositor has painted before background captures
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          sendResponse(
            el
              ? { actualScrollX: el.scrollLeft, actualScrollY: el.scrollTop }
              : { actualScrollX: window.scrollX, actualScrollY: window.scrollY },
          );
        });
      });
      return true; // async
    }

    case 'SCREENSHOT_RESTORE_SCROLL': {
      const { x, y } = message.payload as { x: number; y: number };
      if (screenshotScrollEl) {
        screenshotScrollEl.scrollLeft = x;
        screenshotScrollEl.scrollTop = y;
      } else {
        window.scrollTo(x, y);
      }
      screenshotScrollEl = null; // capture finished — reset for next run
      sendResponse({ success: true });
      break;
    }

    case 'SCREENSHOT_PREPARE_CAPTURE': {
      // Collect fixed/sticky overlays and classify each by where it sits in the
      // viewport, so the background can show it on just one frame instead of every
      // strip. A tall element (e.g. a full-height sidebar) anchors to the top.
      reresolveScrollTargetIfDetached();
      screenshotOverlays = [];
      screenshotLayoutBaseline = (screenshotScrollEl ?? document.documentElement).scrollWidth;
      const vh = window.innerHeight;
      try {
        document.querySelectorAll<HTMLElement>('*').forEach((node) => {
          try {
            const pos = window.getComputedStyle(node).position;
            if (pos !== 'fixed' && pos !== 'sticky') return;
            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            const anchor: OverlayAnchor =
              rect.height >= vh * 0.7 || rect.top + rect.height / 2 < vh * 0.5 ? 'top' : 'bottom';
            screenshotOverlays.push({ el: node, anchor, prevVisibility: node.style.visibility });
          } catch {
            /* skip elements that throw on getComputedStyle */
          }
        });
      } catch {
        /* ignore on restricted pages */
      }
      sendResponse({ success: true });
      break;
    }

    case 'SCREENSHOT_SET_FRAME': {
      // phase decides which overlays are visible for the about-to-be-taken capture:
      //   first  → top-anchored only   (header/sidebar appears once at the top)
      //   last   → bottom-anchored only (footer/composer appears once at the bottom)
      //   middle → none                (clean scrolling content, no repeats)
      const { phase } = message.payload as { phase: 'first' | 'middle' | 'last' };
      reresolveScrollTargetIfDetached();
      for (const o of screenshotOverlays) {
        const show =
          (phase === 'first' && o.anchor === 'top') || (phase === 'last' && o.anchor === 'bottom');
        o.el.style.visibility = show ? o.prevVisibility || 'visible' : 'hidden';
      }

      let layoutBroken = false;
      if (screenshotLayoutBaseline > 0) {
        const nowWidth = (screenshotScrollEl ?? document.documentElement).scrollWidth;
        if (Math.abs(nowWidth - screenshotLayoutBaseline) > screenshotLayoutBaseline * 0.05) {
          layoutBroken = true;
          // Undo this frame's hiding — a collapsed layout is worse than a repeated
          // sticky bar in the stitched image.
          for (const o of screenshotOverlays) {
            o.el.style.visibility = o.prevVisibility;
          }
        }
      }

      sendResponse({ success: true, layoutBroken });
      break;
    }

    case 'SCREENSHOT_RESTORE_CAPTURE': {
      for (const o of screenshotOverlays) {
        o.el.style.visibility = o.prevVisibility;
      }
      screenshotOverlays = [];
      sendResponse({ success: true });
      break;
    }

    case 'SCREENSHOT_SHOW_SELECTOR': {
      console.log('[Content Script] Mounting screenshot selector');
      mountScreenshotSelector();
      sendResponse({ success: true });
      break;
    }

    case 'SCREENSHOT_SHOW_PREVIEW': {
      const { dataUrl, warnings } = message.payload as { dataUrl: string; warnings?: string[] };
      console.log('[Content Script] Mounting screenshot preview');
      mountScreenshotPreview(dataUrl, warnings);
      sendResponse({ success: true });
      break;
    }

    default:
      break;
  }

  return false;
});

// ─── Page Visibility Handling ─────────────────────────────────────────────────

// Pause recording when tab becomes hidden (optional behavior)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && isToolbarVisible) {
    chrome.runtime.sendMessage(
      {
        type: 'GET_STATE',
      } satisfies ExtensionMessage,
      (response) => {
        if (response?.isPaused === false) {
          // Optionally auto-pause – currently disabled for UX reasons
          // chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' })
        }
      },
    );
  }
});

// ─── Toolbar Styles ───────────────────────────────────────────────────────────

function getToolbarStyles(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    :host {
      all: initial;
      display: block;
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: none;
    }

    #jam-toolbar-inner {
      pointer-events: none;
      width: 100%;
      height: 100%;
    }
  `;
}

// ─── Auto-restore on Navigation ───────────────────────────────────────────────
// Backup path: content script asks background for recording state on load.
// Primary path is background pushing SHOW_TOOLBAR via webNavigation listeners.
// The mountToolbar guard (if toolbarContainer) prevents duplicates.

void (async function autoRestoreToolbar() {
  // Retry a few times: on a page refresh the service worker may still be cold, so
  // the first GET_STATE can fail or race the SW's own state restore. The toolbar
  // reappearing is major, so we don't rely on a single attempt (the background
  // navigation listener is a further backup on top of this).
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_STATE',
      } satisfies ExtensionMessage);
      if (!response?.isRecording) return; // definitively not recording — stop trying
      // showToolbar is false for tabs that aren't being recorded (a tab recording
      // only shows the toolbar on its own tab) — so we don't self-mount there.
      if (response?.showToolbar && response?.recordingId) {
        mountToolbar(response.recordingId as string);
        startCapture();
        return;
      }
      return; // recording, but this tab shouldn't show the toolbar
    } catch {
      // SW not ready yet — wait and retry; background nav listener also covers us.
      await new Promise((r) => setTimeout(r, 250));
    }
  }
})();
