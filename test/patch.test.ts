import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveProposal,resolveAgentProposal} from '../src/patch';
test('exact patches preserve surrounding text and use original offsets',()=>{assert.equal(resolveProposal('start A mid B end',{edits:[{oldText:'A',newText:'BB'},{oldText:'B',newText:'C'}]}),'start BB mid C end');});
test('patches reject ambiguous, missing, empty, overlapping, mixed or absent changes',()=>{for(const [original,input] of [['A A',{edits:[{oldText:'A',newText:'B'}]}],['A',{edits:[{oldText:'Z',newText:'B'}]}],['A',{edits:[{oldText:'',newText:'B'}]}],['ABC',{edits:[{oldText:'AB',newText:'X'},{oldText:'BC',newText:'Y'}]}],['A',{content:'B',edits:[{oldText:'A',newText:'B'}]}],['A',{}]] as const)assert.throws(()=>resolveProposal(original,input));});
test('legacy full-content proposals remain supported',()=>assert.equal(resolveProposal('A',{content:'B'}),'B'));

test('LF exact anchors apply to CRLF source without changing surrounding newlines',()=>{
 const original='prefix\r\ndef f():\r\n    return False\r\nsuffix\r\n';
 assert.equal(resolveProposal(original,{edits:[{oldText:'def f():\n    return False',newText:'def f():\n    return True'}]}),'prefix\r\ndef f():\r\n    return True\r\nsuffix\r\n');
});

test('CRLF model anchors apply to LF source and multiple offsets remain correct',()=>{
 const original='prefix\na\nb\nsuffix\n';
 assert.equal(resolveProposal(original,{edits:[{oldText:'a\r\nb',newText:'changed\r\nb'},{oldText:'suffix\n',newText:'tail\r\n'}]}),'prefix\nchanged\nb\ntail\n');
});

test('newline adaptation retains unique-anchor and overlap rejection',()=>{
 assert.throws(()=>resolveProposal('a\r\nb\r\na\r\nb\r\n',{edits:[{oldText:'a\nb',newText:'x'}]}),/exactly once/);
 assert.throws(()=>resolveProposal('a\r\nb\r\nc',{edits:[{oldText:'a\nb',newText:'x'},{oldText:'b\nc',newText:'y'}]}),/overlap/);
});

test('mixed-newline files retain strict matching instead of guessing a convention',()=>{
 const original='prefix\r\na\nb\r\nsuffix\n';
 assert.throws(()=>resolveProposal(original,{edits:[{oldText:'prefix\na',newText:'x'}]}),/exactly once/);
 assert.equal(resolveProposal(original,{edits:[{oldText:'a\nb',newText:'changed\nb'}]}),'prefix\r\nchanged\nb\r\nsuffix\n');
});

test('complete proposals preserve the uniform original newline convention',()=>{
 assert.equal(resolveProposal('before\r\n',{content:'after\nsecond\n'}),'after\r\nsecond\r\n');
 assert.equal(resolveProposal('before\n',{content:'after\r\nsecond\r\n'}),'after\nsecond\n');
});

test('newline expansion cannot make a complete proposal exceed the file limit',()=>{
 assert.throws(()=>resolveProposal('original\r\n',{content:'x\n'.repeat(100000)}),/exceeds limit/);
});

test('agent approval rejects full-file content before preview and preserves exact edit support',()=>{
 assert.throws(()=>resolveAgentProposal('prefix\nold\nsuffix\n',{content:'fragment'}),/exact edits/);
 assert.throws(()=>resolveAgentProposal('old',{content:'new',edits:[{oldText:'old',newText:'new'}]}),/exact edits/);
 assert.equal(resolveAgentProposal('prefix\r\nold\r\nsuffix\r\n',{edits:[{oldText:'old\n',newText:'new\n'}]}),'prefix\r\nnew\r\nsuffix\r\n');
});
