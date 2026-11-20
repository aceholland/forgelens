import { realpath, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isSafeContextPath } from './context';

export async function confinedPath(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || !isSafeContextPath(relative)) throw new Error('Path is not allowed');
  const base = await realpath(root);
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
  return resolved;
}
export async function readWorkspace(root: string, relative: string): Promise<string> {
  const target = await confinedPath(root, relative);
  if ((await stat(target)).size > 1000000) throw new Error('Oversized file excluded');
  const text = await readFile(target, 'utf8');
  if (text.includes('\0') || text.length > 250000) throw new Error('Binary or oversized file excluded');
  return text;
}
export async function listWorkspace(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(path.join(root, dir), {withFileTypes:true})) {
      const name = path.posix.join(dir, entry.name);
      if (!isSafeContextPath(name) || entry.isSymbolicLink()) continue;
      if (result.length >= 3000) return;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) result.push(name);
    }
  }
  await walk(''); return result;
}
