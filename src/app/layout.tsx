import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crossfire",
  description:
    "An AI auditor interrogates the books, an AI accountant defends them, a human referees.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
