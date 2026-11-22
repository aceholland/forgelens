import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { createReviewSkillReadTracker, prepareReviewSkill, reviewSkillManifest, reviewSkillReadCommand } from '../src/nativeSkill';

test('native skill registration is idempotent, tolerates concurrent creation and preserves other manifests', async () => {
  let record: TrueForgeApi.ConfiguredSkill | undefined;
  let creations = 0;
  const client = {settings: {skills: {
    async list() { return {data: record ? [record] : []}; },
    async create({manifest}: {manifest: TrueForgeApi.GitSkill}) {
      creations++;
      record = {name: manifest.name, manifest};
      // We lost the race to another window registering the same manifest.
      throw Object.assign(new Error('exists'), {statusCode: 409});
    },
  }}} as unknown as TrueForge;
  assert.deepEqual(await prepareReviewSkill(client), {name: reviewSkillManifest.name, preload: false});
  await prepareReviewSkill(client);
  assert.equal(creations, 1);
  record = {name: reviewSkillManifest.name, manifest: {...reviewSkillManifest, ref: 'main'}};
  await assert.rejects(prepareReviewSkill(client), /different source/);
  assert.equal(creations, 1);
});

test('only a successful native sandbox read of the pinned checklist is verified', () => {
  const tracker = createReviewSkillReadTracker();
  const checklist = readFileSync('agent/skills/forgelens-review-checklist/SKILL.md', 'utf8');
  const common = {createdAt: '2026-01-01T00:00:00Z', threadId: 'main'};
  const call = (id: string, command: string, toolInfo: TrueForgeApi.ToolInfo = {type: 'truefoundry-system', name: 'exec'}) =>
    tracker.observe({...common, type: 'model.message', id: 'model-' + id, toolCalls: [{id, type: 'function', toolInfo,
      function: {name: 'exec', arguments: JSON.stringify({command, intent: 'Read the checklist'})}}]});
  const reply = (id: string, result: string, exitCode = 0, threadId = 'main') => tracker.observe({...common,
    threadId, type: 'tool.response', id: 'tool-' + id, toolCallId: id, content: JSON.stringify({success: true, response: {exitCode, result}})});
  reply('missing', checklist);
  call('a', 'echo another-file'); reply('a', checklist);
  call('b', reviewSkillReadCommand); reply('b', 'another file');
  call('c', reviewSkillReadCommand); reply('c', checklist, 1);
  call('d', reviewSkillReadCommand, {type: 'mcp', name: 'exec', serverId: 'editor', serverName: 'editor'}); reply('d', checklist);
  call('e', reviewSkillReadCommand); reply('e', checklist, 0, 'other-thread');
  assert.equal(tracker.verified(), false);
  reply('e', checklist);
  assert.equal(tracker.verified(), true);
});
