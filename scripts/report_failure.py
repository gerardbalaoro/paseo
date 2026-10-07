"""One open issue for this workflow, updated on repeat failures (no comments)."""
import json
import os
import subprocess

MARKER = '<!-- paseo-fork-integration-blocked -->'
repo = 'gerardbalaoro/paseo'
assert os.environ['GITHUB_REPOSITORY'] == repo

def gh(*args, payload=None):
    result = subprocess.run(['gh', 'api', *args], input=json.dumps(payload) if payload else None, text=True, capture_output=True, check=True)
    return json.loads(result.stdout)

issues = []
page = 1
while True:
    batch = gh(f'repos/{repo}/issues?state=open&per_page=100&page={page}')
    issues.extend(batch)
    if len(batch) < 100:
        break
    page += 1
existing = next((i for i in issues if 'pull_request' not in i and MARKER in (i.get('body') or '')), None)
body = f'''{MARKER}
Integration did not complete successfully. Build or validation failures leave last-good dev untouched. Publication uses an atomic transaction; if its network acknowledgement failed, inspect remote refs before retrying.

Run: https://github.com/{repo}/actions/runs/{os.environ['GITHUB_RUN_ID']}

Inspect the failed job for conflicting files, validation errors, or changed refs. Resolve conflicts on the canonical patch branch with its current owner; do not resolve them directly on generated dev. Re-run Fork integration after the canonical branch is ready. If refs advanced during testing, rebuild and validate again.
'''
payload = {'title': 'Fork integration needs attention', 'body': body}
path = f'repos/{repo}/issues' + (f'/{existing["number"]}' if existing else '')
print(gh(path, '--method', 'PATCH' if existing else 'POST', '--input', '-', payload=payload)['html_url'])
