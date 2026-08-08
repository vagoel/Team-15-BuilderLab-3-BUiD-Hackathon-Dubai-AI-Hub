import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useLoom } from "../store.js";

/**
 * The drag affordance in a card's bottom-right corner.
 *
 * During the drag it writes width/height straight onto the card's DOM node — no
 * React state, no history churn at 60fps. On release it commits ONE spec change
 * through `resizeComponent`: height in pixels, width snapped to the 12-column grid
 * span it landed nearest. That keeps a whole gesture to a single undo step, and
 * means a size set by dragging and one set by the `resize_component` voice tool are
 * the same kind of thing in the same place.
 */

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 1200;

export function ResizeHandle({
  componentId,
  cardRef,
  allowWidth,
}: {
  componentId: string;
  cardRef: RefObject<HTMLElement | null>;
  /** Width dragging only makes sense where the layout has columns to snap to. */
  allowWidth: boolean;
}) {
  const dragging = useRef(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const card = cardRef.current;
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = card.offsetWidth;
    const startH = card.offsetHeight;
    card.classList.add("resizing");

    const onMove = (ev: globalThis.PointerEvent) => {
      if (!dragging.current) return;
      const h = clamp(startH + (ev.clientY - startY), MIN_HEIGHT, MAX_HEIGHT);
      card.style.height = `${h}px`;
      if (allowWidth) {
        const grid = card.parentElement;
        const maxW = grid ? grid.clientWidth : startW;
        const w = clamp(startW + (ev.clientX - startX), 160, maxW);
        card.style.width = `${w}px`;
        // Freed from the grid track while dragging so the width actually follows
        // the pointer; the committed span takes over the moment the drag ends.
        card.style.gridColumn = "auto";
        card.style.maxWidth = "100%";
      }
    };

    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      card.classList.remove("resizing");

      const height = Math.round(card.offsetHeight);
      let span: number | undefined;
      if (allowWidth) {
        const grid = card.parentElement;
        if (grid && grid.clientWidth > 0) {
          const columnWidth = grid.clientWidth / 12;
          span = clamp(Math.round(card.offsetWidth / columnWidth), 3, 12);
        }
      }

      // Clear the drag's inline styles; the committed spec re-applies the size.
      card.style.height = "";
      card.style.width = "";
      card.style.gridColumn = "";
      card.style.maxWidth = "";

      useLoom.getState().resizeComponent(componentId, {
        height: clamp(height, MIN_HEIGHT, MAX_HEIGHT),
        ...(span !== undefined ? { span } : {}),
      });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className="resize-handle"
      title={allowWidth ? "Drag to resize" : "Drag to change height"}
      onPointerDown={onPointerDown}
      aria-hidden
    />
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
