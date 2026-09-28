#!/usr/bin/env python3
"""Cloud Shell migration: preserve live legacy handlers; deploy only three targets."""
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
import zipfile

PROJECT = "mini-market-shalom"
ROOT = pathlib.Path(__file__).resolve().parents[1]
MARKER = '// Works shop routing migration v1'
APPEND = '\n// Works shop module v1\nObject.assign(exports, require("./shop-notifications"));\n'
HANDLERS = ('clockReminders', 'notifyPayslip', 'notifyMgrFeedback', 'notifyEmpNote',
            'notifyTaking', 'notifyAutoClose', 'notifySchedChange', 'notifySchedAck')


def patch_legacy(source):
    for name in HANDLERS:
        if not re.search(r'exports\.' + name + r'\s*=', source):
            raise ValueError('Unexpected live source: missing ' + name)
    original = 'for (const occ of occs) {'
    replacement = (MARKER + '\n    const shopOnly = (await db.ref("shopNotificationRouting/mode").get()).val() === "shop-only";'
                   '\n    for (const occ of shopOnly ? [] : occs) {')
    if MARKER not in source:
        if source.count(original) != 1:
            raise ValueError('Legacy attendance loop changed; stopping before deployment')
        source = source.replace(original, replacement, 1)
    elif replacement not in source or original in source:
        raise ValueError('Unexpected existing routing patch')
    if APPEND not in source:
        if 'require("./shop-notifications")' in source or "require('./shop-notifications')" in source:
            raise ValueError('Unexpected existing shop module integration')
        source += APPEND
    return source


def run(*args, cwd=None):
    subprocess.run(list(args), cwd=cwd, check=True)


def main():
    # A new persistent local folder on every attempt; never overwrite the backup.
    work = pathlib.Path(tempfile.mkdtemp(prefix='works-deploy-', dir=pathlib.Path.home()))
    print('Backup and deployment folder: ' + str(work), flush=True)
    raw = subprocess.check_output(['gcloud', 'functions', 'describe', 'clockReminders',
        '--gen2', '--region=europe-west1', '--project=' + PROJECT, '--format=json'])
    config = json.loads(raw)['buildConfig']
    if config.get('entryPoint') != 'clockReminders':
        raise ValueError('Unexpected function entry point')
    src = config.get('sourceProvenance', {}).get('resolvedStorageSource') or config['source']['storageSource']
    uri = 'gs://' + src['bucket'] + '/' + src['object']
    if src.get('generation'):
        uri += '#' + str(src['generation'])
    archive = work / 'original-server.zip'
    run('gcloud', 'storage', 'cp', uri, str(archive))
    dest = work / 'functions'
    dest.mkdir()
    with zipfile.ZipFile(archive) as z:
        # Source archives only: reject paths escaping the isolated deployment folder.
        for item in z.infolist():
            path = pathlib.PurePosixPath(item.filename)
            if path.is_absolute() or '..' in path.parts or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Unsafe archive entry')
        z.extractall(dest)
    index = dest / 'index.js'
    index.write_text(patch_legacy(index.read_text()), encoding='utf-8')
    for name in ['shop-notifications.js', 'shop-reminder-logic.js', 'reminder-logic.js']:
        shutil.copy2(ROOT / 'functions' / name, dest / name)
    package = json.loads((dest / 'package.json').read_text())
    desired = json.loads((ROOT / 'functions/package.json').read_text())
    package.setdefault('dependencies', {}).update(desired['dependencies'])
    package['engines'] = {'node': '22'}
    package['main'] = 'index.js'
    (dest / 'package.json').write_text(json.dumps(package, indent=2) + '\n')
    (work / 'firebase.json').write_text(json.dumps({'functions': {'source': 'functions', 'runtime': 'nodejs22'}}))
    run('npm', 'ci', '--prefix', str(ROOT / 'functions'))
    run('npx', '--yes', '--package=node@22', 'node', '--test', cwd=ROOT / 'functions')
    run('npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', cwd=dest)
    run('npx', '--yes', '--package=node@22', 'node', '--check', 'index.js', cwd=dest)
    # Analyze the assembled module locally; this does not invoke handlers or send pushes.
    run('npx', '--yes', '--package=node@22', 'node', '-e',
        'const f=require("./index"); for(const n of '+json.dumps(list(HANDLERS)+['setShopNotificationDevice','sendShopShiftReminders'])+
        ') if(typeof f[n]!=="function") throw Error("Missing export: "+n);', cwd=dest)
    firebase = ['npx', '--yes', '--package=node@22', '--package=firebase-tools@15.31.0',
                'firebase', 'deploy', '--project', PROJECT, '--non-interactive', '--only']
    # Gate the old scheduler first. Never start the new sender if that deployment fails.
    run(*firebase, 'functions:clockReminders', cwd=work)
    run(*firebase, 'functions:setShopNotificationDevice,functions:sendShopShiftReminders', cwd=work)
    print('DEPLOYMENT COMPLETE. Enable shop notifications on the shop phone and run its server notification test.')


if __name__ == '__main__':
    main()
