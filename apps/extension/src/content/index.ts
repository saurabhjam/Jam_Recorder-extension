/**
 * SnapTrace – Content Script
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
    __snaptraceCaptureInitialized?: boolean;
  }
}

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
let networkCaptures: CaptureNetworkEntry[] = [];
let consoleLogs: CaptureConsoleLog[] = [];

// ─── Toolbar Management ───────────────────────────────────────────────────────

function mountToolbar(recordingId: string): void {
  if (toolbarContainer) return; // Already mounted

  toolbarContainer = document.createElement('div');
  toolbarContainer.id = 'jam-toolbar-root';
  toolbarContainer.setAttribute('data-jam', 'true');

  // Prevent site CSS from affecting our toolbar
  const shadow = toolbarContainer.attachShadow?.({ mode: 'open' });

  if (shadow) {
    // Inject styles into shadow DOM
    const style = document.createElement('style');
    style.textContent = getToolbarStyles();
    shadow.appendChild(style);

    const inner = document.createElement('div');
    inner.id = 'jam-toolbar-inner';
    shadow.appendChild(inner);

    document.body.appendChild(toolbarContainer);
    toolbarRoot = createRoot(inner);
  } else {
    document.body.appendChild(toolbarContainer);
    toolbarRoot = createRoot(toolbarContainer);
  }

  isToolbarVisible = true;
  renderToolbar(recordingId);
}

function renderToolbar(recordingId: string): void {
  if (!toolbarRoot) return;

  toolbarRoot.render(
    createElement(FloatingToolbar, {
      recordingId,
      duration: currentDuration,
      onStop: () => {
        chrome.runtime.sendMessage({ type: 'STOP_RECORDING' } satisfies ExtensionMessage);
      },
      onPause: () => {
        chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' } satisfies ExtensionMessage);
      },
      onResume: () => {
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
  screenshotSelectorContainer.id = 'snaptrace-screenshot-selector';
  screenshotSelectorContainer.setAttribute('data-snaptrace', 'true');
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

function mountScreenshotPreview(dataUrl: string): void {
  console.log(
    '[Content Script] mountScreenshotPreview called with dataUrl length:',
    dataUrl.length,
  );
  unmountScreenshotPreview();

  screenshotPreviewContainer = document.createElement('div');
  screenshotPreviewContainer.id = 'snaptrace-screenshot-preview';
  screenshotPreviewContainer.setAttribute('data-snaptrace', 'true');
  document.body.appendChild(screenshotPreviewContainer);
  console.log('[Content Script] Screenshot preview container created and appended');
  screenshotPreviewRoot = createRoot(screenshotPreviewContainer);

  screenshotPreviewRoot.render(
    createElement(ScreenshotPreview, {
      dataUrl,
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
  if (window.__snaptraceCaptureInitialized) return;

  window.__snaptraceCaptureInitialized = true;

  networkCaptures = [];
  consoleLogs = [];

  // The main-world XHR/fetch/console patching is injected by the background
  // service worker via chrome.scripting.executeScript({ world: 'MAIN' }),
  // which bypasses page CSP. We only need to listen for the postMessages here.
  window.addEventListener('message', handlePageMessage);
}

function stopCapture(): void {
  window.removeEventListener('message', handlePageMessage);
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

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  console.log('[Content Script] Received message:', message.type);

  switch (message.type) {
    case 'SHOW_TOOLBAR': {
      const payload = message.payload as { recordingId: string } | undefined;
      if (payload?.recordingId) {
        mountToolbar(payload.recordingId);
        startCapture();
      }
      sendResponse({ success: true });
      break;
    }

    case 'HIDE_TOOLBAR': {
      stopCapture();
      unmountToolbar();
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

    // ── Screenshot workflow ──────────────────────────────────────────────────

    case 'SCREENSHOT_GET_DIMENSIONS': {
      sendResponse({
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        currentScrollX: window.scrollX,
        currentScrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio,
      });
      break;
    }

    case 'SCREENSHOT_SCROLL_TO': {
      const { x, y } = message.payload as { x: number; y: number };
      window.scrollTo(x, y);
      // Double rAF ensures the compositor has painted before background captures
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          sendResponse({ actualScrollX: window.scrollX, actualScrollY: window.scrollY });
        });
      });
      return true; // async
    }

    case 'SCREENSHOT_RESTORE_SCROLL': {
      const { x, y } = message.payload as { x: number; y: number };
      window.scrollTo({ left: x, top: y, behavior: 'instant' });
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
      const { dataUrl } = message.payload as { dataUrl: string };
      console.log('[Content Script] Mounting screenshot preview');
      mountScreenshotPreview(dataUrl);
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
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_STATE',
    } satisfies ExtensionMessage);
    if (response?.isRecording && response?.recordingId && !toolbarContainer) {
      mountToolbar(response.recordingId as string);
      startCapture();
    }
  } catch {
    // SW not ready — background navigation listener will inject instead
  }
})();
