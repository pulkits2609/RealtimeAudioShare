"""Collect upstream license texts already present in the locked build inputs."""
from pathlib import Path
import json
import tomllib

root = Path(__file__).resolve().parents[1]
texts = ['AudioShare third-party notices\n\nInterface notification tones are original synthesized sine tones; no external sound assets are used.\n\nThe Android APK retains its existing Kotlin/LiveKit dependency packaging. Upstream projects: https://github.com/livekit/client-sdk-android (Apache-2.0), AndroidX (Apache-2.0), Kotlin (Apache-2.0).']
seen = set()

def include(folder, heading):
    if not folder.is_dir():
        return
    for file in sorted(folder.iterdir()):
        if file.is_file() and file.name.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'THIRD-PARTY-NOTICES')):
            body = file.read_text(encoding='utf-8', errors='replace')
            key = (heading, body)
            if key not in seen:
                seen.add(key)
                texts.append(f'\n\n=== {heading} · {file.name} ===\n{body}')

for line in (root / 'verification' / 'runtime-packages.txt').read_text(encoding='utf-8-sig').splitlines():
    folder = Path(line.strip())
    package = folder / 'package.json'
    if folder == root or not package.is_file():
        continue
    info = json.loads(package.read_text(encoding='utf-8'))
    include(folder, f"{info.get('name')} {info.get('version')} ({info.get('license', 'see upstream')})")

registry = Path.home() / '.cargo' / 'registry' / 'src'
for package in tomllib.loads((root / 'src-tauri' / 'Cargo.lock').read_text(encoding='utf-8'))['package']:
    for source in registry.glob('*'):
        include(source / f"{package['name']}-{package['version']}", f"Rust crate {package['name']} {package['version']}")

runtime = Path.home() / '.nuget' / 'packages' / 'microsoft.netcore.app.runtime.win-x64'
for version in runtime.glob('*'):
    include(version, f'.NET Windows runtime {version.name}')
naudio = root / 'verification' / 'NAudio-LICENSE.txt'
if not naudio.is_file():
    raise RuntimeError('Fetch the upstream NAudio v2.2.1 license into verification/NAudio-LICENSE.txt before packaging.')
texts.append('\n\n=== NAudio Core / WASAPI 2.2.1 · https://github.com/naudio/NAudio/tree/v2.2.1 ===\n' + naudio.read_text(encoding='utf-8-sig'))
(root / 'THIRD_PARTY_NOTICES.txt').write_text('\n'.join(texts), encoding='utf-8')
print(f'Collected {len(seen)} upstream notice texts.')
