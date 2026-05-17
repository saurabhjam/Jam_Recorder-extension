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
let currentDuration = 0;
let isToolbarVisible = false;
let networkCaptures: CaptureNetworkEntry[] = [];
let consoleLogs: CaptureConsoleLog[] = [];
let isCapturing = false;

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

// ─── Network Capture ──────────────────────────────────────────────────────────

function startCapture(): void {
  if (window.__snaptraceCaptureInitialized) return;

  window.__snaptraceCaptureInitialized = true;

  isCapturing = true;
  networkCaptures = [];
  consoleLogs = [];

  // Inject interceptor into the page's own JS context (bypasses content-script isolation)
  const script = document.createElement('script');
  script.textContent = `
(function() {
  if (window.__stCapture) return;
  window.__stCapture = true;

  function post(data) { window.postMessage(Object.assign({ __st: true }, data), '*'); }

  // ── XHR interception ──────────────────────────────────────────────────────
  var _XHR = window.XMLHttpRequest;
  function PatchedXHR() {
    var xhr = new _XHR();
    var meta = { url: '', method: 'GET', start: 0 };
    var origOpen = xhr.open.bind(xhr);
    xhr.open = function(method, url) {
      meta.method = String(method).toUpperCase();
      meta.url = typeof url === 'string' ? url : String(url);
      return origOpen.apply(xhr, arguments);
    };
    var origSend = xhr.send.bind(xhr);
    xhr.send = function() {
      meta.start = Date.now();
      xhr.addEventListener('loadend', function() {
        post({ kind:'network', url:meta.url, method:meta.method, status:xhr.status,
               statusText:xhr.statusText, duration:Date.now()-meta.start,
               size:parseInt(xhr.getResponseHeader('content-length')||'0')||0,
               timestamp:meta.start, failed:xhr.status===0 });
      });
      return origSend.apply(xhr, arguments);
    };
    return xhr;
  }
  PatchedXHR.prototype = _XHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // ── fetch interception ────────────────────────────────────────────────────
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input==='string' ? input : (input&&input.url) ? input.url : String(input);
    var method = ((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
    var start = Date.now();
    return _fetch(input, init).then(function(response) {
      var clone = response.clone();
      clone.arrayBuffer().catch(function(){return new ArrayBuffer(0);}).then(function(buf) {
        post({ kind:'network', url:url, method:method, status:response.status,
               statusText:response.statusText, duration:Date.now()-start,
               size:buf.byteLength, timestamp:start, failed:false });
      });
      return response;
    }, function(err) {
      post({ kind:'network', url:url, method:method, status:0, statusText:'',
             duration:Date.now()-start, size:0, timestamp:start, failed:true,
             errorText: err && err.message ? err.message : String(err) });
      throw err;
    });
  };

  // ── console interception ──────────────────────────────────────────────────
  var _con = {};
  ['log','info','warn','error','debug'].forEach(function(lvl) {
    _con[lvl] = console[lvl].bind(console);
    console[lvl] = function() {
      _con[lvl].apply(console, arguments);
      var msg = Array.prototype.slice.call(arguments).map(function(a) {
        try { return typeof a==='object' ? JSON.stringify(a) : String(a); } catch(e) { return String(a); }
      }).join(' ');
      post({ kind:'console', level:lvl, message:msg, timestamp:Date.now(), url:window.location.href });
    };
  });

  // ── uncaught errors ───────────────────────────────────────────────────────
  window.addEventListener('error', function(ev) {
    post({ kind:'console', level:'error', message:ev.message||String(ev), timestamp:Date.now(), url:window.location.href });
  });
  window.addEventListener('unhandledrejection', function(ev) {
    var msg = ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason);
    post({ kind:'console', level:'error', message:'Unhandled rejection: '+msg, timestamp:Date.now(), url:window.location.href });
  });
})();
  `;
  document.head.appendChild(script);
  script.remove();

  window.addEventListener('message', handlePageMessage);
}

function stopCapture(): void {
  isCapturing = false;
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
