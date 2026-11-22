import { useId } from "react";
import type { ColoringProgress } from "../lib/reading";

const STRAND_O =
  "M 68.2 89.9 C 56.4 81.6 27 74.9 27 65.5 C 27 53.7 73 46.3 73 34.5 C 73 25.1 43.6 18.4 31.8 10.1";
const STRAND_G =
  "M 31.8 89.9 C 43.6 81.6 73 74.9 73 65.5 C 73 53.7 27 46.3 27 34.5 C 27 25.1 56.4 18.4 68.2 10.1";

/**
 * Full-cover coloring overlay for a shelf book tile.
 *
 * Displays the continuously looping BioCN double-helix brand mark above a
 * compact tabular percentage and chapter readout. Stays `pointer-events-none`
 * so clicking the cover still opens the book (cooperative P0 > P2) and the
 * top-right action menu remains reachable above.
 */
export function ColoringOverlay({ progress }: { progress: ColoringProgress }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const determinate = progress.total > 0;
  const percent = determinate
    ? Math.min(100, Math.max(0, Math.round((progress.done / progress.total) * 100)))
    : 0;
  const chaptersDone =
    progress.chaptersTotal > 0 ? Math.min(progress.chapters, progress.chaptersTotal) : 0;

  const overMidId = `biocn-${uid}-over-mid`;
  const gradOId = `biocn-${uid}-grad-o`;
  const gradGId = `biocn-${uid}-grad-g`;

  return (
    <div
      role="status"
      aria-label="着色进度"
      className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-base-100/88 px-3 pt-7 pb-3 backdrop-blur-md"
    >
      {/* Native progressbar semantics for assistive technologies; visual progress
          is carried by the percentage and chapter readout beneath the helix. */}
      {determinate ? (
        <progress className="sr-only" value={progress.done} max={progress.total} />
      ) : (
        <progress className="sr-only" />
      )}

      <svg
        aria-hidden="true"
        data-helix-loader=""
        viewBox="0 0 100 100"
        className="aspect-square w-[64%] max-w-34 shrink-0"
      >
        <defs>
          <clipPath id={overMidId}>
            <rect x="34" y="40" width="32" height="20" />
          </clipPath>
          <linearGradient
            id={gradOId}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="89.9"
            x2="0"
            y2="10.1"
          >
            <stop offset="0%" style={{ stopColor: "var(--biocn-helix-o)" }} />
            <stop offset="6.1%" style={{ stopColor: "var(--biocn-helix-o)" }} />
            <stop offset="11.1%" style={{ stopColor: "var(--biocn-helix-o-shade)" }} />
            <stop offset="16.1%" style={{ stopColor: "var(--biocn-helix-o)" }} />
            <stop offset="83.9%" style={{ stopColor: "var(--biocn-helix-o)" }} />
            <stop offset="88.9%" style={{ stopColor: "var(--biocn-helix-o-shade)" }} />
            <stop offset="93.9%" style={{ stopColor: "var(--biocn-helix-o)" }} />
            <stop offset="100%" style={{ stopColor: "var(--biocn-helix-o)" }} />
          </linearGradient>
          <linearGradient
            id={gradGId}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="89.9"
            x2="0"
            y2="10.1"
          >
            <stop offset="0%" style={{ stopColor: "var(--biocn-helix-g)" }} />
            <stop offset="45%" style={{ stopColor: "var(--biocn-helix-g)" }} />
            <stop offset="50%" style={{ stopColor: "var(--biocn-helix-g-shade)" }} />
            <stop offset="55%" style={{ stopColor: "var(--biocn-helix-g)" }} />
            <stop offset="100%" style={{ stopColor: "var(--biocn-helix-g)" }} />
          </linearGradient>
        </defs>

        <line
          className="biocn-helix-rung biocn-helix-rung-1"
          pathLength={100}
          x1="28"
          y1="65.5"
          x2="72"
          y2="65.5"
        />
        <line
          className="biocn-helix-rung biocn-helix-rung-2"
          pathLength={100}
          x1="72"
          y1="34.5"
          x2="28"
          y2="34.5"
        />
        <path
          className="biocn-helix-strand biocn-helix-strand-o"
          stroke={`url(#${gradOId})`}
          pathLength={100}
          d={STRAND_O}
        />
        <path
          className="biocn-helix-strand biocn-helix-strand-g"
          stroke={`url(#${gradGId})`}
          pathLength={100}
          d={STRAND_G}
        />
        <path
          className="biocn-helix-strand biocn-helix-strand-o"
          stroke={`url(#${gradOId})`}
          clipPath={`url(#${overMidId})`}
          pathLength={100}
          d={STRAND_O}
        />
      </svg>

      <div className="flex flex-col items-center gap-0.5 text-center">
        {determinate ? (
          <>
            <span className="text-base leading-tight font-semibold tracking-tight tabular-nums text-base-content">
              {percent}%
            </span>
            {progress.chaptersTotal > 0 && (
              <span className="text-xs leading-tight font-medium tabular-nums text-base-content/70">
                {chaptersDone}/{progress.chaptersTotal} 章
              </span>
            )}
          </>
        ) : (
          <span className="text-xs font-medium tracking-wide text-base-content/80">
            准备中…
          </span>
        )}
      </div>
    </div>
  );
}
