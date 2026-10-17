// parseBuildInfo reads the lists of file ids and of file names straight from the text, and the other
// fields through JSON values. A field whose value has another shape, or a repeated key, gives what the
// JSON object with those values gives: the last value of a key counts, and a value of the wrong type
// makes the text invalid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const out = compileSources('tsc-ts-build-info-text-', ['compiler/build-info.ts']);
const { parseBuildInfo, buildInfoToJson } = await import(pathToFileURL(join(out, 'compiler/build-info.js')).href);

test('build info text written by the writer reads back to the same text', () => {
  const text =
    '{"version":"7.0.2","errors":true,"root":[[2,3],4],"packageJsons":["./node_modules/a/package.json"],' +
    '"missingPackageJsons":["./node_modules/b/package.json"],"fileNames":["lib.es5.d.ts","./src/a.ts",' +
    '"./src/b.ts","./src/c \\"q\\" é.ts"],"fileInfos":["v1",{"version":"v2","signature":"s2"},' +
    '{"version":"v3","affectsGlobalScope":true,"impliedNodeFormat":99}],"fileIdsList":[[2,3],[4]],' +
    '"options":{"strict":true},"referencedMap":[[2,1],[3,2]],"semanticDiagnosticsPerFile":[1,[2,' +
    '[{"pos":3,"end":5,"code":2322,"category":1,"messageKey":"k","messageArgs":["x"]}]]],' +
    '"changeFileSet":[3],"affectedFilesPendingEmit":[2,[3,17]]}';
  const buildInfo = parseBuildInfo(text);
  assert.ok(buildInfo !== undefined);
  assert.deepEqual(buildInfo.fileIdsList, [[2, 3], [4]]);
  assert.deepEqual(buildInfo.fileNames, ['lib.es5.d.ts', './src/a.ts', './src/b.ts', './src/c "q" é.ts']);
  assert.equal(buildInfoToJson(buildInfo), text);
});

test('fields read straight from the text and through JSON values agree', () => {
  const read = (text) => {
    const buildInfo = parseBuildInfo(text);
    return buildInfo === undefined
      ? undefined
      : {
          fileIdsList: buildInfo.fileIdsList,
          fileNames: buildInfo.fileNames,
          packageJsons: buildInfo.packageJsons,
          missingPackageJsons: buildInfo.missingPackageJsons,
          referencedMap: buildInfo.referencedMap.map((r) => [r.fileId, r.fileIdListId]),
        };
  };
  // Whitespace anywhere, and numbers in every form JSON has.
  assert.deepEqual(read(' { "fileIdsList" : [ [ 1 , 2 ] , [ ] , [ -0 , 1.5 , 1e2 , 12345678901234567 ] ] } '), {
    fileIdsList: [[1, 2], [], [-0, 1.5, 100, 12345678901234567]],
    fileNames: [],
    packageJsons: [],
    missingPackageJsons: [],
    referencedMap: [],
  });
  assert.ok(Object.is(read('{"fileIdsList":[[-0]]}').fileIdsList[0][0], -0));
  // A repeated key takes its last value, whichever shape the earlier one had.
  assert.deepEqual(read('{"fileNames":5,"fileNames":["a"]}').fileNames, ['a']);
  assert.deepEqual(read('{"fileNames":["a"],"fileNames":["b"]}').fileNames, ['b']);
  assert.equal(read('{"fileNames":["a"],"fileNames":5}'), undefined);
  assert.equal(read('{"referencedMap":[[1,2]],"referencedMap":[[1]]}'), undefined);
  assert.deepEqual(read('{"referencedMap":[[1]],"referencedMap":[[1,2]]}').referencedMap, [[1, 2]]);
  // Values of the wrong type, and text that is not JSON.
  for (const text of [
    '{"fileIdsList":[[1,"2"]]}',
    '{"fileIdsList":[1]}',
    '{"fileNames":[1]}',
    '{"packageJsons":"a"}',
    '{"referencedMap":[[1,2,3]]}',
    '{"fileIdsList":[[1,]]}',
    '{"fileIdsList":[[01]]}',
    '{"fileNames":["a\nb"]}',
    '{"fileNames":["a"]} x',
    '{"fileNames":["a"]',
    '[]',
  ])
    assert.equal(read(text), undefined, text);
  // Keys other than these still need valid JSON values.
  assert.equal(read('{"other":[1,}'), undefined);
  assert.deepEqual(read('{"other":{"a":[1,"b",null]},"fileNames":["a"]}').fileNames, ['a']);
});

