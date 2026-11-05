"""Root-owned D-Bus authority. Never launches application commands."""
import json
import os
import posixpath
from pathlib import Path
import secrets
import stat
import sys
import syslog

sys.path.insert(0, str(Path(__file__).resolve().parent))
from core import ApprovalError, GrantStore, canonical, format_prompt, validate_request
import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

NAME = 'org.omp.OwnerApproval1'
PATH = '/org/omp/OwnerApproval1'
ACTION = 'org.omp.owner-approval.issue'
XML = '''<node><interface name="org.omp.OwnerApproval1">
<method name="Call"><arg type="s" direction="in" name="operation"/>
<arg type="s" direction="in" name="payload"/><arg type="u" direction="in" name="actor_pid"/>
<arg type="s" direction="out" name="result"/></method></interface></node>'''


def process_identity(pid):
    try:
        directory = Path('/proc') / str(pid)
        owner = directory.stat().st_uid
        fields = (directory / 'stat').read_text().rsplit(')', 1)[1].split()
        return owner, int(fields[1]), int(fields[19])
    except (OSError, ValueError, IndexError) as error:
        raise ApprovalError('Calling process is no longer available') from error


def _actual_cwd(actor, owner_uid):
    """Read path and metadata from one pinned, authenticated kernel cwd."""
    pid, expected_start = actor

    def require_identity():
        uid, _, started = process_identity(pid)
        if uid != owner_uid or started != expected_start:
            raise ApprovalError('Descendant process identity changed')

    require_identity()
    try:
        descriptor = os.open(f'/proc/{pid}/cwd', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            cwd = os.readlink(f'/proc/self/fd/{descriptor}')
            metadata = os.fstat(descriptor)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise ApprovalError('Cannot verify descendant cwd') from error
    require_identity()
    if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_nlink == 0 or
            not cwd.startswith('/') or cwd.startswith('//') or
            posixpath.normpath(cwd) != cwd):
        raise ApprovalError('Descendant cwd is unavailable or not canonical')
    return cwd


