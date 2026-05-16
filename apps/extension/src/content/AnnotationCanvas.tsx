import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Pen,
  ArrowUpRight,
  Square,
  Circle,
  Type,
  Highlighter,
  Eraser,
  Undo2,
  Redo2,
  Trash2,
  Download,
  X,
  Check,
} from 'lucide-react';
import type { AnnotationTool } from '@/types';
import { ANNOTATION_COLORS } from '@/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnnotationCanvasProps {
  imageUrl: string;
  onSave: (annotatedUrl: string) => void;
  onClose: () => void;
}

interface CanvasState {
  imageData: ImageData | null;
}

// ─── Tool Config ──────────────────────────────────────────────────────────────

const TOOLS: Array<{
  id: AnnotationTool;
  icon: React.ReactNode;
  label: string;
  cursor: string;
}> = [
  { id: 'pen', icon: <Pen size={16} />, label: 'Pen', cursor: 'crosshair' },
  { id: 'arrow', icon: <ArrowUpRight size={16} />, label: 'Arrow', cursor: 'crosshair' },
  { id: 'rectangle', icon: <Square size={16} />, label: 'Rectangle', cursor: 'crosshair' },
  { id: 'circle', icon: <Circle size={16} />, label: 'Circle', cursor: 'crosshair' },
  { id: 'text', icon: <Type size={16} />, label: 'Text', cursor: 'text' },
  { id: 'highlight', icon: <Highlighter size={16} />, label: 'Highlight', cursor: 'crosshair' },
  { id: 'eraser', icon: <Eraser size={16} />, label: 'Eraser', cursor: 'cell' },
];

const STROKE_WIDTHS = [2, 4, 8, 16];

// ─── AnnotationCanvas ─────────────────────────────────────────────────────────

