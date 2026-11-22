import { createTwoFilesPatch } from 'diff';
import { isSafeContextPath } from './context';
import { renderProposal, type ReviewStore } from './review';

/** Git's quoted path syntax uses C escapes and octal UTF-8 bytes, not JSON \u escapes. */
function quotePath(value: string): string {
  return '"' + [...Buffer.from(value, 'utf8')].map(byte => {
    if (byte === 34) return '\\"';
    if (byte === 92) return '\\\\';
    if (byte < 32 || byte >= 127) return '\\' + byte.toString(8).padStart(3, '0');
    return String.fromCharCode(byte);
  }).join('') + '"';
}

/** Pure text export of accepted hunks against their immutable review originals.
 * Does not apply, save, remove proposals, change decisions or read the workspace.
 * New files use /dev/null as their patch base. Empty edits to existing files truncate them.
 * Returns an empty string when there are no accepted content changes.
 */
export function exportAcceptedPatch(store: Pick<ReviewStore, 'list'>): string {
  const patches: string[] = [];
  for (const proposal of store.list()) {
    const after = renderProposal(proposal, 'accepted');
    if (after === proposal.original) continue;
    const file = proposal.path;
    if (!isSafeContextPath(file) || file.includes('\0') || file.split('/').some(part => !part) || Buffer.from(file, 'utf8').toString('utf8') !== file) throw new Error('Cannot export an unsafe patch path');
    if (proposal.original.includes('\0') || after.includes('\0')) throw new Error('Cannot export binary content as a text patch');
    const beforeName = quotePath('a/' + file), afterName = quotePath('b/' + file);
    const patch = createTwoFilesPatch(proposal.kind === 'create' ? '/dev/null' : beforeName, afterName, proposal.original, after, undefined, undefined, {
      context: 3, headerOptions: { includeIndex: false, includeUnderline: false, includeFileHeaders: true }
    });
    patches.push(`diff --git ${beforeName} ${afterName}\n${proposal.kind === 'create' ? 'new file mode 100644\n' : ''}${patch}`);
  }
  return patches.join('');
}
