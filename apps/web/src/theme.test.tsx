import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './theme';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function CurrentTheme() {
  return <output>{useTheme().theme}</output>;
}

it('updates an already-open window when the theme changes in another window', () => {
  localStorage.setItem('orsem-theme', 'dark');
  render(
    <ThemeProvider>
      <CurrentTheme />
    </ThemeProvider>,
  );
  expect(screen.getByText('dark')).toBeInTheDocument();
  act(() =>
    window.dispatchEvent(new StorageEvent('storage', { key: 'orsem-theme', newValue: 'light' })),
  );
  expect(screen.getByText('light')).toBeInTheDocument();
  expect(document.documentElement.dataset.theme).toBe('light');
});
