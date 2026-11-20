import { useEffect, useState } from 'react';

// Hero title animation: Chinese Bionic Reading condenses into the BioCN wordmark.
// The Chinese n survives as N; unrelated letters dissolve before the remaining
// characters shift into BionCN.
// The h1's semantic text is supplied by the outer element.

const STAGE_MS = [0, 1300, 3000, 4700, 6300, 8300];
const SWAP = 3;
const FINAL = 4;
const HOLD = 5;

type Piece = { kind: 'char'; ch: string; delay: number; cls?: string; uppercaseAtMelt?: boolean; keep?: boolean } | { kind: 'solid'; text: string; cls: string };

const EN_PIECES: Piece[] = [
  ...'Chinese'.split('').map((ch, i) => ({
    kind: 'char' as const,
    ch,
    delay: ch === 'n' ? 0 : 45 + i * 40,
    cls: 'text-[#d95f02]',
    uppercaseAtMelt: ch === 'n',
    keep: ch === 'C' || ch === 'n',
  })),
  { kind: 'char', ch: ' ', delay: 0 },
  { kind: 'solid', text: 'Bio', cls: 'text-[#1b9e77]' },
  ...'nic'.split('').map((ch, i) => ({ kind: 'char' as const, ch, delay: 480 + i * 45, cls: 'text-[#1b9e77]', keep: false })),
  { kind: 'char', ch: ' ', delay: 0 },
  ...'Reading'.split('').map((ch, i) => ({ kind: 'char' as const, ch, delay: 45 + i * 40, cls: 'text-[#1b9e77]' })),
];

export function HeroTitle() {
  const [stage, setStage] = useState(0);
  const [instant, setInstant] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setInstant(true);
      setStage(HOLD);
      return;
    }

    let timers: number[] = [];
    let restartTimer = 0;
    const play = () => {
      setStage(0);
      timers = STAGE_MS.slice(1).map((ms, index) =>
        window.setTimeout(() => setStage(index + 1), ms),
      );
      restartTimer = window.setTimeout(() => {
        setStage(0);
        play();
      }, STAGE_MS[STAGE_MS.length - 1] + 5000);
    };
    play();

    return () => {
      timers.forEach(window.clearTimeout);
      window.clearTimeout(restartTimer);
    };
  }, []);

  const settled = stage >= HOLD;
  const layerClass = (min: number, until = min) => {
    const cls = ['brand-layer'];
    if (stage >= min) cls.push(stage <= until ? 'brand-layer-active' : 'brand-layer-out');
    if ((settled && min < FINAL) || (stage >= SWAP && min < SWAP) || (stage >= FINAL && min === SWAP)) cls.push('brand-layer-drop');
    return cls.join(' ');
  };

  return (
    <span className={`block select-none ${instant ? 'brand-instant' : ''}`} aria-hidden="true">
      <span className="grid">

        {/* ② English title → ③ dissolve unrelated letters */}
        <span className={layerClass(0, 2) + (stage >= 2 ? ' brand-melt' : '')}>
          {EN_PIECES.map((piece, i) => {
            if (piece.kind === 'solid') return <span key={i} className={piece.cls}>{piece.text}</span>;
            return (
              <span
                key={i}
                className={`brand-char-melt ${piece.cls ?? ''} ${piece.keep ? 'brand-char-keep' : piece.uppercaseAtMelt && stage >= 2 ? 'uppercase' : ''}`}
                style={{ transitionDelay: `${piece.delay}ms` }}
              >
                {piece.ch}
              </span>
            );
          })}
        </span>

        {/* ④ Keep the surviving groups in place, then exchange CN and Bio */}
        <span className={layerClass(SWAP, HOLD) + ' brand-wordmark-layer'}>
          <span className="brand-wordmark inline-flex items-baseline tracking-tight">
            <span className={`brand-token brand-group-cn text-[#d95f02] ${stage >= SWAP ? 'brand-token-swap-cn' : ''}`}>C<span className={stage >= SWAP ? '' : 'normal-case'}>{stage >= SWAP ? 'N' : 'n'}</span></span>
            <span className={`brand-token brand-group-bio text-[#1b9e77] ${stage >= SWAP ? 'brand-token-swap-bio' : ''}`}>Bio</span>
          </span>
        </span>
      </span>
    </span>
  );
}
