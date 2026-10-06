import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A menu's `finalFocus` rule: return focus to where it was only while focus is still in the closing
 * menu or nowhere. A click elsewhere during the close animation keeps the focus it moved.
 */
export function focusStillInMenu(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active.closest('[role="menu"]') !== null;
}
