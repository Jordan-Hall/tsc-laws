// The batch queries getContextualTypes and getResolvedSignatures answer, in order, what getContextualType and
// getResolvedSignature answer for each location: tsc --api has no such methods, so tsc-ts is compared with itself.
import assert from 'node:assert/strict';
import { cpSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from './client.mjs';
import { nodeHandles } from './differential.mjs';
import { tempDir } from './temp.mjs';
import { typescriptLib as bundledLib, tscTs, tscTsMissing } from './toolchain.mjs';

const typescriptLib = bundledLib !== undefined && existsSync(bundledLib) ? realpathSync(bundledLib) : '';
const env = { TSC_TS_LIB_DIR: typescriptLib };
const skip = typescriptLib === '' ? 'needs the scriptc toolchain' : tscTsMissing;

// A handle `index.kind.path` relative to a copy's directory, in that copy.
function inCopy(server, relative) {
  const at = relative.indexOf('.', relative.indexOf('.') + 1) + 1;
  return relative.slice(0, at) + server.dir + relative.slice(at);
}

// A server's reply, with its copy's directory as `<dir>`: declarations name nodes by path.
function answer(server, reply) {
  return JSON.parse(reply.payload.toString().replaceAll(server.dir, '<dir>'));
}

// A tsc-ts server on its own copy of the fixture project, with the project's snapshot and source files.
async function open() {
  const dir = tempDir('tsc-ts-api-batch-');
  cpSync(resolve('tests/fixtures/project'), dir, { recursive: true });
  const client = new Client(tscTs, dir, env);
  await client.json('initialize');
  const update = await client.json('updateSnapshot', { openProjects: [join(dir, 'tsconfig.json')] });
  const base = { snapshot: update.snapshot, project: update.projects[0].id };
  // The handles of the copy's nodes, relative to the copy's directory.
  const located = [];
  for (const file of await client.json('getSourceFileNames', base)) {
    if (!file.startsWith(dir)) continue;
    const reply = await client.request('getSourceFile', { ...base, file });
    assert.equal(reply.type, 'response');
    for (const handle of nodeHandles(reply.payload, file)) located.push(handle.replace(dir, ''));
  }
  return { client, base, dir, located };
}

test(
  'batch contextual type and signature queries answer as their single-location methods',
  { skip, timeout: 600_000 },
  async () => {
    // The servers run the same checker work in the same order, so their type and signature ids agree. The first
    // finds the locations the single-location methods answer without an error; handles are kept relative to the copy.
    const probe = await open();
    const servers = [];
    try {
      const located = probe.located;
      assert.ok(located.length > 200, `${located.length} nodes`);
      const answers = async (server, method, relative) => {
        const reply = await server.client.request(method, { ...server.base, location: inCopy(server, relative) });
        return reply.type === 'error' ? { error: reply.payload.toString() } : answer(server, reply);
      };
      const typeLocations = [];
      const signatureLocations = [];
      for (const relative of located) {
        if ((await answers(probe, 'getContextualType', relative))?.error === undefined) typeLocations.push(relative);
        if ((await answers(probe, 'getResolvedSignature', relative))?.error === undefined)
          signatureLocations.push(relative);
      }

      const single = await open();
      const batched = await open();
      servers.push(single, batched);
      const expectedTypes = [];
      for (const relative of typeLocations) expectedTypes.push(await answers(single, 'getContextualType', relative));
      const expectedSignatures = [];
      for (const relative of signatureLocations)
        expectedSignatures.push(await answers(single, 'getResolvedSignature', relative));
      assert.ok(expectedTypes.some((type) => type !== null));
      assert.ok(expectedSignatures.some((signature) => signature !== null));
      const batch = (method, params) => batched.client.request(method, { ...batched.base, ...params });
      const locations = (list) => list.map((relative) => inCopy(batched, relative));
      assert.deepEqual(
        answer(batched, await batch('getContextualTypes', { locations: locations(typeLocations) })),
        expectedTypes,
      );
      assert.deepEqual(
        answer(batched, await batch('getResolvedSignatures', { locations: locations(signatureLocations) })),
        expectedSignatures,
      );

      // Empty batches answer empty lists; a batch with a location a single query refuses is refused with that error.
      const base = probe.base;
      for (const method of ['getContextualTypes', 'getResolvedSignatures']) {
        assert.deepEqual(await probe.client.json(method, { ...base, locations: [] }), []);
        assert.deepEqual(await probe.client.json(method, base), []);
      }
      const missing = `1.0.${join(probe.dir, 'missing.ts')}`;
      for (const [single, batch, answered] of [
        ['getContextualType', 'getContextualTypes', typeLocations[0]],
        ['getResolvedSignature', 'getResolvedSignatures', signatureLocations[0]],
      ]) {
        const refused = await probe.client.request(single, { ...base, location: missing });
        assert.equal(refused.type, 'error');
        const refusedBatch = await probe.client.request(batch, {
          ...base,
          locations: [inCopy(probe, answered), missing],
        });
        assert.equal(refusedBatch.type, 'error');
        assert.equal(refusedBatch.payload.toString(), refused.payload.toString());
      }
    } finally {
      for (const server of [probe, ...servers]) await server.client.close();
    }
  },
);
