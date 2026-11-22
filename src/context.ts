import { bm25Scores, importNeighbours } from './retrievalIndex';
import { fitExcerpt } from './tokenBudget';

export interface ContextFile { path: string; content: string; symbols?: string[] }
export interface ContextItem extends ContextFile { reason: string; score: number; truncated: boolean; startLine?: number; endLine?: number }
export interface ContextSelection {
  items: ContextItem[];
  usedChars: number;
  budgetChars: number;
  usedTokens: number;
  budgetTokens: number;
  encoding: 'o200k_base';
  draftFiles?: ReadonlyMap<string, { hash: string; lineCount: number; lastLineLength: number }>;
}

export function isSafeContextPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.toLowerCase().split('/');
  if (parts.some(p => ['..', '.', '.git', '.pytest_cache', '__pycache__', '.mypy_cache', '.ruff_cache', '.ssh', '.aws', '.azure', '.config', 'node_modules', '.venv', 'venv', 'dist', 'build'].includes(p))) return false;
  const name = parts.at(-1)!.toLowerCase();
  if (name === '.forgelensignore') return false;
  return !(/^(?:\.env(?:\..*)?|secrets?(?:[.-].*)?|credentials?(?:[.-].*)?|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519)$/.test(name)
    || /\.(?:pem|key|p12|pfx|keystore)$/.test(name));
}

export function parseMentions(query: string): { files: string[]; symbols: string[] } {
  const files: string[] = [], symbols: string[] = [];
  for (const match of query.matchAll(/@(file:|symbol:)?([\w./-]+)/g)) {
    const target = match[2]!.replace(/[.,;:!?]+$/, '');
    if (!target) continue;
    const list = match[1] === 'symbol:' ? symbols : files;
    if (!list.includes(target)) list.push(target);
  }
  return { files, symbols };
}

const STOPWORDS = new Set(['the', 'and', 'with', 'that', 'this', 'from', 'into', 'for', 'add', 'new', 'must', 'file', 'symbol', 'any', 'its', 'every', 'other', 'also', 'all', 'only', 'should', 'will', 'can', 'use', 'using', 'have', 'has', 'not', 'are', 'was', 'but', 'then']);
function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? [])].filter(t => !STOPWORDS.has(t));
}

type Role = 'source' | 'tests' | 'docs' | 'other';
export function fileIdentity(path: string): { role: Role; family: string } {
  const parts = path.toLowerCase().split('/');
  const base = parts.at(-1)!;
  const stem = base.replace(/\.[^.]+$/, '').replace(/^test[_-]/, '').replace(/[_.-](?:test|spec)s?$/, '');
  const role = parts.some(p=>/^(?:test|tests|spec|specs|__tests__)$/.test(p)) || /^(test[_-])|[_.-](test|spec)s?\.[^.]+$/.test(base) ? 'tests'
    : parts.some(p=>/^(?:docs?|documentation)$/.test(p)) ? 'docs'
    : /\.(?:py|[cm]?[jt]sx?|rb|go|rs|java|kt|cs|c|cpp|h|php|swift|vue|svelte)$/.test(base) ? 'source' : 'other';
  return { role, family: stem };
}

