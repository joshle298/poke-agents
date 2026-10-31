/**
 * One Escape model for every surface stacked over the office: modals,
 * confirmations, the Pokédex and the Intro. Each open surface pushes a layer;
 * Escape closes the topmost one (highest z, then the most recently opened)
 * and nothing beneath it sees the key. With no layer open, Escape passes
 * through to the office's own handlers (the layout editor's Esc ladder).
 *
 * DOM-free so the Node runner can test it; `useEscapeLayer` binds it to one
 * window keydown listener in the capture phase.
 */

export interface EscapeLayerOptions {
  /** Stacking order (the surface's z-index); ties go to the newest layer. */
  z: number;
  /** False keeps Escape typed in a text field from closing this layer: the
   *  Pokédex keeps its reply draft, and a terminal beside it gets the key.
   *  Default true (a modal closes from its search box). */
  closeFromFields?: boolean;
}

interface Layer {
  close: () => void;
  z: number;
  closeFromFields: boolean;
  seq: number;
}

/** The parts of a keydown the stack decides on. */
export interface EscapeKeyEvent {
  key: string;
  /** An IME composition is open: Escape cancels it, nothing else. */
  isComposing?: boolean;
  /** Focus is in an input, textarea or other editable. */
  inField: boolean;
}

export class EscapeStack {
  private layers: Layer[] = [];
  private seq = 0;

  /** Register an open surface. Returns the function that removes it. */
  push(close: () => void, opts: EscapeLayerOptions): () => void {
    this.seq += 1;
    const layer: Layer = {
      close,
      z: opts.z,
      closeFromFields: opts.closeFromFields ?? true,
      seq: this.seq,
    };
    this.layers.push(layer);
    return () => {
      this.layers = this.layers.filter((l) => l !== layer);
    };
  }

  get size(): number {
    return this.layers.length;
  }

  private top(): Layer | undefined {
    let best: Layer | undefined;
    for (const layer of this.layers) {
      if (!best || layer.z > best.z || (layer.z === best.z && layer.seq > best.seq)) best = layer;
    }
    return best;
  }

  /** Close the topmost layer for an Escape keydown. True when a layer took
   *  the key (the caller stops it there). */
  handle(e: EscapeKeyEvent): boolean {
    if (e.key !== 'Escape' || e.isComposing) return false;
    const top = this.top();
    if (!top) return false;
    if (e.inField && !top.closeFromFields) return false;
    top.close();
    return true;
  }
}
