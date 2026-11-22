"""Check a previously recorded VSIX against the current build before retesting it."""
import hashlib
from pathlib import Path
import sys
import zipfile


def entries(installer):
    with zipfile.ZipFile(installer) as archive:
        files = {}
        for entry in archive.infolist():
            if entry.filename in files:
                raise ValueError(f'Duplicate entry in {installer.name}: {entry.filename}')
            files[entry.filename] = (entry.external_attr, hashlib.sha256(archive.read(entry)).digest())
        return files


current, prior = map(Path, sys.argv[1:3])
if hashlib.sha256(prior.read_bytes()).hexdigest() != sys.argv[3]:
    sys.exit('Prior installer SHA-256 does not match the requested digest.')
if entries(current) != entries(prior):
    sys.exit('The current build and recorded installer have different packaged contents or modes.')
print('Every packaged file and file mode matches the current build. Retesting the exact prior VSIX.')
