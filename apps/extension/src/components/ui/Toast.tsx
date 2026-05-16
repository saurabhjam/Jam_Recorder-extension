import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';
import { cn } from '@/utils';
import { generateId } from '@/utils';

type ToastVariant = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  duration?: number;
}

interface ToastContextValue {
  toasts: Toast[];
  showToast: (message: string, variant?: ToastVariant, duration?: number) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback(
    (message: string, variant: ToastVariant = 'info', duration = 3000) => {
      const id = generateId(8);
      setToasts((prev) => [...prev, { id, message, variant, duration }]);

      if (duration > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, duration);
      }
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

// ─── Toast Container ──────────────────────────────────────────────────────────

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-[340px] pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  );
}

// ─── Toast Item ───────────────────────────────────────────────────────────────

const VARIANT_CONFIG: Record<
  ToastVariant,
  { icon: ReactNode; bg: string; border: string; text: string }
> = {
  success: {
    icon: <CheckCircle size={16} className="text-green-400 shrink-0" />,
    bg: 'bg-dark-800/95',
    border: 'border-green-500/30',
    text: 'text-green-100',
  },
  error: {
    icon: <XCircle size={16} className="text-red-400 shrink-0" />,
    bg: 'bg-dark-800/95',
    border: 'border-red-500/30',
    text: 'text-red-100',
  },
  info: {
    icon: <Info size={16} className="text-jam-400 shrink-0" />,
    bg: 'bg-dark-800/95',
    border: 'border-jam-500/30',
    text: 'text-jam-100',
  },
  warning: {
    icon: <Info size={16} className="text-amber-400 shrink-0" />,
    bg: 'bg-dark-800/95',
    border: 'border-amber-500/30',
    text: 'text-amber-100',
  },
};

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const config = VARIANT_CONFIG[toast.variant];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className={cn(
        'flex items-center gap-3 px-4 py-3 rounded-2xl',
        'backdrop-blur-xl border',
        'shadow-glass pointer-events-auto',
        config.bg,
        config.border,
      )}
    >
      {config.icon}
      <p className={cn('text-sm font-medium flex-1', config.text)}>{toast.message}</p>
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-dark-400 hover:text-white transition-colors ml-1 shrink-0"
      >
        <X size={14} />
      </button>
    </motion.div>
  );
}
