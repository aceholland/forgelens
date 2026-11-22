"""Record the model's emitted argument hash and encode the actual VS Code screencast with its wall-clock timing."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

scratch,evidence=map(Path,sys.argv[1:])
desktop=evidence/'desktop'
adapter=Path(__file__).resolve().parents[1]/'scripts/llama-schema-draft.mjs'
events=[]
for line in (scratch/'adapter.log').read_text(encoding='utf8').splitlines():
    try:
        item=json.loads(line)
    except ValueError:
        continue
    if item.get('mode')=='first-native-draft-via-json-schema' and re.fullmatch(r'[0-9a-f]{64}',item.get('argumentsSha256','')):
        events.append({k:item[k] for k in ('argumentsSha256','characters','completionTokens','promptTokens') if k in item})
frames=sorted(p for p in (desktop/'frames').glob('*.jpg') if re.fullmatch(r'\d+-(\d+)\.jpg',p.name))
report={'localInference':True,'schemaAdapterSha256':hashlib.sha256(adapter.read_bytes()).hexdigest(),
        'completedStructuredDrafts':len(events),'drafts':events,'recordedFrames':len(frames)}
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
sys.exit(0 if len(events)==1 and frames else 1)
