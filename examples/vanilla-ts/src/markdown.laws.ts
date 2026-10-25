import { assume } from 'tslaws';
import { escapeHtml, markdown } from './markdown';

// The preview is set with innerHTML, so this is the law that keeps it safe: no input ever opens a script tag.
export law markdownNeverEmitsScript(source: string) {
  return !/<script/i.test(markdown(source));
}

export law escapedTextHasNoMarkup(text: string) {
  return !/[<>"']/.test(escapeHtml(text)) && !/&(?!amp;|lt;|gt;|quot;|#39;)/.test(escapeHtml(text));
}

// Blocks are separated by blank lines, so converting two notes joined by one is converting each and joining.
export law blocksConcatenate(a: string, b: string) {
  return markdown(`${a}\n\n${b}`) === markdown(a) + markdown(b);
}

export law blankInputIsEmptyOutput(spaces: ('' | ' ' | '\n' | '\t' | '\r\n')[]) {
  return markdown(spaces.join('')) === '';
}

export law headingsStopAtLevelThree(source: string) {
  return !/<h[4-9]/.test(markdown(source));
}

export law tagsStayBalanced(source: string) {
  const html = markdown(source);
  const count = (re: RegExp): number => (html.match(re) ?? []).length;
  return (
    count(/<p>/g) === count(/<\/p>/g) &&
    count(/<ul>/g) === count(/<\/ul>/g) &&
    count(/<li>/g) === count(/<\/li>/g) &&
    count(/<strong>/g) === count(/<\/strong>/g) &&
    count(/<em>/g) === count(/<\/em>/g)
  );
}

export law plainTextSurvivesAsAParagraph(words: ('alpha' | 'beta' | 'gamma')[]) {
  assume(words.length > 0);
  const text = words.join(' ');
  return markdown(text) === `<p>${text}</p>`;
}

// An empty heading is announced by screen readers as nothing at all, so the converter never writes one.
export law noEmptyHeadingsOrItems(source: string) {
  return !/<h[1-3]><\/h[1-3]>/.test(markdown(source)) && !markdown(source).includes('<li></li>');
}

export law headingLevelFollowsHashes(level: 1 | 2 | 3, text: 'alpha' | 'beta' | 'gamma') {
  return markdown(`${'#'.repeat(level)} ${text}`) === `<h${level}>${text}</h${level}>`;
}

export law listItemsBecomeOneList(items: ('alpha' | 'beta' | 'gamma')[]) {
  assume(items.length > 0);
  return (
    markdown(items.map((item) => `- ${item}`).join('\n')) === `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`
  );
}

export law emphasisBecomesTags(text: 'alpha' | 'beta') {
  return markdown(`**${text}** and *${text}*`) === `<p><strong>${text}</strong> and <em>${text}</em></p>`;
}
