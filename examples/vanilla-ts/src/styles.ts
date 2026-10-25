// The look of the notes app: one stylesheet the app puts in its root, so a browser law mounts what a user sees.
const css = `
.notes-app { --ink: #1f2937; --muted: #4b5563; --line: #e5e7eb; --accent: #0f766e; --accent-soft: #ccfbf1; --danger: #b91c1c;
  box-sizing: border-box; display: grid; grid-template-columns: 15rem 1fr; grid-template-areas: "bar bar" "list editor"; gap: 1rem 1.5rem;
  max-width: 52rem; margin: 2rem auto; padding: 1.25rem; background: #fff; color: var(--ink);
  border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 10px 30px rgba(31, 41, 55, .10);
  font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
.notes-app > button { grid-area: bar; justify-self: start; }
.notes-app > p { grid-area: bar; justify-self: end; align-self: center; margin: 0; color: var(--muted); }
.notes-app > div:nth-of-type(1) { grid-area: list; }
.notes-app > div:nth-of-type(2) { grid-area: editor; display: flex; flex-direction: column; gap: .75rem; }
.notes-app button { font: inherit; cursor: pointer; padding: .45rem .9rem; border-radius: 10px; border: 1px solid transparent; background: var(--accent); color: #fff; }
.notes-app button:hover:not(:disabled) { filter: brightness(1.12); }
.notes-app button:disabled { cursor: not-allowed; opacity: .5; }
.notes-app button:focus-visible, .notes-app input:focus-visible, .notes-app textarea:focus-visible { outline: 3px solid #5eead4; outline-offset: 2px; }
.notes-app label { display: flex; flex-direction: column; gap: .25rem; font-weight: 600; font-size: .9rem; }
.notes-app input, .notes-app textarea { font: 400 1rem/1.4 inherit; padding: .5rem .7rem; border: 1px solid #9ca3af; border-radius: 10px; }
.notes-app textarea { min-height: 7rem; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9rem; }
.notes-app ul { list-style: none; margin: .75rem 0 0; padding: 0; display: grid; gap: .35rem; }
.notes-app li { display: flex; gap: .25rem; align-items: center; }
.notes-app li > button:first-child { flex: 1; text-align: left; background: transparent; color: var(--ink); border-color: var(--line); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notes-app li > button[aria-pressed=true] { background: var(--accent-soft); border-color: #5eead4; color: #115e59; font-weight: 600; }
.notes-app li > button:last-child { background: transparent; color: var(--danger); padding: .45rem .55rem; }
.notes-app li > button:last-child:hover { background: #fef2f2; }
.notes-app [role=region] { min-height: 4rem; padding: .75rem 1rem; border: 1px dashed #9ca3af; border-radius: 10px; background: #f9fafb; }
.notes-app [role=region] h1, .notes-app [role=region] h2, .notes-app [role=region] h3 { margin: .2rem 0 .4rem; line-height: 1.25; }
.notes-app [role=region] p { margin: .3rem 0; }
.notes-app word-counter { display: block; color: var(--muted); font-size: .85rem; }
`;

/** Gives `root` the notes look. */
export function installStyles(root: HTMLElement): void {
  root.classList.add('notes-app');
  const style = document.createElement('style');
  style.textContent = css;
  root.prepend(style);
}
