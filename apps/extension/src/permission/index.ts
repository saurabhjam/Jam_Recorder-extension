/**
 * SnapTrace — Microphone Permission Page
 *
 * An offscreen document and the action popup cannot reliably show the mic
 * permission prompt: the popup closes as soon as the prompt steals focus.
 * This page runs in a normal tab, so `getUserMedia` can surface the prompt and
 * the grant persists for the extension origin — after which the offscreen
 * recorder can capture the mic without any further prompt.
 *
 * The result is written back to settings so the popup reflects it on reopen,
 * and broadcast so an open popup can update live.
 */

import { STORAGE_KEYS, DEFAULT_SETTINGS } from '@/types';
import type { ExtensionSettings } from '@/types';

const statusEl = document.getElementById('status') as HTMLDivElement;
const hintEl = document.getElementById('hint') as HTMLDivElement;
const retryBtn = document.getElementById('retry') as HTMLButtonElement;

async function persistMicEnabled(enabled: boolean): Promise<void> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS]);
  const stored = (res[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings>) ?? {};
  const next: ExtensionSettings = { ...DEFAULT_SETTINGS, ...stored, micEnabled: enabled };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  // Let an open popup update its toggle without waiting for a reopen.
  chrome.runtime
    .sendMessage({ type: 'MIC_PERMISSION_RESULT', payload: { granted: enabled } })
    .catch(() => {
      /* no listener — safe to ignore */
    });
}

function setStatus(text: string, kind: 'ok' | 'err' | ''): void {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
}

async function requestMic(): Promise<void> {
  retryBtn.disabled = true;
  setStatus('Requesting microphone…', '');
  hintEl.textContent = '';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // We only needed the grant — release the device immediately.
    stream.getTracks().forEach((t) => t.stop());
    await persistMicEnabled(true);
    setStatus('Microphone enabled! You can close this tab.', 'ok');
    hintEl.textContent = 'Return to SnapTrace and start your recording.';
    retryBtn.textContent = 'Close';
    retryBtn.disabled = false;
    retryBtn.onclick = () => window.close();
    setTimeout(() => window.close(), 1500);
  } catch (err) {
    await persistMicEnabled(false);
    const denied =
      err instanceof DOMException &&
      (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    setStatus(
      denied ? 'Microphone access was blocked.' : 'Could not access the microphone.',
      'err',
    );
    hintEl.textContent = denied
      ? 'Click the camera/lock icon in the address bar to allow the microphone, then try again.'
      : err instanceof Error
        ? err.message
        : 'Please check that a microphone is connected.';
    retryBtn.disabled = false;
    retryBtn.textContent = 'Try again';
  }
}

retryBtn.onclick = () => void requestMic();

// Kick off the request automatically on load.
void requestMic();
