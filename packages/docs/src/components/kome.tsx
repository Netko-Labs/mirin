import { useId } from "react";

/**
 * Kome — the logo is the mascot, see the brand book. Rice body, amber to the
 * brew line, eyes above it.
 *
 * The clip id comes from `useId` rather than a constant: two Kome on one page
 * with the same id make the second one resolve the first's clip, and the amber
 * silently disappears.
 */
export function Kome({ size = 22, className }: { size?: number; className?: string }) {
  const clipId = useId();
  const body =
    "M100 20c9 14 22 32 30 50 6 14 9 27 9 40 0 33-17 54-39 54s-39-21-39-54c0-13 3-26 9-40 8-18 21-36 30-50z";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      className={className}
      style={{ width: size, height: size, flexShrink: 0 }}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          <path d={body} />
        </clipPath>
      </defs>
      <path d={body} fill="#f7f4ec" />
      <g clipPath={`url(#${clipId})`}>
        <path d="M52 118h96v82H52z" fill="#dd9a3f" />
      </g>
      <ellipse cx="85" cy="100" rx="7.5" ry="9.5" fill="#232830" />
      <ellipse cx="115" cy="100" rx="7.5" ry="9.5" fill="#232830" />
      <path
        d="M92 118q8 8 16 0"
        stroke="#232830"
        strokeWidth="3.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/** Kome plus the wordmark, for a nav slot. */
export function KomeWordmark() {
  return (
    <span className="inline-flex items-center gap-2">
      <Kome size={24} />
      <span className="text-[17px] font-bold tracking-[-0.045em]">Mirin</span>
    </span>
  );
}
