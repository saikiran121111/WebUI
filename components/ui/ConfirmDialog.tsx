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
          className="fixed inset-0 z-[999] flex items-center justify-center"
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.15 }}
            className="relative z-10 w-[340px] rounded-xl
              bg-[#141416] border border-white/[0.1] shadow-2xl p-5 space-y-4"
          >
            <h3 className="text-[15px] font-semibold text-white/95">{title}</h3>
            <p className="text-sm text-white/55 leading-relaxed">{message}</p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onCancel}
                className="px-4 py-1.5 rounded-lg text-sm font-medium text-white/70
                  hover:bg-white/[0.06] transition-colors"
              >
                {cancelLabel}
              </button>
              <button
                onClick={onConfirm}
                data-testid="confirm-dialog-confirm"
                className={cn(
                  "px-4 py-1.5 rounded-lg text-sm font-medium transition-colors",
                  danger
                    ? "bg-red-500/80 hover:bg-red-500 text-white"
                    : "bg-white/15 hover:bg-white/25 text-white/90",
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

