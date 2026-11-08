"""Owner-policy capabilities. No command execution or credential handling."""
import copy
import hashlib
import hmac
import json
import posixpath
import re
import secrets
import time
import unicodedata


class ApprovalError(ValueError):
    pass


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ApprovalError('Duplicate request field')
        result[key] = value
    return result


def _text(value, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ApprovalError('Missing or oversized scope text')
    if value != value.strip() or any(
        unicodedata.category(c).startswith('C') or (c.isspace() and c != ' ') for c in value
    ):
        raise ApprovalError('Control characters and ambiguous whitespace are forbidden')
    return value


def within(path, root):
    return path == root or path.startswith(root.rstrip('/') + '/')


def goal_errors(request):
    errors = []

    def text(value, limit, field):
        try:
            _text(value, limit)
            return True
        except ApprovalError as error:
            errors.append(f'{field}: {error}')
            return False

    def object_fields(value, fields, field):
        if not isinstance(value, dict):
            errors.append(f'{field}: expected object with {", ".join(sorted(fields))}')
            return {}
        missing, unknown = fields - set(value), set(value) - fields
        if missing:
            errors.append(f'{field}: missing fields {", ".join(sorted(missing))}')
        if unknown:
            errors.append(f'{field}: unknown fields {", ".join(sorted(unknown))}')
        return value

    seconds = request.get('duration_seconds')
    duration_valid = type(seconds) is int and 21600 <= seconds <= 28800
    if request.get('purpose') != 'goal' or not duration_valid:
        errors.append('duration_seconds: goal duration must be between 6 and 8 hours')
    fields = {'goal_id', 'outcome', 'acceptance', 'roots', 'models', 'tiers', 'operations', 'resources', 'delivery'}
    goal = object_fields(request.get('goal'), fields, 'goal')
    text(goal.get('goal_id'), 128, 'goal_id')
    text(goal.get('outcome'), 1500, 'outcome')
    lists = {}
    for name, limit in [('acceptance', 500), ('roots', 1024), ('models', 128), ('tiers', 32), ('operations', 128)]:
        values = goal.get(name)
        if not isinstance(values, list) or not 1 <= len(values) <= 32:
            errors.append(f'{name}: expected 1..32 unique text entries')
            lists[name] = []
            continue
        valid = [value for index, value in enumerate(values) if text(value, limit, f'{name}[{index}]')]
        lists[name] = valid
        if len(set(valid)) != len(valid):
            errors.append(f'{name}: duplicate entries')
    roots = lists['roots']
    if any(not root.startswith('/') or root == '/' or posixpath.normpath(root) != root for root in roots):
        errors.append('roots: use explicit normalized absolute directories, not /')
    cwd = request.get('cwd')
    if not isinstance(cwd, str) or not any(within(cwd, root) for root in roots):
        errors.append('roots: current project must be inside an approved root')
    if any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._/-]*:(off|minimal|low|medium|high)', model) for model in lists['models']):
        errors.append('models: use exact provider/model:effort selectors, from off through high; no aliases or wildcards')
    if any(tier not in ('default', 'priority') for tier in lists['tiers']):
        errors.append('tiers: allowed values are default or priority')
    resource = object_fields(goal.get('resources'),
                             {'memory_ceiling', 'runtime_seconds', 'elastic', 'gpu'}, 'resources')
    memory = resource.get('memory_ceiling')
    if type(memory) is not int or not 256*1024**2 <= memory <= 1024**5:
        errors.append('resources.memory_ceiling: expected integer bytes from 256 MiB to 1 PiB')
    runtime = resource.get('runtime_seconds')
    if type(runtime) is not int or runtime < 1 or (duration_valid and runtime > seconds - 30):
        errors.append('resources.runtime_seconds: expected 1..duration_seconds-30')
    for name in ('elastic', 'gpu'):
        if type(resource.get(name)) is not bool:
            errors.append(f'resources.{name}: expected boolean')
    delivery = object_fields(goal.get('delivery'), {'branch', 'remote', 'actions'}, 'delivery')
    actions = delivery.get('actions')
    if not isinstance(actions, list) or any(action not in ('commit', 'push', 'mr') for action in actions):
        errors.append('delivery.actions: allowed values are commit, push, mr')
    for name in ('branch', 'remote'):
        if not isinstance(delivery.get(name), str) or len(delivery[name]) > 500:
            errors.append(f'delivery.{name}: expected text of at most 500 characters')
    if isinstance(actions, list):
        if actions and not delivery.get('branch'):
            errors.append('delivery.branch: required for delivery actions')
        if 'push' in actions and not delivery.get('remote'):
            errors.append('delivery.remote: required for push')
    return errors


