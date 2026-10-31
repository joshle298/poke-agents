import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A yes/no question in the app's dialog style, above every other modal. */
export function ConfirmDialog({
  isOpen,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={title} zIndex={56}>
      <div className="px-10 pb-8 max-w-[420px]">
        <p className="text-base mt-4 mb-12" style={{ lineHeight: 1.35 }}>
          {body}
        </p>
        <div className="flex justify-end gap-6">
          <Button size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="md"
            variant="accent"
            onClick={() => {
              onConfirm();
              onCancel();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
