"""Unprivileged transport; passwords are handled only by the system polkit agent."""
import argparse
import json
import os
import sys
from pathlib import Path
import runpy
import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib


def call(operation, payload, actor_pid):
    if len(payload.encode()) > 16000:
        raise ValueError('Approval payload exceeds the size limit')
    if operation == 'validate':
        core = runpy.run_path(str(Path(__file__).with_name('core.py')))
        try:
            core['validate_request'](payload)
            return {'valid': True, 'authorization': False, 'errors': []}
        except core['ApprovalError'] as error:
            return {'valid': False, 'authorization': False, 'errors': str(error).splitlines()}
    bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
    reply = bus.call_sync(
        'org.omp.OwnerApproval1', '/org/omp/OwnerApproval1', 'org.omp.OwnerApproval1',
        'Call', GLib.Variant('(ssu)', (operation, payload, actor_pid)),
        GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE,
        125000 if operation == 'request' else 5000, None,
    )
    return json.loads(reply.unpack()[0])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Request one exact owner-policy exception; never execute a root command')
    parser.add_argument('operation', choices=['health', 'request', 'activate', 'check', 'revoke',
                                             'issue_descendant', 'descendant_check', 'validate'])
    parser.add_argument('payload', nargs='?', default='{}')
    parser.add_argument('--actor-pid', type=int, default=os.getppid())
    args = parser.parse_args()
    try:
        print(json.dumps(call(args.operation, args.payload, args.actor_pid), ensure_ascii=False))
    except (GLib.Error, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