def validate_goal(request):
    errors = goal_errors(request)
    if errors:
        raise ApprovalError('\n'.join(errors))


def validate_request(raw):
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > 12000:
        raise ApprovalError('Request exceeds the size limit')
    try:
        request = json.loads(raw, object_pairs_hook=_object)
    except (TypeError, json.JSONDecodeError) as error:
        raise ApprovalError('Invalid JSON request') from error
    base_fields = {'session', 'cwd', 'action', 'exceptions'}
    if not isinstance(request, dict) or set(request) not in (
            base_fields, base_fields | {'purpose', 'duration_seconds', 'goal'}):
        raise ApprovalError('Unknown or incomplete approval fields')
    session = _text(request['session'], 128)
    if not re.fullmatch(r'[A-Za-z0-9_-]+', session):
        raise ApprovalError('Invalid session identifier')
    cwd = _text(request['cwd'], 1024)
    if not cwd.startswith('/') or posixpath.normpath(cwd) != cwd:
        raise ApprovalError('Project path must be absolute and normalized')
    _text(request['action'], 500)
    exceptions = request['exceptions']
    if not isinstance(exceptions, list) or not 1 <= len(exceptions) <= 8:
        raise ApprovalError('Specify between one and eight exact owner-policy exceptions')
    for exception in exceptions:
        _text(exception, 800)
    if len(set(exceptions)) != len(exceptions) or sum(map(len, exceptions)) > 1600:
        raise ApprovalError('Duplicate or oversized exceptions')
    if 'goal' in request:
        validate_goal(request)
    return request


def canonical(request):
    return json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def format_prompt(request):
    exceptions = '\n'.join(f'{i + 1}. {text}' for i, text in enumerate(request['exceptions']))
    goal = request.get('goal')
    lifetime = (f"Для goal на {request['duration_seconds'] // 3600} часов; обычный конец turn не отзывает разрешение. "
                if goal else 'Только для одного запуска агента, максимум 1 час. ')
    envelope = ('Границы goal:\n' + json.dumps(goal, ensure_ascii=False, indent=2) + '\n\n') if goal else ''
    return (
        'Разовое исключение из ВАШИХ правил OMP\n\n'
        f"Сессия: {request['session']}\nПроект: {request['cwd']}\n"
        f"Действие: {request['action']}\n\nИсключения:\n{exceptions}\n\n{envelope}"
        f'{lifetime}Не изменяет постоянные правила. '
        'Не выдаёт root и не отменяет системные ограничения провайдера. '
        'Введите пароль только если подтверждаете ВСЁ показанное выше.'
    )