class Broker:
    def __init__(self, owner_uid):
        self.owner_uid = owner_uid
        self.store = GrantStore(owner_uid)
        self.pending = None
        self.loop = GLib.MainLoop()
        self.registration = None
        self.bus = None

    def _dbus_property(self, sender, method):
        return self.bus.call_sync(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            method, GLib.Variant('(s)', (sender,)), GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE, 5000, None,
        ).unpack()[0]

    def _actor(self, sender, actor_pid):
        uid = self._dbus_property(sender, 'GetConnectionUnixUser')
        if uid != self.owner_uid:
            raise ApprovalError('This service belongs to another user')
        pid = self._dbus_property(sender, 'GetConnectionUnixProcessID')
        for _ in range(16):
            owner, parent, start = process_identity(pid)
            if owner != self.owner_uid:
                break
            if pid == actor_pid:
                return uid, (pid, start)
            if parent <= 1 or parent == pid:
                break
            pid = parent
        raise ApprovalError('Actor must be an owner-owned ancestor of the requesting client')

    def _ancestors(self, actor):
        chain, pid = [], actor[0]
        for _ in range(64):
            owner, parent, start = process_identity(pid)
            if owner != self.owner_uid:
                break
            chain.append((pid, start))
            if parent <= 1 or parent == pid:
                break
            pid = parent
        return chain

    @staticmethod
    def _reply(invocation, result):
        invocation.return_value(GLib.Variant('(s)', (json.dumps(result, ensure_ascii=False),)))

    @staticmethod
    def _deny(invocation, error):
        invocation.return_dbus_error(NAME + '.Denied', str(error)[:500])

    def _request(self, sender, actor_pid, uid, actor, request, invocation):
        if self.pending is not None:
            raise ApprovalError('Another owner authentication request is already open')
        if self.store.count() >= 32:
            raise ApprovalError('Approval capacity reached')
        cancellation = secrets.token_hex(16)
        self.pending = (sender, cancellation)
        # This canonical object is frozen BEFORE the password request; only it can be approved.
        frozen = validate_request(canonical(request))
        params = GLib.Variant('((sa{sv})sa{ss}us)', (
            ('system-bus-name', {'name': GLib.Variant('s', sender)}),
            ACTION,
            {'polkit.message': format_prompt(frozen), 'polkit.gettext_domain': ''},
            1, cancellation,
        ))

        def completed(connection, result, _data):
            still_pending = self.pending == (sender, cancellation)
            if still_pending:
                self.pending = None
            try:
                if not still_pending:
                    raise ApprovalError('Authentication request was cancelled')
                authorization = connection.call_finish(result).unpack()[0]
                if authorization[0] is not True:
                    raise ApprovalError('Owner declined authentication; no exception was granted')
                current_uid, current_actor = self._actor(sender, actor_pid)
                if (current_uid, current_actor) != (uid, actor):
                    raise ApprovalError('Requesting process changed during authentication')
                receipt = self.store.issue(uid, actor, frozen, authenticated=True)
                syslog.syslog(syslog.LOG_NOTICE, f"owner approval issued uid={uid} actor={actor[0]} id={receipt['id']}")
                self._reply(invocation, receipt)
            except (ApprovalError, GLib.Error) as error:
                self._deny(invocation, error)

        try:
            self.bus.call(
                'org.freedesktop.PolicyKit1', '/org/freedesktop/PolicyKit1/Authority',
                'org.freedesktop.PolicyKit1.Authority', 'CheckAuthorization', params,
                GLib.VariantType('((bba{ss}))'), Gio.DBusCallFlags.NONE, 120000, None,
                completed, None,
            )
        except Exception:
            self.pending = None
            raise

    def handle(self, connection, sender, object_path, interface, method, parameters, invocation):
        try:
            operation, raw, actor_pid = parameters.unpack()
            if len(raw.encode()) > 16000:
                raise ApprovalError('Payload exceeds the size limit')
            uid, actor = self._actor(sender, actor_pid)
            if operation == 'health':
                if raw != '{}':
                    raise ApprovalError('Health does not accept arguments')
                self._reply(invocation, {'ready': True, 'owner_uid': self.owner_uid, 'grants': self.store.count(), 'authentication_pending': self.pending is not None})
                return
            if operation == 'request':
                request = validate_request(raw)
                self._request(sender, actor_pid, uid, actor, request, invocation)
                return
            payload = json.loads(raw)
            if operation == 'issue_descendant':
                fields = {'id', 'secret', 'session', 'cwd', 'roots', 'role'}
                if not isinstance(payload, dict) or set(payload) != fields:
                    raise ApprovalError('Invalid descendant request')
                result = self.store.issue_descendant(uid, actor, payload['id'], payload['secret'],
                    payload['session'], payload['cwd'], payload['roots'], payload['role'])
                self._reply(invocation, result)
                return
            if operation == 'descendant_check':
                fields = {'id', 'secret', 'session', 'cwd'}
                if not isinstance(payload, dict) or set(payload) != fields or any(
                        not isinstance(v, str) for v in payload.values()):
                    raise ApprovalError('Invalid descendant capability')
                actual_cwd = _actual_cwd(actor, uid)
                if payload['cwd'] != actual_cwd:
                    raise ApprovalError('Descendant project differs from its real cwd')
                result = self.store.check_descendant(uid, self._ancestors(actor), payload['id'],
                    payload['secret'], payload['session'], actual_cwd)
                self._reply(invocation, result)
                return
            required = {'id', 'secret'} if operation == 'revoke' else {'id', 'secret', 'session', 'cwd'}
            if not isinstance(payload, dict) or set(payload) != required or any(not isinstance(v, str) for v in payload.values()):
                raise ApprovalError('Invalid capability arguments')
            if operation == 'revoke':
                result = self.store.revoke(uid, actor, payload['id'], payload['secret'])
            elif operation in ('activate', 'check'):
                function = self.store.activate if operation == 'activate' else self.store.check
                result = function(uid, actor, payload['id'], payload['secret'], payload['session'], payload['cwd'])
            else:
                raise ApprovalError('Unknown operation; this broker never executes commands')
            self._reply(invocation, result)
        except (ApprovalError, GLib.Error, ValueError, TypeError) as error:
            self._deny(invocation, error)
        except Exception:
            syslog.syslog(syslog.LOG_ERR, 'owner approval internal error; request denied')
            self._deny(invocation, 'Internal error; no exception was granted')

    def owner_changed(self, connection, sender, path, interface, signal, parameters):
        name, previous, current = parameters.unpack()
        if not self.pending or name != self.pending[0] or current or not previous:
            return
        _, cancellation = self.pending
        self.pending = None
        self.bus.call(
            'org.freedesktop.PolicyKit1', '/org/freedesktop/PolicyKit1/Authority',
            'org.freedesktop.PolicyKit1.Authority', 'CancelCheckAuthorization',
            GLib.Variant('(s)', (cancellation,)), GLib.VariantType('()'),
            Gio.DBusCallFlags.NONE, 5000, None, None, None,
        )

    def acquired(self, connection, _name):
        self.bus = connection
        info = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0]
        self.registration = connection.register_object(PATH, info, self.handle, None, None)
        connection.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', None, Gio.DBusSignalFlags.NONE,
            self.owner_changed,
        )

    def lost(self, _connection, _name):
        self.loop.quit()

    def run(self):
        Gio.bus_own_name(Gio.BusType.SYSTEM, NAME, Gio.BusNameOwnerFlags.NONE, self.acquired, None, self.lost)
        self.loop.run()


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('The broker must run as the root-owned system service')
    config = json.loads((Path(__file__).resolve().parent / 'owner.json').read_text())
    Broker(config['uid']).run()
