"""Fixed-path installation/removal, intended for an explicitly authenticated bootstrap."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile
import secrets

ROOT = Path('/usr/local/lib/omp-owner-approval')
ASSETS = {
    'core.py': ROOT / 'core.py',
    'broker.py': ROOT / 'broker.py',
    'client.py': ROOT / 'client.py',
    'extension.js': ROOT / 'extension.js',
    'night-runtime.js': ROOT / 'night-runtime.js',
    'install.py': ROOT / 'install.py',
    'owner-rule-authority.md': ROOT / 'owner-rule-authority.md',
    'org.omp.OwnerApproval1.policy': Path('/usr/share/polkit-1/actions/org.omp.OwnerApproval1.policy'),
    'org.omp.OwnerApproval1.conf': Path('/etc/dbus-1/system.d/org.omp.OwnerApproval1.conf'),
    '00-omp-owner-approval.rules': Path('/etc/polkit-1/rules.d/00-omp-owner-approval.rules'),
    'omp-owner-approval.service': Path('/etc/systemd/system/omp-owner-approval.service'),
}
MANIFEST = ROOT / 'installation.json'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_regular(path, maximum=100000):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
            raise ValueError(f'Not a bounded regular file: {path}')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            return stream.read(maximum + 1)
    finally:
        os.close(descriptor)


def load_snapshot(source, manifest_hash):
    data = read_regular(source / 'manifest.json')
    if digest(data) != manifest_hash:
        raise ValueError('Installation manifest changed after authorization')
    manifest = json.loads(data)
    if set(manifest) != {'owner_uid', 'files'} or set(manifest['files']) != set(ASSETS):
        raise ValueError('Installation manifest has an unexpected scope')
    uid = manifest['owner_uid']
    if type(uid) is not int or uid <= 0:
        raise ValueError('A non-root owner UID is required')
    account = pwd.getpwuid(uid)
    if not re.fullmatch(r'[a-z_][a-z0-9_-]*', account.pw_name):
        raise ValueError('Unsupported owner account name')
    contents = {}
    for name, expected in manifest['files'].items():
        body = read_regular(source / name)
        if not isinstance(expected, str) or digest(body) != expected:
            raise ValueError(f'Installation payload changed after authorization: {name}')
        if name in ('org.omp.OwnerApproval1.conf', '00-omp-owner-approval.rules'):
            body = body.replace(b'@OWNER@', account.pw_name.encode('ascii'))
        contents[ASSETS[name]] = body
    contents[ROOT / 'owner.json'] = json.dumps({'uid': uid, 'user': account.pw_name}).encode()
    return uid, contents


def secure_directory(path):
    if path == path.parent:
        return
    secure_directory(path.parent)
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=0o755)
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise ValueError(f'Unsafe installation directory: {path}')


def write_atomic(path, data):
    secure_directory(path.parent)
    descriptor, temporary = tempfile.mkstemp(prefix='.owner-approval-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def control(*args):
    subprocess.run(args, check=True, timeout=30, stdin=subprocess.DEVNULL)


def reload_bus():
    control('/usr/bin/busctl', '--system', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ReloadConfig')


def install(source, manifest_hash):
    uid, contents = load_snapshot(source, manifest_hash)
    caller = os.environ.get('PKEXEC_UID', os.environ.get('SUDO_UID'))
    if caller != str(uid):
        raise ValueError('Bootstrap must be authenticated by the configured owner')
    if MANIFEST.exists() or MANIFEST.is_symlink():
        raise ValueError('Already installed; refuse to overwrite an existing installation')
    for destination in contents:
        if destination.exists() or destination.is_symlink():
            raise ValueError(f'Refuse to overwrite a preexisting destination: {destination}')
        secure_directory(destination.parent)
    installed = []
    try:
        for destination, body in contents.items():
            write_atomic(destination, body)
            installed.append(destination)
        record = {'owner_uid': uid, 'files': {str(path): digest(body) for path, body in contents.items()}}
        write_atomic(MANIFEST, json.dumps(record, indent=2).encode())
        installed.append(MANIFEST)
        reload_bus()
        control('/usr/bin/systemctl', 'daemon-reload')
        control('/usr/bin/systemctl', 'enable', '--now', 'omp-owner-approval.service')
    except Exception:
        subprocess.run(['/usr/bin/systemctl', 'disable', '--now', 'omp-owner-approval.service'], timeout=30, stdin=subprocess.DEVNULL, check=False)
        for destination in reversed(installed):
            if destination == MANIFEST or digest(read_regular(destination)) == digest(contents[destination]):
                destination.unlink()
        subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], timeout=30, stdin=subprocess.DEVNULL, check=False)
        raise
    print(json.dumps({'installed': True, 'owner_uid': uid, 'root': str(ROOT), 'service': 'omp-owner-approval.service'}))


def remove():
    record = json.loads(read_regular(MANIFEST))
    caller = os.environ.get('PKEXEC_UID', os.environ.get('SUDO_UID'))
    if caller != str(record['owner_uid']):
        raise ValueError('Removal must be authenticated by the configured owner')
    allowed = {str(path) for path in ASSETS.values()} | {str(ROOT / 'owner.json')}
    if set(record['files']) != allowed:
        raise ValueError('Installed manifest scope is invalid')
    for destination, expected in record['files'].items():
        path = Path(destination)
        secure_directory(path.parent)
        metadata = path.lstat()
        if metadata.st_uid != 0 or metadata.st_mode & 0o022 or digest(read_regular(path)) != expected:
            raise ValueError(f'Installed file changed; refuse to delete: {path}')
    control('/usr/bin/systemctl', 'disable', '--now', 'omp-owner-approval.service')
    for destination in record['files']:
        Path(destination).unlink()
    MANIFEST.unlink()
    reload_bus()
    control('/usr/bin/systemctl', 'daemon-reload')
    print(json.dumps({'removed': True, 'user_extension_links_must_be_removed': True}))


def verified_installation():
    secure_directory(ROOT)
    metadata = MANIFEST.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise ValueError('Installed manifest is not root protected')
    record = json.loads(read_regular(MANIFEST))
    allowed = {str(path) for path in ASSETS.values()} | {str(ROOT / 'owner.json')}
    legacy = allowed - {str(ROOT / 'night-runtime.js')}
    if set(record.get('files', {})) not in (allowed, legacy):
        raise ValueError('Installed manifest scope is invalid')
    for destination, expected in record['files'].items():
        path = Path(destination)
        metadata = path.lstat()
        secure_directory(path.parent)
        if metadata.st_uid != 0 or metadata.st_mode & 0o022 or digest(read_regular(path)) != expected:
            raise ValueError('Installed baseline changed: ' + destination)
    return record


def require_drained(uid):
    # Contact the broker as its configured owner, never as root or a forged
    # caller. A service restart must not silently revoke another active goal.
    account = pwd.getpwuid(uid)
    probe = ('import os,sys,json;sys.path.insert(0,sys.argv[1]);'
             'from client import call;print(json.dumps(call("health","{}",os.getpid())))')
    result = subprocess.run(['/usr/bin/python3', '-I', '-c', probe, str(ROOT)],
                            user=uid, group=account.pw_gid, extra_groups=[],
                            capture_output=True, text=True, timeout=10, check=True, cwd='/')
    health = json.loads(result.stdout)
    if health.get('ready') is not True or health.get('owner_uid') != uid or (
            health.get('grants') != 0 or health.get('authentication_pending') is not False):
        raise ValueError('Broker update deferred: active grants or owner authentication must drain')


def update(source, manifest_hash):
    uid, contents = load_snapshot(source, manifest_hash)
    if os.environ.get('PKEXEC_UID', os.environ.get('SUDO_UID')) != str(uid):
        raise ValueError('Update must be authenticated by the configured owner')
    previous = verified_installation()
    if previous['owner_uid'] != uid:
        raise ValueError('Cannot change the installed owner')
    for destination in contents:
        if str(destination) not in previous['files'] and (destination.exists() or destination.is_symlink()):
            raise ValueError('Unowned update destination: ' + str(destination))
    old = {Path(path): read_regular(Path(path)) for path in previous['files']}
    changed = {path: body for path, body in contents.items() if old.get(path) != body}
    frontend_files = {ROOT / name for name in ('extension.js', 'night-runtime.js', 'install.py')}
    restart_required = not set(changed).issubset(frontend_files)
    if restart_required:
        require_drained(uid)
    backup = ROOT / 'backups' / secrets.token_hex(16)
    secure_directory(backup)
    old_manifest = read_regular(MANIFEST)
    for index, (path, body) in enumerate(old.items()):
        write_atomic(backup / str(index), body)
    write_atomic(backup / 'index.json', json.dumps({
        'paths': [str(path) for path in old], 'manifest': previous,
    }, sort_keys=True).encode())
    installed = []
    if restart_required:
        control('/usr/bin/systemctl', 'stop', 'omp-owner-approval.service')
    try:
        for path, body in changed.items():
            write_atomic(path, body)
            installed.append(path)
        record = {'owner_uid': uid, 'files': {str(path): digest(body) for path, body in contents.items()}}
        write_atomic(MANIFEST, json.dumps(record, indent=2).encode())
        if restart_required:
            reload_bus()
            control('/usr/bin/systemctl', 'daemon-reload')
            control('/usr/bin/systemctl', 'start', 'omp-owner-approval.service')
            control('/usr/bin/systemctl', 'is-active', '--quiet', 'omp-owner-approval.service')
    except Exception:
        if restart_required:
            control('/usr/bin/systemctl', 'stop', 'omp-owner-approval.service')
        for path in installed:
            if path in old:
                write_atomic(path, old[path])
            else:
                path.unlink(missing_ok=True)
        write_atomic(MANIFEST, old_manifest)
        if restart_required:
            reload_bus()
            control('/usr/bin/systemctl', 'daemon-reload')
            control('/usr/bin/systemctl', 'start', 'omp-owner-approval.service')
        raise
    print(json.dumps({'updated': True, 'owner_uid': uid, 'backup': str(backup), 'broker_restarted': restart_required}))

def rollback(identifier):
    if not re.fullmatch('[0-9a-f]{32}', identifier):
        raise ValueError('Invalid root backup identifier')
    current = verified_installation()
    uid = current['owner_uid']
    if os.environ.get('PKEXEC_UID', os.environ.get('SUDO_UID')) != str(uid):
        raise ValueError('Rollback must be authenticated by the configured owner')
    backup = ROOT / 'backups' / identifier
    secure_directory(backup)
    index = json.loads(read_regular(backup / 'index.json'))
    previous = index['manifest']
    allowed = {str(path) for path in ASSETS.values()} | {str(ROOT / 'owner.json')}
    paths = index['paths']
    if (previous.get('owner_uid') != uid or set(paths) != set(previous['files']) or
            set(paths) not in (allowed, allowed - {str(ROOT / 'night-runtime.js')}) or
            len(paths) != len(set(paths))):
        raise ValueError('Invalid rollback scope')
    bodies = {}
    for number, path in enumerate(paths):
        body = read_regular(backup / str(number))
        if digest(body) != previous['files'][path]:
            raise ValueError('Rollback payload digest mismatch')
        bodies[Path(path)] = body
    require_drained(uid)
    control('/usr/bin/systemctl', 'stop', 'omp-owner-approval.service')
    for path, body in bodies.items():
        write_atomic(path, body)
    for path in set(current['files']) - set(paths):
        Path(path).unlink()
    write_atomic(MANIFEST, json.dumps(previous, indent=2).encode())
    reload_bus()
    control('/usr/bin/systemctl', 'daemon-reload')
    control('/usr/bin/systemctl', 'start', 'omp-owner-approval.service')
    control('/usr/bin/systemctl', 'is-active', '--quiet', 'omp-owner-approval.service')
    print(json.dumps({'rolled_back': True, 'backup': identifier}))



if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['install', 'remove', 'update', 'rollback'])
    parser.add_argument('--source', type=Path)
    parser.add_argument('--manifest-hash')
    parser.add_argument('--backup')
    arguments = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Use the explicitly authenticated root bootstrap')
    lock_directory = Path('/run/omp-owner-approval-install')
    secure_directory(lock_directory)
    descriptor = os.open(lock_directory / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if arguments.operation in ('install', 'update'):
            if arguments.source is None or arguments.manifest_hash is None:
                parser.error('Installation/update requires a frozen source and manifest hash')
            function = install if arguments.operation == 'install' else update
            function(arguments.source, arguments.manifest_hash)
        elif arguments.operation == 'rollback':
            rollback(arguments.backup or '')
        else:
            remove()
