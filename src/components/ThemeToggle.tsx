"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "adjuster-theme";

function currentTheme(): "light" | "dark" {
  const pinned = document.documentElement.dataset.theme;
  if (pinned === "dark" || pinned === "light") return pinned;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Masthead theme switch. The label names the mode it switches TO. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  function toggle() {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode — the pin just won't survive a reload */
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Switch between light and dark mode"
      className="mono text-[0.72rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)] cursor-pointer"
    >
      {theme === null ? "◐" : theme === "dark" ? "◐ Light" : "◐ Dark"}
    </button>
  );
}
