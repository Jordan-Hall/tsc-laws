// A node:test reporter that writes one JSON line per finished top-level test, for run-tests.mjs.
export default async function* reporter(source) {
  for await (const event of source) {
    if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.nesting === 0)
      yield JSON.stringify({ name: event.data.name, passed: event.type === 'test:pass' }) + '\n';
  }
}
