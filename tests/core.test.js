'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const core = require('../src/core.js');

const adapter = {device: 'en0', port: 'Wi-Fi'};
const original = '00:11:22:33:44:55';
const changed = '02:aa:bb:cc:dd:ee';
const next = '06:aa:bb:cc:dd:ff';
function fixture() {
    let address = original;
    let saved = core.emptyState();
    const history = [];
    const io = {
        readMac: () => address,
        loadState: () => JSON.parse(JSON.stringify(saved)),
        saveState: state => { history.push('save'); saved = JSON.parse(JSON.stringify(state)); },
        setMac: (dev, mac) => { history.push(['set', dev, mac]); address = mac; },
        now: () => '2026-09-16T12:00:00.000Z'
    };
    return {io, history, state: () => saved, address: () => address,
        setAddress: value => { address = value; }, setState: value => { saved = value; }};
}

test('generated MACs are locally administered unicast, for all first octets', () => {
    for (let first = 0; first < 256; first++) {
        const value = core.randomMac(first.toString(16).padStart(2, '0') + '1234567890');
        assert.equal(parseInt(value.slice(0, 2), 16) & 3, 2);
        assert.match(value, /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/);
    }
    assert.throws(() => core.randomMac('broken'));
});

test('rejects shell fragments, multicast, broadcast, zero and invalid interfaces', () => {
    for (const value of ['ff:ff:ff:ff:ff:ff', '01:00:00:00:00:01', '00:00:00:00:00:00',
        '02:11:22:33:44:55;id', '$(id)', '021122334455']) assert.throws(() => core.mac(value));
    for (const value of ['en0;id', 'en0\n', '-a', '../en0', 'en0 ether x', 'lo0']) {
        assert.throws(() => core.device(value));
    }
});

test('shell quoting preserves arbitrary text without executing substitutions', () => {
    const value = "text ' apostrophe $(echo EXECUTED) `echo EXECUTED` ; & \n next";
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
    const result = execFileSync(bash, ['-c', 'printf %s ' + core.quote(value)], {encoding: 'utf8'});
    assert.equal(result, value);
    assert.throws(() => core.quote('x\0y'));
});

test('discovers hardware ports and reads actual interface MAC', () => {
    const ports = core.hardwarePorts('Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: 00:11:22:33:44:55\n\n' +
        'Hardware Port: USB 10/100/1000 LAN\nDevice: en4\nEthernet Address: 02:11:22:33:44:55\n\n' +
        'Hardware Port: Thunderbolt Bridge\nDevice: bridge0\nEthernet Address: 00:11:22:33:44:55');
    assert.deepEqual(ports, [adapter, {port: 'USB 10/100/1000 LAN', device: 'en4'}]);
    assert.equal(core.currentMac('en0: flags=8863<UP>\n\tether 00:11:22:33:44:55\n\tstatus: active'), original);
    assert.throws(() => core.currentMac('status: active'));
});

test('persists original before first change and retains it across rotations', () => {
    const f = fixture();
    assert.equal(core.changeMac(adapter, changed, false, f.io).address, changed);
    assert.equal(f.history[0], 'save');
    assert.equal(f.state().adapters.en0.original, original);
    core.changeMac(adapter, next, false, f.io);
    assert.equal(f.state().adapters.en0.original, original);
    assert.equal(f.state().adapters.en0.lastApplied, next);
    assert.equal(f.state().adapters.en0.pending, null);
    assert.equal(core.changeMac(adapter, null, true, f.io).address, original);
    assert.equal(f.address(), original);
});

test('a rejected initial backup blocks all privileged changes', () => {
    const f = fixture();
    f.io.saveState = () => { throw new Error('disk full'); };
    assert.throws(() => core.changeMac(adapter, changed, false, f.io), /disk full/);
    assert.equal(f.address(), original);
    assert.equal(f.history.length, 0);
});

test('driver rejecting a change never produces success', () => {
    const f = fixture();
    f.io.setMac = () => { throw new Error('Operation not supported'); };
    assert.throws(() => core.changeMac(adapter, changed, false, f.io), /Operation not supported/);
    assert.equal(f.address(), original);
    assert.equal(f.state().adapters.en0.original, original);
});

test('driver ignoring a change is detected by readback', () => {
    const f = fixture();
    f.io.setMac = () => {};
    assert.throws(() => core.changeMac(adapter, changed, false, f.io), /nicht uebernommen/);
    assert.equal(f.address(), original);
});

