// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { WebStartupState } from './web-startup-state';

afterEach(() => { cleanup(); });

it('leaves checking on a startup defect without calling the browser unsupported', () => {
  render(<WebStartupState status="failed" />);
  expect(screen.getByRole('heading', { name: 'CSV Viewer could not start' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Checking browser support' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'This browser cannot start CSV Viewer Web' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Reload CSV Viewer' })).toBeTruthy();
});
