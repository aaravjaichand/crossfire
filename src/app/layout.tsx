import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "./_components/app-shell";
import { recentRuns, type RunSummary } from "@/lib/referee/runs";

const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "Crossfire",
  description:
    "An AI auditor interrogates the books, an AI accountant defends them, a human controller rules on what is left.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The sidebar lists recent runs. A database that is not there yet must not
  // take the whole shell down with it; the page decides how to explain that.
  let runs: RunSummary[] = [];
  try {
    runs = await recentRuns(8);
  } catch (error) {
    console.error("[shell] loading recent runs failed", { error });
  }

  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <AppShell runs={runs}>{children}</AppShell>
      </body>
    </html>
  );
}
