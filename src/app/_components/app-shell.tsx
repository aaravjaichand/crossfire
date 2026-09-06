"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { RunSummary } from "@/lib/referee/runs";

const STORAGE_KEY = "crossfire.sidebar.pinned";

export function AppShell({
  runs,
  children,
}: {
  runs: RunSummary[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The reveal animates only after the stored preference has been applied, so a
  // pinned sidebar does not slide open on every page load.
  const [ready, setReady] = useState(false);
  const expanded = pinned || hovered || focusWithin;

  useEffect(() => {
    try {
      setPinned(localStorage.getItem(STORAGE_KEY) === "true");
    } catch {
      // Storage can be unavailable; hover-to-expand remains available.
    }
    setReady(true);

    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  function openSidebar() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setHovered(true);
  }

  function scheduleClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setHovered(false);
      if (!pinned && document.activeElement instanceof HTMLElement) {
        const sidebar = document.getElementById("primary-sidebar");
        if (sidebar?.contains(document.activeElement)) {
          document.activeElement.blur();
          setFocusWithin(false);
        }
      }
    }, 120);
  }

  function releaseNavigationFocus() {
    if (pinned) return;
    clearSidebarFocus();
  }

  function clearSidebarFocus() {
    setFocusWithin(false);
    requestAnimationFrame(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
  }

  function togglePinned() {
    const next = !pinned;
    setPinned(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Not worth surfacing.
    }
    if (!next) clearSidebarFocus();
  }

  return (
    <div className="relative h-screen overflow-hidden bg-paper text-ink">
      <div
        aria-hidden
        onMouseEnter={openSidebar}
        onMouseLeave={scheduleClose}
        className="fixed inset-y-0 left-0 z-50 w-3"
      />
      {!pinned ? (
        <button
          type="button"
          onClick={togglePinned}
          aria-controls="primary-sidebar"
          aria-expanded="false"
          aria-label="Pin sidebar open"
          title="Pin sidebar open"
          className="fixed left-2 top-2 z-50 grid h-8 w-8 place-items-center rounded-md border border-line bg-paper text-ink-3 shadow-[0_3px_10px_rgba(0,0,0,0.08)] transition-colors hover:bg-paper-2 hover:text-ink"
        >
          <IconSidebar />
        </button>
      ) : null}
      <aside
        id="primary-sidebar"
        aria-label="Primary"
        onMouseEnter={openSidebar}
        onMouseLeave={scheduleClose}
        onFocusCapture={() => setFocusWithin(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFocusWithin(false);
          }
        }}
        style={{
          width: "var(--sidebar-w)",
          transform: expanded ? "translateX(0)" : "translateX(calc(-100% - 1rem))",
        }}
        className={`fixed bottom-3 left-3 top-3 z-40 flex flex-col overflow-hidden rounded-xl border border-line bg-paper shadow-[0_14px_40px_rgba(0,0,0,0.12)] ${
          ready ? "transition-[transform,box-shadow] duration-200 ease-out" : ""
        }`}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3">
          <Link
            href="/"
            onClick={releaseNavigationFocus}
            aria-label="Crossfire home"
            className="rounded-lg"
          >
            <CrossfireLogo />
          </Link>
          <button
            type="button"
            onClick={togglePinned}
            aria-pressed={pinned}
            aria-expanded={expanded}
            aria-label={pinned ? "Unpin sidebar" : "Pin sidebar open"}
            title={pinned ? "Unpin sidebar" : "Pin sidebar open"}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[4px] text-ink-3 hover:bg-paper-2 hover:text-ink"
          >
            <IconSidebar />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2">
          <NavItem
            href="/"
            label="Overview"
            icon={<IconGrid />}
            active={pathname === "/"}
            collapsed={false}
            onNavigate={releaseNavigationFocus}
          />
          <NavItem
            href="/audit/mock"
            label="Walkthrough"
            icon={<IconBook />}
            active={pathname === "/audit/mock"}
            collapsed={false}
            onNavigate={releaseNavigationFocus}
          />

          {runs.length > 0 ? (
            <div className="mt-5">
              <div className="px-3.5 pb-1 text-[11.5px] text-ink-3">Recent runs</div>
              {runs.map((run) => (
                <NavItem
                  key={run.id}
                  href={`/audit/${run.id}`}
                  label={run.name}
                  meta={`${run.defended}/${run.total}`}
                  icon={<span className="font-mono text-[11px] num">{run.id}</span>}
                  active={pathname === `/audit/${run.id}`}
                  collapsed={false}
                  onNavigate={releaseNavigationFocus}
                />
              ))}
            </div>
          ) : null}
        </nav>

        <div className="shrink-0 border-t border-line px-3.5 py-3 text-[11.5px] leading-snug text-ink-3">
          Northwind Labs, FY2025
        </div>
      </aside>

      <div
        style={
          {
            paddingLeft: pinned ? "calc(var(--sidebar-w) + 1.5rem)" : 0,
            "--shell-header-left": pinned ? "1rem" : "3.5rem",
          } as React.CSSProperties
        }
        className={`flex h-full min-w-0 w-full flex-col ${
          ready ? "transition-[padding] duration-200 ease-out" : ""
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function NavItem({
  href,
  label,
  meta,
  icon,
  active,
  collapsed,
  onNavigate,
}: {
  href: string;
  label: string;
  meta?: string;
  icon: React.ReactNode;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={`mx-2 flex h-8 items-center gap-2.5 rounded-[4px] px-1.5 text-[12.5px] ${
        active
          ? "bg-accent-soft font-medium text-ink"
          : "text-ink-2 hover:bg-paper-2 hover:text-ink"
      }`}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center">{icon}</span>
      {!collapsed ? <span className="min-w-0 flex-1 truncate">{label}</span> : null}
      {!collapsed && meta ? (
        <span className="font-mono text-[11px] text-ink-3 num">{meta}</span>
      ) : null}
    </Link>
  );
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function IconGrid() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE} aria-hidden>
      <rect x="2" y="2" width="5" height="5" />
      <rect x="9" y="2" width="5" height="5" />
      <rect x="2" y="9" width="5" height="5" />
      <rect x="9" y="9" width="5" height="5" />
    </svg>
  );
}

function IconBook() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE} aria-hidden>
      <path d="M2.5 3h4.5a1 1 0 0 1 1 1v9.5a1.5 1.5 0 0 0-1.5-1.5H2.5z" />
      <path d="M13.5 3H9a1 1 0 0 0-1 1v9.5A1.5 1.5 0 0 1 9.5 12h4z" />
    </svg>
  );
}

function IconSidebar() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" {...STROKE} aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10" />
    </svg>
  );
}

function CrossfireLogo() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden>
      <rect width="30" height="30" rx="8" fill="var(--ink)" />
      <path
        d="M6.75 9.25 12.5 15l-5.75 5.75M23.25 9.25 17.5 15l5.75 5.75"
        fill="none"
        stroke="var(--paper)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="12.9" y="12.9" width="4.2" height="4.2" rx="1.1" fill="var(--paper)" />
    </svg>
  );
}
