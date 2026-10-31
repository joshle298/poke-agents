/**
 * Conversation text from Conductor as plain text (DOM-free, Node-tested).
 *
 * Messages carry light markdown: attachments arrive as mention links such as
 * `@[Transcript of X.md](.context%2Fattachments%2F...)`. The Pokédex shows a
 * link as its text, drops the `@` mention marker in front of it, and decodes
 * %XX escapes. The result is always rendered as a React text node, so no
 * markup in a message is ever interpreted as HTML.
 */

/** `@`? `!`? `[label](target "title")`, on one line. */
const MARKDOWN_LINK = /@?!?\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"\n]*")?\s*\)/g;
/** `<https://…>` autolinks. */
const AUTOLINK = /<((?:https?|mailto):[^>\s]+)>/g;

/** decodeURIComponent that leaves malformed escapes (a bare "%") as they are. */
function decodeEscapes(text: string): string {
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The text a link reads as: its label, else its decoded target. */
function linkText(label: string, target: string): string {
  const trimmed = label.trim();
  return trimmed ? decodeEscapes(trimmed) : decodeEscapes(target);
}

export function plainText(text: string): string {
  if (!text) return '';
  return text
    .replace(MARKDOWN_LINK, (_match, label: string, target: string) => linkText(label, target))
    .replace(AUTOLINK, (_match, url: string) => url);
}
