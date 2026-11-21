export function renderWebview(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
:root{color-scheme:light dark}body{max-width:68rem;margin:0 auto;padding:18px;color:var(--vscode-foreground);font:var(--vscode-font-size,13px) var(--vscode-font-family,sans-serif)}
header,.bar,.context-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}header{justify-content:space-between}h1{font-weight:600;font-size:1.45rem;margin:2px 0 12px}h2{font-size:1.05rem;margin:0}label{display:block;margin:4px 0 6px}
textarea{width:100%;box-sizing:border-box;min-height:76px;resize:vertical;padding:8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));font:inherit}
button{cursor:pointer;border:1px solid transparent;padding:5px 9px;border-radius:3px;font:inherit;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
button:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
#run{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button:disabled{opacity:.6;cursor:default}.bar{margin:8px 0}section,details{border-top:1px solid var(--vscode-panel-border);margin-top:14px;padding-top:11px}
#phase,#budget,.reason,.range{color:var(--vscode-descriptionForeground)}#context[hidden]{display:none}progress{width:100%;height:7px;accent-color:var(--vscode-progressBar-background)}.files{padding:0;list-style:none}.files li{margin:8px 0}.file{padding:0;text-align:left;color:var(--vscode-textLink-foreground);background:transparent;overflow-wrap:anywhere}.range{margin-left:6px}.reason{display:block;margin-top:2px}
summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:var(--vscode-editor-font-size,13px)/1.4 var(--vscode-editor-font-family,monospace)}
</style></head><body>
<header><h1>ForgeLens</h1><span id="phase" role="status">Ready</span></header>
<label for="task">What would you like to change?</label><textarea id="task" placeholder="Describe the change, or include @file:path or @symbol:name."></textarea>
<div class="bar"><button id="run">Run agent</button><button id="inspect">Preview context</button><button id="stop">Stop</button></div>
<section><h2>Review &amp; verify</h2><div class="bar"><button id="review">Review hunks</button><button id="undo">Undo last</button><button id="verify">Verify saved changes</button></div></section>
<section id="queue" hidden aria-label="Staged changes"><h2>Staged changes</h2><div id="hunks"></div><button id="export">Export accepted patch</button></section>
<section id="context" hidden><div class="context-head"><h2 id="context-title">Context preview</h2><span id="budget"></span></div><progress id="meter" aria-label="Excerpt character budget"></progress><ul class="files" id="files"></ul></section>
<section id="plan" aria-label="Agent file plan" hidden></section>
<details open><summary>Run output</summary><pre id="events" role="log">Ready.</pre></details>
<script nonce="${nonce}">
const api = acquireVsCodeApi();
const el = id => document.getElementById(id);
let streaming = false;
let running = false;
for (const type of ['run','inspect','stop','review','undo','verify','export']) {
  el(type).onclick = () => api.postMessage({type, prompt: el('task').value});
}
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && running && !event.defaultPrevented) {
    event.preventDefault();
    api.postMessage({type:'stop'});
  }
});
window.addEventListener('message', ({data}) => {
  if (data.type === 'state') {
    running = data.active;
    el('phase').textContent = data.phase;
    el('run').disabled = running;
    el('inspect').disabled = running;
    el('stop').disabled = !running && !data.pending;
    el('review').disabled = running || !data.pending;
    el('undo').disabled = running || !data.canUndo;
    el('export').disabled = running || !data.canExport;
  } else if (data.type === 'reset') {
    el('context').hidden = true;
    el('files').replaceChildren();
    el('plan').hidden = true;
    el('plan').replaceChildren();
    el('events').textContent = 'Ready.';
    streaming = false;
  } else if (data.type === 'queue') {
    const list=el('hunks');
    list.replaceChildren();
    el('queue').hidden=!data.files.length;
    for (const file of data.files) {
      const heading=document.createElement('h3');
      heading.textContent=file.path;
      list.appendChild(heading);
      for(const hunk of file.hunks) {
        const row=document.createElement('div');
        row.className='bar';
        const name=document.createElement('span');
        name.textContent=hunk.id+' · '+hunk.status;
        row.appendChild(name);
        for (const [label,action] of [['View diff','preview'],['Accept','accepted'],['Reject','rejected']]) {
          const button=document.createElement('button');
          button.textContent=label;
          button.disabled=!data.editable || hunk.status===action;
          button.onclick=()=>api.postMessage({type:'hunk',version:data.version,path:file.path,id:hunk.id,action});
          row.appendChild(button);
        }
        list.appendChild(row);
      }
    }
  } else if (data.type === 'context') {
    const {items,usedChars,budgetChars} = data.preview;
    el('context').hidden = false;
    el('context-title').textContent = data.label;
    el('budget').textContent = usedChars.toLocaleString()+' / '+budgetChars.toLocaleString()+' characters';
    el('meter').max = Math.max(1,budgetChars);
    el('meter').value = usedChars;
    el('files').replaceChildren();
    for (const [index,item] of items.entries()) {
      const row = document.createElement('li');
      const file = document.createElement('button');
      file.className = 'file';
      file.textContent = item.path;
      file.onclick = () => api.postMessage({type:'openContext',id:data.id,index});
      const range = document.createElement('span');
      range.className = 'range';
      range.textContent = 'L'+item.startLine+'–'+item.endLine;
      const reason = document.createElement('span');
      reason.className = 'reason';
      reason.textContent = item.reason;
      row.append(file,range,reason);
      el('files').appendChild(row);
    }
    if (!items.length) el('files').textContent = 'No matching excerpts.';
  } else if (data.type === 'plan') {
    const root = el('plan');
    root.hidden = !data.files.length;
    root.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = 'Agent file plan';
    root.appendChild(title);
    for (const file of data.files) {
      const row = document.createElement('p');
      const name = document.createElement('strong');
      name.textContent = file.path;
      row.appendChild(name);
      row.appendChild(document.createTextNode(': '+file.reason));
      root.appendChild(row);
    }
  } else if (data.type === 'append' || data.type === 'delta') {
    const events = el('events');
    const start = data.type === 'append' || !streaming ? '\\n' : '';
    events.textContent = (events.textContent + start + data.text).slice(-80000);
    streaming = data.type === 'delta';
  }
});
api.postMessage({type:'ready'});
</script></body></html>`;
}
