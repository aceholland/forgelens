"""Record the model's emitted argument hash and encode the actual VS Code screencast with its wall-clock timing."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys

scratch,evidence=map(Path,sys.argv[1:])
desktop=evidence/'desktop'
adapter=Path(__file__).resolve().parents[1]/'scripts/llama-schema-draft.mjs'
events=[]
first='first-native-draft-via-json-schema'
continued='continued-native-draft-via-json-schema'
sequential=os.environ.get('FORGELENS_SEQUENTIAL_DRAFT')=='true'
for line in (scratch/'adapter.log').read_text(encoding='utf8').splitlines():
    try:
        item=json.loads(line)
    except ValueError:
        continue
    if item.get('mode') in {first,continued} and re.fullmatch(r'[0-9a-f]{64}',item.get('argumentsSha256','')):
        events.append({k:item[k] for k in ('mode','argumentsSha256','argumentsSha256CanonicalJSON','characters','completionTokens','promptTokens') if k in item})
frames=sorted(p for p in (desktop/'frames').glob('*.jpg') if re.fullmatch(r'\d+-(\d+)\.jpg',p.name))
sequence_ok=bool(events and events[0]['mode']==first and all(e['mode']==continued for e in events[1:]) and (sequential or len(events)==1))
replay_file=evidence/'native-replay.json'
matches_native=False
if replay_file.exists() and events:
    replay=json.loads(replay_file.read_text(encoding='utf8'))
    proposals=iter(c['nativeArgumentsSha256CanonicalJSON'] for c in replay['writeCalls'] if c.get('nativeArgumentsSha256CanonicalJSON'))
    generated=[e.get('argumentsSha256CanonicalJSON') for e in events]
    # Native tools can also be emitted without the structured-output adapter.
    # Every structured generation must appear in the real session in the same order.
    matches_native=all(h and any(native==h for native in proposals) for h in generated)
report={'localInference':True,'schemaAdapterSha256':hashlib.sha256(adapter.read_bytes()).hexdigest(),
        'sequentialDraft':sequential,'structuredArgumentsMatchNativeToolCalls':matches_native,
        'completedStructuredDrafts':len(events),'drafts':events,'recordedFrames':len(frames)}
database=scratch/'trueforge.sqlite'
# This database is created in an empty, job-specific directory. Record every
# attempt of the exact request, even when the editor stream closes early.
turns=[]
if database.is_file():
    with sqlite3.connect(database.resolve().as_uri()+'?mode=ro',uri=True) as db:
        rows=db.execute('select session_id,turn_id,json(input),json(state) from turn order by created_at,turn_id')
        for session,turn,raw,state in rows:
            request=json.loads(raw)
            if len(request)!=1 or request[0].get('type')!='user.message':
                continue
            if hashlib.sha256(request[0].get('content','').encode()).hexdigest()!='adf0a71141397baaec45456103eec636889bfb57789532a01a7d9daa5d793fd1':
                continue
            counts=dict(db.execute("select json_extract(event,'$.type'),count(*) from session_event where session_id=? group by 1",(session,)))
            turns.append({'session':session,'turn':turn,'nativeStatus':json.loads(state).get('status'),
                'modelMessages':counts.get('model.message',0),'toolResponses':counts.get('tool.response',0),
                'operatorAnswers':counts.get('user.tool_response',0)})
report['attemptsWithOriginalRequest']=turns
(evidence/'model-receipt.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
if frames:
    # All filenames contain only digits, a hyphen and .jpg. No external media is accepted.
    listing=frames[0].parent/'capture.ffconcat'
    timestamps=[int(p.stem.split('-')[1]) for p in frames]
    lines=['ffconcat version 1.0']
    for i,p in enumerate(frames):
        delta=timestamps[i+1]-timestamps[i] if i+1<len(frames) else 1000
        lines.extend([f"file '{p.name}'",f'duration {max(1,delta)/1000:.3f}'])
    lines.append(f"file '{frames[-1].name}'")
    listing.write_text('\n'.join(lines)+'\n',encoding='ascii')
    ffmpeg=shutil.which('ffmpeg')
    if not ffmpeg:
        import imageio_ffmpeg
        ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-nostdin','-y',
                    '-f','concat','-safe','1','-i',str(listing),'-fps_mode','vfr','-c:v','libx264','-threads','2',
                    '-preset','ultrafast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(evidence/'desktop.mp4')],check=True)
print(json.dumps(report))
sys.exit(0 if sequence_ok and matches_native and frames else 1)
