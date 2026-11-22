/** Infer a small Python string-parser contract from source without running it or importing the workspace. */
interface FalseCases { literals:string[]; empty:boolean; missing:boolean; caseInsensitive:boolean }

const namePattern = '[A-Za-z_]\\w*';
const literalPattern = `(?:"[^"\\\\\\r\\n]*"|'[^'\\\\\\r\\n]*')`;
const lookup = new RegExp(`^(${namePattern})\\s*=\\s*(?:${namePattern}\\.)+get\\(\\s*(?:${namePattern}|${literalPattern})(?:\\s*,\\s*(None|${literalPattern}))?\\s*\\)$`);

function falseCases(statements:string[]):FalseCases|undefined {
  const assignment = lookup.exec(statements[0] ?? '');
  if (!assignment) return;
  const variable = assignment[1]!;
  const fallback = assignment[2] && assignment[2] !== 'None' ? assignment[2].slice(1,-1) : null;
  let rest = statements.slice(1);
  let guard:'falsy'|'none'|undefined;
  if (rest[0] === `if not ${variable}:` || rest[0] === `if ${variable} is None:`) {
    if (rest[1] !== 'return False') return;
    guard = rest[0].startsWith('if not ') ? 'falsy' : 'none';
    rest = rest.slice(2);
  }
  if (!rest[0]?.startsWith('return ')) return;
  // Only the one final membership expression can span lines. Other statements fail the anchored grammar below.
  let expression = rest.join(' ').slice('return '.length).trim();
  const wrapped = /^bool\s*\(([\s\S]*)\)$/.exec(expression);
  if (wrapped) expression = wrapped[1]!.trim();
  const shortCircuit = new RegExp(`^(bool\\(\\s*${variable}\\s*\\)|${variable})\\s+and\\s+`).exec(expression);
  if (shortCircuit) {
    if (!wrapped && shortCircuit[1] === variable) return; // A bare "and" can return the input itself.
    guard = 'falsy';
    expression = expression.slice(shortCircuit[0].length);
  }
  const membership = new RegExp(`^${variable}(?:\\.(lower|casefold|upper)\\(\\))?\\s+not\\s+in\\s*([({\\[])([\\s\\S]*)([)}\\]])$`).exec(expression);
  if (!membership) return;
  const [ , transform, open, inner, close ] = membership;
  if ((open==='(' && close!==')') || (open==='[' && close!==']') || (open==='{' && close!=='}')) return;
  const group = inner!.trim();
  if (!new RegExp(`^${literalPattern}(?:\\s*,\\s*${literalPattern})*\\s*,?$`).test(group)) return;
  if (open==='(' && !group.includes(',')) return; // Parenthesized strings perform substring testing.
  const literals = Array.from(group.matchAll(new RegExp(literalPattern,'g')), m=>m[0].slice(1,-1));
  const normalized = (value:string) => transform==='upper' ? value.toUpperCase() : transform ? value.toLowerCase() : value;
  // JavaScript lowercasing is sufficient for this ASCII subset of Python case folding.
  if ([...literals, fallback??''].some(v=>/[^\x20-\x7e]/.test(v)) || literals.some(v=>normalized(v)!==v)) return;
  return {
    literals:[...new Set(literals.filter(v=>v!==''))],
    empty:guard==='falsy' || literals.includes(''),
    missing:fallback===null ? Boolean(guard) : (guard==='falsy' && !fallback) || literals.includes(normalized(fallback)),
    caseInsensitive:Boolean(transform),
  };
}

