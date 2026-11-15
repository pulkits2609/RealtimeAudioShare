"""Package only verified build outputs; never include profiles, credentials or sources."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DATE = '2026-11-15'
OUT = ROOT / 'artifacts' / DATE
OUT.mkdir(parents=True, exist_ok=True)
WINDOWS = ROOT / 'src-tauri' / 'target' / 'release'
APK = ROOT.parent / 'electron' / 'android' / 'app' / 'build' / 'outputs' / 'apk' / 'debug' / 'app-debug.apk'

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def required(file):
    if not file.is_file() or not file.stat().st_size:
        raise RuntimeError(f'Required build output is missing: {file}')
    return file

shared = [(required(ROOT / name), name) for name in ['VERIFICATION.md', 'THIRD_PARTY_NOTICES.txt']]
windows = [
    (required(WINDOWS / 'audioshare-desktop.exe'), 'AudioShare.exe'),
    (required(WINDOWS / 'native' / 'AudioShare.Capture.exe'), 'native/AudioShare.Capture.exe'),
]
android = [(required(APK), 'AudioShare-Android-0.2.2-debug.apk')]
web = [(file, file.relative_to(ROOT / 'dist').as_posix()) for file in sorted((ROOT / 'dist').rglob('*')) if file.is_file()]
required(ROOT / 'dist' / 'index.html')
if not any(name.startswith('assets/pcm-worklet-') for _, name in web):
    raise RuntimeError('Browser build must include its actual AudioWorklet module asset.')

instructions = {
    'Windows': 'Extract this WHOLE directory, then run AudioShare.exe. Keep native/ beside it. Requires Windows 10/11 x64 and Edge WebView2; .NET is bundled. Unsigned acceptance build. Existing servers must append http://tauri.localhost to their exact ALLOWED_ORIGINS. No Electron runtime is required. See VERIFICATION.md for remaining actual-device checks.',
    'Android': 'Install AudioShare-Android-0.2.2-debug.apk on Android 10+. This is a fresh build of the existing Kotlin client with its existing interface/protocol, debug-signed for acceptance testing, not a Play Store release. Device testing is not implied by compilation. No Android redesign is claimed.',
    'Browser': 'Deploy this directory to the existing HTTPS frontend on port 9998. It is a static client: the existing API/signaling and LiveKit services remain required. Do not double-click index.html for live capture. Use API host vps.pulkitworks.info, port 9999, TLS enabled for the documented public deployment. Local test HTTP is supported on localhost.',
}

groups = {'Windows': windows, 'Android': android, 'Browser': web}
screens = [(file, 'Screenshots/' + file.name) for file in sorted((ROOT / 'verification' / 'meeting-views').glob('*.png'))]
if (ROOT / 'verification' / 'connection-720.png').exists():
    screens.append((ROOT / 'verification' / 'connection-720.png', 'Screenshots/connection-720.png'))
manifest = {
    'buildDate': DATE,
    'status': 'acceptance builds; see VERIFICATION.md',
    'platforms': {
        name: [{'path': target, 'bytes': file.stat().st_size, 'sha256': digest(file)} for file, target in files]
        for name, files in groups.items()
    },
}
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')

def archive(filename, files, texts):
    target = OUT / filename
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for file, name in files:
            if name.startswith('/') or '..' in Path(name).parts:
                raise RuntimeError('Unsafe archive path')
            bundle.write(file, name)
        for name, text in texts.items():
            bundle.writestr(name, text + '\n')
    with zipfile.ZipFile(target) as bundle:
        bad = bundle.testzip()
        if bad:
            raise RuntimeError(f'Archive checksum failed: {bad}')
    return target

archives = []
for name, files in groups.items():
    archives.append(archive(f'AudioShare-{name}-{DATE}.zip', files + shared + [(OUT / 'manifest.json', 'manifest.json')], {'README.txt': instructions[name]}))

combined = [(file, platform + '/' + name) for platform, files in groups.items() for file, name in files]
combined += shared + screens + [(OUT / 'manifest.json', 'manifest.json')]
combined_text = {'README.txt': 'AudioShare: Android, Browser and Windows builds\n\n' + '\n\n'.join(name + '\n' + text for name, text in instructions.items())}
for name, text in instructions.items():
    combined_text[name + '/README.txt'] = text
archives.append(archive(f'AudioShare-All-Builds-{DATE}.zip', combined, combined_text))

checksums = ''.join(f'{digest(file)}  {file.name}\n' for file in archives)
(OUT / 'SHA256SUMS.txt').write_text(checksums, encoding='utf-8')
print(json.dumps([{'file': str(file), 'bytes': file.stat().st_size, 'sha256': digest(file)} for file in archives], indent=2))
