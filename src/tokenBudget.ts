import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

const ordinaryText = { disallowedSpecial: new Set<string>() };
export function excerptTokenCount(text: string): number { return countTokens(text, ordinaryText); }

/** Retain the highest-ranked line when a character-bounded window still exceeds the BPE limit. */
export function fitExcerpt(text: string, anchor: number, budget: number) {
  const tokens = excerptTokenCount(text);
  if (tokens <= budget) return { text, tokens, startOffset: 0 };
  const lines = text.split('\n');
  const at = Math.max(0, Math.min(lines.length-1, anchor));
  let result = { text: '', tokens: 0, startOffset: at };
  let low = 1, high = lines.length;
  while (low <= high) {
    const width = Math.floor((low+high)/2);
    const first = Math.max(0, Math.min(at-Math.floor(width/2), lines.length-width));
    const window = lines.slice(first,first+width).join('\n');
    const size = excerptTokenCount(window);
    if (size <= budget) { result={text:window,tokens:size,startOffset:first}; low=width+1; }
    else high=width-1;
  }
  if (result.text || !lines[at]) return result;
  const chars = Array.from(lines[at]!);
  low=1; high=chars.length;
  while(low<=high) {
    const end=Math.floor((low+high)/2), prefix=chars.slice(0,end).join(''), size=excerptTokenCount(prefix);
    if(size<=budget){result={text:prefix,tokens:size,startOffset:at};low=end+1;}
    else high=end-1;
  }
  return result;
}
