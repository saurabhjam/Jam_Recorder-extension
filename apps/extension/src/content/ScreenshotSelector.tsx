import { useState, useEffect, useCallback, useRef } from 'react';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScreenshotSelectorProps {
  onSelect: (bounds: Rect) => void;
  onCancel: () => void;
}

export function ScreenshotSelector({ onSelect, onCancel }: ScreenshotSelectorProps) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [end, setEnd] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  const getRect = useCallback(
    (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    }),
    [],
  );

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setStart({ x: e.clientX, y: e.clientY });
    setEnd({ x: e.clientX, y: e.clientY });
    setDragging(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      setEnd({ x: e.clientX, y: e.clientY });
    },
    [dragging],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging || !start) return;
      setDragging(false);
      const rect = getRect(start, { x: e.clientX, y: e.clientY });
      if (rect.width > 8 && rect.height > 8) {
        onSelect(rect);
      } else {
        setStart(null);
        setEnd(null);
      }
    },
    [dragging, start, getRect, onSelect],
  );

  const sel = start && end ? getRect(start, end) : null;

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483647,
        cursor: 'crosshair',
        userSelect: 'none',
        outline: 'none',
      }}
    >
      {/* Base dim — hidden once selection starts */}
      {!sel && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} />}

      {/* Four-quadrant dim around selection */}
      {sel && (
        <>
          {/* top */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: sel.y,
              background: 'rgba(0,0,0,0.55)',
            }}
          />
          {/* bottom */}
          <div
            style={{
              position: 'absolute',
              top: sel.y + sel.height,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0,0,0,0.55)',
            }}
          />
          {/* left */}
          <div
            style={{
              position: 'absolute',
              top: sel.y,
              left: 0,
              width: sel.x,
              height: sel.height,
              background: 'rgba(0,0,0,0.55)',
            }}
          />
          {/* right */}
          <div
            style={{
              position: 'absolute',
              top: sel.y,
              left: sel.x + sel.width,
              right: 0,
              height: sel.height,
              background: 'rgba(0,0,0,0.55)',
            }}
          />
          {/* Selection border */}
          <div
            style={{
              position: 'absolute',
              left: sel.x,
              top: sel.y,
              width: sel.width,
              height: sel.height,
              border: '2px solid #8b5cf6',
              boxSizing: 'border-box',
              pointerEvents: 'none',
            }}
          >
            {/* Corner handles */}
            {[
              { top: -4, left: -4 },
              { top: -4, right: -4 },
              { bottom: -4, left: -4 },
              { bottom: -4, right: -4 },
            ].map((pos, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  width: 8,
                  height: 8,
                  background: '#8b5cf6',
                  borderRadius: 2,
                  ...pos,
                }}
              />
            ))}
            {/* Dimensions badge */}
            <div
              style={{
                position: 'absolute',
                top: sel.height + 6,
                left: 0,
                background: '#8b5cf6',
                color: '#fff',
                fontSize: 11,
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                padding: '2px 7px',
                borderRadius: 4,
                whiteSpace: 'nowrap',
                lineHeight: 1.6,
              }}
            >
              {sel.width} × {sel.height}
            </div>
          </div>
        </>
      )}

      {/* Instruction hint */}
      {!dragging && !sel && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(15,10,30,0.88)',
            border: '1px solid rgba(139,92,246,0.4)',
            color: '#e2d9f3',
            padding: '12px 22px',
            borderRadius: 10,
            fontSize: 13,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            pointerEvents: 'none',
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          Drag to select an area
          <br />
          <span style={{ fontSize: 11, color: '#9171d4' }}>Press Esc to cancel</span>
        </div>
      )}

      {/* Cancel button */}
      <button
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onCancel}
        style={{
          position: 'absolute',
          top: 14,
          right: 14,
          background: 'rgba(15,10,30,0.88)',
          border: '1px solid rgba(255,255,255,0.18)',
          borderRadius: 8,
          color: '#e2d9f3',
          padding: '6px 14px',
          fontSize: 12,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          cursor: 'pointer',
          zIndex: 1,
        }}
      >
        Cancel (Esc)
      </button>
    </div>
  );
}
