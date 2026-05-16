import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@utils/index';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  showClose?: boolean;
  className?: string;
}

const sizeStyles = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  full: 'max-w-5xl',
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
  showClose = true,
  className,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            {/* Overlay */}
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
              />
            </Dialog.Overlay>

            {/* Content */}
            <Dialog.Content asChild>
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className={cn(
                  'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
                  'w-full p-4',
                  sizeStyles[size],
                )}
              >
                <div
                  className={cn(
                    'relative rounded-xl bg-gray-900 border border-white/[0.08]',
                    'shadow-[0_25px_50px_rgba(0,0,0,0.7)] p-6',
                    className,
                  )}
                >
                  {/* Header */}
                  {(title || showClose) && (
                    <div className="flex items-start justify-between mb-5">
                      <div>
                        {title && (
                          <Dialog.Title className="text-lg font-semibold text-gray-100">
                            {title}
                          </Dialog.Title>
                        )}
                        {description && (
                          <Dialog.Description className="mt-1 text-sm text-gray-400">
                            {description}
                          </Dialog.Description>
                        )}
                      </div>
                      {showClose && (
                        <Dialog.Close
                          onClick={onClose}
                          className="ml-4 flex-shrink-0 rounded-lg p-1.5 text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] transition-colors"
                        >
                          <X className="h-4 w-4" />
                        </Dialog.Close>
                      )}
                    </div>
                  )}
                  {children}
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

interface ModalFooterProps {
  children: React.ReactNode;
  className?: string;
}

export function ModalFooter({ children, className }: ModalFooterProps) {
  return (
    <div className={cn('mt-6 flex items-center justify-end gap-3', className)}>{children}</div>
  );
}
