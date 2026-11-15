"""Add the verified server to the previous three-client bundle without changing it."""
from pathlib import Path, PurePosixPath, PureWindowsPath
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
output = root / 'artifacts' / '2026-11-15'
client = output / 'AudioShare-All-Builds-2026-11-15.zip'
server = output / 'AudioShare-Server-2026-11-15.zip'
target = output / 'AudioShare-All-Builds-With-Server-2026-11-15.zip'
report = root / 'SERVER-VERIFICATION.md'
if not report.is_file():
    raise RuntimeError('Complete server verification before producing the combined bundle.')

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

with zipfile.ZipFile(client) as clients, zipfile.ZipFile(server) as service:
    assert clients.testzip() is None and service.testzip() is None
    assert {'run.bat', 'launch.mjs', 'runtime/node.exe', 'media/livekit-server.exe', 'app/dist/index.js'}.issubset(service.namelist())
    manifest = json.loads(clients.read('manifest.json'))
    manifest['platforms']['Server'] = []
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as combined:
        def transfer(archive, item, name):
            assert not PureWindowsPath(name).drive and not name.startswith('/') and '..' not in PurePosixPath(name).parts
            hashed = hashlib.sha256()
            with archive.open(item) as source, combined.open(name, 'w') as destination:
                while chunk := source.read(1024 * 1024):
                    destination.write(chunk)
                    hashed.update(chunk)
            return hashed.hexdigest()

        for item in clients.infolist():
            if not item.is_dir() and item.filename not in {'manifest.json', 'README.txt'}:
                transfer(clients, item, item.filename)
        for item in service.infolist():
            if item.is_dir():
                continue
            relative = item.filename.lower()
            assert PurePosixPath(relative).name not in {'settings.env', '.env', 'access.json', 'livekit.yaml'}
            assert not relative.startswith(('data/', 'app/data/'))
            sha = transfer(service, item, 'Server/' + item.filename)
            manifest['platforms']['Server'].append({'path': item.filename, 'bytes': item.file_size, 'sha256': sha})

        combined.write(report, 'SERVER-VERIFICATION.md')
        combined.writestr('manifest.json', json.dumps(manifest, indent=2))
        combined.writestr('README.txt', 'AudioShare: Android, Browser, Windows and Server\n\n'
            'The Server directory is the self-contained Windows x64 backend. Extract the whole directory and run:\n'
            '    run.bat 9999 9998 9996 9997\n\n'
            'First launch generates unique credentials in Server/settings.env and access data in Server/data/. '
            'Do not distribute a started server folder. Existing settings/access data are never bundled. '
            'New default origins support the new Tauri client; explicit allowlists are preserved. '
            'Use your existing TLS reverse proxy for public HTTPS/WSS.\n\n'
            'Windows/native client is unsigned; Android is the existing debug-signed client. '
            'Browser is a static HTTPS frontend. Read each component README, VERIFICATION.md and SERVER-VERIFICATION.md.\n')

with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    assert {'Windows/AudioShare.exe', 'Android/AudioShare-Android-0.2.2-debug.apk', 'Browser/index.html', 'Server/run.bat'}.issubset(archive.namelist())
(output / 'manifest-with-server.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
archives = sorted(output.glob('*.zip'))
(output / 'SHA256SUMS.txt').write_text(''.join(f'{digest(file)}  {file.name}\n' for file in archives), encoding='utf-8')
print(json.dumps({'file': str(target), 'bytes': target.stat().st_size, 'sha256': digest(target)}, indent=2))
