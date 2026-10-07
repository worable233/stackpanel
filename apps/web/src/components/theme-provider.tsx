'use client';

import * as React from 'react';
import { THEME_STORAGE_KEY, type ResolvedTheme, type Theme } from '@/lib/theme';

const MEDIA = '(prefers-color-scheme: dark)';
const THEMES: Theme[] = ['light', 'dark', 'system'];

interface ThemeContextValue {
  /** The user's stored preference. */
  theme: Theme;
  /** The concrete theme currently applied to `<html>`. */
  resolvedTheme: ResolvedTheme;
  /** The current OS preference, independent of the stored choice. */
  systemTheme: ResolvedTheme;
  themes: Theme[];
  setTheme: (theme: Theme) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

// The stored preference lives in `localStorage`, i.e. an external store, so it is
// read through `useSyncExternalStore`: that keeps hydration deterministic (server
// snapshot = the same fallback the server rendered) without a setState-in-effect.
const themeListeners = new Set<() => void>();

// Fallback for when storage is unavailable (private mode, blocked cookies), so
// the switcher still works for the current page.
let memoryTheme: Theme | null = null;

function getThemeSnapshot(): Theme {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(raw)) return raw;
  } catch {
    // Unreadable storage: fall through to the in-memory value.
  }
  return memoryTheme ?? 'system';
}

function getThemeServerSnapshot(): Theme {
  return 'system';
}

function subscribeTheme(onStoreChange: () => void): () => void {
  themeListeners.add(onStoreChange);
  // `storage` fires in *other* tabs; same-tab writes notify via `setStoredTheme`.
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) onStoreChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    themeListeners.delete(onStoreChange);
    window.removeEventListener('storage', onStorage);
  };
}

function setStoredTheme(theme: Theme): void {
  memoryTheme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Persisting failed; `memoryTheme` keeps the current page working.
  }
  for (const listener of themeListeners) listener();
}

// The OS preference is a second external store (matchMedia).
let mediaQuery: MediaQueryList | null = null;

function getMediaQuery(): MediaQueryList {
  mediaQuery ??= window.matchMedia(MEDIA);
  return mediaQuery;
}

function getSystemSnapshot(): ResolvedTheme {
  return getMediaQuery().matches ? 'dark' : 'light';
}

function getSystemServerSnapshot(): ResolvedTheme {
  return 'light';
}

function subscribeSystem(onStoreChange: () => void): () => void {
  const query = getMediaQuery();
  query.addEventListener('change', onStoreChange);
  return () => query.removeEventListener('change', onStoreChange);
}

/**
 * Theme provider owning the `dark`/`light` class on `<html>`.
 *
 * The first paint is handled by `themeBootstrapScript` in the server layout, so
 * this provider never renders a `<script>` (React 19 dev-warns about
 * client-rendered scripts, which would not execute anyway). It only mirrors the
 * resolved theme onto `<html>` after hydration and on every later change.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = React.useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeServerSnapshot,
  );
  const systemTheme = React.useSyncExternalStore(
    subscribeSystem,
    getSystemSnapshot,
    getSystemServerSnapshot,
  );
  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme;

  // Push the resolved theme to `<html>`. The first run is skipped: during
  // hydration the snapshots are the server-safe fallbacks (`system`/`light`) and
  // the bootstrap script has already painted the real theme, so applying that
  // fallback would clobber it. Once hydration settles on the client snapshots,
  // any difference re-runs the effect with the correct value.
  const applied = React.useRef(false);
  React.useEffect(() => {
    if (!applied.current) {
      applied.current = true;
      return;
    }
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(resolvedTheme);
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, systemTheme, themes: THEMES, setTheme: setStoredTheme }),
    [theme, resolvedTheme, systemTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Access the current theme and switcher. Throws outside `ThemeProvider`. */
export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}
