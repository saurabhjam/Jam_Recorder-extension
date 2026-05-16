import { createElement } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, X } from 'lucide-react';
import { AnnotationCanvas } from '../../content/AnnotationCanvas';
import { useRecordingStore } from '../../store/recording.store';

interface AnnotationViewProps {
  /** The screenshot data URL to annotate */
  imageUrl: string;
  /** Called when the user saves the annotated image */
  onSave: () => void;
  /** Called when the user clicks Back/Cancel without saving */
  onBack: () => void;
}

export function AnnotationView({ imageUrl, onSave, onBack }: AnnotationViewProps) {
  const { setAnnotationScreenshot } = useRecordingStore();

  const handleSave = (annotatedDataUrl: string) => {
    // Persist annotated screenshot in the store so BugReportView can pick it up
    setAnnotationScreenshot(annotatedDataUrl);
    onSave();
  };

  const handleClose = () => {
    onBack();
  };

  // The AnnotationCanvas is designed to be mounted as a full-screen overlay inside
  // the content script, but we adapt it here for the popup by wrapping in a
  // relative container that fills the popup dimensions.
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="relative w-full h-full bg-dark-950 flex flex-col overflow-hidden"
    >
      {/* Compact header with back/cancel buttons — sits above the canvas */}
      <div className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between px-3 py-2 bg-dark-950/90 backdrop-blur-sm border-b border-white/8">
        <button
          type="button"
          onClick={handleClose}
          className="flex items-center gap-1.5 text-xs text-dark-300 hover:text-white transition-colors"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <span className="text-xs font-semibold text-white">Annotate Screenshot</span>
        <button type="button" onClick={handleClose} className="icon-btn" aria-label="Cancel">
          <X size={14} />
        </button>
      </div>

      {/* Canvas fills the remaining space below the header */}
      <div className="flex-1 relative mt-10 overflow-hidden">
        {createElement(AnnotationCanvas, {
          imageUrl,
          onSave: handleSave,
          onClose: handleClose,
        })}
      </div>
    </motion.div>
  );
}