function readFunction(source:string) {
  const lines = source.replace(/\r\n/g,'\n').split('\n');
  if (!/^\s*def\s+\w+\s*\([^\n]*\)\s*(?:->\s*bool\s*)?:\s*$/.test(lines[0]??'')) return;
  const body = lines.slice(1).join('\n').trimStart();
  const opening = /^(?:[rRuU])?("""|'''|"|')/.exec(body);
  if (!opening) return;
  const quote = opening[1]!;
  const afterOpening = opening[0].length;
  const end = body.indexOf(quote,afterOpening);
  if (end<0 || body[end-1]==='\\' || !/^\s*\n/.test(body.slice(end+quote.length))) return;
  const doc = body.slice(afterOpening,end);
  if (quote.length===1 && doc.includes('\n')) return;
  const linesOfCode = body.slice(end+quote.length).split('\n').filter(l=>l.trim() && !l.trimStart().startsWith('#'));
  const indent = linesOfCode[0]?.match(/^[ \t]+/)?.[0];
  if (!indent || linesOfCode.some(l=>!l.startsWith(indent))) return;
  // A guard's false return must be nested, and the following return must be outside its suite.
  const guardLine = linesOfCode.findIndex(l=>l.trimStart().startsWith('if '));
  if (guardLine>=0 && (linesOfCode[guardLine]?.slice(indent.length).startsWith(' ') ||
      !/^\s+return False$/.test(linesOfCode[guardLine+1]?.slice(indent.length).trimEnd()??'') ||
      !linesOfCode[guardLine+2]?.slice(indent.length).startsWith('return '))) return;
  return {doc, statements:linesOfCode.map(l=>l.trim())};
}

const emptyWords = /\b(?:empty|blank|zero[ -]length|length (?:zero|0)|no characters)\b|""|''/i;
const missingWords = /\b(?:unset|undefined|missing|absent|nonexistent|unspecified|omitted|unconfigured|not (?:set|defined|present|provided|found|specified|supplied|configured)|does(?:n't| not) exist|no (?:environment variable|key|entry|value)(?:\s+is)?\b)/i;
const falseMeaning = /\b(?:returns?|yields?|is|are|defaults? to|counts? as|treated as|interpreted as|considered|evaluates? to|resolves? to|results? in|as)\s+(?:the (?:boolean|value)\s+)?["']?false\b|\bfalse\s+(?:if|when|for|values?|inputs?|cases?)\b|\b(?:disabled?|turns? off)\b|\btrue\s+(?:unless|except(?: when| for)?)\b/gi;
const trueMeaning = /\b(?:returns?|is|are|yields?|evaluates? to|results? in|treated as)\s+["']?true\b(?!\s+(?:unless|except))/i;

function docBlocks(doc:string) {
  const blocks:{bullet:boolean;text:string}[] = [];
  // Preserve block boundaries before joining soft wraps. A blank line between a heading and its list is valid RST.
  for (const paragraph of doc.replace(/\x60/g,'').split(/\n[ \t]*\n/)) {
    let block:{bullet:boolean;text:string}|undefined, listIndent=0;
    for (const line of paragraph.split('\n')) {
      const row = /^(\s*)(?:([-*+]|\d+[.)])\s+)?(.*)$/.exec(line)!;
      const [, indent, marker, text] = row;
      if (!text?.trim()) continue;
      if (!block || marker || (block.bullet && indent!.length<=listIndent)) {
        block={bullet:Boolean(marker),text:''};
        listIndent=indent!.length;
        blocks.push(block);
      }
      block.text+=(block.text?' ':'')+text.trim();
    }
  }
  return blocks;
}

function documentedConditions(doc:string) {
  const negative:string[] = [], positive:string[] = [];
  let list:string[]|undefined;
  for (const block of docBlocks(doc)) {
    for (const sentence of block.text.split(/(?<=[.!?;])\s+|\botherwise\b|\bbut\b/i)) {
      const statement = sentence.replace(falseMeaning,' ');
      const denied = /\b(?:not|never|doesn't)\s+(?:return(?:s)?|treated as|considered|evaluate to|result in|count as)\s+false\b/i.test(sentence);
      const polarity = denied || trueMeaning.test(statement) ? positive : statement!==sentence ? negative : undefined;
      (polarity ?? list)?.push(statement);
      if (!block.bullet) list = /:\s*$|\b(?:following|these)\b/i.test(sentence) ? polarity : undefined;
    }
  }
  return {negative:negative.join(' '), positive:positive.join(' ')};
}

/** An empty result also means the task or implementation is outside the supported grammar. */
export function pythonDocCoverageIssues(request:string, replacement:string):string[] {
  if (replacement.length>32000 || !/\b(?:docstrings?|docs?|document(?:ation|ing)?)\b/i.test(request) ||
      !/\b(?:every|all|exhaustive(?:ly)?|each|enumerate)\b/i.test(request) || !/\b(?:false|falsy|falsey)\b/i.test(request) ||
      /\b(?:without|avoid|skip|do not|don't|never)\s+(?:(?:chang(?:e|ing)|edit(?:ing)?|updat(?:e|ing)|touch|the)\s+)*(?:docs?|docstrings?|documentation)\b/i.test(request)) return [];
  const parsed = readFunction(replacement);
  if (!parsed) return [];
  const contract = falseCases(parsed.statements);
  if (!contract) return [];
  const docs = documentedConditions(parsed.doc);
  const missing:string[] = [];
  const complement = /\b(?:non[- ]?|not\s+)(?:empty|blank|missing|absent|unset)\b/gi;
  const directPositive = docs.positive.replace(complement,'');
  const directNegative = docs.negative.replace(complement,'');
  // An unquoted determiner in a noun phrase is not a named input.
  const listWords = docs.negative.replace(/(?<!["'])\b(?:no|any|the|each|a|an)\s+(?=(?:environment\s+variable|key|entry|value|characters|input|variable)\b)/gi,'');
  for (const [condition, pattern, label] of [[contract.empty,emptyWords,'an empty string'],[contract.missing,missingWords,'a missing lookup key']] as const) {
    if (condition && (!pattern.test(directNegative) || pattern.test(directPositive))) missing.push(label);
  }
  for (const literal of contract.literals) {
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const mentioned = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`,contract.caseInsensitive?'i':'');
    const list = /^\w+$/.test(literal) ? listWords : docs.negative;
    if (!mentioned.test(list) || mentioned.test(directPositive)) missing.push(JSON.stringify(literal));
  }
  return missing.length ? ['The candidate implementation returns False for '+missing.join(', ')+
    '. Describe these inputs and their false result explicitly in the function docstring.'] : [];
}
