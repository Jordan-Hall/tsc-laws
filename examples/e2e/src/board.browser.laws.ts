import type { int } from 'tslaws';
import { assume } from 'tslaws';
import { accessible, baseURL, fast, open, page, settle } from 'tslaws/e2e';

// Each law starts from an empty board: the server keeps the tasks, so a law clears them first.
async function emptyBoard(): Promise<void> {
  await fetch(`${baseURL()}api/reset`, { method: 'POST' });
  await open('/');
  await settle();
}

async function addTask(title: string): Promise<void> {
  await page().fill('#title', title);
  await page().press('#title', 'Enter');
  await page().getByText(title, { exact: true }).first().waitFor();
}

// A task typed into the form shows up on the board, and the counter says one is left.
export async law addedTaskIsListed(title: string) {
  assume(title.trim() !== '' && !/[<>&]/.test(title));
  await emptyBoard();
  await addTask(title.trim());
  return (await page().locator('#list li').count()) === 1 && (await page().textContent('#left')) === '1 left';
}

// The counter always equals the number of tasks that are not done, across any number of adds and checks.
export async law counterCountsTheUndone(adds: int, checks: int) {
  const added = Math.abs(adds) % 5;
  const checked = Math.abs(checks) % (added + 1);
  await emptyBoard();
  for (let i = 0; i < added; i++) await addTask(`Task ${i + 1}`);
  for (let i = 0; i < checked; i++) await page().locator('#list li input[type=checkbox]').nth(i).check();
  await page().waitForFunction(`document.getElementById('left').textContent === '${added - checked} left'`);
  return (await page().textContent('#left')) === `${added - checked} left`;
}

// Deleting the only task leaves an empty board, and the page is told by the server, not by its own memory.
export async law deletedTaskStaysGone(title: string) {
  assume(title.trim() !== '' && !/[<>&]/.test(title));
  await emptyBoard();
  await addTask(title.trim());
  await page().getByRole('button', { name: /^Delete/ }).click();
  await page().waitForFunction(`document.querySelectorAll('#list li').length === 0`);
  await page().reload();
  await settle();
  return (await page().locator('#list li').count()) === 0;
}

// The whole page, with tasks on it, has no accessibility violation (axe-core).
export async law boardPageIsAccessible(count: int) {
  await emptyBoard();
  for (let i = 0; i < Math.abs(count) % 4; i++) await addTask(`Task ${i + 1}`);
  return await accessible();
}

// The page loads fast: paint, layout shift, main-thread blocking, size and load, against a budget.
export async law boardPageIsFast(n: int) {
  assume(n >= 0 && n <= 2);
  await open('/');
  await settle();
  return await fast({ fcp: 2500, lcp: 2500, cls: 0.1, blocking: 300, domNodes: 200, bytes: 50_000, load: 5000 });
}
