import test from 'node:test';
import assert from 'node:assert/strict';
import { compareBudgets, relatedTests } from '../src/contextInspection';

const files = [
  {path:'src/check.ts',content:'export function check() { return "unpublished source text"; }\n'},
  {path:'tests/inputs.spec.ts',content:'import { check } from "../src/check";'},
  {path:'tests/check.test.ts',content:'export {};'},
  {path:'src/unrelated.ts',content:'import { check } from "./check";'},
  {path:'tests/isolated.spec.ts',content:'export {};'}
];
test('related tests ranks direct imports first and excludes unrelated test and source files', () => {
  assert.deepEqual(relatedTests(files,'src/check.ts'), [
    {path:'tests/inputs.spec.ts',reason:'Imports this source file'},
    {path:'tests/check.test.ts',reason:'Matching test filename'}
  ]);
  assert.deepEqual(relatedTests(files,'missing.ts'), []);
});
test('related Python tests support src layout and avoid pairing unrelated package indexes', () => {
  const py = [
    {path:'src/project/flags.py',content:'def enabled(): pass'},
    {path:'tests/test_flags.py',content:'from project.flags import enabled'},
    {path:'src/project/__init__.py',content:''},
    {path:'tests/__init__.py',content:''}
  ];
  assert.match(relatedTests(py,'src/project/flags.py')[0]!.reason,/Imports.*Matching/);
  assert.deepEqual(relatedTests(py,'src/project/__init__.py'),[]);
});
test('budget comparison reports range and same-line truncation without exposing source text', () => {
  const report = compareBudgets(files,'@file:src/check.ts',1000,10000,2);
  assert.match(report,/(?:Changed|Removed)  src\/check.ts/);
  assert.doesNotMatch(report,/unpublished source text|export function/);
  assert.match(report,/o200k_base/);
  assert.match(compareBudgets([], 'anything',1000,10,3), /Neither budget selected an excerpt/);
});
