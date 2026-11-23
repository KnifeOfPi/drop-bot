import type { Metadata } from "next";
import { Nunito } from "next/font/google";
import "./globals.css";

// Rounded, friendly typeface (falls back to Apple's rounded system font).
const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
  weight: ["400", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  title: "Drop Bot",
  description: "Pokémon drop monitor",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${nunito.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
