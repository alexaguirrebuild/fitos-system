"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconBarbell, IconChart, IconFood, IconMore, IconToday } from "./icons";

const TABS = [
  { href: "/", label: "Hoy", Icon: IconToday, match: (p: string) => p === "/" },
  { href: "/entreno", label: "Entreno", Icon: IconBarbell, match: (p: string) => p.startsWith("/entreno") },
  { href: "/nutricion", label: "Comida", Icon: IconFood, match: (p: string) => p.startsWith("/nutricion") },
  { href: "/progreso", label: "Progreso", Icon: IconChart, match: (p: string) => p.startsWith("/progreso") },
  { href: "/mas", label: "Más", Icon: IconMore, match: (p: string) => ["/mas", "/bienestar", "/cardio", "/libreria", "/ajustes"].some((x) => p.startsWith(x)) },
];

export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="tabbar" aria-label="Principal">
      <ul>
        {TABS.map(({ href, label, Icon, match }) => (
          <li key={href}>
            <Link href={href} aria-current={match(path) ? "page" : undefined}>
              <Icon width={22} height={22} />
              <span>{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
