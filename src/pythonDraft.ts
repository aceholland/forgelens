// Identify physical lines inside strings, logical continuations and decorator groups.
// This inspects source text only; it never imports or runs the module.
function boundaries(lines:string[]) {
  let quote='', depth=0, continued=false, decorator=false;
  return lines.map(line=>{
    const insideString=Boolean(quote);
    const significant=Boolean(line.trim()) && !line.trimStart().startsWith('#');
    const topLevel=!quote && !depth && !continued && significant && /^\S/.test(line);
    const betweenDecorators=decorator;
    const declaration=/^(?:@|(?:async\s+)?def\s+|class\s+)/.test(line);
    if(topLevel)decorator=line.startsWith('@');
    continued=false;
    for(let i=0;i<line.length;i++){
      const c=line[i]!;
      if(quote){
        if(c==='\\'){if(i+1===line.length)continued=true;i++;continue;}
        if(line.startsWith(quote,i)){i+=quote.length-1;quote='';}
      }else if(c==='#')break;
      else if(c==='"'||c==="'"){
        quote=line.startsWith(c.repeat(3),i)?c.repeat(3):c;
        i+=quote.length-1;
      }else if('([{'.includes(c))depth++;
      else if(')]}'.includes(c))depth=Math.max(0,depth-1);
      else if(c==='\\'&&i+1===line.length)continued=true;
    }
    if(quote.length===1 && !continued)quote='';
    return {insideString,significant,betweenDecorators,safeAnchor:topLevel && declaration && !betweenDecorators};
  });
}

function startsWithDeclaration(text:string) {
  const lines=text.split(/\r?\n/);
  const first=lines.find(line=>line.trim() && !line.trimStart().startsWith('#'));
  if(!first)return false;
  const definition=/^(?:(?:async[ \t]+)?def[ \t]+|class[ \t]+)\S/;
  return definition.test(first) || (first.startsWith('@') && lines.some(line=>definition.test(line)));
}

export function guardPythonDraftInsertions(file:string,source:string,
  edits:ReadonlyArray<{beforeLine?:number|'end';oldText?:string;newText:string}>,
  visible:ReadonlyMap<number|'end',number>) {
  if(!/\.pyi?$/i.test(file))return;
  const insertions=edits.flatMap(e=>typeof e.beforeLine==='number' && visible.has(e.beforeLine) &&
    startsWithDeclaration(e.newText) ? [e.beforeLine] : []);
  if(!insertions.length)return;
  const lines=source.split(/\r?\n/);
  const state=boundaries(lines);
  for(const beforeLine of insertions){
    const start=beforeLine-1;
    if(!state[start] || state[start]!.insideString)continue;
    let next=start;
    while(next<lines.length && !state[next]!.significant)next++;
    if(next===lines.length)continue;
    const reason=state[start]!.betweenDecorators?'inside a Python decorator group':
      /^[ \t]/.test(lines[next]!)?'inside an existing Python block or continuation':undefined;
    if(!reason)continue;
    const candidates=[...visible.keys()].filter((line):line is number=>typeof line==='number' && Boolean(state[line-1]?.safeAnchor));
    const nearest=candidates.sort((a,b)=>Math.abs(a-1-start)-Math.abs(b-1-start))[0];
    const hint=nearest!==undefined ? 'A displayed module-level anchor is beforeLine '+nearest+' ('+JSON.stringify(lines[nearest-1]!.slice(0,100))+'). ' :
      visible.has('end')?'The displayed beforeLine "end" can append a declaration with separating newlines. ':'';
    throw new Error('A module-level Python declaration would start '+reason+'. '+hint+
      'For an intentional structural replacement, use exact oldText and include the existing statements you are restructuring.');
  }
}
