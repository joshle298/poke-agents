/**
 * Focus rules for dialogs (DOM-free, Node-tested).
 */

const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Whether focusing an element with this tag, `type` attribute and
 *  editability takes typed text (on a phone: summons the keyboard). */
export function isTextEntry(
  tagName: string,
  type: string | null | undefined,
  contentEditable = false,
): boolean {
  if (contentEditable) return true;
  const tag = tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return !NON_TEXT_INPUT_TYPES.has((type ?? 'text').toLowerCase());
}
