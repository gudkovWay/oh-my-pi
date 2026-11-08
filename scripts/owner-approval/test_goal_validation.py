import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest
import core


def request():
    return {'session': 'session-test', 'cwd': '/workspace/task', 'action': 'Complete scoped repairs',
            'exceptions': ['Allow bounded goal execution'], 'purpose': 'goal', 'duration_seconds': 21600,
            'goal': {'goal_id': 'repairs', 'outcome': 'Verified scoped repairs', 'acceptance': ['Native tests pass'],
                     'roots': ['/workspace'], 'models': ['openai-codex/gpt-6.1-sol:high'], 'tiers': ['priority'],
                     'operations': ['edit', 'test'], 'resources': {'memory_ceiling': 2**30, 'runtime_seconds': 600,
                                                               'elastic': False, 'gpu': False},
                     'delivery': {'branch': '', 'remote': '', 'actions': []}}}


class GoalValidationTests(unittest.TestCase):
    def test_exact_non_sol_models_and_reasoning_ceiling(self):
        for selector in ('openai-codex/gpt-6-astra:high', 'anthropic/claude-opus-5:high',
                         'deepseek/deepseek-v4.1-flash:low', 'local/my-model:off'):
            value = request()
            value['goal']['models'] = [selector]
            self.assertEqual(core.goal_errors(value), [], selector)
        for selector in ('@task', 'openai-codex/*:high', 'openai-codex/gpt-6-astra:xhigh',
                         'openai-codex/gpt-6-astra', 'provider/model:high '):
            value = request()
            value['goal']['models'] = [selector]
            self.assertTrue(core.goal_errors(value), selector)

    def test_all_goal_shape_errors_are_returned_together(self):
        value = request()
        value['goal']['goal_id'] = ''
        value['goal']['models'] = ['wrong-model']
        value['goal']['tiers'] = ['fast']
        value['goal']['resources'] = {'memory_ceiling': True, 'runtime_seconds': 99999, 'elastic': 'yes', 'gpu': 'device'}
        value['goal']['delivery'] = {'branch': '', 'remote': '', 'actions': ['push', 'merge']}
        errors = core.goal_errors(value)
        for name in ('goal_id', 'models', 'tiers', 'memory_ceiling', 'runtime_seconds', 'elastic', 'gpu', 'delivery'):
            self.assertTrue(any(name in error for error in errors), (name, errors))
        with self.assertRaises(core.ApprovalError) as failure:
            core.validate_goal(value)
        self.assertEqual(str(failure.exception).splitlines(), errors)

    def test_local_client_validation_uses_the_broker_validator_without_bus_or_auth(self):
        value = request()
        client = Path(__file__).with_name('client.py')
        for valid in (True, False):
            item = copy.deepcopy(value)
            if not valid:
                item['goal']['resources']['gpu'] = 'not-a-bool'
            result = subprocess.run([sys.executable, '-I', str(client), 'validate', json.dumps(item)],
                                    text=True, capture_output=True, check=True)
            response = json.loads(result.stdout)
            self.assertEqual(response['valid'], valid)
            self.assertIs(response['authorization'], False)
            if not valid:
                self.assertIn('gpu', '\n'.join(response['errors']))

    def test_valid_unicode_and_boundary_contracts_keep_authoritative_limits(self):
        value = request()
        value['goal']['outcome'] = '🙂' * 1500
        self.assertEqual(core.goal_errors(value), [])
        value['goal']['outcome'] += '🙂'
        self.assertTrue(core.goal_errors(value))
        for bad in (None, [], {'resources': []}):
            self.assertTrue(core.goal_errors({**request(), 'goal': bad}))


if __name__ == '__main__':
    unittest.main()
