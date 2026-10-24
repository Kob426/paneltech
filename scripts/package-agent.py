"""Build/verify a private unsigned Windows x64 lab package; never installs or runs it."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'PanelTech.Agent-win-x64/'
MAX_BYTES = 64 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_name(name):
    if not name or '\\' in name or ':' in name or name.startswith('/'):
        raise ValueError('Unsafe package path')
    parts = name.split('/')
    if len(name)>220 or any(not p or p.startswith('.') or p.endswith('.') or re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])',p.split('.')[0],re.I) or not re.fullmatch(r'[A-Za-z0-9_.-]+', p) for p in parts):
        raise ValueError('Unsafe package path')
    leaf = parts[-1].lower()
    if leaf in {'config.json','identity.json','receipts.json','ownership.json','rollback.json','recovery-plan.json'} or leaf.startswith(('enroll','paneltech-recovery','agentharness')):
        raise ValueError('State, credentials or test harness in package')
    if PurePosixPath(leaf).suffix not in {'.exe','.dll','.json','.ps1','.md','.txt'}:
        raise ValueError('Unexpected file type')
    return name


def check_payload(manifest, payload):
    if (manifest.get('format'),manifest.get('formatVersion'),manifest.get('target'),manifest.get('tfm'),manifest.get('selfContained')) != ('paneltech-agent-package',1,'win-x64','net10.0',False):
        raise ValueError('Wrong package format or runtime')
    if manifest.get('windowsExecutionVerified') is not False or manifest.get('signature') != 'unsigned':
        raise ValueError('Unexpected validation/signature claim')
    rows=manifest.get('files')
    if not isinstance(rows,list) or not 1 <= len(rows) <= 128:
        raise ValueError('Invalid manifest inventory')
    names=set()
    for row in rows:
        name=safe_name(row['path'])
        if name.casefold() in names or name not in payload:
            raise ValueError('Duplicate or missing file')
        names.add(name.casefold())
        if len(payload[name]) != row['bytes'] or digest(payload[name]) != row['sha256']:
            raise ValueError('Package checksum mismatch')
    if {r['path'] for r in rows} != set(payload):
        raise ValueError('Unlisted package file')
    required={'PanelTech.Agent.exe','PanelTech.Agent.dll','PanelTech.Agent.deps.json','PanelTech.Agent.runtimeconfig.json','qos.ps1','config.example.json','README-RU.md','LICENSES/Microsoft-MIT.txt','THIRD-PARTY-NOTICES.txt'}
    if not required.issubset(payload):
        raise ValueError('Incomplete package')
    exe=payload['PanelTech.Agent.exe']
    if len(exe)<64 or exe[:2]!=b'MZ':
        raise ValueError('Not a Windows executable')
    offset=struct.unpack_from('<I',exe,0x3c)[0]
    if offset+26>len(exe) or exe[offset:offset+4]!=b'PE\0\0' or struct.unpack_from('<H',exe,offset+4)[0]!=0x8664 or struct.unpack_from('<H',exe,offset+24)[0]!=0x20b:
        raise ValueError('Not a PE32+ x64 apphost')
    runtime=json.loads(payload['PanelTech.Agent.runtimeconfig.json'])['runtimeOptions']
    version=runtime.get('framework',{}).get('version','')
    if runtime['tfm']!='net10.0' or runtime.get('framework',{}).get('name')!='Microsoft.NETCore.App' or not re.fullmatch(r'10\.0\.[0-9]+',version) or int(version.split('.')[-1])<13 or 'includedFrameworks' in runtime:
        raise ValueError('Wrong framework-dependent runtime configuration')
    deps=json.loads(payload['PanelTech.Agent.deps.json'])
    target=deps['runtimeTarget']['name']
    if target!='.NETCoreApp,Version=v10.0/win-x64':
        raise ValueError('Wrong dependency runtime target')
    for library in deps['targets'][target].values():
        for section in ['runtime','native']:
            for asset in library.get(section,{}):
                if PurePosixPath(asset).name not in payload:
                    raise ValueError('Missing runtime dependency')
    qos=payload['qos.ps1']
    if not qos.startswith(b'\xef\xbb\xbf'):
        raise ValueError('PowerShell 5.1 UTF-8 BOM required')
    qos.decode('utf-8-sig')
    config=json.loads(payload['config.example.json'])
    if config != {'serverUrl':'https://paneltech.invalid','stateDirectory':'C:\\ProgramData\\PanelTechAgent\\state','name':'CHANGE-ME'}:
        raise ValueError('Package must include only the inert example configuration')


def verify(path):
    with zipfile.ZipFile(path) as archive:
        entries=archive.infolist()
        if len(entries)>129 or sum(e.file_size for e in entries)>MAX_BYTES:
            raise ValueError('Package is too large')
        payload={};seen=set()
        for entry in entries:
            if not entry.filename.startswith(PREFIX) or entry.is_dir() or stat.S_ISLNK(entry.external_attr>>16):
                raise ValueError('Invalid ZIP member')
            name=safe_name(entry.filename[len(PREFIX):])
            if name.casefold() in seen or entry.flag_bits&1:
                raise ValueError('Duplicate/encrypted ZIP member')
            seen.add(name.casefold());payload[name]=archive.read(entry)
        raw=payload.pop('manifest.json',None)
        if raw is None or len(raw)>65536:
            raise ValueError('Missing or oversized manifest')
        manifest=json.loads(raw);check_payload(manifest,payload)
    return {'ok':True,'files':len(payload)+1,'bytes':Path(path).stat().st_size,'sha256':digest(Path(path).read_bytes()),'target':'win-x64','selfContained':False,'windowsExecutionVerified':False,'signature':'unsigned'}


def notices(stage,cache,deps,host_version):
    host=cache/'microsoft.netcore.app.host.win-x64'/host_version
    (stage/'LICENSES').mkdir()
    shutil.copyfile(host/'LICENSE.TXT',stage/'LICENSES/Microsoft-MIT.txt')
    text=['Microsoft .NET apphost and NuGet dependencies (MIT).\nRuntime is not bundled.\n']
    unique=set()
    packages=[key for key,value in deps['libraries'].items() if value['type']=='package']
    packages.append('Microsoft.NETCore.App.Host.win-x64/'+host_version)
    for item in sorted(packages):
        name,version=item.rsplit('/',1);folder=cache/name.lower()/version
        spec=ET.parse(next(folder.glob('*.nuspec'))).getroot()
        license_node=next((e for e in spec.iter() if e.tag.rsplit('}',1)[-1]=='license'),None)
        if license_node is None or license_node.text!='MIT':
            raise ValueError('Review dependency license before packaging')
        text.append(f'{name} {version} — MIT — https://www.nuget.org/packages/{name}/{version}\n')
        notice=folder/'THIRD-PARTY-NOTICES.TXT'
        if notice.exists() and digest(notice.read_bytes()) not in unique:
            unique.add(digest(notice.read_bytes()));text.append('\n'+notice.read_text(encoding='utf-8-sig')+'\n')
    (stage/'THIRD-PARTY-NOTICES.txt').write_text(''.join(text),encoding='utf-8')


def build(output):
    output=Path(output).resolve()
    if output.exists():raise ValueError('Destination exists; use a new ZIP filename')
    output.parent.mkdir(parents=True,exist_ok=True)
    dotnet=os.environ.get('PANELTECH_DOTNET') or shutil.which('dotnet') or '/workspace/.tools/dotnet/dotnet'
    env=dict(os.environ,DOTNET_CLI_TELEMETRY_OPTOUT='1',DOTNET_GENERATE_ASPNET_CERTIFICATE='false')
    sdk=json.loads((ROOT/'agent/global.json').read_text())['sdk']['version']
    if subprocess.check_output([dotnet,'--version'],cwd=ROOT/'agent',env=env,text=True).strip()!=sdk:
        raise ValueError('Pinned SDK required')
    with tempfile.TemporaryDirectory(prefix='.paneltech-agent-build-',dir=output.parent) as temporary:
        directory=Path(temporary);stage=directory/'payload'
        subprocess.run([dotnet,'restore','--locked-mode'],cwd=ROOT/'agent',env=env,check=True)
        subprocess.run([dotnet,'publish','--no-restore','-c','Release','-r','win-x64','--self-contained','false','-p:PublishSingleFile=false','-p:PublishTrimmed=false','-p:PublishReadyToRun=false','-p:DebugType=None','-p:DebugSymbols=false','-o',str(stage)],cwd=ROOT/'agent',env=env,check=True)
        (stage/'config.example.json').write_text(json.dumps({'serverUrl':'https://paneltech.invalid','stateDirectory':'C:\\ProgramData\\PanelTechAgent\\state','name':'CHANGE-ME'},indent=2)+'\n')
        shutil.copyfile(ROOT/'docs/WINDOWS-PACKAGE.md',stage/'README-RU.md')
        deps=json.loads((stage/'PanelTech.Agent.deps.json').read_text())
        cache=Path(env.get('NUGET_PACKAGES',str(Path.home()/'.nuget/packages')))
        assets=json.loads((ROOT/'agent/obj/project.assets.json').read_text())
        host=next(d for d in assets['project']['frameworks']['net10.0']['downloadDependencies'] if d['name']=='Microsoft.NETCore.App.Host.win-x64')
        match=re.fullmatch(r'\[([0-9.]+), \1\]',host['version'])
        if match is None:raise ValueError('Exact apphost version required')
        notices(stage,cache,deps,match[1])
        payload={p.relative_to(stage).as_posix():p.read_bytes() for p in stage.rglob('*') if p.is_file()}
        sources=['agent/global.json','agent/PanelTech.Agent.csproj','agent/packages.lock.json','agent/qos.ps1','scripts/package-agent.py','docs/WINDOWS-PACKAGE.md']+[str(p.relative_to(ROOT)) for p in (ROOT/'agent').glob('*.cs')]
        manifest={'format':'paneltech-agent-package','formatVersion':1,'target':'win-x64','tfm':'net10.0','selfContained':False,'sdk':sdk,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'signature':'unsigned','windowsExecutionVerified':False,'sourceSHA256':{name:digest((ROOT/name).read_bytes()) for name in sorted(sources)},'files':[{'path':name,'bytes':len(data),'sha256':digest(data)} for name,data in sorted(payload.items())]}
        check_payload(manifest,payload)
        archive_path=directory/'package.zip'
        with zipfile.ZipFile(archive_path,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
            for name,data in sorted(payload.items()):archive.writestr(PREFIX+name,data)
            archive.writestr(PREFIX+'manifest.json',json.dumps(manifest,indent=2)+'\n')
        result=verify(archive_path)
        # Atomic no-overwrite publication; no installation or state/config replacement.
        os.link(archive_path,output)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['build','verify'])
    parser.add_argument('--out')
    parser.add_argument('--from',dest='source')
    args=parser.parse_args()
    if args.command=='build' and args.out and not args.source:result=build(args.out)
    elif args.command=='verify' and args.source and not args.out:result=verify(args.source)
    else:parser.error('build --out <new.zip> or verify --from <package.zip>')
    print(json.dumps(result))
