import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

/**
 * Unified Hero Brand Choreography — continuous looping sequence (~7.0s cycle):
 *
 *   Helix (left): draws in ONE unbroken fluid stroke (0.04s -> 2.00s) with both
 *   purple rungs bridging naturally as the strands sweep past each loop belly,
 *   pulses subtly on `n -> N`, counter-twists on `CN <-> Bio`, breathes during
 *   the settled hold, then dissolves softly before the next cycle begins.
 *
 *   Wordmark (right):
 *     1 (0.00s): Chinese Bionic Reading
 *     2 (0.84s): Extra letters vanish & collapse -> Cn Bio (smoothly zooms to full size)
 *     3 (1.54s): n -> N + word gap closes right off the zoom's momentum -> CNBio
 *     4 (2.04s): CN <-> Bio counter-arc weave (FLIP-measured) -> BioCN
 *     5 (2.76s): Settled BioCN + 中文仿生阅读 glides in below (holds ~3.8s)
 *     6 (6.57s): Soft fade-out before looping seamlessly back to Stage 1 (7.04s)
 *
 * Respects `prefers-reduced-motion: reduce` (renders static Stage 5 without looping)
 * and pauses the loop when the browser tab is hidden.
 */

type Stage = 1 | 2 | 3 | 4 | 5 | 6;

const STRAND_O =
  'M 68.2 89.9 C 56.4 81.6 27 74.9 27 65.5 C 27 53.7 73 46.3 73 34.5 C 73 25.1 43.6 18.4 31.8 10.1';
const STRAND_G =
  'M 31.8 89.9 C 43.6 81.6 73 74.9 73 65.5 C 73 53.7 27 46.3 27 34.5 C 27 25.1 56.4 18.4 68.2 10.1';

const STAGE_SCHEDULE: readonly { stage: Stage; atMs: number }[] = [
  { stage: 2, atMs: 840 },
  { stage: 3, atMs: 1540 },
  { stage: 4, atMs: 2040 },
  { stage: 5, atMs: 2760 },
  { stage: 6, atMs: 6570 },
];

const LOOP_RESET_MS = 7040;

function Vanish({
  text,
  gone,
  delayMs = 0,
  className = '',
}: {
  text: string;
  gone: boolean;
  delayMs?: number;
  className?: string;
}) {
  return (
    <span
      className={`hero-vanish ${className}`}
      data-gone={gone ? 'true' : 'false'}
      style={{ '--vanish-delay': `${delayMs}ms` } as CSSProperties}
    >
      <span className="hero-vanish-inner">{text}</span>
    </span>
  );
}

