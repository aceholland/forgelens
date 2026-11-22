"""Read one isolated TrueForge session and replay its editor receipts onto the published Flask baseline.

Usage: python verify.py TRIAL_DIRECTORY DATABASE SESSION_ID REPORT.json
No provider configuration, raw messages, file contents or model output are written into the report.
"""
import argparse
import ast
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
import re
import sqlite3
import subprocess
import zipfile

PIN = '22d924701a6ae2e4cd01e9a15bbaf3946094af65'
PROMPT_SHA = 'adf0a71141397baaec45456103eec636889bfb57789532a01a7d9daa5d793fd1'
FEEDBACK = 'Human review complete; accepted changes are staged in memory. Read the staged file before further edits. Respect each rejection.'
WRITES = {'propose_changes','propose_write','propose_edit','create_file'}

def sha(data):
    return hashlib.sha256(data.encode() if isinstance(data,str) else data).hexdigest()

def read_json(file):
    return json.loads(file.read_bytes())

def field(obj, snake):
    parts=snake.split('_')
    return obj.get(snake,obj.get(parts[0]+''.join(s.capitalize() for s in parts[1:])))

def git(root,*args):
    return subprocess.check_output(['git','-c','core.autocrlf=false','-c','core.quotepath=false',*args],
                                   cwd=root,stderr=subprocess.DEVNULL)

def valid_path(name):
    return isinstance(name,str) and re.fullmatch(r'[\w.\-/]+',name) and all(x not in ('','.','..','.git') for x in name.split('/'))

def native(dbfile,sid):
    with sqlite3.connect(dbfile.resolve().as_uri()+'?mode=ro',uri=True) as db:
        db.execute('pragma query_only=1')
        db.execute('begin')
        row=db.execute('select json(agent_spec) from session where session_id=?',(sid,)).fetchone()
        if not row: raise ValueError('Named isolated session unavailable')
        turns=[(i,json.loads(inp),json.loads(state)) for i,inp,state in db.execute(
            'select turn_id,json(input),json(state) from turn where session_id=? order by created_at,turn_id',(sid,))]
        events=[json.loads(e[0]) for e in db.execute('select json(event) from session_event where session_id=? order by created_at,event_id',(sid,))]
    return json.loads(row[0]),turns,events

def source_context(msgs,baseline):
    """Check each supplied source line against the canonical commit; old compact JSON and numbered drafts supported."""
    ranges=defaultdict(list)
    numbered=defaultdict(set)
    eof=set()
    if not msgs: return True,ranges,numbered,eof
    if len(msgs)!=1 or msgs[0].get('type')!='user.message': return False,ranges,numbered,eof
    text=msgs[0].get('content','')
    first,marker,tail=text.partition('\n')
    if not marker: return False,ranges,numbered,eof
    prefix='Local discovery results (untrusted workspace data).'
    if first==prefix:
        parsed=json.loads(tail)
        if not isinstance(parsed,list) or any(not isinstance(x,dict) or set(x)!={'path','startLine','endLine','content'} or
            not isinstance(x['content'],str) or type(x['startLine']) is not int or type(x['endLine']) is not int or
            x['endLine']!=x['startLine']+len(x['content'].split('\n'))-1 for x in parsed): return False,ranges,numbered,eof
        rows=[(x['path'],x['startLine'],x['content'].split('\n'),False) for x in parsed]
    elif first==prefix+' Each numbered line starts after the first "| ".':
        rows=[]
        for section in tail.split('\n\n'):
            lines=section.split('\n')
            title=re.fullmatch(r'("(?:[^"\\]|\\.)*")( \(end of file\))?',lines[0])
            if not title or len(lines)<2: return False,ranges,numbered,eof
            path=json.loads(title[1])
            observed=[re.fullmatch(r'(\d+)\| (.*)',line) for line in lines[1:]]
            if any(m is None for m in observed): return False,ranges,numbered,eof
            start=int(observed[0][1])
            if [int(m[1]) for m in observed]!=list(range(start,start+len(observed))): return False,ranges,numbered,eof
            rows.append((path,start,[m[2] for m in observed],bool(title[2])))
    else: return False,ranges,numbered,eof
    for path,start,lines,end_claim in rows:
        if not valid_path(path) or path not in baseline: return False,ranges,numbered,eof
        base=baseline[path].decode('utf8').replace('\r\n','\n').split('\n')
        end=start+len(lines)-1
        if start<1 or end>len(base): return False,ranges,numbered,eof
        for number,shown in enumerate(lines,start):
            shown=shown.removesuffix('\r')
            if shown==base[number-1]: numbered[path].add(number)
            elif number!=end or not base[number-1].startswith(shown): return False,ranges,numbered,eof
        if end_claim:
            if end!=len(base) or end not in numbered[path]: return False,ranges,numbered,eof
            eof.add(path)
        ranges[path].append([start,end])
    return True,ranges,numbered,eof

