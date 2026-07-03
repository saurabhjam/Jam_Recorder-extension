/**
 * BestQ — Microphone Permission Page
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
import { INSTANCE_LABEL, IS_PRODUCTION } from '@/config';

const statusEl = document.getElementById('status') as HTMLDivElement;
const hintEl = document.getElementById('hint') as HTMLDivElement;
const retryBtn = document.getElementById('retry') as HTMLButtonElement;

// Mark this page with the build instance to match the rest of the extension:
// a green shield for Production, a yellow flask for QA.
const SHIELD_CHECK_SVG =
  '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>';
const FLASK_SVG =
  '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>';

function renderInstanceBadge(): void {
  if (!INSTANCE_LABEL) return;
  const card = document.querySelector('.card');
  if (!card) return;
  const color = IS_PRODUCTION ? '#34d399' : '#fbbf24';
  const badge = document.createElement('div');
  badge.title = INSTANCE_LABEL;
  badge.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${
    IS_PRODUCTION ? SHIELD_CHECK_SVG : FLASK_SVG
  }</svg>`;
  Object.assign(badge.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    margin: '0 auto 16px',
    borderRadius: '10px',
    border: `1px solid ${IS_PRODUCTION ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.4)'}`,
    background: IS_PRODUCTION ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
  } satisfies Partial<CSSStyleDeclaration>);
  card.insertBefore(badge, card.firstChild);
}

renderInstanceBadge();

async function persistMicEnabled(enabled: boolean): Promise<void> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS]);
  const stored = (res[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings>) ?? {};
  // getUserMedia succeeding here is the ground truth that the extension origin has
  // mic access — record it so the start-recording gate trusts this instead of the
  // flaky Permissions API (which was looping the user back to this page).
  const next: ExtensionSettings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    micEnabled: enabled,
    micPermissionGranted: enabled,
  };
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
    hintEl.textContent = 'Return to BestQ and start your recording.';
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
