export type ThemeMode = 'light' | 'dark';
const themeStorageKey = 'csv-viewer-theme';

/** A color palette, independent of light or dark mode. styles.css defines the tokens of each one. */
export type ThemePalette = 'studio' | 'ledger' | 'terminal' | 'aurora';
export const themePalettes = ['studio', 'ledger', 'terminal', 'aurora'] as const satisfies readonly ThemePalette[];
const paletteStorageKey = 'csv-viewer-palette';

const sidebarStorageKey = 'csv-viewer-sidebar-collapsed';

export function getInitialTheme(): ThemeMode {
  const storedTheme = readPreference(themeStorageKey);
  if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: ThemeMode): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
  savePreference(themeStorageKey, theme);
}

export function getInitialPalette(): ThemePalette {
  const storedPalette = readPreference(paletteStorageKey);
  return themePalettes.find((palette) => palette === storedPalette) ?? 'studio';
}

export function applyPalette(palette: ThemePalette): void {
  document.documentElement.dataset.palette = palette;
  savePreference(paletteStorageKey, palette);
}

/** Whether the Workbench sidebar starts collapsed to its icon rail. */
export function getInitialSidebarCollapsed(): boolean {
  return readPreference(sidebarStorageKey) === 'true';
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  savePreference(sidebarStorageKey, String(collapsed));
}

function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage can be blocked by the browser; callers fall back to a default.
    return null;
  }
}

function savePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The current session keeps the choice without saving it.
  }
}
