import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {instructions, instructionsForTools} from '../src/instructions';

test('published agent definition uses the same instructions as the runtime',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../agent/forgelens.json',import.meta.url),'utf8'));
 assert.equal(manifest.instructions,instructions);
});

 test('tool instructions match deferred or preloaded capabilities',()=>{
 assert.equal(instructionsForTools(false), instructions);
 assert.match(instructionsForTools(false), /Use deferred tool discovery/);
 assert.doesNotMatch(instructionsForTools(true), /deferred tool discovery/);
 assert.match(instructionsForTools(true), /already available/);
 assert.match(instructionsForTools(true), /Never use commands to write files or bypass review/);
 });

test('multi-file instruction transitions from bounded discovery to an exposed plan and staged writes',()=>{
 assert.match(instructions,/Call find_relevant_files once/);
 assert.match(instructions,/Use focused reads with exact line ranges/);
 assert.match(instructions,/report_plan/);
 assert.match(instructions,/call propose_write/);
 assert.match(instructions,/Targeted recovery reads are allowed/);
 assert.doesNotMatch(instructions,/After 6 exploration calls|read at most 2 files/);
 assert.doesNotMatch(instructions,/(?:tests|docs|src)\/[\w./-]+/);
});
