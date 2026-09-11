'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// Preserve the original Demo-baseline regression without requiring that Demo
// to be present in a formal-mode checkout. See workbench-api/fixtures/README.md.
const sources = ['group-workbench/data-io.js', 'workbench-api/fixtures/data-io-demo-baseline.js'].map(file => path.resolve(__dirname, '..', file));
const first = fs.readFileSync(sources[0], 'utf8');
assert.equal(fs.readFileSync(sources[1], 'utf8'), first, 'Formal data I/O must match the frozen Demo baseline.');
let cases = 0;
for (const source of sources) {
  const io = require(source);
  const parse = text => {
    const rows = io.parseTidRows(text);
    rows.forEach(row => {
      assert.equal(typeof row.structureError, 'boolean');
      if (!row.error) assert.equal(row.structureError, false);
    });
    // Existing assertions below focus on row preservation/values; the explicit
    // structure-error assertions exercise the complete public result directly.
    return rows.map(({structureError, ...row}) => row);
  };
  const check = test => { test(); cases += 1; };
  const failure = (text, code, count = 1) => {
    const rows = parse(text);
    assert.equal(rows.length, count, text);
    assert(rows.every(row => row.error), text);
    if (code) assert(rows.every(row => row.code === code), text);
    return rows;
  };
  check(() => assert.deepEqual(parse(''), []));
  check(() => assert.deepEqual(parse('\uFEFF\r\n  \r\n\t\n'), []));
  check(() => assert.deepEqual(parse('\uFEFFTID\r\n000001\r\n\r\n AbC_2-3 \r\n'), [{ line: 2, tid: '000001' }, { line: 4, tid: 'AbC_2-3' }]));
  check(() => assert.deepEqual(parse('\n"任务TID"\n"0000123"\n"DEF_1-2"\n'), [{ line: 3, tid: '0000123' }, { line: 4, tid: 'DEF_1-2' }]));
  check(() => assert.deepEqual(parse('  001  \rABC\nXYZ\r\nLAST'), [{ line: 1, tid: '001' }, { line: 2, tid: 'ABC' }, { line: 3, tid: 'XYZ' }, { line: 4, tid: 'LAST' }]));
  check(() => assert.deepEqual(parse('TID\n'), []));
  check(() => assert.deepEqual(parse('Case_ID\nX'), [{ line: 2, tid: 'X' }]));
  check(() => {
    const rows = parse('TID\nAbC_01\nabc_01\nABC_01\nNEW');
    assert.equal(rows.length, 4); assert(!rows[0].error); assert(!rows[3].error);
    assert.equal(rows[1].code, 'DUPLICATE_TID'); assert.equal(rows[1].duplicateOf, 2);
    assert.equal(rows[2].duplicateOf, 2); assert.equal(rows[2].line, 4);
    assert.match(rows[1].error, /第 2 行/);
  });
  check(() => { const rows = parse('BAD A\nBAD A\nVALID\nvalid'); assert.equal(rows[0].code, 'INVALID_TID'); assert.equal(rows[1].code, 'INVALID_TID'); assert.equal(rows[3].duplicateOf, 3); });
  for (const input of ['A,B', 'A\tB', 'A，B', 'A;B', 'A；B', 'A,', ',A', 'A\t', '\tA', '"A,B"', '"A\tB"', '"A,B",C']) check(() => failure(input, 'MULTIPLE_COLUMNS'));
  check(() => { const rows = parse('TID\nGOOD\nA\t影片名\nOK\nB,验收通过'); assert.equal(rows.length, 4); assert.deepEqual(rows.filter(r => !r.error).map(r => r.tid), ['GOOD', 'OK']); assert.equal(rows[1].line, 3); assert.equal(rows[1].code, 'MULTIPLE_COLUMNS'); assert.equal(rows[3].line, 5); });
  check(() => { const rows = parse('TID\nA\t\nB'); assert.equal(rows[0].code, 'MULTIPLE_COLUMNS'); assert.deepEqual(rows[1], { line: 3, tid: 'B' }); });
  check(() => { const rows = parse('TID\t\nA'); assert.equal(rows.length, 2); assert.equal(rows[0].code, 'MULTIPLE_COLUMNS'); });
  check(() => failure('影片名,TID\n影片甲,A', 'MULTIPLE_COLUMNS', 2));
  check(() => failure('TID,状态\nA,验收通过', 'MULTIPLE_COLUMNS', 2));
  check(() => failure('TID\t状态\nA\t验收通过', 'MULTIPLE_COLUMNS', 2));
  for (const header of ['影片名', 'movie', '状态', 'status', '说明', 'note']) check(() => { const rows = parse(header+'\nA'); assert.equal(rows[0].code, 'WRONG_HEADER'); assert.deepEqual(rows[1], { line: 2, tid: 'A' }); });
  for (const bad of ['中文', 'A B', 'A/B', 'A.B', '=A1', '@ABC', 'x'.repeat(129), 'A\u200bB']) check(() => failure(bad, 'INVALID_TID'));
  check(() => assert.deepEqual(parse('x'.repeat(128)), [{ line: 1, tid: 'x'.repeat(128) }]));
  check(() => { const rows = failure('"A\r\nB"', 'MULTILINE_VALUE'); assert.equal(rows[0].line, 1); assert.equal(rows[0].lineEnd, 2); assert.equal(rows[0].input, '"A\nB"'); });
  check(() => { const rows = parse('TID\n"A\nB"\nC'); assert.equal(rows.length, 2); assert.equal(rows[0].code, 'MULTILINE_VALUE'); assert.equal(rows[0].line, 2); assert.equal(rows[0].lineEnd, 3); assert.deepEqual(rows[1], { line: 4, tid: 'C' }); });
  check(() => { const rows = parse('TID\n"BROKEN\nSHOULD_NOT_SPLIT'); assert.equal(rows.length, 1); assert.equal(rows[0].code, 'INVALID_QUOTING'); assert.equal(rows[0].lineEnd, 3); assert(rows[0].input.includes('SHOULD_NOT_SPLIT')); });
  check(() => { const rows = parse('TID\n"ABC"broken\nVALID'); assert.equal(rows[0].code, 'INVALID_QUOTING'); assert.deepEqual(rows[1], { line: 3, tid: 'VALID' }); });
  check(() => { const rows = parse('TID\n,\n""\nA\n,,\n\nB'); assert.equal(rows.length, 5); assert.deepEqual(rows.map(row => row.line), [2, 3, 4, 5, 7]); assert.equal(rows[0].code, 'MULTIPLE_COLUMNS'); assert.equal(rows[1].code, 'EMPTY_TID'); assert.equal(rows[3].code, 'MULTIPLE_COLUMNS'); });
  check(() => { const rows = parse(',,\nTID\nA'); assert.equal(rows.length, 3); assert.equal(rows[0].code, 'MULTIPLE_COLUMNS'); assert.equal(rows[1].tid, 'TID'); });
  check(() => {
    for (const value of ['A,B', 'A\tB', 'A B', 'A；B', '"A\nB"', '"unclosed', 'status']) assert.equal(io.parseTidRows(value)[0].structureError, true, value);
    for (const value of ['中文', 'A/B', 'A.B', '=A1', '@ABC', 'x'.repeat(129), 'A\u200bB', '""']) assert.equal(io.parseTidRows(value)[0].structureError, false, value);
    const rows = io.parseTidRows('TID\nA\na'); assert.equal(rows[0].structureError, false); assert.equal(rows[1].structureError, false); assert.equal(rows[1].code, 'DUPLICATE_TID');
  });
  check(() => { const rows = parse(Array.from({length:2000}, (_,index) => `ID_${String(index).padStart(5,'0')}`).join('\n')); assert.equal(rows.length, 2000); assert(rows.every(row => !row.error)); });
  check(() => {
    const context = { window: {} }; vm.createContext(context); vm.runInContext(fs.readFileSync(source, 'utf8'), context);
    assert.equal(typeof context.window.WorkbenchDataIO.parseTidRows, 'function');
    assert.equal(JSON.stringify(context.window.WorkbenchDataIO.parseTidRows('TID\nA\na')), JSON.stringify(io.parseTidRows('TID\nA\na')));
    assert(Object.isFrozen(context.window.WorkbenchDataIO));
  });
  // Compatibility APIs keep their existing two-/three-column semantics.
  check(() => assert.deepEqual(io.parseTaskRows('影片名,TID\n影片甲,A'), [{ line: 2, movie: '影片甲', tid: 'A' }]));
  check(() => assert.deepEqual(io.parseAcceptanceRows('说明\tTID\t状态\n补完\tA\t验收通过'), [{ line: 2, tid: 'A', status: '验收通过', note: '补完' }]));
}
console.log(JSON.stringify({ok:true,cases,implementations:sources,contract:'parseTidRows(input) => [{line,tid,structureError,error?,code?,input?,lineEnd?,duplicateOf?}]',unknownTidResolution:'Caller must resolve valid rows against existing tasks; parser never creates tasks.'},null,2));
