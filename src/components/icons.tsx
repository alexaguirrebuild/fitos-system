/** Iconos en línea: trazo de 1,75 px redondeado, 24 × 24, sin relleno. Decorativos por defecto (aria-hidden). */
import type { SVGProps } from "react";

function Base({ children, ...p }: SVGProps<SVGSVGElement>) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...p}>
      {children}
    </svg>
  );
}

export const IconToday = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <rect x="4" y="5" width="16" height="15" />
    <path d="M4 10h16M8 3v4M16 3v4" />
    <path d="M9 15h2" />
  </Base>
);

export const IconBarbell = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M2 12h20" />
    <rect x="5" y="7" width="3" height="10" />
    <rect x="16" y="7" width="3" height="10" />
  </Base>
);

export const IconFood = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10" />
    <path d="M16 3c-2 1-3 4-3 7h3v11" />
  </Base>
);

export const IconChart = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M4 4v16h16" />
    <path d="M7 15l4-4 3 2 5-6" />
  </Base>
);

export const IconMore = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </Base>
);

export const IconChevron = (p: SVGProps<SVGSVGElement>) => (
  <Base width="18" height="18" {...p}>
    <path d="M9 5l7 7-7 7" />
  </Base>
);

export const IconBack = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Base>
);

export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Base>
);

export const IconCamera = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <rect x="3" y="7" width="13" height="11" />
    <path d="M16 11l5-3v9l-5-3" />
  </Base>
);

export const IconScan = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
    <path d="M8 8v8M11 8v8M14 8v8M16.5 8v8" strokeWidth="1.2" />
  </Base>
);

export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l5 5" />
  </Base>
);

export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Base>
);

export const IconSwap = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M4 8h14l-3-3M20 16H6l3 3" />
  </Base>
);

export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);

export const IconPlan = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M9 9v11M15 9v11" />
  </Base>
);
