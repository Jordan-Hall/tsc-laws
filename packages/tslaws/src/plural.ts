/** `1 law`, `2 laws`: the noun takes an s unless there is exactly one. Pass the plural for irregular nouns. */
export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}
