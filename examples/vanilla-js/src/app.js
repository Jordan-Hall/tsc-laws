// Wires the widget to a page.
import { createWidget } from './widget.js';

/**
 * Starts the converter inside `root` (the element with id "app" when omitted) and focuses its value field.
 * @param {HTMLElement | null} [root]
 * @returns {import('./widget.js').Widget | undefined}
 */
export function start(root = document.getElementById('app')) {
  if (root === null) return undefined;
  const widget = createWidget(root);
  widget.input.focus();
  return widget;
}

if (typeof document !== 'undefined' && document.getElementById('app') !== null) start();
