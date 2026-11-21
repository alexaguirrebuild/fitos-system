import type { Metadata, Viewport } from "next";
import { Bodoni_Moda, IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import { ServiceWorker } from "@/components/sw-register";
import "./globals.css";

const bodoni = Bodoni_Moda({ variable: "--font-bodoni", subsets: ["latin"], display: "swap" });
const grotesk = Space_Grotesk({ variable: "--font-grotesk", subsets: ["latin"], display: "swap" });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "FITOS SYSTEM", template: "%s · FITOS SYSTEM" },
  description: "Entreno, comida y recuperación en un solo sitio.",
  applicationName: "FITOS SYSTEM",
  appleWebApp: { capable: true, title: "Físico", statusBarStyle: "black-translucent" },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0e0c0a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className={`${bodoni.variable} ${grotesk.variable} ${plexMono.variable} antialiased`}>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
