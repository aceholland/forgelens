import assert from 'node:assert/strict';
import test from 'node:test';
import { selectContext } from '../src/context';
import { bm25Scores, importNeighbours } from '../src/retrievalIndex';
import { excerptTokenCount, fitExcerpt } from '../src/tokenBudget';

test('static imports connect source to local dependencies and reverse users in Python and TypeScript', () => {
  const files=[
    {path:'src/app.py',content:'from .helpers import answer'},
    {path:'src/helpers.py',content:'answer = 1'},
    {path:'suite.py',content:'from src.app import runner'},
    {path:'editor/view.ts',content:"import { button } from './buttons.js'"},
    {path:'editor/buttons.ts',content:'export const button = true'},
  ];
  const found=importNeighbours(files,new Set(['src/app.py','editor/view.ts']));
  assert.equal(found.get('src/helpers.py'),'imported by src/app.py');
  assert.equal(found.get('suite.py'),'imports src/app.py');
  assert.equal(found.get('editor/buttons.ts'),'imported by editor/view.ts');
  const scores=bm25Scores(files,['answer','runner']);
  assert.ok(scores[2]!>0 && scores[3]===0);
});

test('hard token limit uses counted Unicode excerpts with accurate line locations', () => {
  const raw=['alpha','世界の地図 🌏'.repeat(90),'omega'].join('\n');
  const fit=fitExcerpt(raw,1,9);
  assert.equal(fit.startOffset,1);
  assert.ok(fit.text.length>0 && !fit.text.includes('\uFFFD') && raw.split('\n')[1]!.startsWith(fit.text));
  assert.equal(fit.tokens,excerptTokenCount(fit.text));
  assert.ok(fit.tokens<=9);
  assert.doesNotThrow(()=>excerptTokenCount('<|endoftext|>'));
  const result=selectContext([{path:'a.ts',content:raw}], '@file:a.ts',9000, undefined,12);
  assert.ok(result.items.length>0 && result.usedTokens<=12);
  assert.equal(result.usedTokens,result.items.reduce((n,item)=>n+excerptTokenCount(item.content),0));
  for (const item of result.items) assert.equal(item.endLine!,item.startLine!+item.content.split('\n').length-1);
});
