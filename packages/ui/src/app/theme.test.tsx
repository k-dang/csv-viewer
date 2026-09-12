// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RendererWorkspace } from './renderer-workspace';
import { App } from './App';
import { applyTheme, getInitialTheme } from './theme';
import { createTestCsvViewer, withCsvViewer } from '../test-helpers/csv-viewer';

let workspace: RendererWorkspace;
afterEach(() => {
  workspace?.dispose();
  cleanup();
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  document.documentElement.style.colorScheme = '';
  vi.unstubAllGlobals();
});

it('applies the system theme at startup, toggles it, and restores the saved choice', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  applyTheme(getInitialTheme());
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  const viewer = createTestCsvViewer({ capabilities: { recentCsvSources: false } });
  workspace = new RendererWorkspace(viewer, { confirmClose: () => true });
  render(withCsvViewer(<App workspace={workspace} />, viewer));
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
  expect(document.documentElement.classList.contains('dark')).toBe(false);
  expect(document.documentElement.style.colorScheme).toBe('light');
  expect(window.localStorage.getItem('csv-viewer-theme')).toBe('light');
  expect(getInitialTheme()).toBe('light');
  fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(document.documentElement.style.colorScheme).toBe('dark');
  expect(window.localStorage.getItem('csv-viewer-theme')).toBe('dark');
});
