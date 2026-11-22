/**
 * Ambient type surface of foliate-js (which ships none), scoped to the parser.
 *
 * Declared here as a module (`declare module "foliate-js/view.js"`) so the
 * import in `epub.ts` is typed; the book/section interfaces are the same ones
 * the first attempt used, minus everything renderer-specific.
 */
declare module "foliate-js/view.js" {
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
    // For XHTML the loader branch returns a blob: URL of the whole
    // resource-rewritten document; `createDocument()` parses but does not
    // rewrite resources.
    load(): Promise<string | Document | Blob | null>;
    unload(): void;
  }

  export interface FoliateBook {
    sections: FoliateSection[];
    toc?: FoliateTocItem[];
    metadata?: Record<string, unknown>;
    dir?: string;
    /** Container href → `{ index, anchor }`, `index` being the spine position. */
    resolveHref(href: string): { index: number; anchor: unknown } | null;
    isExternal(uri: string): boolean;
    destroy(): void;
  }

  /** Reads a zip/EPUB/other supported container into a book object. */
  export function makeBook(file: Blob | File | string): Promise<FoliateBook>;
}