/** Stable lexical retrieval with explicit mentions first, returning bounded snippets. */
export function selectContext(files: ContextFile[], query: string, budgetChars: number, options?: {maxFiles:number;maxLines:number}, budgetTokens=10000): ContextSelection {
  if (!Number.isSafeInteger(budgetChars) || budgetChars < 0) throw new Error('Context budget must be a nonnegative integer.');
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 0) throw new Error('Token budget must be a nonnegative integer.');
  const mentions = parseMentions(query);
  const keywords = terms(query.replace(/@(file:|symbol:)?[\w./-]+/g, ''));
  const safeFiles = files.filter(file => isSafeContextPath(file.path));
  const automatic = !mentions.files.length && !mentions.symbols.length;
  const identities = safeFiles.map(f=>fileIdentity(f.path));
  const families = new Map<string,Set<Role>>();
  for (const {role,family} of identities) {
    if (!keywords.includes(family) || role === 'other') continue;
    const roles = families.get(family) ?? new Set<Role>();
    roles.add(role);
    families.set(family,roles);
  }
  const wantsTests = /\b(?:test|tests|testing|coverage)\b/i.test(query);
  const wantsDocs = /\b(?:docs?|documentation|documented|document)\b/i.test(query);
  const coherent = automatic && wantsTests && wantsDocs;
  const coherentFamily = coherent ? [...families].filter(([,roles])=>roles.size===3)
    .sort(([a],[b])=>keywords.indexOf(a)-keywords.indexOf(b) || a.localeCompare(b))[0]?.[0] : undefined;
  const createsFeature = automatic && /\b(?:add|introduce|create|register)\b/i.test(query);
  const quoted = [...query.matchAll(/(?:`([^`\n]+)`|"([^"\n]+)"|(--[a-z][\w-]+))/gi)]
    .map(m=>(m[1]??m[2]??m[3]??'').toLowerCase()).filter(t=>/[a-z]/.test(t));
  const directive = /\b(?:add|register|install|mount|wire|expose|declare|define|setup|set up)\b/i;
  // Prefer the leading request subject for additions; later acceptance details
  // can otherwise dominate unrelated constructs and sections.
  const featureWords = createsFeature ? keywords.slice(0, 6) : keywords;
  const requestedKinds = new Set([...featureWords,...(keywords.includes('commands')?['command']:[])]);
  const bm25 = bm25Scores(safeFiles, keywords);
  const scored = safeFiles.map((file,index) => {
    const {role,family} = identities[index]!;
    const reasons: string[] = [];
    let score = 0;
    if (mentions.files.includes(file.path)) { score += 10000; reasons.push('explicit @file mention'); }
    const matchedSymbols = mentions.symbols.filter(s => file.symbols?.includes(s) || new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(file.content));
    if (matchedSymbols.length) { score += 5000; reasons.push(`explicit @symbol: ${matchedSymbols.join(', ')}`); }
    const lowerPath = file.path.toLowerCase(), lowerContent = file.content.toLowerCase();
    const pathTerms = lowerPath.split(/[^a-z0-9]+/);
    const matches = keywords.filter(term => pathTerms.includes(term) || lowerContent.includes(term));
    for (const term of matches) score += pathTerms.includes(term) ? 6 : 1;
    score += bm25[index]!;
    if (matches.length) reasons.push(`lexical relevance: ${matches.join(', ')}`);
    if (family === coherentFamily && role !== 'other') { score += 30; reasons.push(`matching ${role} module: ${family}`); }
    return { ...file, role, family, reason: reasons.join('; '), score };
  });
  const rank = (a:typeof scored[number],b:typeof scored[number])=>b.score-a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if(automatic && !coherentFamily) {
    const seeds=scored.filter(f=>f.score>0).sort(rank).slice(0,2);
    const links=importNeighbours(safeFiles,new Set(seeds.map(f=>f.path)));
    for(const file of scored) {
      const link=links.get(file.path);
      if(link){ file.score+=4; file.reason=[file.reason,link].filter(Boolean).join('; '); }
    }
  }
  const candidates=scored.filter(file=>file.score>0).sort(rank);
  // Diversify automatic retrieval across top-level areas (implementation, tests, docs)
  // without baking in any repository-specific filenames. Explicit mentions retain rank.
  if (!mentions.files.length && !mentions.symbols.length) {
    const remaining = [...candidates], ordered: typeof candidates = [], counts = new Map<string,number>();
    while (remaining.length) {
      const adjusted = (f: typeof candidates[number]) => f.score / (1 + (counts.get(f.path.split('/')[0]!) ?? 0));
      remaining.sort((a,b)=>adjusted(b)-adjusted(a) || a.path.localeCompare(b.path));
      const next = remaining.shift()!; ordered.push(next);
      const area = next.path.split('/')[0]!; counts.set(area,(counts.get(area) ?? 0)+1);
    }
    candidates.splice(0,candidates.length,...ordered);
  }
  if (coherentFamily) {
    const bestByRole = (['source','tests','docs'] as const).flatMap(role=>candidates.find(f=>f.family===coherentFamily&&f.role===role)??[]);
    if(bestByRole.length===3)candidates.splice(0,candidates.length,...bestByRole);
  }
  const items: ContextItem[] = [];
  let usedChars = 0;
  let usedTokens = 0;
  const seen = new Set<string>();
  const hasMentions=!!(mentions.files.length || mentions.symbols.length);
  // Broader automatic packs get more focused windows when both budgets allow it.
  // Explicit mentions and the discovery tool retain their own allocation rules.
  const automaticWindows=Math.max(4,Math.min(16,Math.floor(budgetChars/1500),Math.floor(budgetTokens/600)));
  const maxFiles=options?.maxFiles??(hasMentions?4:automaticWindows), maxLines=options?.maxLines??Infinity;
  const snippetBudget = !options&&hasMentions ? budgetChars : Math.ceil(budgetChars / Math.min(maxFiles, Math.max(1,candidates.length)));
  for (const file of candidates) {
    if (usedChars >= budgetChars || usedTokens >= budgetTokens) break;
    // Avoid low-value leftover fragments beyond the configured window count.
    if ((options || !hasMentions) && items.length >= maxFiles) break;
    if (seen.has(file.path) || !file.content.length) continue;
    seen.add(file.path);
    const size = Math.min(file.content.length, snippetBudget, budgetChars-usedChars);
    const lines = file.content.split('\n');
    const queryTerms = [...keywords, ...mentions.symbols.map(s => s.toLowerCase())];
    const lineScore = (line: string) => {
      const words = new Set(line.toLowerCase().split(/[^a-z0-9]+/));
      return queryTerms.reduce((sum, term) => sum + (words.has(term) || line.toLowerCase().includes(term) ? 1 : 0), 0);
    };
    // Choose the strongest local cluster, not the first generic import/header hit.
    // Explicit symbols remain strong anchors even when there are no lexical keywords.
    let anchor = 0, best = -1;
    const scores = lines.map(lineScore);
    for (let i = 0; i < lines.length; i++) {
      const symbol = mentions.symbols.some(s => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lines[i]!));
      const raw = lines[i]!;
      const words = raw.toLowerCase().replace(/[_-]/g,' ');
      const lineWords=words.match(/[a-z][a-z0-9]*/g)??[];
      const isRelated = lineWords.some(w=>requestedKinds.has(w)||requestedKinds.has(w.replace(/s$/, '')));
      const inFamily = coherentFamily !== undefined && file.family===coherentFamily;
      const exact = automatic && quoted.some(term=>raw.toLowerCase().includes(term));
      const nearby = lines.slice(Math.max(0,i-3),i+4).join(' ').toLowerCase().replace(/[_-]/g,' ');
      const isTestExample = file.role==='tests' && inFamily && exact && /\b(?:assert|invoke|expect|run)\b/.test(words);
      const isRegistration = file.role==='source' && inFamily && createsFeature && isRelated && directive.test(words) && /\w+\s*\(/.test(raw);
      const isSection = file.role==='docs' && inFamily && isRelated && !!raw.trim() && (/^\s{0,3}#{1,6}\s/.test(raw) || /^[-=~^]+$/.test(lines[i+1]?.trim()??''));
      const priorTest = isTestExample ? lines.slice(Math.max(0,i-20),i).reverse().find(l=>/^\s*(?:(?:async )?def |function |(?:it|test)\s*\()/.test(l))?.toLowerCase() : undefined;
      const namesFlag = priorTest && quoted.some(t=>priorTest.includes(t.replace(/^--/,'')));
      const conciseTopicSection = isSection && lineWords.length<=3 && lineWords.some(w=>w!==file.family&&requestedKinds.has(w.replace(/s$/,'')));
      const boost = (isTestExample ? 24 : 0) + (namesFlag ? 8 : 0) + (isRegistration ? 22 : 0)
        + (isSection ? 16 : 0) + (conciseTopicSection ? 8 : 0) + (exact ? 3 : 0)
        + (isRegistration && /\b(?:default|built in|entrypoint|entry point)\b/.test(nearby) ? 6 : 0);
      const score = boost + scores[i]! + 0.35 * ((scores[i-1] ?? 0) + (scores[i+1] ?? 0)) + (symbol ? 100 : 0);
      if (score > best) { best = score; anchor = i; }
    }
    let first = anchor, last = anchor, snippet = lines[anchor]!.slice(0,size);
    if (file.content.length <= size && lines.length <= maxLines) { first = 0; last = lines.length-1; snippet = file.content; }
    else if (lines[anchor]!.length <= size) {
      let left = true;
      while (last-first+1<maxLines && (first > 0 || last < lines.length-1)) {
        const canLeft = first > 0 && snippet.length + lines[first-1]!.length + 1 <= size;
        const canRight = last < lines.length-1 && snippet.length + lines[last+1]!.length + 1 <= size;
        if (!canLeft && !canRight) break;
        if (canLeft && (left || !canRight)) snippet = lines[--first]! + '\n' + snippet;
        else snippet += '\n' + lines[++last]!;
        left = !left;
      }
    }
    const {role,family,...contextFile} = file;
    const remainingFiles = Math.max(1, Math.min(maxFiles,candidates.length)-items.length);
    const perFile = hasMentions && !options ? budgetTokens-usedTokens : Math.ceil((budgetTokens-usedTokens)/remainingFiles);
    const fit = fitExcerpt(snippet, anchor-first, perFile);
    if (!fit.text.length) continue;
    first += fit.startOffset; snippet = fit.text; last = first + snippet.split('\n').length-1;
    usedTokens += fit.tokens;
    items.push({ ...contextFile, content: snippet, startLine:first+1, endLine:last+1, truncated: snippet.length < file.content.length });
    usedChars += snippet.length;
  }
  return { items, usedChars, budgetChars, usedTokens, budgetTokens, encoding:'o200k_base' };
}
