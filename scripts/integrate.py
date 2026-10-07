#!/usr/bin/env python3
"""Build first, validate separately, publish an atomic expected-ref transaction."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

IDENTITY = {"GIT_AUTHOR_NAME": "Paseo fork integration", "GIT_AUTHOR_EMAIL": "integration@users.noreply.github.com", "GIT_COMMITTER_NAME": "Paseo fork integration", "GIT_COMMITTER_EMAIL": "integration@users.noreply.github.com"}


def run(args, cwd=None, data=None, env=None):
    result = subprocess.run(args, cwd=cwd, input=data, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, **IDENTITY, **(env or {})})
    if result.returncode:
        raise RuntimeError(f"{args[0:3]} failed: {result.stderr[-6000:]}")
    return result.stdout.strip()


def git(repo, *args, **kwargs):
    return run(["git", *args], repo, **kwargs)


def api(path):
    return json.loads(run(["gh", "api", path]))


def remote(url, branch):
    result = run(["git", "ls-remote", url, "refs/heads/" + branch])
    return result.split()[0] if result else ""


def ancestor(repo, a, b):
    return subprocess.run(["git", "merge-base", "--is-ancestor", a, b], cwd=repo, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def sole_owner(commits, owner):
    # Unknown identities and coauthors are shared history, never a rebase permit.
    return bool(commits) and all((c.get("author") or {}).get("login") == owner and "co-authored-by:" not in c["commit"]["message"].lower() for c in commits)


def pr_snapshot(manifest, patch, head):
    prefix = f'repos/{manifest["upstream"]}/pulls/{patch["pr"]}'
    pr = api(prefix)
    if pr["head"]["sha"] != head or pr["head"]["ref"] != patch["branch"] or pr["head"]["repo"]["full_name"] != manifest["fork"]:
        raise RuntimeError("PR and branch refs disagree; retry after concurrent work finishes")
    commits = []
    page = 1
    while True:
        batch = api(f"{prefix}/commits?per_page=100&page={page}")
        commits.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return {"state": pr["state"], "merged": bool(pr["merged"]), "sole": sole_owner(commits, patch["owner"])}


def sync_patch(repo, head, upstream, sole):
    git(repo, "checkout", "--detach", head)
    if ancestor(repo, upstream, head):
        return head
    if sole:
        git(repo, "rebase", "--rebase-merges", upstream)
    else:
        git(repo, "merge", "--no-edit", upstream)
    return git(repo, "rev-parse", "HEAD")


def apply_patch(repo, head, upstream):
    if ancestor(repo, head, upstream):
        return "ancestor"
    base = git(repo, "merge-base", upstream, head)
    # Patch equivalence covers ordinary cherry-pick merges. A closed PR alone
    # never authorizes dropping its changes; ambiguous squash/rework fails closed.
    cherries = git(repo, "cherry", upstream, head).splitlines()
    if cherries and all(line.startswith("-") for line in cherries):
        return "patch-equivalent"
    patch = git(repo, "diff", "--binary", "--full-index", base, head)
    if patch:
        git(repo, "apply", "--3way", "--index", "-", data=patch + "\n")
    return "applied"


def build(manifest, repo, fork_url=None, upstream_url=None, snapshots=None):
    fork_url = fork_url or f'https://github.com/{manifest["fork"]}.git'
    upstream_url = upstream_url or f'https://github.com/{manifest["upstream"]}.git'
    if Path(repo).exists():
        raise RuntimeError("Candidate directory already exists; never reset user work")
    run(["git", "clone", "--no-checkout", "--no-tags", fork_url, str(repo)])
    git(repo, "fetch", "--no-tags", upstream_url, "main")
    upstream = git(repo, "rev-parse", "FETCH_HEAD")
    expected = {name: remote(fork_url, name) for name in ["main", "dev", *[p["branch"] for p in manifest["patches"]]]}
    for branch, sha in expected.items():
        if sha:
            git(repo, "fetch", "--no-tags", fork_url, f"refs/heads/{branch}")
            if git(repo, "rev-parse", "FETCH_HEAD") != sha:
                raise RuntimeError("Ref moved during snapshot")
    if not expected["main"] or not ancestor(repo, expected["main"], upstream):
        raise RuntimeError("Fork main diverged; refusing to discard user commits")
    if expected["dev"]:
        message = git(repo, "show", "-s", "--format=%B", expected["dev"])
        if not message.startswith("Fork integration [skip ci]\n\nIntegration-Version: 1\n"):
            raise RuntimeError("Existing dev lacks integration provenance; refusing overwrite")
        if f'Integration-Tree: {git(repo, "rev-parse", expected["dev"] + "^{tree}")}\n' not in message:
            raise RuntimeError("Existing dev tree changed outside integration; refusing overwrite")
    plan = {"version": 1, "fork_url": fork_url, "upstream_url": upstream_url, "upstream": upstream, "expected": expected, "updates": {}, "patches": [], "manifest": manifest}
    for p in manifest["patches"]:
        head = expected[p["branch"]]
        if not head:
            raise RuntimeError(f'Missing selected branch {p["branch"]}')
        snapshot = snapshots[p["id"]] if snapshots is not None else pr_snapshot(manifest, p, head)
        for path, blob in p.get("preserve", {}).items():
            if git(repo, "rev-parse", f"{head}:{path}") != blob:
                raise RuntimeError(f"Preserved blob changed: {path}")
        if p["writer"] == "actions" and snapshot["state"] == "open":
            head = sync_patch(repo, head, upstream, snapshot["sole"])
            plan["updates"][p["branch"]] = head
        elif p["writer"] != "external" and p["writer"] != "actions":
            raise RuntimeError("Unknown canonical branch writer")
        git(repo, "update-ref", f'refs/integration/{p["id"]}', head)
        plan["patches"].append({"id": p["id"], "head": head, "snapshot": snapshot})
    git(repo, "checkout", "--detach", upstream)
    for item in plan["patches"]:
        item["result"] = apply_patch(repo, item["head"], upstream)
    tree = git(repo, "write-tree")
    for p in manifest["patches"]:
        for path, blob in p.get("preserve", {}).items():
            if git(repo, "rev-parse", f"{tree}:{path}") != blob:
                raise RuntimeError(f"Integration changed preserved blob: {path}")
    source = json.dumps({"upstream": upstream, "patches": plan["patches"], "manifest": manifest}, sort_keys=True)
    digest = hashlib.sha256(source.encode()).hexdigest()
    date = git(repo, "show", "-s", "--format=%cI", upstream)
    message = f"Fork integration [skip ci]\n\nIntegration-Version: 1\nIntegration-Inputs: {digest}\nIntegration-Tree: {tree}\n\n{source}\n"
    candidate = git(repo, "commit-tree", tree, "-p", upstream, data=message, env={"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date})
    git(repo, "reset", "--hard", candidate)  # Only the new, dedicated candidate clone.
    plan["candidate"] = candidate
    plan["tree"] = tree
    plan["updates"].update({"main": upstream, "dev": candidate})
    return plan


def verify_refs(plan):
    if remote(plan["upstream_url"], "main") != plan["upstream"]:
        raise RuntimeError("Upstream advanced; rebuild and validate again")
    for branch, sha in plan["expected"].items():
        if remote(plan["fork_url"], branch) != sha:
            raise RuntimeError(f"Concurrent change on {branch}; refusing publication")


def publish(repo, plan, dev_only=False, fixture=False):
    if not fixture and not dev_only and not (os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_REPOSITORY") == plan["manifest"]["fork"] and os.environ.get("GITHUB_REF") == "refs/heads/automation" and os.environ.get("INTEGRATION_BUILTIN_TOKEN") == "true"):
        raise RuntimeError("Main/patch publication requires the audited Actions workflow and built-in token")
    if git(repo, "rev-parse", "HEAD") != plan["candidate"] or git(repo, "status", "--porcelain"):
        raise RuntimeError("Validated candidate has changed")
    if not fixture:
        for patch, item in zip(plan["manifest"]["patches"], plan["patches"]):
            current = pr_snapshot(plan["manifest"], patch, plan["expected"][patch["branch"]])
            if current != item["snapshot"]:
                raise RuntimeError("PR status/contributors changed; rebuild")
    if not fixture and not dev_only and remote(plan["fork_url"], "automation") != os.environ.get("GITHUB_SHA"):
        raise RuntimeError("Automation changed during run; retry on current automation")
    verify_refs(plan)
    updates = {"dev": plan["candidate"]} if dev_only else plan["updates"]
    args = ["push", "--atomic"]
    for branch in updates:
        args.append(f'--force-with-lease=refs/heads/{branch}:{plan["expected"][branch]}')
    args += [plan["fork_url"], *[f"{sha}:refs/heads/{branch}" for branch, sha in updates.items()]]
    git(repo, *args)
    for branch, sha in updates.items():
        if remote(plan["fork_url"], branch) != sha:
            raise RuntimeError(f"Post-push verification failed: {branch}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["build", "publish"])
    parser.add_argument("--manifest", default="manifest.json")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--plan", default="plan.json")
    parser.add_argument("--dev-only", action="store_true")
    args = parser.parse_args()
    if args.mode == "build":
        plan = build(json.loads(Path(args.manifest).read_text()), Path(args.repo))
        Path(args.plan).write_text(json.dumps(plan, indent=2) + "\n")
        print(json.dumps({"candidate": plan["candidate"], "upstream": plan["upstream"], "patches": plan["patches"]}, indent=2))
    else:
        publish(Path(args.repo), json.loads(Path(args.plan).read_text()), args.dev_only)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
