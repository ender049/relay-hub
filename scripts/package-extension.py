#!/usr/bin/env python3
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'dist' / 'relay-hub-extension.zip'
FILES = [
    'manifest.json',
    'src/background.js',
    'pages/popup.html',
    'pages/sidepanel.html',
    'src/shell.js',
    'pages/index.html',
    'src/app.js',
    'assets/relayhub.png',
]


def main():
    missing = [file for file in FILES if not (ROOT / file).is_file()]
    if missing:
        raise SystemExit('Missing package files: ' + ', '.join(missing))

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUTPUT, 'w', zipfile.ZIP_DEFLATED) as archive:
        for file in FILES:
            archive.write(ROOT / file, file)

    with zipfile.ZipFile(OUTPUT) as archive:
        bad_file = archive.testzip()
        if bad_file:
            raise SystemExit(f'Bad zip entry: {bad_file}')

    print(OUTPUT.relative_to(ROOT))


if __name__ == '__main__':
    main()
