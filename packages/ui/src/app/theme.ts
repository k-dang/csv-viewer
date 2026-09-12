export type ThemeMode = 'light' | 'dark';
const themeStorageKey = 'csv-viewer-theme';

export function getInitialTheme(): ThemeMode {
  try {
    const storedTheme = window.localStorage.getItem(themeStorageKey);
    if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme;
  } catch {
    // Storage can be blocked by the browser; use the system preference instead.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: ThemeMode): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
  try {
    window.localStorage.setItem(themeStorageKey, theme);
  } catch {
    // The current session can still change theme without saving the preference.
  }
}
