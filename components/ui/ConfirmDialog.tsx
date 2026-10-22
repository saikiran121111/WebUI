"use client";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "../../lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open, title, message,
  confirmLabel = "OK", cancelLabel = "Cancel",
  danger = false,
  onConfirm, onCancel,
}: ConfirmDialogProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[999] flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="surface-glass relative z-10 w-[340px] rounded-2xl
              border-[rgba(255,255,255,0.15)] shadow-2xl p-5 space-y-4"
          >
            <h3 className="text-[15px] font-semibold text-white/95">{title}</h3>
            <p className="text-sm text-white/55 leading-relaxed">{message}</p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onCancel}
                className="px-4 py-1.5 rounded-lg text-sm font-medium text-white/70
                  hover:bg-white/[0.06] transition-colors duration-[120ms]"
              >
                {cancelLabel}
              </button>
              <button
                onClick={onConfirm}
                data-testid="confirm-dialog-confirm"
                className={cn(
                  "px-4 py-1.5 rounded-lg text-sm font-medium transition-colors duration-[120ms]",
                  danger
                    ? "bg-white text-black hover:bg-white/90"
                    : "bg-white/[0.15] hover:bg-white/[0.25] text-white/90",
                )}
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
