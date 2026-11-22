import path from 'node:path';
import type { ContextFile } from './context';

/** Corpus-sensitive relevance for query words. Titles/roles and explicit mentions are scored by selectContext. */
export function bm25Scores(files: ContextFile[], words: string[]): number[] {
  const wanted = new Set(words);
  const documentCounts = new Map<string, number>();
  const documents = files.map(file => {
    const frequencies = new Map<string, number>();
    const tokens = file.content.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const token of tokens) if (wanted.has(token)) frequencies.set(token,(frequencies.get(token) ?? 0)+1);
    for (const token of frequencies.keys()) documentCounts.set(token,(documentCounts.get(token) ?? 0)+1);
    return { length: tokens.length, frequencies };
  });
  const average = documents.reduce((n, d) => n+d.length, 0) / Math.max(1, files.length) || 1;
  return documents.map(doc => {
    let score = 0;
    for (const [word, count] of doc.frequencies) {
      const frequency = documentCounts.get(word)!;
      const idf = Math.log1p((files.length-frequency+0.5)/(frequency+0.5));
      score += idf * count * 2.2 / (count + 1.2*(0.25 + 0.75*doc.length/average));
    }
    return score;
  });
}

/** Resolve static local imports without executing the repository or traversing outside the discovered file set. */
export function importNeighbours(files: ContextFile[], seeds: Set<string>): Map<string,string> {
  const names = new Set(files.map(f=>f.path));
  const neighbours = new Map<string,string>();
  for (const file of files) {
    const dir = path.posix.dirname(file.path);
    const bases = new Set<string>();
    if (/\.[cm]?[jt]sx?$/.test(file.path)) {
      const imports = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"\s]+)['"]/g;
      for (const match of file.content.matchAll(imports)) bases.add(path.posix.join(dir, match[1]!));
    } else if (file.path.endsWith('.py')) {
      for (const m of file.content.matchAll(/^\s*(?:from\s+([.\w]+)\s+import\s+(\w+)|import\s+([\w.]+))/gm)) {
        const spec=m[1]??m[3]!;
        const dots=spec.match(/^\.+/)?.[0].length??0;
        const module=spec.slice(dots).replace(/\./g,'/');
        if (dots) bases.add(path.posix.join(dir,'../'.repeat(dots-1),module||m[2]!));
        else { bases.add(module); bases.add('src/'+module); }
      }
    }
    for (const base of bases) {
      const resolved = [base,...['.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','/index.ts','/index.js','/__init__.py'].map(s=>base+s),
        ...(/\.[cm]?js$/.test(base)?[base.replace(/\.js$/,'.ts'),base.replace(/\.mjs$/,'.mts'),base.replace(/\.cjs$/,'.cts')]:[])].find(p=>names.has(p));
      if (!resolved || resolved===file.path) continue;
      if (seeds.has(file.path) && !seeds.has(resolved)) neighbours.set(resolved,`imported by ${file.path}`);
      if (seeds.has(resolved) && !seeds.has(file.path)) neighbours.set(file.path,`imports ${resolved}`);
    }
  }
  return neighbours;
}
