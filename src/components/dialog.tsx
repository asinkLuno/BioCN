import { useEffect, type RefObject } from "react";

/**
 * The one line every React-driven `<dialog>` needs: open it an effect after
 * the element exists. Native dialogs are styled with daisyUI's modal classes,
 * so only the imperative call is shared here.
 *
 * Takes the ref object (not `.current`, which is still null during the render
 * that mounts the element) so the effect fires once, after the ref is attached.
 * Callers that unmount the dialog when its job ends just pass a constant
 * `true`; callers that keep it mounted toggle `open` and get the close for
 * free.
 */
export function useDialog(ref: RefObject<HTMLDialogElement | null> | null, open: boolean) {
  useEffect(() => {
    const element = ref?.current;
    if (!element) return;
    // A closed `<dialog>` cannot accept focus; opening it as an effect gives
    // the browser a settled tree to modal-lock onto.
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [ref, open]);
}

/**
 * daisyUI's `.modal-backdrop` is a full-screen sibling of the dialog box that
 * eats clicks on the dimmed area. Every dialog that can close from the
 * backdrop uses this exact button; the close guard stays with the caller
 * (the model sheet refuses to close while an operation runs).
 */
export function ModalBackdrop({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="关闭"
      className="modal-backdrop"
      onClick={onClose}
    />
  );
}
