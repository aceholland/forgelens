"""Post-human-acceptance smoke check. Does not write Flask or apply proposals."""
import json, os, pathlib, subprocess, sys, tempfile
root=pathlib.Path(sys.argv[1]).resolve()
expected='22d924701a6ae2e4cd01e9a15bbaf3946094af65'
if subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()!=expected:
    raise SystemExit('STOP: wrong Flask baseline')
with tempfile.TemporaryDirectory(prefix='forgelens-synthetic-') as d:
    keys={'DEMO_SECRET_VALUE':'synthetic-one','DB_PASSWORD':'synthetic-two','AUTH_TOKEN':'synthetic-three','API_KEY':'synthetic-four','PUBLIC_LABEL':'visible-demo-value'}
    app=pathlib.Path(d,'demo_app.py')
    app.write_text('from flask import Flask\napp=Flask(__name__)\napp.config.update('+repr(keys)+')\n',encoding='utf-8')
    env=dict(os.environ,PYTHONPATH=str(root/'src'),PYTHONDONTWRITEBYTECODE='1',FLASK_APP=str(app),FLASK_SKIP_DOTENV='1',FLASK_DEBUG='0')
    def run(args):
        result=subprocess.run([sys.executable,'-B','-m','flask',*args],cwd=d,env=env,capture_output=True,text=True,timeout=60)
        if result.returncode:raise SystemExit('FAIL: Flask command failed. Inspect it locally; raw output deliberately not printed.')
        return result.stdout
    help_text=run(['--help'])
    if not any(line.strip().split()[:1]==['config'] for line in help_text.splitlines()):raise SystemExit('FAIL: config absent from help')
    raw=run(['config'])
    try:data=json.loads(raw)
    except ValueError:raise SystemExit('FAIL: output is not valid JSON; raw output not printed')
    if not isinstance(data,dict):raise SystemExit('FAIL: output is not a JSON object')
    for key,value in keys.items():
        expected_value=value if key=='PUBLIC_LABEL' else '***'
        if data.get(key)!=expected_value:raise SystemExit('FAIL: wrong value for '+key+'; raw output not printed')
        if key!='PUBLIC_LABEL' and value in raw:raise SystemExit('FAIL: synthetic sentinel leaked; raw output not printed')
    for key,value in data.items():
        if any(term in key for term in ('SECRET','PASSWORD','TOKEN','KEY')) and value!='***':raise SystemExit('FAIL: a matching configuration key was not masked; raw output not printed')
    print(help_text)
    print(json.dumps({key:data[key] for key in keys},indent=2))
    print('PASS: all four masking categories, visible nonsecret value and valid JSON. This is not by itself a genuine Task B pass.')