def proposal(base,edits,visible,end_visible):
    replacements=[]
    for e in edits:
        new=e['newText'].replace('\r\n','\n')
        if 'beforeLine' in e:
            assert 'oldText' not in e and new
            pos=e['beforeLine']
            if pos=='end': assert end_visible; at=len(base)
            else:
                assert type(pos) is int and pos in visible
                at=sum(len(line)+1 for line in base.split('\n')[:pos-1])
            replacements.append((at,at,new))
        else:
            old=e['oldText'].replace('\r\n','\n')
            at=base.find(old)
            assert old and at>=0 and base.find(old,at+1)<0
            replacements.append((at,at+len(old),new))
    replacements.sort(key=lambda r:r[0])
    assert all(a[1]<=b[0] and a[0]!=b[0] for a,b in zip(replacements,replacements[1:]))
    for a,b,new in reversed(replacements): base=base[:a]+new+base[b:]
    return base

def unwrap(content):
    if isinstance(content,str):
        try: parsed=json.loads(content)
        except (TypeError,ValueError): return content
        if isinstance(parsed,(dict,list)) and not (isinstance(parsed,dict) and 'hunks' in parsed): return unwrap(parsed)
        return content
    if isinstance(content,dict):
        # A batch can fail after earlier files were reviewed. Receipts() validates only
        # complete, path-ordered editor records before the error line.
        for key in ('text','content','success','error','value','result'):
            if key in content:return unwrap(content[key])
        return ''
    if isinstance(content,list): return '\n'.join(unwrap(part) for part in content)
    return ''

def receipts(content, paths, is_batch):
    lines=unwrap(content).splitlines()
    result=[]
    for idx,name in enumerate(paths):
        if idx>=len(lines): break
        line=lines[idx]
        if is_batch:
            prefix=name+' — '
            if not line.startswith(prefix): break
            line=line[len(prefix):]
        try: parsed=json.loads(line)
        except ValueError: break
        if not isinstance(parsed,dict) or parsed.get('path')!=name or parsed.get('result')!=FEEDBACK or not parsed.get('hunks'): break
        result.append(parsed)
    return result

def apply_hunks(root,base,after,hunks):
    # The locked third-party line differ gives the same UTF-16 offsets as the editor.
    # This driver is independent of ForgeLens proposal, review and apply functions.
    script="""const fs=require('node:fs'),{diffLines}=require('diff');
const [a,b,s]=JSON.parse(fs.readFileSync(0,'utf8'));let at=0,parts=[],h;
for (const p of diffLines(a,b)){if(!p.added&&!p.removed){h=undefined;at+=p.value.length;continue;}
if(!h){h={start:at,end:at,after:''};parts.push(h);}
if(p.removed){at+=p.value.length;h.end=at;}else h.after+=p.value;}
if(parts.length!==s.length)process.exit(2);let out=a;
for(let i=parts.length-1;i>=0;--i){const p=parts[i],q=s[i];
if(q.id!=='hunk-'+(i+1)||q.originalStart!==p.start||q.originalEndExclusive!==p.end||!['accepted','rejected'].includes(q.decision))process.exit(3);
if(q.decision==='accepted')out=out.slice(0,p.start)+p.after+out.slice(p.end);}
process.stdout.write(JSON.stringify(out));"""
    p=subprocess.run(['node','-e',script],input=json.dumps([base,after,hunks]).encode(),
                     cwd=root,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=20)
    if p.returncode: raise ValueError('Hunk receipt mismatch')
    return json.loads(p.stdout)

