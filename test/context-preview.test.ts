import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeContext, previewWorkspace } from '../src/contextPreview';

test('local context preview works without a provider and exposes only metadata to the panel', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forgelens-preview-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  await writeFile(path.join(root, 'model.ts'), 'export const taskLabel = "source-body-marker";\n');
  await writeFile(path.join(root, '.forgelensignore'), 'private.ts\n');
  await writeFile(path.join(root, 'private.ts'), 'export const hidden = "private-body-marker";\n');
  const selection = await previewWorkspace(root, '@file:model.ts @file:private.ts', 250, () => false);
  assert.ok(selection);
  const preview = describeContext(selection);
  assert.deepEqual(preview.items.map(item=>item.path), ['model.ts']);
  assert.ok(preview.items[0]!.startLine >= 1);
  assert.ok(preview.usedChars > 0 && preview.usedChars <= 250);
  assert.doesNotMatch(JSON.stringify(preview), /source-body-marker|private-body-marker/);
  assert.equal(await previewWorkspace(root, 'taskLabel', 250, () => true), undefined);
});