function HeroHelix({
  stage,
  reducedMotion,
  onReplay,
}: {
  stage: Stage;
  reducedMotion: boolean;
  onReplay: () => void;
}) {
  const settled = stage === 5;
  const fading = stage === 6;

  return (
    <div
      className={`hero-brand-mark ${settled && !reducedMotion ? 'cursor-pointer' : ''}`}
      aria-hidden="true"
      onClick={onReplay}
      title={settled && !reducedMotion ? '点击立即重播' : undefined}
    >
      <svg
        viewBox="0 0 100 100"
        className={`hero-helix-svg size-[4.5rem] text-base-content sm:size-[5.5rem] ${
          reducedMotion ? 'hero-helix-static' : ''
        } ${stage === 4 ? 'hero-helix-twist' : ''} ${fading ? 'hero-helix-fadeout' : ''}`}
        data-stage={stage}
      >
        <defs>
          <clipPath id="biocn-hero-over-mid">
            <rect x="34" y="40" width="32" height="20" />
          </clipPath>
          <linearGradient
            id="biocn-hero-grad-o"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="89.9"
            x2="0"
            y2="10.1"
          >
            <stop offset="0%" style={{ stopColor: 'var(--biocn-hero-o)' }} />
            <stop offset="6.1%" style={{ stopColor: 'var(--biocn-hero-o)' }} />
            <stop offset="11.1%" style={{ stopColor: 'var(--biocn-hero-o-shade)' }} />
            <stop offset="16.1%" style={{ stopColor: 'var(--biocn-hero-o)' }} />
            <stop offset="83.9%" style={{ stopColor: 'var(--biocn-hero-o)' }} />
            <stop offset="88.9%" style={{ stopColor: 'var(--biocn-hero-o-shade)' }} />
            <stop offset="93.9%" style={{ stopColor: 'var(--biocn-hero-o)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--biocn-hero-o)' }} />
          </linearGradient>
          <linearGradient
            id="biocn-hero-grad-g"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="89.9"
            x2="0"
            y2="10.1"
          >
            <stop offset="0%" style={{ stopColor: 'var(--biocn-hero-g)' }} />
            <stop offset="45%" style={{ stopColor: 'var(--biocn-hero-g)' }} />
            <stop offset="50%" style={{ stopColor: 'var(--biocn-hero-g-shade)' }} />
            <stop offset="55%" style={{ stopColor: 'var(--biocn-hero-g)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--biocn-hero-g)' }} />
          </linearGradient>
        </defs>

        {/* Faint blueprint guide softly fades out as the continuous draw finishes,
            and gently reappears during the loop reset fade so there is never an empty hole. */}
        {!reducedMotion && (
          <g className={`hero-helix-guide ${fading ? 'hero-helix-guide-return' : ''}`}>
            <line className="hero-helix-guide-rung" x1="28" y1="65.5" x2="72" y2="65.5" />
            <line className="hero-helix-guide-rung" x1="72" y1="34.5" x2="28" y2="34.5" />
            <path className="hero-helix-guide-strand" d={STRAND_O} />
            <path className="hero-helix-guide-strand" d={STRAND_G} />
          </g>
        )}

        {/* Active SVO layers wrap in one group so loop fade-out softens cleanly
            back onto the guide without snapping. */}
        <g className="hero-helix-ink">
          <line
            className="hero-helix-rung hero-helix-rung-1"
            pathLength={100}
            x1="28"
            y1="65.5"
            x2="72"
            y2="65.5"
          />
          <line
            className="hero-helix-rung hero-helix-rung-2"
            pathLength={100}
            x1="72"
            y1="34.5"
            x2="28"
            y2="34.5"
          />

          <path
            className="hero-helix-strand hero-helix-strand-o"
            stroke="url(#biocn-hero-grad-o)"
            pathLength={100}
            d={STRAND_O}
          />
          <path
            className="hero-helix-strand hero-helix-strand-g"
            stroke="url(#biocn-hero-grad-g)"
            pathLength={100}
            d={STRAND_G}
          />
          <path
            className="hero-helix-strand hero-helix-strand-o"
            stroke="url(#biocn-hero-grad-o)"
            clipPath="url(#biocn-hero-over-mid)"
            pathLength={100}
            d={STRAND_O}
          />
        </g>
      </svg>
    </div>
  );
}

