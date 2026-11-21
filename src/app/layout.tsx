import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";
import { ServiceWorker } from "@/components/sw-register";
import "./globals.css";

/** Una sola familia variable: el eje de anchura (62-125) hace la jerarquía; la condensada pesada, las cifras que mandan. */
const archivo = Archivo({ variable: "--font-archivo", subsets: ["latin"], axes: ["wdth"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "FITOS SYSTEM", template: "%s · FITOS SYSTEM" },
  description: "Entreno, comida y recuperación en un solo sitio.",
  applicationName: "FITOS SYSTEM",
  appleWebApp: { capable: true, title: "Físico", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f4f2" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0e10" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className={`${archivo.variable} antialiased`}>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
