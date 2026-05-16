import { useState, useCallback } from 'react';

interface UseClipboardReturn {
  copied: boolean;
  copy: (text: string) => Promise<boolean>;
  reset: () => void;
}

export function useClipboard(resetDelay = 2000): UseClipboardReturn {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        // Try modern Clipboard API first
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          // Fallback for extension popups
          const textArea = document.createElement('textarea');
          textArea.value = text;
          textArea.style.position = 'fixed';
          textArea.style.left = '-9999px';
          textArea.style.top = '-9999px';
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();

          const success = document.execCommand('copy');
          document.body.removeChild(textArea);

          if (!success) throw new Error('execCommand copy failed');
        }

        setCopied(true);
        if (resetDelay > 0) {
          setTimeout(() => setCopied(false), resetDelay);
        }
        return true;
      } catch (err) {
        console.error('[useClipboard] Copy failed:', err);
        return false;
      }
    },
    [resetDelay],
  );

  const reset = useCallback(() => {
    setCopied(false);
  }, []);

  return { copied, copy, reset };
}
