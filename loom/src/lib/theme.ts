/**
 * Theme selection: light, dark, or follow the OS.
 *
 * The whole mechanism is one attribute on <html> — styles.css defines both
 * palettes over the same tokens, so nothing has to re-render for a switch to
 * land. "system" deliberately *removes* the attribute rather than resolving the
 * preference in JS, which lets the `prefers-color-scheme` block in styles.css
 * stay authoritative and keeps the app tracking a mid-session OS change.
 */

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "loom:theme";

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

export function getTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Private mode / storage disabled — fall through to the default.
  }
  return "light";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);

  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Not being able to remember the choice must not stop it applying now.
  }
}

/** What the page is actually showing right now, with "system" resolved. */
export function resolvedTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Called once before React mounts, so the first paint is already correct. */
export function initTheme(): Theme {
  const theme = getTheme();
  applyTheme(theme);
  return theme;
}
