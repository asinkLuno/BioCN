/**
 * Minimal declarations for foliate-js, which ships none.
 *
 * Only the surface BioCN touches is typed: the `foliate-view` element, the
 * book interface its `open()` accepts, and the events it emits. Everything
 * else is deliberately `unknown` — the upstream API is documented as unstable,
 * so an untyped field failing loudly is preferable to a wrong assumption.
 */

interface FoliateTocItem {
  label: string;
  /** Container-relative href, possibly with a `#fragment`. */
  href: string;
  subitems?: FoliateTocItem[];
}

interface FoliateSection {
  /** Spine order index equals the Rust reader's chapter index. */
  linear: string;
  size: number;
  createDocument(): Promise<Document>;
  load(): Promise<Document | Blob>;
  unload(): void;
}

interface FoliateBook {
  sections: FoliateSection[];
  toc?: FoliateTocItem[];
  metadata?: Record<string, unknown>;
  dir?: string;
  /** Container href → `{ index, anchor }`, `index` being the spine position. */
  resolveHref(href: string): { index: number; anchor: unknown } | null;
  isExternal(uri: string): boolean;
}

interface FoliateRenderer {
  /** Layout is attribute-driven (`flow`, `gap`, `margin`, …), not properties. */
  setAttribute(name: string, value: string): void;
  /** Loaded sections; the paginator carries at most one. */
  getContents(): { index: number; doc: Document; overlayer: unknown }[];
  /**
   * CSS injected into every section document; the string form is appended
   * after the book's own styles, the two-element form also prepends one.
   */
  setStyles?(css: string | [before: string, after: string]): void;
}

interface FoliateRelocateDetail {
  /** Spine index of the section now in view. */
  index: number;
  fraction: number;
  section: { current: number; total: number };
  tocItem: { label: string; href: string } | null;
  cfi: string;
}

interface FoliateLoadDetail {
  /** The section's live document (an iframe contentDocument). */
  doc: Document;
  index: number;
}

interface FoliateViewEventMap extends HTMLElementEventMap {
  load: CustomEvent<FoliateLoadDetail>;
  relocate: CustomEvent<FoliateRelocateDetail>;
}

interface FoliateView extends HTMLElement {
  book: FoliateBook;
  renderer: FoliateRenderer;
  lastLocation: FoliateRelocateDetail | undefined;
  /** Accepts a Blob/File (sniffed by magic bytes), a URL, or a book object. */
  open(book: Blob | string): Promise<void>;
  init(options?: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
  goTo(target: number | string | { fraction: number }): Promise<unknown>;
  prev(distance?: number): Promise<void>;
  next(distance?: number): Promise<void>;
  close(): void;
  addEventListener<K extends keyof FoliateViewEventMap>(
    type: K,
    listener: (this: FoliateView, event: FoliateViewEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

interface HTMLElementTagNameMap {
  "foliate-view": FoliateView;
}
