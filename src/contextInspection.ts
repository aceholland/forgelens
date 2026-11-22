import { fileIdentity, selectContext, type ContextFile, type ContextSelection } from './context';
import { importNeighbours } from './retrievalIndex';

export function relatedTests(files: ContextFile[], source: string) {
  if (!files.some(file => file.path === source)) return [];
  const neighbours = importNeighbours(files, new Set([source]));
  const sourceFamily = fileIdentity(source).family;
  const parts = source.split('/');
  const matches = [];
  for (const file of files) {
    const { role, family } = fileIdentity(file.path);
    if (role !== 'tests' || file.path === source) continue;
    const directImport = neighbours.get(file.path) === 'imports ' + source;
    const pairedName = family === sourceFamily && !['index','__init__','main'].includes(family);
    if (!directImport && !pairedName) continue;
    const testParts = file.path.split('/');
    let shared = 0;
    while (shared < parts.length - 1 && parts[shared] === testParts[shared]) shared++;
    matches.push({ path: file.path, directImport, pairedName, shared });
  }
  return matches.sort((a,b) => Number(b.directImport) - Number(a.directImport) ||
    Number(b.pairedName) - Number(a.pairedName) || b.shared - a.shared || a.path.localeCompare(b.path))
    .map(({path, directImport, pairedName}) => ({
      path, reason: [directImport && 'Imports this source file', pairedName && 'Matching test filename'].filter(Boolean).join(' · ')
    }));
}

export function compareBudgets(files: ContextFile[], prompt: string, chars: number, current: number, alternative: number) {
  const select = (tokens: number) => selectContext(files, prompt, chars, undefined, tokens);
  const before = select(current), after = select(alternative);
  const excerpts = (selection: ContextSelection) => new Map(selection.items.map(item => [item.path, item]));
  const left = excerpts(before), right = excerpts(after);
  const lines = [
    'ForgeLens context budget comparison', '',
    'Current      ' + before.usedTokens + ' / ' + current + ' excerpt tokens',
    'Alternative  ' + after.usedTokens + ' / ' + alternative + ' excerpt tokens',
    'Character limit for both selections: ' + chars + '  |  Encoding: ' + before.encoding, ''
  ];
  for (const path of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(path), b = right.get(path);
    const span = (item: typeof a) => item ? 'lines ' + item.startLine + '–' + item.endLine + ' (' + item.content.length + ' chars)' : 'absent';
    const change = !a ? 'Added' : !b ? 'Removed' : a.startLine === b.startLine && a.content === b.content ? 'Same' : 'Changed';
    lines.push(change + '  ' + path, '  ' + span(a) + '  →  ' + span(b));
  }
  if (!left.size && !right.size) lines.push('Neither budget selected an excerpt.');
  return lines.join('\n');
}
