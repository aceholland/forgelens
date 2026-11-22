import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { confinedPath, listWorkspace } from './workspace';
import { isSafeContextPath } from './context';
import { copyPinnedFixtures, type FixturePins } from './candidateFixtures';

const execute = promisify(execFile);
export interface CandidateFile { path: string; original: string; content: string; isNew?: boolean }
export function candidateTestArgs(tests: string[]): string[] {
  return ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--', ...tests];
}

/** A clean copy protects the user's working tree. Pytest still runs trusted project code with local user permissions. */
export async function validateCandidate(root: string, overlays: CandidateFile[], tests: string[], python: string, signal?: AbortSignal, fixturePins:FixturePins={}): Promise<string> {
  if (!overlays.length) throw new Error('Stage a candidate edit before validating it.');
  if (tests.length > 20 || tests.some(test => {
    const [file, ...nodes] = test.split('::');
    return !file || !/^[\w][\w./-]*$/.test(file) || !isSafeContextPath(file)
      || file.split('/').some(part => !part) || nodes.some(node => !/^[\w.-]+$/.test(node));
  })) throw new Error('Choose workspace-relative test paths or pytest node IDs.');
  signal?.throwIfAborted();
  const scratch = await mkdtemp(path.join(tmpdir(), 'forgelens-candidate-'));
  try {
    const names = new Set(await listWorkspace(root, true));
    let bytes = 0;
    for (const name of names) {
      signal?.throwIfAborted();
      const source = await confinedPath(root, name);
      const info = await lstat(source);
      bytes += info.size;
      if (!info.isFile() || info.size > 16 * 1024 * 1024 || bytes > 128 * 1024 * 1024) {
        throw new Error('Candidate validation requires ordinary files and a workspace under 128 MiB (16 MiB per file).');
      }
      const target = path.join(scratch, name);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    const seen = new Set<string>();
    for (const file of overlays) {
      signal?.throwIfAborted();
      const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
      if (seen.has(key)) throw new Error('Duplicate candidate path.');
      seen.add(key);
      if (file.content.includes('\0') || file.content.length > 250000) throw new Error('Candidate must be a bounded text file.');
      const source = await confinedPath(root, file.path);
      const target = path.join(scratch, file.path);
      if (file.isNew) {
        try { await lstat(source); throw new Error(`New file already exists: ${file.path}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, { flag: 'wx' });
      } else {
        if (!names.has(file.path)) throw new Error(`Candidate source is excluded or missing: ${file.path}`);
        const saved = await readFile(target, 'utf8');
        const bom = saved.startsWith('\uFEFF') && !file.original.startsWith('\uFEFF') ? '\uFEFF' : '';
        if (saved !== bom + file.original) throw new Error(`Candidate is stale or the editor has unsaved changes: ${file.path}`);
        await writeFile(target, bom + file.content);
      }
    }
    await copyPinnedFixtures(root,scratch,fixturePins,signal);
    for (const test of tests) await lstat(path.join(scratch, test.split('::')[0]!));
    signal?.throwIfAborted();
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['PATH','SystemRoot','WINDIR','PATHEXT','COMSPEC','LANG','LC_ALL','TMPDIR','TMP','TEMP']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.PYTHONPATH = [path.join(scratch, 'src'), scratch].join(path.delimiter);
    env.PYTHONDONTWRITEBYTECODE = '1';
    env.PYTHONIOENCODING = 'utf-8';
    const args = candidateTestArgs(tests);
    let code = 0, output = '';
    try {
      const result = await execute(python, args, { cwd: scratch, env, signal, timeout: 120000, maxBuffer: 512 * 1024, windowsHide: true });
      output = result.stdout + result.stderr;
    } catch (error) {
      signal?.throwIfAborted();
      const failure = error as Error & {code?: number|string; killed?: boolean; stdout?: string; stderr?: string};
      if (typeof failure.code !== 'number' || failure.killed) throw new Error('Candidate tests could not finish: ' + failure.message);
      code = failure.code;
      output = (failure.stdout ?? '') + (failure.stderr ?? '');
    }
    return `Candidate pytest exited ${code}; ${overlays.length} staged file(s) in a temporary copy.\n${output.slice(-12000)}`;
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}
