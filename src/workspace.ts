import { realpath, readFile, opendir, stat, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { isSafeContextPath } from './context';

const MAX_FILES = 3000;
const MAX_DISCOVERY_ENTRIES = 20000;
const MAX_IGNORE_BYTES = 65536;
const ignoreCache = new Map<string, { signature: string; paths: string[] }>();
const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

/** Optional .forgelensignore: literal workspace-relative paths, one per line.
 * Blank lines and # comments are ignored. A path excludes itself and its
 * descendants; a trailing slash is optional. Globs and negation are rejected.
 * These exclusions also apply to tracked files, explicit reads and edit targets.
 */
async function exclusions(base: string): Promise<string[]> {
  let info;
  try { info = await lstat(path.join(base, '.forgelensignore')); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    ignoreCache.delete(base); return [];
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_IGNORE_BYTES) throw new Error('Invalid .forgelensignore: expected a regular file of at most 64 KiB');
  const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const cached = ignoreCache.get(base);
  if (cached?.signature === signature) return cached.paths;
  const text = await readFile(path.join(base, '.forgelensignore'), 'utf8');
  if (Buffer.byteLength(text) > MAX_IGNORE_BYTES || text.includes('\0')) throw new Error('Invalid .forgelensignore: oversized or binary file');
  const paths: string[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const entry = line.replace(/\/$/, '');
    if (path.isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || /[\\*?!\[\]\0]/.test(entry) || entry.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Invalid .forgelensignore entry on line ${index + 1}: use literal relative paths, not globs or negation`);
    }
    paths.push(pathKey(entry));
  }
  if (ignoreCache.size >= 64) ignoreCache.delete(ignoreCache.keys().next().value!);
  ignoreCache.set(base, { signature, paths });
  return paths;
}
function excluded(relative: string, paths: string[]): boolean {
  const key = pathKey(relative);
  return paths.some(entry => key === entry || key.startsWith(entry + '/'));
}

/** One read-only Git process, with bounded output/time; no per-file commands. */
async function gitFiles(base: string, paths: string[], requireComplete: boolean): Promise<string[] | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', base, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
    const files = new Set<string>();
    let pending = '', stderr = '', bytes = 0, entries = 0, limited = false, failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('Git workspace discovery timed out'); child.kill(); }, 5000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.stdout.on('data', (chunk: string) => {
      if (limited || failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) { failure = new Error('Git workspace discovery exceeded its output limit'); child.kill(); return; }
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\0')) >= 0) {
        const name = pending.slice(0, end); pending = pending.slice(end + 1);
        if (isSafeContextPath(name) && !excluded(name, paths)) files.add(name);
        if (++entries >= MAX_DISCOVERY_ENTRIES || files.size >= MAX_FILES) { limited = true; child.kill(); break; }
      }
    });
    child.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); if (error.code === 'ENOENT') resolve(undefined); else reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (limited && requireComplete) reject(new Error('Workspace exceeds the candidate validation file limit.'));
      else if (limited || code === 0) resolve([...files]);
      else if (/not a git repository/i.test(stderr)) resolve(undefined);
      else reject(new Error('Git workspace discovery failed: ' + stderr.trim()));
    });
  });
}

export async function confinedPath(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || !isSafeContextPath(relative)) throw new Error('Path is not allowed');
  const base = await realpath(root);
  const paths = await exclusions(base);
  if (excluded(relative, paths)) throw new Error('Path excluded by .forgelensignore');
  const target = path.resolve(base, relative);
  if (!target.startsWith(base + path.sep)) throw new Error('Path escapes workspace');
  let resolved: string;
  try { resolved = await realpath(target); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    resolved = path.join(await realpath(path.dirname(target)), path.basename(target));
  }
  if (!resolved.startsWith(base + path.sep)) throw new Error('Symlink escapes workspace');
  if (!isSafeContextPath(path.relative(base, resolved).split(path.sep).join('/'))) throw new Error('Resolved path is protected');
  if (excluded(path.relative(base, resolved).split(path.sep).join('/'), paths)) throw new Error('Resolved path excluded by .forgelensignore');
  return resolved;
}
export async function readWorkspace(root: string, relative: string): Promise<string> {
  const target = await confinedPath(root, relative);
  if ((await stat(target)).size > 1000000) throw new Error('Oversized file excluded');
  const text = await readFile(target, 'utf8');
  if (text.includes('\0') || text.length > 250000) throw new Error('Binary or oversized file excluded');
  return text;
}
export async function listWorkspace(root: string, requireComplete = false): Promise<string[]> {
  const base = await realpath(root);
  const paths = await exclusions(base);
  const result: string[] = [];
  const candidates = await gitFiles(base, paths, requireComplete);
  if (candidates) {
    for (const name of candidates) {
      const target = path.join(base, name);
      try {
        // Git may list deleted files, submodules or a tracked path whose parent
        // was replaced by a symlink. None should enter automatic context.
        if ((await lstat(target)).isFile() && pathKey(await realpath(target)) === pathKey(target)) result.push(name);
      } catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    return result;
  }
  let visited = 0;
  async function walk(dir: string) {
    for await (const entry of await opendir(path.join(base, dir))) {
      if (++visited > MAX_DISCOVERY_ENTRIES || result.length >= MAX_FILES) {
        if (requireComplete) throw new Error('Workspace exceeds the candidate validation file limit.');
        return;
      }
      const name = path.posix.join(dir, entry.name);
      if (!isSafeContextPath(name) || excluded(name, paths) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) result.push(name);
    }
  }
  await walk(''); return result;
}
