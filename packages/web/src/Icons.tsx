// Single-stroke icon system: 24px grid, 1.75 stroke, round caps/joins.
import type { SVGProps } from "react";

function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconVolume = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M11 5 6.5 8.5H3v7h3.5L11 19V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 6a9 9 0 0 1 0 12" />
  </Icon>
);

export const IconVolumeOff = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M11 5 6.5 8.5H3v7h3.5L11 19V5Z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </Icon>
);

export const IconExpand = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
  </Icon>
);

export const IconShrink = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" />
  </Icon>
);

export const IconCopy = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" />
  </Icon>
);

export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m4.5 12.5 5 5 10-11" />
  </Icon>
);

export const IconScreen = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2.5" y="4.5" width="19" height="13" rx="2" />
    <path d="M9 20.5h6" />
  </Icon>
);

export const IconEye = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.75" />
  </Icon>
);
