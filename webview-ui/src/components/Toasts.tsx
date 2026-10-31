import { useEffect } from 'react';

import type { Toast } from '../conductor/conductorStore.js';
import { conductorStore, useConductor } from '../conductor/conductorStore.js';
import { TOAST_VISIBLE_MS, TOAST_Z_INDEX } from '../constants.js';

function ToastItem({ toast }: { toast: Toast }) {
  useEffect(() => {
    const timer = setTimeout(() => conductorStore.dismissToast(toast.seq), TOAST_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [toast.seq]);
  return (
    <div
      className={`pixel-panel pointer-events-auto flex items-center gap-8 py-4 px-10 text-sm cursor-pointer ${
        toast.tone === 'error' ? 'border-status-error' : ''
      }`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      onClick={() => conductorStore.dismissToast(toast.seq)}
      title="Dismiss"
    >
      <span
        className={`size-6 shrink-0 ${toast.tone === 'error' ? 'bg-status-error' : 'bg-status-success'}`}
      />
      {toast.text}
    </div>
  );
}

/**
 * Outcomes of Conductor actions (message sent, stop refused, ...), stacked at
 * the top centre. Mounted at App's top level: position:fixed inside the mobile
 * shell's transformed track would size to the track.
 */
export function Toasts() {
  const toasts = useConductor((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 flex flex-col items-center gap-4 pointer-events-none mobile-safe-top"
      style={{ zIndex: TOAST_Z_INDEX, marginTop: 40 }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.seq} toast={toast} />
      ))}
    </div>
  );
}