export function AnnotationCanvas({ imageUrl, onSave, onClose }: AnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const [activeTool, setActiveTool] = useState<AnnotationTool>('pen');
  const [activeColor, setActiveColor] = useState('#ef4444');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [isDrawing, setIsDrawing] = useState(false);
  const [history, setHistory] = useState<CanvasState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const startPoint = useRef<{ x: number; y: number } | null>(null);
  const ctx = useRef<CanvasRenderingContext2D | null>(null);
  const overlayCtx = useRef<CanvasRenderingContext2D | null>(null);

  // ── Initialize Canvas ─────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayCanvasRef.current;
    if (!canvas || !overlay) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      const w = img.naturalWidth || window.innerWidth;
      const h = img.naturalHeight || window.innerHeight;

      canvas.width = w;
      canvas.height = h;
      overlay.width = w;
      overlay.height = h;

      const context = canvas.getContext('2d');
      const overlayContext = overlay.getContext('2d');

      if (!context || !overlayContext) return;

      ctx.current = context;
      overlayCtx.current = overlayContext;

      context.drawImage(img, 0, 0);

      // Save initial state
      const initialState: CanvasState = {
        imageData: context.getImageData(0, 0, w, h),
      };
      setHistory([initialState]);
      setHistoryIndex(0);
    };

    img.onerror = () => {
      // Draw placeholder if image fails
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = w;
      canvas.height = h;
      overlay.width = w;
      overlay.height = h;

      const context = canvas.getContext('2d');
      if (context) {
        context.fillStyle = '#0f172a';
        context.fillRect(0, 0, w, h);
        ctx.current = context;
      }
      overlayCtx.current = overlay.getContext('2d');
    };

    img.src = imageUrl;
  }, [imageUrl]);

  // ── Canvas Event Helpers ──────────────────────────────────────────────────

  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  const setupDrawingContext = useCallback(
    (context: CanvasRenderingContext2D) => {
      context.strokeStyle =
        activeTool === 'highlight'
          ? activeColor + '60'
          : activeTool === 'eraser'
            ? '#000000'
            : activeColor;

      context.lineWidth = activeTool === 'highlight' ? strokeWidth * 3 : strokeWidth;
      context.lineCap = 'round';
      context.lineJoin = 'round';

      if (activeTool === 'highlight') {
        context.globalCompositeOperation = 'multiply';
        context.globalAlpha = 0.5;
      } else if (activeTool === 'eraser') {
        context.globalCompositeOperation = 'destination-out';
        context.globalAlpha = 1;
      } else {
        context.globalCompositeOperation = 'source-over';
        context.globalAlpha = 1;
      }
    },
    [activeTool, activeColor, strokeWidth],
  );

  // ── Drawing Handlers ──────────────────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      setIsDrawing(true);
      const coords = getCanvasCoords(e);
      startPoint.current = coords;

      if (activeTool === 'pen' || activeTool === 'eraser' || activeTool === 'highlight') {
        const context = ctx.current;
        if (!context) return;

        setupDrawingContext(context);
        context.beginPath();
        context.moveTo(coords.x, coords.y);
      }

      if (activeTool === 'text') {
        const text = prompt('Enter text:');
        if (text && ctx.current) {
          const context = ctx.current;
          context.font = `${strokeWidth * 6}px Inter, sans-serif`;
          context.fillStyle = activeColor;
          context.globalAlpha = 1;
          context.globalCompositeOperation = 'source-over';
          context.fillText(text, coords.x, coords.y);
          saveState();
        }
        setIsDrawing(false);
        startPoint.current = null;
      }
    },
    [activeTool, getCanvasCoords, setupDrawingContext, activeColor, strokeWidth],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawing || !startPoint.current) return;

      const coords = getCanvasCoords(e);

      if (activeTool === 'pen' || activeTool === 'eraser' || activeTool === 'highlight') {
        const context = ctx.current;
        if (!context) return;
        context.lineTo(coords.x, coords.y);
        context.stroke();
      } else {
        // For shapes: draw on overlay canvas to show preview
        const oCtx = overlayCtx.current;
        if (!oCtx) return;

        oCtx.clearRect(0, 0, overlayCanvasRef.current!.width, overlayCanvasRef.current!.height);
        oCtx.strokeStyle = activeColor;
        oCtx.lineWidth = strokeWidth;
        oCtx.lineCap = 'round';
        oCtx.globalAlpha = 1;
        oCtx.globalCompositeOperation = 'source-over';

        const start = startPoint.current;
        const dx = coords.x - start.x;
        const dy = coords.y - start.y;

        oCtx.beginPath();

        if (activeTool === 'rectangle') {
          oCtx.strokeRect(start.x, start.y, dx, dy);
        } else if (activeTool === 'circle') {
          const rx = Math.abs(dx) / 2;
          const ry = Math.abs(dy) / 2;
          oCtx.ellipse(start.x + dx / 2, start.y + dy / 2, rx, ry, 0, 0, Math.PI * 2);
          oCtx.stroke();
        } else if (activeTool === 'arrow') {
          drawArrow(oCtx, start.x, start.y, coords.x, coords.y);
        }
      }
    },
    [isDrawing, activeTool, getCanvasCoords, activeColor, strokeWidth],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawing) return;
      setIsDrawing(false);

      const coords = getCanvasCoords(e);

      if (
        activeTool !== 'pen' &&
        activeTool !== 'eraser' &&
        activeTool !== 'highlight' &&
        activeTool !== 'text' &&
        startPoint.current
      ) {
        // Commit overlay to main canvas
        const mainCtx = ctx.current;
        const oCtx = overlayCtx.current;
        if (!mainCtx || !oCtx) return;

        const canvas = overlayCanvasRef.current!;
        oCtx.clearRect(0, 0, canvas.width, canvas.height);

        mainCtx.strokeStyle = activeColor;
        mainCtx.lineWidth = strokeWidth;
        mainCtx.lineCap = 'round';
        mainCtx.globalAlpha = 1;
        mainCtx.globalCompositeOperation = 'source-over';

        const start = startPoint.current;
        const dx = coords.x - start.x;
        const dy = coords.y - start.y;

        mainCtx.beginPath();

        if (activeTool === 'rectangle') {
          mainCtx.strokeRect(start.x, start.y, dx, dy);
        } else if (activeTool === 'circle') {
          const rx = Math.abs(dx) / 2;
          const ry = Math.abs(dy) / 2;
          mainCtx.ellipse(start.x + dx / 2, start.y + dy / 2, rx, ry, 0, 0, Math.PI * 2);
          mainCtx.stroke();
        } else if (activeTool === 'arrow') {
          drawArrow(mainCtx, start.x, start.y, coords.x, coords.y);
        }
      }

      startPoint.current = null;
      saveState();
    },
    [isDrawing, activeTool, getCanvasCoords, activeColor, strokeWidth],
  );

  // ── State Management ──────────────────────────────────────────────────────

  const saveState = useCallback(() => {
    const canvas = canvasRef.current;
    const context = ctx.current;
    if (!canvas || !context) return;

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const newHistory = history.slice(0, historyIndex + 1);
    const trimmed = newHistory.slice(-50); // max 50 states
    setHistory([...trimmed, { imageData }]);
    setHistoryIndex(trimmed.length);
  }, [history, historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex <= 0) return;
    const newIndex = historyIndex - 1;
    const state = history[newIndex];

    if (state?.imageData && ctx.current && canvasRef.current) {
      ctx.current.putImageData(state.imageData, 0, 0);
    }
    setHistoryIndex(newIndex);
  }, [history, historyIndex]);

  const redo = useCallback(() => {
    if (historyIndex >= history.length - 1) return;
    const newIndex = historyIndex + 1;
    const state = history[newIndex];

    if (state?.imageData && ctx.current && canvasRef.current) {
      ctx.current.putImageData(state.imageData, 0, 0);
    }
    setHistoryIndex(newIndex);
  }, [history, historyIndex]);

  const clearCanvas = useCallback(() => {
    if (!ctx.current || !canvasRef.current) return;
    const { width, height } = canvasRef.current;
    ctx.current.clearRect(0, 0, width, height);

    // Restore background image
    if (history[0]?.imageData) {
      ctx.current.putImageData(history[0].imageData, 0, 0);
      setHistoryIndex(0);
    }
  }, [history]);

  const handleSave = useCallback(() => {
    if (!canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL('image/png');
    onSave(dataUrl);
  }, [onSave]);

  const handleDownload = useCallback(() => {
    if (!canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `jam-screenshot-${Date.now()}.png`;
    link.href = dataUrl;
    link.click();
  }, []);

  // ── Keyboard Shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, undo, redo, handleSave]);

  const currentTool = TOOLS.find((t) => t.id === activeTool);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483646,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Canvas Area */}
      <div
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          cursor: currentTool?.cursor ?? 'crosshair',
        }}
      >
        {/* Main canvas */}
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
          }}
        />

        {/* Overlay canvas for shape preview */}
        <canvas
          ref={overlayCanvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
          }}
        />
      </div>

      {/* Toolbar */}
      <div
        style={{
          position: 'fixed',
          bottom: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 14px',
          background: 'rgba(9,9,11,0.96)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '20px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          zIndex: 2147483647,
        }}
      >
        {/* Tools */}
        {TOOLS.map((tool) => (
          <AnnotationToolButton
            key={tool.id}
            active={activeTool === tool.id}
            title={tool.label}
            onClick={() => setActiveTool(tool.id)}
          >
            {tool.icon}
          </AnnotationToolButton>
        ))}

        {/* Divider */}
        <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.1)' }} />

        {/* Colors */}
        {ANNOTATION_COLORS.slice(0, 6).map((color) => (
          <button
            key={color.value}
            onClick={() => setActiveColor(color.value)}
            title={color.name}
            style={{
              width: '20px',
              height: '20px',
              borderRadius: '50%',
              background: color.value,
              border: activeColor === color.value ? '2px solid white' : '2px solid transparent',
              cursor: 'pointer',
              flexShrink: 0,
              transition: 'transform 0.15s ease',
              transform: activeColor === color.value ? 'scale(1.2)' : 'scale(1)',
            }}
          />
        ))}

        {/* Divider */}
        <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.1)' }} />

        {/* Stroke widths */}
        {STROKE_WIDTHS.map((w) => (
          <button
            key={w}
            onClick={() => setStrokeWidth(w)}
            title={`${w}px`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '28px',
              height: '28px',
              borderRadius: '8px',
              border: 'none',
              background: strokeWidth === w ? 'rgba(99,102,241,0.3)' : 'transparent',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: Math.min(w * 1.5, 20),
                height: Math.min(w * 1.5, 20),
                borderRadius: '50%',
                background: activeColor,
              }}
            />
          </button>
        ))}

        {/* Divider */}
        <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.1)' }} />

        {/* Actions */}
        <AnnotationToolButton title="Undo (⌘Z)" onClick={undo} disabled={historyIndex <= 0}>
          <Undo2 size={16} />
        </AnnotationToolButton>

        <AnnotationToolButton
          title="Redo (⌘⇧Z)"
          onClick={redo}
          disabled={historyIndex >= history.length - 1}
        >
          <Redo2 size={16} />
        </AnnotationToolButton>

        <AnnotationToolButton title="Clear All" onClick={clearCanvas}>
          <Trash2 size={16} />
        </AnnotationToolButton>

        <AnnotationToolButton title="Download" onClick={handleDownload}>
          <Download size={16} />
        </AnnotationToolButton>

        {/* Save */}
        <button
          onClick={handleSave}
          title="Save & Share"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            height: '32px',
            padding: '0 12px',
            borderRadius: '10px',
            border: 'none',
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            color: 'white',
            fontSize: '12px',
            fontWeight: '600',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <Check size={14} />
          Save
        </button>

        {/* Close */}
        <AnnotationToolButton title="Close (Esc)" onClick={onClose}>
          <X size={16} style={{ color: '#f87171' }} />
        </AnnotationToolButton>
      </div>
    </motion.div>
  );
}

// ─── Annotation Tool Button ───────────────────────────────────────────────────

interface AnnotationToolButtonProps {
  active?: boolean;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}

function AnnotationToolButton({
  active = false,
  title,
  onClick,
  disabled = false,
  children,
}: AnnotationToolButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '32px',
        height: '32px',
        borderRadius: '10px',
        border: 'none',
        background: active ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.06)',
        color: active ? '#a5b4fc' : disabled ? 'rgba(148,163,184,0.3)' : 'rgba(148,163,184,0.9)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all 0.15s ease',
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

// ─── Draw Arrow Helper ────────────────────────────────────────────────────────

function drawArrow(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): void {
  const headLength = 20;
  const angle = Math.atan2(toY - fromY, toX - fromX);

  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  // Arrowhead
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - headLength * Math.cos(angle - Math.PI / 6),
    toY - headLength * Math.sin(angle - Math.PI / 6),
  );
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - headLength * Math.cos(angle + Math.PI / 6),
    toY - headLength * Math.sin(angle + Math.PI / 6),
  );
  ctx.stroke();
}
