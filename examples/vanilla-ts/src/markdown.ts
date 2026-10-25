// A tiny markdown-lite converter: headings (# to ###), lists (- or *), paragraphs, **bold** and *italic*.
// Everything the author typed is escaped first, so the only tags in the output are the ones written here.

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes the five characters that can open a tag, close an attribute or start an entity. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => entities[c]!);
}

/** Escapes `text`, then turns `**bold**` and `*italic*` into tags. */
export function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

/** Converts markdown-lite to HTML. Blocks are separated by blank lines, so converting is concatenation-friendly. */
export function markdown(source: string): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  const endParagraph = (): void => {
    if (paragraph.length > 0) blocks.push(`<p>${inline(paragraph.join('\n'))}</p>`);
    paragraph = [];
  };
  const endList = (): void => {
    if (items.length > 0) blocks.push(`<ul>${items.join('')}</ul>`);
    items = [];
  };
  for (const line of source.split(/\r?\n/)) {
    // A heading or list item needs some text; a bare "# " would give an empty heading, which screen readers announce.
    const heading = /^(#{1,3}) +(.*\S.*)$/.exec(line);
    const item = /^[-*] +(.*\S.*)$/.exec(line);
    if (line.trim() === '') {
      endParagraph();
      endList();
    } else if (heading !== null) {
      endParagraph();
      endList();
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (item !== null) {
      endParagraph();
      items.push(`<li>${inline(item[1]!)}</li>`);
    } else {
      endList();
      paragraph.push(line);
    }
  }
  endParagraph();
  endList();
  return blocks.join('');
}
