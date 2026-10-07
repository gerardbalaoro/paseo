import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('integrate', Path(__file__).parents[1] / 'scripts/integrate.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.up = self.root / 'up.git'
        self.fork = self.root / 'fork.git'
        self.work = self.root / 'work'
        m.run(['git', 'init', '--bare', str(self.up)])
        m.run(['git', 'init', '-b', 'main', str(self.work)])
        self.commit('base', 'base\n')
        m.git(self.work, 'remote', 'add', 'origin', str(self.up))
        m.git(self.work, 'push', 'origin', 'main')
        m.run(['git', 'clone', '--bare', str(self.up), str(self.fork)])
        m.git(self.work, 'checkout', '-b', 'patch')
        self.patch = self.commit('feature', 'selected\n')
        m.git(self.work, 'push', str(self.fork), 'patch')
        m.git(self.work, 'checkout', 'main')
        self.upstream = self.commit('upstream', 'new\n')
        m.git(self.work, 'push', 'origin', 'main')
        self.manifest = {'version': 1, 'fork': 'fixture/fork', 'upstream': 'fixture/upstream', 'patches': [{'id': 'patch', 'branch': 'patch', 'pr': 1, 'owner': 'owner', 'writer': 'external'}]}
        self.snapshots = {'patch': {'state': 'open', 'merged': False, 'sole': True}}

    def commit(self, file, text):
        (self.work / file).write_text(text)
        m.git(self.work, 'add', file)
        m.git(self.work, 'commit', '-m', file)
        return m.git(self.work, 'rev-parse', 'HEAD')

    def build(self, name='candidate'):
        repo = self.root / name
        return repo, m.build(self.manifest, repo, str(self.fork), str(self.up), self.snapshots)

    def test_repeat_is_deterministic_and_keeps_canonical_patch(self):
        repo, plan = self.build()
        m.publish(repo, plan, fixture=True)
        self.assertEqual(m.remote(str(self.fork), 'patch'), self.patch)
        repo2, plan2 = self.build('repeat')
        self.assertEqual(plan['candidate'], plan2['candidate'])
        m.publish(repo2, plan2, fixture=True)
        self.assertEqual((repo2 / 'feature').read_text(), 'selected\n')
        self.assertEqual(m.remote(str(self.fork), 'main'), self.upstream)

    def test_conflict_preserves_last_good(self):
        repo, plan = self.build()
        m.publish(repo, plan, fixture=True)
        m.git(self.work, 'checkout', 'main')
        self.commit('feature', 'conflicting upstream\n')
        m.git(self.work, 'push', 'origin', 'main')
        with self.assertRaises(RuntimeError):
            self.build('conflict')
        self.assertEqual(m.remote(str(self.fork), 'dev'), plan['candidate'])

    def test_remote_races_block_all_updates(self):
        repo, plan = self.build()
        m.git(self.work, 'checkout', 'patch')
        changed = self.commit('another', 'concurrent\n')
        m.git(self.work, 'push', str(self.fork), 'patch')
        with self.assertRaisesRegex(RuntimeError, 'Concurrent change'):
            m.publish(repo, plan, fixture=True)
        self.assertEqual(m.remote(str(self.fork), 'dev'), '')
        self.assertNotEqual(m.remote(str(self.fork), 'main'), self.upstream)
        self.assertEqual(m.remote(str(self.fork), 'patch'), changed)

    def test_atomic_server_rejection_keeps_all_refs(self):
        repo, plan = self.build()
        hook = self.fork / 'hooks' / 'update'
        hook.write_text('#!/bin/sh\n[ "$1" != refs/heads/main ]\n')
        hook.chmod(0o755)
        before = m.remote(str(self.fork), 'main')
        with self.assertRaises(RuntimeError):
            m.publish(repo, plan, fixture=True)
        self.assertEqual(m.remote(str(self.fork), 'main'), before)
        self.assertEqual(m.remote(str(self.fork), 'dev'), '')

    def test_upstream_race_blocks_publication(self):
        repo, plan = self.build()
        self.commit('later', 'advance\n')
        m.git(self.work, 'push', 'origin', 'main')
        with self.assertRaisesRegex(RuntimeError, 'Upstream advanced'):
            m.publish(repo, plan, fixture=True)

    def test_existing_user_dev_is_not_overwritten(self):
        m.git(self.work, 'push', str(self.fork), 'main:dev')
        with self.assertRaisesRegex(RuntimeError, 'provenance'):
            self.build()

    def test_modified_generated_dev_is_not_overwritten(self):
        repo, plan = self.build()
        m.publish(repo, plan, fixture=True)
        (repo / 'user-work').write_text('preserve me')
        m.git(repo, 'add', 'user-work')
        m.git(repo, 'commit', '--amend', '--no-edit')
        m.git(repo, 'push', '--force', str(self.fork), 'HEAD:dev')
        with self.assertRaisesRegex(RuntimeError, 'tree changed'):
            self.build('modified')

    def test_shared_contributor_uses_merge(self):
        self.manifest['patches'][0]['writer'] = 'actions'
        self.snapshots['patch']['sole'] = False
        repo, plan = self.build()
        head = plan['updates']['patch']
        self.assertTrue(m.ancestor(repo, self.patch, head))
        self.assertEqual(len(m.git(repo, 'rev-list', '--parents', '-n', '1', head).split()), 3)

    def test_sole_contributor_rebases(self):
        self.manifest['patches'][0]['writer'] = 'actions'
        repo, plan = self.build()
        self.assertTrue(m.ancestor(repo, self.upstream, plan['updates']['patch']))
        self.assertEqual(m.git(repo, 'show', plan['updates']['patch'] + ':feature'), 'selected')

    def test_cherry_picked_upstream_is_actually_included(self):
        m.git(self.work, 'cherry-pick', self.patch)
        m.git(self.work, 'push', 'origin', 'main')
        repo, plan = self.build()
        self.assertEqual(plan['patches'][0]['result'], 'patch-equivalent')
        self.assertEqual(m.git(repo, 'rev-parse', 'HEAD^{tree}'), m.git(repo, 'rev-parse', plan['upstream'] + '^{tree}'))

    def test_closed_status_alone_does_not_drop_patch(self):
        self.snapshots['patch'].update(state='closed', merged=True)
        repo, plan = self.build()
        self.assertEqual(plan['patches'][0]['result'], 'applied')
        self.assertTrue((repo / 'feature').exists())

    def test_unknown_and_coauthors_are_shared(self):
        self.assertFalse(m.sole_owner([{'author': None, 'commit': {'message': 'x'}}], 'owner'))
        self.assertFalse(m.sole_owner([{'author': {'login': 'owner'}, 'commit': {'message': 'x\nCo-authored-by: someone'}}], 'owner'))
        self.assertTrue(m.sole_owner([{'author': {'login': 'owner'}, 'commit': {'message': 'x'}}], 'owner'))

    def test_main_divergence_stops_build(self):
        m.git(self.work, 'checkout', '-b', 'fork-main')
        self.commit('private', 'do not lose\n')
        m.git(self.work, 'push', str(self.fork), 'HEAD:main')
        with self.assertRaisesRegex(RuntimeError, 'diverged'):
            self.build()

    def test_main_local_publish_is_blocked(self):
        repo, plan = self.build()
        with self.assertRaisesRegex(RuntimeError, 'built-in token'):
            m.publish(repo, plan)

if __name__ == '__main__':
    unittest.main()
