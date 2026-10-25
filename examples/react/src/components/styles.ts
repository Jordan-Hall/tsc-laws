// The look of the board, as one stylesheet the App renders, so a component law mounts exactly what a user sees.
export const css = `
.board { --ink: #1f2937; --muted: #4b5563; --line: #e5e7eb; --accent: #4338ca; --accent-soft: #eef2ff; --danger: #b91c1c;
  box-sizing: border-box; max-width: 34rem; margin: 2rem auto; padding: 0 0 1rem; background: #fff; color: var(--ink);
  border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 10px 30px rgba(31, 41, 55, .10); overflow: hidden;
  font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
.board h1 { margin: 0; padding: 1.25rem 1.5rem; font-size: 1.35rem; letter-spacing: -.01em; color: #fff;
  background: linear-gradient(135deg, #4338ca, #6d28d9); }
.board form { display: flex; gap: .5rem; padding: 1rem 1.5rem .5rem; }
.board input[aria-label="New task"] { flex: 1; min-width: 0; font: inherit; padding: .6rem .8rem; border: 1px solid #9ca3af; border-radius: 10px; }
.board input[aria-label="New task"]:focus-visible, .board button:focus-visible, .board input[type=checkbox]:focus-visible {
  outline: 3px solid #a5b4fc; outline-offset: 2px; }
.board button { font: inherit; cursor: pointer; padding: .55rem .9rem; border-radius: 10px; border: 1px solid transparent; background: var(--accent); color: #fff; }
.board button:hover:not(:disabled) { filter: brightness(1.1); }
.board button:disabled { cursor: not-allowed; opacity: .5; }
.board [role=group] { display: flex; gap: .4rem; padding: .5rem 1.5rem; }
.board [role=group] button { background: transparent; color: var(--muted); border-color: var(--line); padding: .3rem .8rem; border-radius: 999px; }
.board [role=group] button[aria-pressed=true] { background: var(--accent-soft); color: var(--accent); border-color: #c7d2fe; font-weight: 600; }
.board ul { list-style: none; margin: .25rem 0; padding: 0; }
.board li.task { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .6rem 1.5rem; border-top: 1px solid var(--line); }
.board li.task:hover { background: #f9fafb; }
.board li.task label { display: flex; align-items: center; gap: .65rem; flex: 1; min-width: 0; cursor: pointer; }
.board li.task input[type=checkbox] { width: 1.15rem; height: 1.15rem; accent-color: var(--accent); }
.board li.task.done .title { text-decoration: line-through; color: var(--muted); }
.board li.task button { background: transparent; color: var(--danger); border-color: transparent; padding: .25rem .6rem; }
.board li.task button:hover { background: #fef2f2; }
.board .empty { margin: 1rem 1.5rem; color: var(--muted); text-align: center; }
.board footer { display: flex; align-items: center; justify-content: space-between; padding: .75rem 1.5rem 0; border-top: 1px solid var(--line); color: var(--muted); }
.board footer button { background: transparent; color: var(--accent); border-color: var(--line); }
`;