export function HeroBrandLockup({ children }: { children: ReactNode }) {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [stage, setStage] = useState<Stage>(1);
  const [runId, setRunId] = useState(0);
  const [swapOffsets, setSwapOffsets] = useState<{ cn: number; bio: number } | null>(null);

  const cnRef = useRef<HTMLSpanElement>(null);
  const bioRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (media.matches) {
      setReducedMotion(true);
      setStage(5);
      return;
    }

    setReducedMotion(false);
    setStage(1);
    setSwapOffsets(null);

    // 滚出视野就不再排下一轮定时器：hero 每轮都会整块重排，看不见时纯烧电。
    let visible = true;
    let timers: number[] = [];
    const clearAll = () => {
      timers.forEach(window.clearTimeout);
      timers = [];
    };

    const scheduleCycle = () => {
      clearAll();
      if (document.hidden || !visible) return;
      timers = STAGE_SCHEDULE.map(({ stage: nextStage, atMs }) =>
        window.setTimeout(() => setStage(nextStage), atMs),
      );
      timers.push(window.setTimeout(() => setRunId((n) => n + 1), LOOP_RESET_MS));
    };

    scheduleCycle();

    // 回到视野时从第 0 幕重播，和标签页切回来的行为保持一致。
    const root = rootRef.current;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting === visible) return;
      visible = entry.isIntersecting;
      if (visible) setRunId((n) => n + 1);
      else clearAll();
    });
    if (root) observer.observe(root);

    const onVisibility = () => {
      if (document.hidden) {
        clearAll();
      } else {
        setRunId((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearAll();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [runId]);

  // Measure exact rendered widths of `CN` and `Bio` right as Stage 4 begins so
  // the two tokens trade places with 0px error in any font or viewport width.
  useLayoutEffect(() => {
    if (stage !== 4) return;
    const cnEl = cnRef.current;
    const bioEl = bioRef.current;
    if (!cnEl || !bioEl) return;

    const cnWidth = cnEl.getBoundingClientRect().width;
    const bioWidth = bioEl.getBoundingClientRect().width;
    setSwapOffsets({ cn: bioWidth, bio: -cnWidth });
  }, [stage]);

  const replay = useCallback(() => {
    if (reducedMotion || stage < 5) return;
    setRunId((n) => n + 1);
  }, [reducedMotion, stage]);

  const settled = stage >= 5;
  const fading = stage === 6;
  const condensed = stage >= 2;
  const uppercased = stage >= 3;
  const swapping = stage === 4 && swapOffsets !== null;

  return (
    <div ref={rootRef} className="flex w-full flex-col gap-6 sm:gap-7">
      <div className="hero-brand-head">
        <HeroHelix
          key={`helix-${runId}`}
          stage={stage}
          reducedMotion={reducedMotion}
          onReplay={replay}
        />

        <h1
          id="intro-title"
          className={`space-y-1 font-semibold ${stage === 5 && !reducedMotion ? 'cursor-pointer' : ''}`}
          onClick={replay}
          title={stage === 5 && !reducedMotion ? '点击立即重播' : undefined}
        >
          {/* Semantic heading text is always stable for assistive tech & SEO. */}
          <span className="sr-only">BioCN — 中文仿生阅读</span>

          {/* Primary stage: reserves the exact final headline height to guarantee zero CLS. */}
          <span
            aria-hidden="true"
            className="relative flex min-h-[1.16em] items-center text-[2.375rem] leading-[1.12] tracking-[-0.025em] select-none sm:text-[3.125rem]"
          >
            {settled ? (
              <span className={`hero-settled inline-flex items-baseline ${fading ? 'hero-settled-out' : ''}`}>
                <span className="svo-predicate">Bio</span>
                <span className="svo-object">CN</span>
              </span>
            ) : (
              /* Stages 1–4: Chinese Bionic Reading -> Cn Bio -> CNBio -> BioCN */
              <span
                key={`en-${runId}`}
                className="hero-en-stage inline-flex items-baseline whitespace-nowrap"
                data-visible="true"
                data-full-scale={condensed ? 'true' : 'false'}
                data-swapping={swapping ? 'true' : 'false'}
              >
                <span
                  ref={cnRef}
                  className={`hero-en-group hero-en-group-cn svo-object inline-flex items-baseline ${
                    swapping ? 'hero-swap-cn' : ''
                  }`}
                  style={
                    swapping
                      ? ({ '--swap-x': `${swapOffsets.cn}px` } as CSSProperties)
                      : undefined
                  }
                >
                  <span>C</span>
                  <Vanish text="hi" gone={condensed} delayMs={0} />
                  <span className="hero-case-slot" data-upper={uppercased ? 'true' : 'false'}>
                    <span className="hero-case-lower">
                      <span className="hero-case-inner">n</span>
                    </span>
                    <span className="hero-case-upper">
                      <span className="hero-case-inner">N</span>
                    </span>
                  </span>
                  <Vanish text="ese" gone={condensed} delayMs={40} />
                </span>

                {/* Word gap stays open for `Cn Bio` in Stage 2, then closes smoothly into `CNBio` in Stage 3. */}
                <span className="hero-gap" data-closed={uppercased ? 'true' : 'false'}>
                  <span className="hero-vanish-inner"> </span>
                </span>

                <span
                  ref={bioRef}
                  className={`hero-en-group hero-en-group-bio svo-predicate inline-flex items-baseline ${
                    swapping ? 'hero-swap-bio' : ''
                  }`}
                  style={
                    swapping
                      ? ({ '--swap-x': `${swapOffsets.bio}px` } as CSSProperties)
                      : undefined
                  }
                >
                  <span>Bio</span>
                  <Vanish text="nic" gone={condensed} delayMs={70} />
                  <Vanish text=" Reading" gone={condensed} delayMs={100} />
                </span>
              </span>
            )}
          </span>

          {/* Subtitle slot: always occupies its final height; glides in once BioCN settles. */}
          <span
            aria-hidden="true"
            className={`hero-subtitle block text-base leading-snug font-normal tracking-tight text-base-content/65 sm:text-lg ${
              stage === 5 ? 'hero-subtitle-visible' : ''
            }`}
          >
            中文仿生阅读
          </span>
        </h1>
      </div>

      {children}
    </div>
  );
}
