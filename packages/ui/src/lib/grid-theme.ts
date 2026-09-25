import { themeQuartz } from 'ag-grid-community';

/**
 * The AG Grid theme for every grid. Each color and font param reads a styles.css token, so switching
 * the palette or light/dark mode restyles open grids without swapping the theme object.
 */
export const gridTheme = themeQuartz.withParams({
  accentColor: 'var(--primary)',
  backgroundColor: 'var(--card)',
  foregroundColor: 'var(--card-foreground)',
  borderColor: 'var(--border)',
  chromeBackgroundColor: 'var(--muted)',
  headerBackgroundColor: 'var(--grid-header)',
  headerTextColor: 'var(--foreground)',
  oddRowBackgroundColor: 'var(--grid-odd-row)',
  selectedRowBackgroundColor: 'color-mix(in oklch, var(--primary) 14%, transparent)',
  browserColorScheme: 'inherit',
  fontFamily: 'var(--font-sans)',
  headerFontFamily: 'var(--font-display)',
  fontSize: 'var(--grid-font-size)',
  headerFontSize: 'var(--grid-font-size)',
  headerFontWeight: 700,
  spacing: 'var(--grid-spacing)',
  rowHeight: 32,
  iconSize: 15,
  borderRadius: 'calc(var(--radius) * 0.6)',
  wrapperBorder: false,
  wrapperBorderRadius: 0,
});