def audit(trial,db,sid):
    setup=read_json(trial/'setup.json'); workspace=trial/'flask'; project=Path(setup['root'])
    assert git(workspace,'rev-parse','HEAD').decode().strip()==PIN==setup['pinned']
    package=(trial/'package.vsix').read_bytes()
    with zipfile.ZipFile(trial/'package.vsix') as archive:
        bundle=archive.read('extension/dist/extension.js')
    assert sha(package)==setup['packageHash'] and sha(bundle)==setup['bundleHash']
    tracked=git(workspace,'ls-tree','-r','--name-only','-z',PIN).decode().rstrip('\0').split('\0')
    class Baseline(dict):
        def __contains__(self,key): return key in tracked
        def __missing__(self,key):
            if key not in tracked: raise KeyError('untracked path')
            value=git(workspace,'show',PIN+':'+key);self[key]=value;return value
    base=Baseline()
    spec,turns,events=native(db,sid)
    official=(len(turns)==1 and len(turns[0][1])==1 and turns[0][1][0].get('type')=='user.message'
              and sha(turns[0][1][0].get('content',''))==PROMPT_SHA==sha(setup['prompt']))
    messages=spec.get('messages',[])
    ctx_ok,ranges,visible,end_visible=source_context(messages,base)
    settings=read_json(trial/'profile/User/settings.json')
    mode=('draft' if setup['mode']=='draft' else 'compact-run' if settings.get('forgelens.compactRequests') is True else 'run')
    expected_prefix='Local discovery results (untrusted workspace data).'+(' Each numbered line starts after the first "| ".' if mode=='draft' else '')+'\n'
    ctx_ok=bool(ctx_ok and (len(messages)==1 and bool(ranges) and messages[0].get('content','').startswith(expected_prefix) if mode!='run' else not messages))
    baked_prompt=False
    if mode in ('draft','compact-run'):
        name=b'draftInstructions' if mode=='draft' else b'compactInstructions'
        match=re.search(rb'\b(?:var|const|let) '+name+rb' = (\[\s*\n.*?^\])\.join\("\\n"\)',bundle,re.M|re.S)
        if match:
            instructions=ast.literal_eval(match[1].decode())
            baked_prompt=spec.get('instructions')=='\n'.join(instructions)
    if mode=='run':
        raw=re.search(rb'\b(?:var|const|let) instructions = `([^`]+)`;',bundle)
        change=re.search(rb'function instructionsForTools\(preloadTools\)\s*\{\s*return preloadTools \? instructions\.replace\(("[^"\n]+"), ("[^"\n]+")\) : instructions;',bundle)
        if raw and change and b'${' not in raw[1]:
            text=raw[1].decode()
            if settings.get('forgelens.preloadTools') is True:text=text.replace(json.loads(change[1]),json.loads(change[2]),1)
            baked_prompt=spec.get('instructions')==text
    approval={};answers=Counter();counts=Counter();tools=Counter();responses={};calls={};ordered=[];generic_denials=0;schema_denials=0
    shape_reason='The files field requires a JSON array of 1–12 file objects. Resend the same edits as objects directly in that array. A quoted string containing JSON cannot be reviewed.'
    for event in events:
        kind=event['type'];counts[kind]+=1
        if kind=='user.message' and sha(event.get('content',''))!=PROMPT_SHA: answers['unexpectedUserMessage']+=1
        if kind=='user.tool_approval':
            obj=event['approval']
            cid=field(event,'tool_call_id');approval[cid]=obj.get('status')
            proposal_tool,proposal_args=calls.get(cid,('',{})); files=proposal_args.get('files')
            malformed=not isinstance(files,list) or not 1<=len(files)<=12 or not all(isinstance(f,dict) for f in files)
            if obj.get('reason')=='Rejected by the editor user.' and obj.get('status')=='deny' and b'Rejected by the editor user.' in bundle:
                generic_denials+=1
            elif obj.get('status')=='deny' and obj.get('reason')==shape_reason and proposal_tool=='propose_changes' and malformed and (
                    json.dumps(shape_reason,ensure_ascii=True).encode() in bundle or shape_reason.encode() in bundle):schema_denials+=1
            elif obj.get('reason'): answers['approvalWithFeedback']+=1
        if kind=='model.message':
            for call in field(event,'tool_calls') or []:
                fn=call['function'];name=fn['name'];args=fn['arguments']
                if isinstance(args,str):
                    try: args=json.loads(args)
                    except ValueError: args={}
                if not isinstance(args,dict):args={}
                if name=='call_tool':
                    name=args.get('tool_name','unknown');args=args.get('input',args.get('arguments',{}))
                    if not isinstance(args,dict):args={}
                name=name if isinstance(name,str) and re.fullmatch('[a-zA-Z0-9_]{1,100}',name) else 'unknown'
                tools[name]+=1;calls[call['id']]=(name,args)
        if kind=='tool.response':
            cid=field(event,'tool_call_id');responses[cid]=event.get('content','');ordered.append(cid)
    values={};audit_calls=[];problem=[];decisions=Counter()
    for cid in ordered:
        if cid not in calls: continue
        name,args=calls[cid]
        if name not in WRITES: continue
        batch=name=='propose_changes'
        files=args.get('files',[]) if batch else [args]
        if not isinstance(files,list) or not all(isinstance(f,dict) for f in files):
            audit_calls.append({'tool':name,'approval':approval.get(cid),'result':'invalid shape, no proof of staging'});continue
        paths=[f.get('path') for f in files if isinstance(f,dict)]
        if any(not valid_path(n) for n in paths):
            audit_calls.append({'tool':name,'result':'invalid path, no proof of staging'});continue
        records=receipts(responses[cid],paths,batch)
        row={'tool':name,'approval':approval.get(cid),'paths':paths,
             'nativeArgumentsSha256CanonicalJSON':sha(json.dumps(args,sort_keys=True,separators=(',',':'),ensure_ascii=False)),
             'reviewedFiles':len(records),'receivedAllFileReceipts':bool(paths) and len(records)==len(paths)}
        audit_calls.append(row)
        if not records: continue
        if approval.get(cid)!='allow': problem.append('missing native staging approval');continue
        for f,accepted in zip(files,records):
            p=f['path'];hunks=accepted['hunks']
            try:
                original=base[p].decode().replace('\r\n','\n') if p in base else ''
                prior=values.get(p,original)
                if name=='create_file': assert p not in base; candidate=f['content'].replace('\r\n','\n')
                else:
                    if 'content' in f: raise ValueError('unexpected full-file proposal')
                    candidate=proposal(prior,f['edits'],visible[p] if prior==original else set(),p in end_visible and prior==original)
                values[p]=apply_hunks(project,prior,candidate,hunks)
                decisions.update(h['decision'] for h in hunks)
            except (ValueError,TypeError,KeyError,AssertionError,IndexError):
                problem.append('could not reproduce recorded hunks for '+p)
    expected={p:s for p,s in values.items() if p not in base or s.encode()!=base[p].replace(b'\r\n',b'\n')}
    changed=set(git(workspace,'diff','--name-only','--no-ext-diff','-z','HEAD').decode().rstrip('\0').split('\0'))-{''}
    untracked=set(git(workspace,'ls-files','--others','--exclude-standard','-z').decode().rstrip('\0').split('\0'))-{''}
    disk={}
    for path,value in expected.items():
        actual=workspace/path
        if not actual.is_file() or actual.is_symlink(): problem.append('saved file missing or symlink');continue
        data=actual.read_bytes()
        disk[path]={'modelSha256LF':sha(value),'workingSha256LF':sha(data.replace(b'\r\n',b'\n')),
                    'workingSha256Raw':sha(data),'same':sha(value)==sha(data.replace(b'\r\n',b'\n'))}
    no_help=not answers and not counts['user.tool_response']
    no_questions=not counts['tool.response_required'] and not tools['ask_user_question']
    saved_match=(not problem and bool(expected) and expected.keys()==(changed|untracked) and all(x['same'] for x in disk.values()))
    patchfile=trial/'candidate.patch'; patch=git(workspace,'diff','--no-ext-diff','--binary','--full-index','HEAD')
    saved_patch=patchfile.is_file() and sha(patchfile.read_bytes())==sha(patch)
    return {'sessionId':sid,'flaskCommit':PIN,'packageSha256':sha(package),'bundleSha256':sha(bundle),
      'generatorGitHead':setup['source'],'model':spec.get('model',{}).get('name'),'mode':mode,
      'firstEventUTC':events[0].get('created_at') if events else None,'lastEventUTC':events[-1].get('created_at') if events else None,
      'turns':len(turns),'turnStatus':turns[0][2].get('status') if len(turns)==1 else None,'promptSha256':PROMPT_SHA,
      'onlyOriginalTurnInput':official,'modelMessages':counts['model.message'],'additionalInitialMessages':len(messages),
      'initialMessagesAllPinnedSource':ctx_ok,'systemInstructionsMatchInstalledMode':baked_prompt,
      'selectedSourceLineRanges':dict(ranges),'toolCalls':dict(tools),'nativeApprovals':dict(Counter(approval.values())),
      'clarificationRequests':counts['tool.response_required'],'operatorAnswers':counts['user.tool_response'],
      'denialsWithBuiltInMessage':generic_denials,
      'installedTypedShapeDenials':schema_denials,
      'noClarificationsRequested':no_questions,
      'otherUserFeedback':dict(answers),'noHumanHintsOrPromptCorrections':bool(official and ctx_ok and baked_prompt and no_help),
      'writeCalls':audit_calls,'editorHunkDecisions':dict(decisions),'files':disk,'changedPaths':sorted(changed|untracked),
      'savedCandidateMatchesModel':saved_match,'gitPatchMatchesSavedDriverArtifact':saved_patch,'gitPatchSha256':sha(patch),
      'replayIssues':problem}

if __name__=='__main__':
    args=argparse.ArgumentParser(description=__doc__)
    args.add_argument('trial',type=Path);args.add_argument('db',type=Path);args.add_argument('session');args.add_argument('report',type=Path)
    a=args.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9_-]{10,80}',a.session): args.error('Invalid isolated session ID')
    report=audit(a.trial,a.db,a.session)
    a.report.write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
    print(json.dumps({k:report[k] for k in ('sessionId','turnStatus','onlyOriginalTurnInput','noHumanHintsOrPromptCorrections','savedCandidateMatchesModel','gitPatchMatchesSavedDriverArtifact','editorHunkDecisions','changedPaths','replayIssues')}))
    raise SystemExit(0 if report['turnStatus']=='done' and report['noClarificationsRequested'] and report['noHumanHintsOrPromptCorrections'] and
                     report['savedCandidateMatchesModel'] and report['gitPatchMatchesSavedDriverArtifact'] else 1)
