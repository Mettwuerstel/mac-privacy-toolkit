/* Shared validation and transactions. No OS access or third-party dependencies. */
var PrivacyCore = (function () {
    'use strict';

    function fail(message) { throw new Error(message); }
    function quote(value) {
        value = String(value);
        if (value.indexOf('\0') !== -1) fail('NUL im Shell-Argument.');
        return "'" + value.replace(/'/g, "'\\''") + "'";
    }
    function device(value) {
        if (!/^en[0-9]{1,4}$/.test(String(value))) fail('Ungueltige Netzwerkschnittstelle.');
        return String(value);
    }
    function mac(value) {
        value = String(value).trim().toLowerCase();
        if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(value)) fail('Ungueltige MAC-Adresse.');
        if (value === '00:00:00:00:00:00' || (parseInt(value.slice(0, 2), 16) & 1)) {
            fail('Es wird eine gueltige Unicast-Adresse benoetigt.');
        }
        return value;
    }
    function randomMac(hex) {
        if (!/^[0-9a-f]{12}$/i.test(hex)) fail('Zufallsquelle lieferte ungueltige Daten.');
        var first = ((parseInt(hex.slice(0, 2), 16) | 2) & 254).toString(16);
        var result = ('0' + first).slice(-2) + hex.slice(2).toLowerCase();
        return mac(result.match(/../g).join(':'));
    }
    function hardwarePorts(text) {
        return String(text).split(/\r?\n\s*\r?\n/).map(function (block) {
            var port = block.match(/^Hardware Port:\s*(.+)$/m);
            var dev = block.match(/^Device:\s*(en[0-9]+)\s*$/m);
            if (!port || !dev) return null;
            return {device: device(dev[1]), port: port[1].trim()};
        }).filter(function (item) { return item !== null; });
    }
    function currentMac(text) {
        var match = String(text).match(/^\s*ether\s+([0-9a-f:]{17})(?:\s|$)/im);
        if (!match) fail('Keine aktive Ethernet-/WLAN-Adresse lesbar.');
        return mac(match[1]);
    }
    function cachePath(root, name) {
        if (typeof root !== 'string' || root.charAt(0) !== '/' || root.slice(-15) !== '/Library/Caches') {
            fail('Unzulaessiges Cache-Stammverzeichnis.');
        }
        if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
                /[\/\\\x00-\x1f\x7f\u2028\u2029]/.test(name) || name.charAt(0) === '.') {
            fail('Unzulaessiger Cache-Ordnername.');
        }
        if (name.indexOf('com.apple.') === 0) fail('Apple-Systemcaches werden nicht angeboten.');
        return root + '/' + name;
    }
    function emptyState() { return {version: 1, adapters: {}}; }
    function validateState(state) {
        if (!state || state.version !== 1 || !state.adapters || typeof state.adapters !== 'object' ||
                Array.isArray(state.adapters)) fail('Die Sicherungsdatei ist ungueltig.');
        Object.keys(state.adapters).forEach(function (key) {
            device(key);
            var item = state.adapters[key];
            if (!item || item.device !== key || typeof item.port !== 'string' || !item.port ||
                    typeof item.savedAt !== 'string') fail('Ungueltiger Sicherungseintrag.');
            mac(item.original);
            if (item.lastApplied) mac(item.lastApplied);
            if (item.pending) mac(item.pending);
        });
        return state;
    }
    function copy(value) { return JSON.parse(JSON.stringify(value)); }

    /* A failed save aborts BEFORE the privileged operation. A failed change is
       read back and rolled back to the address seen immediately before it. */
    function changeMac(adapter, requested, restoring, io) {
        var dev = device(adapter.device);
        var before = mac(io.readMac(dev));
        var state = copy(validateState(io.loadState()));
        var entry = state.adapters[dev];
        if (entry && entry.port !== adapter.port) fail('Der Anschluss passt nicht zur Sicherung.');
        if (restoring && !entry) fail('Fuer diesen Anschluss existiert keine Sicherung.');
        var target = restoring ? mac(entry.original) : mac(requested);
        if (before === target) return {changed: false, address: before};
        if (!entry) {
            entry = {device: dev, port: adapter.port, original: before,
                savedAt: io.now(), lastApplied: null, pending: null};
            state.adapters[dev] = entry;
        }
        entry.pending = target;
        io.saveState(state);
        try {
            io.setMac(dev, target);
            if (mac(io.readMac(dev)) !== target) fail('Der Treiber hat die neue Adresse nicht uebernommen.');
        } catch (error) {
            var rollback = '';
            try {
                if (mac(io.readMac(dev)) !== before) {
                    io.setMac(dev, before);
                    if (mac(io.readMac(dev)) !== before) fail('Ruecklesen stimmt nicht ueberein.');
                }
                entry.pending = null;
                io.saveState(state);
                rollback = 'Die vorherige Adresse ist wieder aktiv bzw. blieb unveraendert.';
            } catch (rollbackError) {
                rollback = 'Wiederherstellung nicht bestaetigt: ' + rollbackError.message +
                    '\nDie urspruengliche Adresse bleibt in der Sicherungsdatei erhalten.';
            }
            fail('MAC-Wechsel fehlgeschlagen: ' + error.message + '\n\n' + rollback);
        }
        entry.pending = null;
        entry.lastApplied = target;
        try { io.saveState(state); }
        catch (saveError) {
            fail('Die Adresse wurde auf ' + target + ' geaendert und geprueft. ' +
                'Der Abschluss konnte nicht gespeichert werden: ' + saveError.message +
                '\nDie vorher angelegte Sicherung bleibt erhalten.');
        }
        return {changed: true, address: target};
    }
    function trashCaches(root, names, io) {
        if (!names.length) fail('Keine Cache-Ordner ausgewaehlt.');
        var paths = names.map(function (name) { return cachePath(root, name); });
        if (paths.some(function (path, index) { return paths.indexOf(path) !== index; })) {
            fail('Doppelte Cache-Auswahl.');
        }
        // Validate the whole selection before the first move, then recheck each.
        paths.forEach(function (path) { io.validateDirectory(path); });
        io.assertAppsClosed(names);
        var results = [];
        paths.forEach(function (path, index) {
            try {
                io.validateDirectory(path);
                io.assertAppsClosed([names[index]]);
                var destination = io.trash(path);
                results.push({name: names[index], ok: true, destination: destination});
            } catch (error) {
                results.push({name: names[index], ok: false, error: error.message});
            }
        });
        return results;
    }
    return {quote: quote, device: device, mac: mac, randomMac: randomMac,
        hardwarePorts: hardwarePorts, currentMac: currentMac, cachePath: cachePath,
        emptyState: emptyState, validateState: validateState, changeMac: changeMac,
        trashCaches: trashCaches};
}());
if (typeof module !== 'undefined') module.exports = PrivacyCore;
