import type { ReactNode, RefObject } from 'react';
import { Dialog } from 'radix-ui';
import { motion, useReducedMotion } from 'motion/react';

export function MeetingDialog({ open, onOpenChange, title, description, children, returnFocus }: {
  open: boolean; onOpenChange(open: boolean): void; title: string; description: string; children: ReactNode;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const reducedMotion = useReducedMotion();
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="meeting-dialog-overlay"/>
    <Dialog.Content asChild onCloseAutoFocus={event => { if (returnFocus?.current) { event.preventDefault(); returnFocus.current.focus(); } }}>
      <motion.section className="meeting-dialog" initial={{ opacity: 0, x: reducedMotion ? 0 : 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reducedMotion ? 0 : .18 }}>
        <div className="meeting-dialog-heading"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div><Dialog.Close className="drawer-close" aria-label={`Close ${title}`}>×</Dialog.Close></div>
        <div className="meeting-dialog-body">{children}</div>
      </motion.section>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