test('diagnostics read straight from the text and through JSON values agree', () => {
  const read = (text) => {
    const buildInfo = parseBuildInfo(text);
    return buildInfo === undefined
      ? undefined
      : JSON.parse(JSON.stringify([buildInfo.semanticDiagnosticsPerFile, buildInfo.emitDiagnosticsPerFile]));
  };
  const d =
    '"pos":1,"end":2,"code":3,"category":1,"messageKey":"k","messageArgs":["a","b"],' +
    '"messageChain":[{"code":4,"messageKey":"c","messageChain":[{"code":5}]}],"relatedInformation":[{"file":2,"pos":5,"noFile":true}],' +
    '"reportsUnnecessary":true,"reportsDeprecated":false,"skippedOnNoEmit":true,' +
    '"repopulateInfo":{"kind":1,"moduleReference":"m","mode":99,"packageName":"p"}';
  const both = (diagnostic) =>
    `{"semanticDiagnosticsPerFile":[1,[2,[{${diagnostic}}]],3],"emitDiagnosticsPerFile":[[4,[{${diagnostic}},{}]]]}`;
  const direct = read(both(d));
  assert.ok(direct !== undefined);
  assert.equal(direct[0][1].diagnostics.diagnostics[0].messageChain[0].messageChain[0].code, 5);
  // An unknown key, which is left out, makes the diagnostics go through JSON values.
  assert.deepEqual(read(both(d + ',"other":[1]')), direct);
  assert.deepEqual(read(both(d.replace('"code":3', '"code":3,"other":{}'))), direct);
  // A repeated key takes its last value.
  assert.deepEqual(read(both(d.replace('"code":3', '"code":9,"code":3'))), direct);
  assert.deepEqual(
    read(both(d.replace('"repopulateInfo":{"kind":1', '"repopulateInfo":{"kind":7,"other":0,"kind":1'))),
    direct,
  );
  // Values of the wrong type.
  for (const text of [
    both(d.replace('"code":3', '"code":"3"')),
    both(d.replace('"noFile":true', '"noFile":1')),
    both(d.replace('"messageArgs":["a","b"]', '"messageArgs":"a"')),
    both(d.replace('"kind":1', '"kind":"1"')),
    '{"semanticDiagnosticsPerFile":[[2]]}',
    '{"semanticDiagnosticsPerFile":[[2,[],3]]}',
    '{"semanticDiagnosticsPerFile":[[2,{}]]}',
    '{"semanticDiagnosticsPerFile":["2"]}',
    '{"emitDiagnosticsPerFile":[2]}',
  ])
    assert.equal(read(text), undefined, text);
});

test('lists of file ids read from text without whitespace keep their text, and others none', () => {
  assert.deepEqual(parseBuildInfo('{"fileIdsList":[[2,3],[],[14]]}').fileIdsListText, ['2,3', '', '14']);
  assert.deepEqual(parseBuildInfo('{"fileIdsList":[[2,3],[4, 5]]}').fileIdsListText, []);
  assert.deepEqual(parseBuildInfo('{"fileIdsList":[[2,3],[ ]]}').fileIdsListText, []);
  // A later value read through JSON values replaces the lists, and their text with them.
  const repeated = parseBuildInfo('{"fileIdsList":[[2,3]],"fileIdsList":[[4,1e0]]}');
  assert.deepEqual(repeated.fileIdsList, [[4, 1]]);
  assert.deepEqual(repeated.fileIdsListText, []);
});
