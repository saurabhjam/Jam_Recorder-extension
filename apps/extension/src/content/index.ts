/**
 * SnapTrace – Content Script
 *
 * Injected into every page. Responsibilities:
 *  - Mount/unmount the floating recording toolbar
 *  - Mount/unmount the annotation canvas overlay
 *  - Mount/unmount the recording preview panel
 *  - Listen to messages from the background service worker
 *  - Relay tab-level events back to background
 *  - Capture network requests during recording
 */

import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import type { ExtensionMessage } from '@/types';
import { FloatingToolbar } from './FloatingToolbar';
import { AnnotationCanvas } from './AnnotationCanvas';
import { RecordingPreviewPanel } from './RecordingPreviewPanel';

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface NetworkCapture {
  url: string;
  method: string;
  status: number;
  duration: number;
  timestamp: number;
  size: number;
}

interface PreviewPayload {
  thumbnailDataUrl: string | null;
  duration: number;
  blobSize: number;
  shareUrl: string | null;
  uploadProgress: number;
  errorMessage?: string | null;
}

// ─── State ────────────────────────────────────────────────────────────────────

let toolbarContainer: HTMLElement | null = null;
let toolbarRoot: Root | null = null;
let annotationContainer: HTMLElement | null = null;
let annotationRoot: Root | null = null;
let previewContainer: HTMLElement | null = null;
let previewRoot: Root | null = null;
let currentDuration = 0;
let isToolbarVisible = false;
let networkCaptures: NetworkCapture[] = [];
let isCapturingNetwork = false;

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

// ─── Preview Panel Management ─────────────────────────────────────────────────

function handleSignIn(): void {
  chrome.runtime.sendMessage({ type: 'OPEN_POPUP' } satisfies ExtensionMessage);
}

function mountPreviewPanel(payload: PreviewPayload): void {
  if (previewContainer) {
    // Update existing panel
    previewRoot?.render(
      createElement(RecordingPreviewPanel, {
        ...payload,
        networkCaptures,
        onClose: unmountPreviewPanel,
        onCopied: () => {},
        onSignIn: handleSignIn,
      }),
    );
    return;
  }

  previewContainer = document.createElement('div');
  previewContainer.id = 'snaptrace-preview-root';
  previewContainer.setAttribute('data-snaptrace', 'true');
  previewContainer.style.cssText = [
    'position: fixed',
    'top: 0',
    'right: 0',
    'width: 380px',
    'height: 100vh',
    'z-index: 2147483645',
    'pointer-events: all',
    'font-family: Inter, system-ui, sans-serif',
  ].join('; ');

  document.body.appendChild(previewContainer);
  previewRoot = createRoot(previewContainer);
  previewRoot.render(
    createElement(RecordingPreviewPanel, {
      ...payload,
      networkCaptures,
      onClose: unmountPreviewPanel,
      onCopied: () => {},
      onSignIn: handleSignIn,
    }),
  );
}

function unmountPreviewPanel(): void {
  if (previewRoot) {
    previewRoot.unmount();
    previewRoot = null;
  }
  if (previewContainer) {
    previewContainer.remove();
    previewContainer = null;
  }
}

// ─── Network Capture ──────────────────────────────────────────────────────────

function startNetworkCapture(): void {
  if (isCapturingNetwork) return;
  isCapturingNetwork = true;
  networkCaptures = [];

  // Inject interceptor script into page context
  const script = document.createElement('script');
  script.textContent = `
(function() {
  if (window.__snaptraceNetCapture) return;
  window.__snaptraceNetCapture = true;

  const _XHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new _XHR();
    const meta = { url: '', method: 'GET', start: 0 };
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function(method, url, ...rest) {
      meta.method = method;
      meta.url = typeof url === 'string' ? url : String(url);
      return origOpen(method, url, ...rest);
    };
    const origSend = xhr.send.bind(xhr);
    xhr.send = function(...args) {
      meta.start = Date.now();
      xhr.addEventListener('loadend', function() {
        window.postMessage({
          __snaptrace: true,
          type: 'network',
          url: meta.url,
          method: meta.method,
          status: xhr.status,
          duration: Date.now() - meta.start,
          size: parseInt(xhr.getResponseHeader('content-length') || '0') || 0,
          timestamp: meta.start,
        }, '*');
      });
      return origSend(...args);
    };
    return xhr;
  }
  PatchedXHR.prototype = _XHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  const _fetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const start = Date.now();
    try {
      const response = await _fetch(input, init);
      const clone = response.clone();
      const buf = await clone.arrayBuffer().catch(() => new ArrayBuffer(0));
      window.postMessage({
        __snaptrace: true,
        type: 'network',
        url,
        method,
        status: response.status,
        duration: Date.now() - start,
        size: buf.byteLength,
        timestamp: start,
      }, '*');
      return response;
    } catch(err) {
      window.postMessage({
        __snaptrace: true,
        type: 'network',
        url,
        method,
        status: 0,
        duration: Date.now() - start,
        size: 0,
        timestamp: start,
      }, '*');
      throw err;
    }
  };
})();
  `;
  document.head.appendChild(script);
  script.remove();

  window.addEventListener('message', handlePageNetworkMessage);
}

function stopNetworkCapture(): NetworkCapture[] {
  isCapturingNetwork = false;
  window.removeEventListener('message', handlePageNetworkMessage);
  return networkCaptures;
}

function handlePageNetworkMessage(e: MessageEvent): void {
  if (!e.data?.__snaptrace || e.data.type !== 'network') return;
  networkCaptures.push({
    url: e.data.url as string,
    method: e.data.method as string,
    status: e.data.status as number,
    duration: e.data.duration as number,
    timestamp: e.data.timestamp as number,
    size: e.data.size as number,
  });
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  switch (message.type) {
    case 'SHOW_TOOLBAR': {
      const payload = message.payload as { recordingId: string } | undefined;
      if (payload?.recordingId) {
        mountToolbar(payload.recordingId);
        startNetworkCapture();
      }
      sendResponse({ success: true });
      break;
    }

    case 'HIDE_TOOLBAR': {
      stopNetworkCapture();
      unmountToolbar();
      sendResponse({ success: true });
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

    case 'SHOW_PREVIEW': {
      const payload = message.payload as PreviewPayload;
      mountPreviewPanel(payload);
      sendResponse({ success: true });
      break;
    }

    case 'UPDATE_PREVIEW': {
      const payload = message.payload as PreviewPayload;
      mountPreviewPanel(payload); // updates existing panel
      sendResponse({ success: true });
      break;
    }

    case 'RECORDING_ERROR': {
      // Show error in the preview panel if it's open
      if (previewRoot && previewContainer) {
        const errMsg =
          (message as { error?: string }).error ?? 'Upload failed — check console for details';
        mountPreviewPanel({
          thumbnailDataUrl: null,
          duration: 0,
          blobSize: 0,
          shareUrl: null,
          uploadProgress: 0,
          errorMessage: errMsg,
        });
      }
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
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }

    :host {
      all: initial;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }

    #jam-toolbar-inner {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
    }
  `;
}
