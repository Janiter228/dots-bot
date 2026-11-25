"""Normalize ZIP records by game ID. Output tournament records for training and audit."""
import json
from pathlib import Path
import re
import sys
import zipfile

games = {}
logs = []
copies = 0
with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in archive.namelist():
        if not name.endswith('.json'):
            continue
        item = json.loads(archive.read(name))
        if item.get('kind') == 'dots':
            key = re.search(r'partiya-([a-f0-9]+)', name).group(1)
            if key in games:
                if item != games[key]:
                    raise ValueError(f'Conflicting replay {key}')
                copies += 1
            games[key] = item
        else:
            rows = item['moves']
            logs.append(dict(id=item['gameId'], you=item['you'], field=item['field'],
                             score=item['score'], requests=len(rows),
                             fallbacks=sum(bool(r.get('fallback')) for r in rows),
                             errors=sum(r.get('status') != 200 for r in rows)))
Path(sys.argv[2]).write_text(json.dumps(dict(games=games, logs=logs, copies=copies), ensure_ascii=False))