class GrantStore:
    def __init__(self, owner_uid, clock=time.monotonic):
        self.owner_uid = owner_uid
        self.clock = clock
        self.grants = {}
        self.descendants = {}

    def _owner(self, uid):
        if uid != self.owner_uid:
            raise ApprovalError('Only the configured owner may use this service')

    def _prune(self):
        now = self.clock()
        for key in list(self.grants):
            if self.grants[key]['expires'] <= now:
                del self.grants[key]
        for key in list(self.descendants):
            if self.descendants[key]['parent'] not in self.grants:
                del self.descendants[key]

    def count(self):
        self._prune()
        return len(self.grants)

    def issue(self, uid, actor, request, *, authenticated):
        self._owner(uid)
        if authenticated is not True:
            raise ApprovalError('Fresh owner authentication is required')
        request = validate_request(canonical(request))
        self._prune()
        if len(self.grants) >= 32:
            raise ApprovalError('Approval capacity reached')
        if any(g['actor'] == actor and g['request']['session'] == request['session'] for g in self.grants.values()):
            raise ApprovalError('An approval for this run is already open; revoke it first')
        grant_id, secret = secrets.token_hex(16), secrets.token_hex(32)
        self.grants[grant_id] = {
            'actor': actor,
            'request': copy.deepcopy(request),
            'secret': secret,
            'status': 'pending',
            'expires': self.clock() + 60,
        }
        return {'id': grant_id, 'secret': secret}

    def _get(self, uid, actor, grant_id, secret):
        self._owner(uid)
        self._prune()
        grant = self.grants.get(grant_id)
        if not grant or grant['actor'] != actor or not isinstance(secret, str) or not hmac.compare_digest(grant['secret'], secret):
            raise ApprovalError('Unknown, expired or wrong-process approval')
        return grant

    def _bound(self, uid, actor, grant_id, secret, session, cwd):
        grant = self._get(uid, actor, grant_id, secret)
        if grant['request']['session'] != session or grant['request']['cwd'] != cwd:
            raise ApprovalError('Approval belongs to another session or project')
        return grant

    def _public(self, grant_id, grant):
        return {
            'id': grant_id,
            'request': copy.deepcopy(grant['request']),
            'request_hash': hashlib.sha256(canonical(grant['request']).encode()).hexdigest(),
            'remaining_seconds': max(0, int(grant['expires'] - self.clock())),
        }

    def activate(self, uid, actor, grant_id, secret, session, cwd):
        grant = self._bound(uid, actor, grant_id, secret, session, cwd)
        if grant['status'] != 'pending':
            raise ApprovalError('Approval has already been claimed')
        grant['status'] = 'active'
        grant['expires'] = self.clock() + grant['request'].get('duration_seconds', 3600)
        return self._public(grant_id, grant)

    def check(self, uid, actor, grant_id, secret, session, cwd):
        grant = self._bound(uid, actor, grant_id, secret, session, cwd)
        if grant['status'] != 'active':
            raise ApprovalError('Approval is not active')
        return self._public(grant_id, grant)

    def revoke(self, uid, actor, grant_id, secret):
        self._get(uid, actor, grant_id, secret)
        del self.grants[grant_id]
        return {'revoked': True}

    def issue_descendant(self, uid, actor, grant_id, secret, session, cwd, roots, role):
        parent = self._bound(uid, actor, grant_id, secret, session, cwd)
        if parent['status'] != 'active' or parent['request'].get('purpose') != 'goal':
            raise ApprovalError('Only an active goal may delegate authority')
        if role not in ('resource', 'worker') or not isinstance(roots, list) or not roots or len(roots) > 32:
            raise ApprovalError('Invalid descendant scope')
        allowed = parent['request']['goal']['roots']
        if any(not isinstance(root, str) or posixpath.normpath(root) != root or
               not any(within(root, original) for original in allowed) for root in roots):
            raise ApprovalError('Descendant cannot expand approved roots')
        for child_id, child in self.descendants.items():
            if child['parent'] == grant_id and child['role'] == role and child['request']['goal']['roots'] == roots:
                return {'id': child_id, 'secret': child['secret']}
        if len(self.descendants) >= 128:
            raise ApprovalError('Descendant capacity reached')
        child_id, child_secret = secrets.token_hex(16), secrets.token_hex(32)
        scope = copy.deepcopy(parent['request'])
        scope['goal']['roots'] = list(roots)
        self.descendants[child_id] = dict(parent=grant_id, actor=actor, secret=child_secret,
                                          request=scope, role=role)
        return {'id': child_id, 'secret': child_secret}

    def check_descendant(self, uid, ancestors, grant_id, secret, session, cwd):
        self._owner(uid)
        self._prune()
        child = self.descendants.get(grant_id)
        if not child or not isinstance(secret, str) or not hmac.compare_digest(child['secret'], secret):
            raise ApprovalError('Unknown or revoked descendant')
        if child['actor'] not in ancestors:
            raise ApprovalError('Descendant lacks the original live process ancestry')
        parent = self.grants.get(child['parent'])
        if not parent or parent['status'] != 'active' or child['request']['session'] != session:
            raise ApprovalError('Goal expired or belongs to another session')
        if posixpath.normpath(cwd) != cwd or not any(within(cwd, root) for root in child['request']['goal']['roots']):
            raise ApprovalError('Descendant belongs to another root')
        result = self._public(grant_id, {**parent, 'request': child['request']})
        result['role'] = child['role']
        return result