test('partially applied change rolls back to immediate previous address', () => {
    const f = fixture();
    let calls = 0;
    f.io.setMac = (dev, value) => {
        calls++;
        f.setAddress(value);
        if (calls === 1) throw new Error('link failed after change');
    };
    assert.throws(() => core.changeMac(adapter, changed, false, f.io), /link failed/);
    assert.equal(calls, 2);
    assert.equal(f.address(), original);
    assert.equal(f.state().adapters.en0.pending, null);
});

test('rollback failure preserves recovery data and reports uncertainty', () => {
    const f = fixture();
    f.io.setMac = () => { f.setAddress(next); throw new Error('driver failed'); };
    assert.throws(() => core.changeMac(adapter, changed, false, f.io), /Wiederherstellung nicht bestaetigt/);
    assert.equal(f.state().adapters.en0.original, original);
    assert.equal(f.state().adapters.en0.pending, changed);
});

test('final save failure reports applied change accurately', () => {
    const f = fixture();
    const save = f.io.saveState;
    let calls = 0;
    f.io.saveState = value => { if (++calls === 2) throw new Error('disk full'); save(value); };
    assert.throws(() => core.changeMac(adapter, changed, false, f.io), /wurde auf.*geaendert und geprueft/);
    assert.equal(f.address(), changed);
    assert.equal(f.state().adapters.en0.original, original);
});

test('missing or mismatched recovery record cannot be restored', () => {
    const f = fixture();
    assert.throws(() => core.changeMac(adapter, null, true, f.io), /keine Sicherung/);
    core.changeMac(adapter, changed, false, f.io);
    assert.throws(() => core.changeMac({device: 'en0', port: 'Another adapter'}, null, true, f.io), /Anschluss/);
});

test('already active address produces no mutation', () => {
    const f = fixture();
    assert.equal(core.changeMac(adapter, original, false, f.io).changed, false);
    assert.equal(f.history.length, 0);
});

test('corrupt backups fail closed', () => {
    for (const value of [null, {}, {version: 2, adapters: {}}, {version: 1, adapters: []},
        {version: 1, adapters: {en0: {device: 'en0', port: 'Wi-Fi', savedAt: 'today', original: '$(id)'}}}]) {
        assert.throws(() => core.validateState(value));
    }
});

test('cache allowlist rejects traversal, root operations, hidden names and system caches', () => {
    const root = '/Users/Example/Library/Caches';
    assert.equal(core.cachePath(root, 'com.riotgames.RiotClient'), root + '/com.riotgames.RiotClient');
    assert.equal(core.cachePath(root, "Example's Cache"), root + "/Example's Cache");
    for (const name of ['', '.', '..', '../Library', '/Applications', 'a/b', 'a\\b',
        '.hidden', 'a\0b', 'a\nb', 'com.apple.Safari']) assert.throws(() => core.cachePath(root, name));
    assert.throws(() => core.cachePath('/Users/Example/Library', 'Caches'));
    assert.throws(() => core.cachePath('/Applications', 'League of Legends.app'));
});

test('all selected cache paths are validated before the first move', () => {
    const moved = [];
    const io = {validateDirectory: path => { if (path.endsWith('/linked')) throw new Error('symlink'); },
        assertAppsClosed: () => {}, trash: path => moved.push(path)};
    assert.throws(() => core.trashCaches('/Users/Example/Library/Caches', ['good', 'linked'], io), /symlink/);
    assert.deepEqual(moved, []);
});

test('active apps prevent clearing and cache move errors are reported per folder', () => {
    const root = '/Users/Example/Library/Caches';
    const moved = [];
    const io = {validateDirectory: () => {}, assertAppsClosed: () => { throw new Error('app open'); },
        trash: path => moved.push(path)};
    assert.throws(() => core.trashCaches(root, ['test'], io), /app open/);
    assert.deepEqual(moved, []);
    io.assertAppsClosed = () => {};
    io.trash = path => { if (path.endsWith('/locked')) throw new Error('permission denied'); return '/Trash/good'; };
    const result = core.trashCaches(root, ['good', 'locked'], io);
    assert.equal(result[0].ok, true);
    assert.equal(result[1].ok, false);
    assert.match(result[1].error, /permission denied/);
});

test('cache paths are rechecked immediately before each move', () => {
    let checks = 0;
    const moved = [];
    const result = core.trashCaches('/Users/Example/Library/Caches', ['test'], {
        validateDirectory: () => { if (++checks === 2) throw new Error('path replaced'); },
        assertAppsClosed: () => {}, trash: path => moved.push(path)
    });
    assert.equal(result[0].ok, false);
    assert.deepEqual(moved, []);
});
