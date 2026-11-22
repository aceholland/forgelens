import assert from 'node:assert/strict';
import test from 'node:test';

test('only a matched native proposal receipt can request another schema-constrained file',async()=>{
  const {sequentialSchema} = await import(new URL('../scripts/sequential-schema.mjs',import.meta.url).href);
  const parameters={type:'object',properties:{plan:{type:'array'},files:{type:'array',maxItems:1}},required:['files']};
  const first=[{role:'system',content:'Use the sequential file plan.'},{role:'user',content:'Original request'}];
  const call={role:'assistant',tool_calls:[{id:'c1',type:'function',function:{name:'propose_changes'}}]};
  const receipt={role:'tool',tool_call_id:'c1',content:'Next planned file: sample.txt\nForgeLens sequential draft: continue'};
  assert.deepEqual(sequentialSchema(parameters,first).required,['files','plan']);
  assert.deepEqual(Object.keys(sequentialSchema(parameters,[...first,call,receipt]).properties),['files']);
  for(const last of [{...receipt,role:'user'},{...receipt,tool_call_id:'other'},{...receipt,content:'ForgeLens sequential draft: stopped'},
    {...receipt,content:'ForgeLens sequential draft: complete'}])assert.equal(sequentialSchema(parameters,[...first,call,last]),undefined);
  assert.equal(sequentialSchema(parameters,[...first,{...call,tool_calls:[]},receipt]),undefined);
  assert.deepEqual(parameters.required,['files']);
});
