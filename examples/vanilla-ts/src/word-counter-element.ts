// <word-counter text="..."> shows how many words its `text` attribute holds.
import { countWords } from './notes-store';

export class WordCounterElement extends HTMLElement {
  static observedAttributes = ['text'];

  connectedCallback(): void {
    this.setAttribute('role', 'status');
    this.render();
  }

  attributeChangedCallback(): void {
    this.render();
  }

  private render(): void {
    const n = countWords(this.getAttribute('text') ?? '');
    this.textContent = `${n} ${n === 1 ? 'word' : 'words'}`;
  }
}

if (!customElements.get('word-counter')) customElements.define('word-counter', WordCounterElement);
