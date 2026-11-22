import { selectContext, type ContextFile, type ContextSelection } from './context';
import { listWorkspace, readWorkspace } from './workspace';

export async function previewWorkspace(root: string, prompt: string, budget: number, stopped: () => boolean, tokenBudget=10000) {
  const files: ContextFile[] = [];
  let scanned = 0;
  for (const file of await listWorkspace(root)) {
    if (stopped()) return undefined;
    let content: string;
    try {
      content = await readWorkspace(root, file);
    } catch {
      continue;
    }
    if (scanned + content.length > 8_000_000) break;
    scanned += content.length;
    files.push({ path: file, content });
    if (scanned === 8_000_000) break;
  }
  if (stopped()) return undefined;
  return selectContext(files, prompt, budget, undefined, tokenBudget);
}

export function describeContext(result: ContextSelection) {
  return {
    usedChars: result.usedChars,
    budgetChars: result.budgetChars,
    usedTokens: result.usedTokens,
    budgetTokens: result.budgetTokens,
    encoding: result.encoding,
    items: result.items.map(({ path, startLine, endLine, reason, truncated }) => ({
      path, startLine: startLine ?? 1, endLine: endLine ?? 1, reason, truncated
    }))
  };
}
