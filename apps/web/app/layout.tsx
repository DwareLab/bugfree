import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "bugfree", template: "%s · bugfree" },
  description: "Self-hosted error tracking for Next.js and Express",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
