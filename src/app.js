/* Native macOS JXA front end. Concatenated after core.js by Start.command. */
ObjC.import('Foundation');
ObjC.import('AppKit');

function run() {
    'use strict';
    var app = Application.currentApplication();
    app.includeStandardAdditions = true;
    var fm = $.NSFileManager.defaultManager;
    var title = 'Mac Privacy Toolkit';
    var core = PrivacyCore;
    var home = ObjC.unwrap($(ObjC.unwrap($.NSHomeDirectory())).stringByResolvingSymlinksInPath);
    var cacheRoot = home + '/Library/Caches';
    var stateDirectory = home + '/Library/Application Support/Mac Privacy Toolkit';
    var statePath = stateDirectory + '/mac-backups.json';

    function shell(command, admin) {
        return String(app.doShellScript(command, admin ? {administratorPrivileges: true} : {}));
    }
    function info(message) {
        app.displayDialog(String(message), {withTitle: title, buttons: ['OK'], defaultButton: 'OK'});
    }
    function confirm(message, button) {
        var result = app.displayDialog(message, {withTitle: title,
            buttons: ['Abbrechen', button], defaultButton: 'Abbrechen', cancelButton: 'Abbrechen'});
        return result.buttonReturned === button;
    }
    function choose(items, prompt, multiple) {
        return app.chooseFromList(items, {withTitle: title, withPrompt: prompt,
            multipleSelectionsAllowed: !!multiple, emptySelectionAllowed: false,
            okButtonName: 'Weiter', cancelButtonName: 'Zurueck'});
    }
    function isCancelled(error) {
        return error.errorNumber === -128 || /User cancel|Benutzer.*abgebrochen|\(-128\)/i.test(String(error));
    }
    function exists(path) { return Boolean(fm.fileExistsAtPath($(path))); }
    function canonical(path) { return ObjC.unwrap($(path).stringByResolvingSymlinksInPath); }
    function requirePlainPath(path) {
        // lstat via the shell also rejects a dangling symlink, which exists() misses.
        if (shell('if [ -L ' + core.quote(path) + ' ]; then /usr/bin/printf link; fi') === 'link' ||
                canonical(path) !== path) throw new Error('Verknuepfungen werden nicht verwendet: ' + path);
    }
    function ensureStateDirectory() {
        requirePlainPath(stateDirectory);
        if (!exists(stateDirectory)) {
            if (!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
                    $(stateDirectory), true, null, null)) throw new Error('Sicherungsordner nicht erstellbar.');
        }
        requirePlainPath(stateDirectory);
        requirePlainPath(statePath);
        shell('/bin/chmod 700 ' + core.quote(stateDirectory));
    }
    function loadState() {
        requirePlainPath(stateDirectory);
        requirePlainPath(statePath);
        if (!exists(statePath)) return core.emptyState();
        var content = $.NSString.stringWithContentsOfFileEncodingError($(statePath), $.NSUTF8StringEncoding, null);
        if (!content) throw new Error('Sicherungsdatei nicht lesbar.');
        return core.validateState(JSON.parse(ObjC.unwrap(content)));
    }
    function saveState(state) {
        core.validateState(state);
        ensureStateDirectory();
        var data = $(JSON.stringify(state, null, 2) + '\n');
        if (!data.writeToFileAtomicallyEncodingError($(statePath), true, $.NSUTF8StringEncoding, null)) {
            throw new Error('Sicherung konnte nicht atomar gespeichert werden.');
        }
        shell('/bin/chmod 600 ' + core.quote(statePath));
    }
    function readMac(dev) {
        return core.currentMac(shell('/sbin/ifconfig ' + core.quote(core.device(dev))));
    }
    function adapters() {
        var list = core.hardwarePorts(shell('LC_ALL=C /usr/sbin/networksetup -listallhardwareports'));
        return list.map(function (adapter) {
            try { adapter.address = readMac(adapter.device); }
            catch (error) { adapter.address = null; }
            return adapter;
        }).filter(function (adapter) { return adapter.address !== null; });
    }
    function pickAdapter() {
        var list = adapters();
        if (!list.length) throw new Error('Kein physischer Anschluss mit lesbarer MAC-Adresse gefunden.');
        var labels = list.map(function (item) {
            return item.port + ' | ' + item.device + ' | ' + item.address;
        });
        var selected = choose(labels, 'Netzwerkanschluss auswaehlen. Die aktuelle Adresse wird angezeigt.', false);
        return selected ? list[labels.indexOf(selected[0])] : null;
    }
    var macIO = {
        readMac: readMac, loadState: loadState, saveState: saveState,
        now: function () { return new Date().toISOString(); },
        setMac: function (dev, value) {
            shell('/sbin/ifconfig ' + core.quote(core.device(dev)) + ' ether ' + core.quote(core.mac(value)), true);
            $.NSThread.sleepForTimeInterval(1);
        }
    };
    function changeAddress(restoring) {
        var adapter = pickAdapter();
        if (!adapter) return;
        var saved = loadState().adapters[adapter.device];
        if (restoring && !saved) throw new Error('Noch keine gespeicherte Ausgangsadresse fuer diesen Anschluss.');
        var target = restoring ? core.mac(saved.original) : core.randomMac(shell('/usr/bin/openssl rand -hex 6').trim());
        if (!confirm(adapter.port + ' (' + adapter.device + ')\n\nAktuell: ' + adapter.address +
                '\nZiel: ' + target + '\n\nDie Verbindung kann unterbrochen werden. ' +
                'Der Treiber muss den Wechsel unterstuetzen. Die App prueft danach die aktive Adresse.\n\n' +
                (restoring ? 'Wiederhergestellt wird die vor der ersten Aenderung erfasste Adresse, ' +
                    'nicht zwingend die werksseitige MAC. Bei USB-Adaptern pruefen, dass dies derselbe Adapter ist.' :
                    'Die bisherige Adresse wird vor dem Wechsel lokal gesichert. ' +
                    'Sequoias private WLAN-Adresse kann diesen manuellen Wert spaeter wieder ersetzen.'),
                restoring ? 'Wiederherstellen' : 'Adresse wechseln')) return;
        var result = core.changeMac(adapter, target, restoring, macIO);
        info((result.changed ? 'Adresse geaendert und zurueckgelesen: ' : 'Diese Adresse ist bereits aktiv: ') +
            result.address + '\n\nSicherung: ' + statePath +
            '\n\nDie oeffentliche IP-Adresse und Hardware-Seriennummern werden dadurch nicht geaendert.');
    }
    function privateWifi() {
        info('Sequoia: Systemeinstellungen > WLAN > Details beim Netzwerk > Private WLAN-Adresse > Rotierend.\n\n' +
            'macOS verwendet dann eine private Adresse fuer dieses WLAN und wechselt sie ungefaehr alle zwei Wochen. ' +
            'Die App aktiviert die Einstellung nicht selbst und meldet keinen ungeprueften Schutzstatus.\n\n' +
            'Diese Einstellung betrifft WLAN, nicht Ethernet. Sie aendert weder die Internet-IP noch deine Riot-Anmeldung.');
        // Open the supported settings app, without depending on an undocumented deep link.
        shell('/usr/bin/open -a ' + core.quote('System Settings'));
    }
    function validateCacheDirectory(path) {
        requirePlainPath(cacheRoot);
        var name = path.slice(cacheRoot.length + 1);
        if (core.cachePath(cacheRoot, name) !== path) throw new Error('Ordner liegt ausserhalb des Cache-Bereichs.');
        requirePlainPath(path);
        var isDir = Ref();
        if (!fm.fileExistsAtPathIsDirectory($(path), isDir) || !isDir[0]) {
            throw new Error('Cache-Ordner nicht mehr vorhanden: ' + name);
        }
    }
    function runningApps() {
        var values = $.NSWorkspace.sharedWorkspace.runningApplications;
        var result = [];
        for (var i = 0; i < Number(values.count); i++) {
            var item = values.objectAtIndex(i);
            var bundle = item.bundleIdentifier;
            var name = item.localizedName;
            result.push({id: bundle ? String(ObjC.unwrap(bundle)).toLowerCase() : '',
                name: name ? String(ObjC.unwrap(name)) : ''});
        }
        return result;
    }
    function assertAppsClosed(names) {
        var running = runningApps();
        var blocked = running.filter(function (appInfo) {
            return names.some(function (name) {
                var lower = name.toLowerCase();
                return (appInfo.id && (lower === appInfo.id || lower.indexOf(appInfo.id + '.') === 0)) ||
                    (/(riot|league)/.test(lower) && /riot|league of legends/i.test(appInfo.id + ' ' + appInfo.name));
            });
        });
        if (blocked.length) throw new Error('Zuerst diese Programme schliessen: ' +
            blocked.map(function (item) { return item.name || item.id; }).join(', '));
        if (names.some(function (name) { return /riot|league/i.test(name); })) {
            var processes = shell('/bin/ps -axo comm=');
            if (/(?:RiotClient|LeagueClient|League of Legends)/i.test(processes)) {
                throw new Error('Riot-/League-Prozesse laufen noch. Bitte selbst beenden und erneut versuchen.');
            }
        }
    }
    function cleanCaches() {
        requirePlainPath(cacheRoot);
        if (!exists(cacheRoot)) { info('Kein Benutzer-Cache-Verzeichnis vorhanden.'); return; }
        var entries = fm.contentsOfDirectoryAtPathError($(cacheRoot), null);
        if (!entries) throw new Error('Cache-Verzeichnis nicht lesbar.');
        var names = ObjC.deepUnwrap(entries).filter(function (name) {
            try { validateCacheDirectory(core.cachePath(cacheRoot, name)); return true; }
            catch (error) { return false; }
        }).sort();
        if (!names.length) { info('Keine geeigneten Cache-Ordner gefunden.'); return; }
        var selected = choose(names, 'Nur Benutzer-Caches. Zugehoerige Apps vorher schliessen. ' +
            'Mehrfachauswahl mit Cmd. Es ist nichts vorausgewaehlt.', true);
        if (!selected) return;
        if (!confirm('Diese Ordner werden in den Papierkorb verschoben:\n\n' + selected.join('\n') +
                '\n\nBasis: ' + cacheRoot + '\n\nApps bauen ihren Cache beim naechsten Start neu auf. ' +
                'Cookies, Schluesselbund, Spielprogramme, Spielstaende und Serverdaten werden nicht bearbeitet. ' +
                'Ein Cache kann trotzdem Sitzungsdaten enthalten; erneutes Anmelden kann erforderlich sein. ' +
                'Im Papierkorb bleiben die Daten erhalten, bis du ihn selbst leerst.', 'In Papierkorb')) return;
        var results = core.trashCaches(cacheRoot, selected, {
            validateDirectory: validateCacheDirectory, assertAppsClosed: assertAppsClosed,
            trash: function (path) {
                var resultingURL = Ref();
                var error = Ref();
                if (!fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath($(path)), resultingURL, error)) {
                    throw new Error(error[0] ? String(ObjC.unwrap(error[0].localizedDescription)) : 'Verschieben fehlgeschlagen.');
                }
                return resultingURL[0] ? String(ObjC.unwrap(resultingURL[0].path)) : 'Papierkorb';
            }
        });
        info(results.map(function (item) {
            return (item.ok ? 'Verschoben: ' : 'FEHLER: ') + item.name + (item.ok ? '' : '\n' + item.error);
        }).join('\n\n') + '\n\nEs wurde nichts endgueltig geloescht.');
    }
    function status() {
        var version = shell('/usr/bin/sw_vers -productVersion');
        var arch = shell('/usr/bin/uname -m');
        var lines = adapters().map(function (item) { return item.port + ' (' + item.device + '): ' + item.address; });
        var state = loadState();
        var saved = Object.keys(state.adapters).map(function (key) {
            var item = state.adapters[key];
            return key + ': ' + item.original + (item.pending ? ' | offener Versuch: ' + item.pending : '');
        });
        info('macOS ' + version + ' | ' + arch + '\n\nAktuell gelesene MAC-Adressen:\n' +
            (lines.join('\n') || 'Keine lesbar') + '\n\nGesicherte Ausgangsadressen:\n' +
            (saved.join('\n') || 'Noch keine') + '\n\nDiese MAC-/Cache-App veraendert keine Hardwarekennungen. Den Status einer separaten Identity Session zeigt sie nicht an. Internet-IP: wird nicht abgefragt oder veraendert. ' +
            'Private WLAN-Adresse: bitte in den Systemeinstellungen pruefen.');
    }
    var actions = [
        'Status und Netzwerkadressen',
        'Private WLAN-Adresse in Sequoia einrichten',
        'Manuellen MAC-Wechsel versuchen',
        'Gesicherte MAC-Adresse wiederherstellen',
        'Ausgewaehlte Cache-Ordner in den Papierkorb',
        'Wirkung und Grenzen',
        'Beenden'
    ];
    while (true) {
        try {
            var selected = choose(actions, 'Lokale MAC- und Cache-Verwaltung fuer macOS. ' +
                'Keine vollstaendige HWID- oder Konto-Anonymisierung.', false);
            if (!selected || selected[0] === actions[6]) break;
            switch (actions.indexOf(selected[0])) {
            case 0: status(); break;
            case 1: privateWifi(); break;
            case 2: changeAddress(false); break;
            case 3: changeAddress(true); break;
            case 4: cleanCaches(); break;
            case 5:
                info('MAC: Die Netzwerkadresse eines ausgewaehlten Anschlusses. Der Wechsel haengt vom Treiber ab. ' +
                    'Er ersetzt keine Seriennummer oder Geraete-UUID.\n\n' +
                    'HWID: Diese MAC-/Cache-App veraendert keine Hardwarekennungen. ' +
                    'Das separate Build-Identity.command erstellt die Identity-Session-App zum Abfangen einzelner UUID-/Seriennummer-Abfragen. Siehe IDENTITY.md.\n\n' +
                    'IP/Konto: Eine andere MAC aendert nicht deine oeffentliche IP oder Riot-Anmeldung. ' +
                    'Auch ein VPN wuerde diese Konto-Zuordnung nicht beseitigen.\n\n' +
                    'Caches: Nur ausdruecklich ausgewaehlte Ordner unter ~/Library/Caches. ' +
                    'Verschieben in den Papierkorb loescht keine Daten auf Riot-Servern.\n\n' +
                    'Die App hat keine Telemetrie und laedt keinen Code nach. ' +
                    'MAC-Sicherungen werden nur lokal gespeichert.');
                break;
            }
        } catch (error) {
            if (!isCancelled(error)) info('Aktion nicht abgeschlossen.\n\n' +
                (error.message || String(error)) + '\n\nBei abgelehntem MAC-Wechsel: die private WLAN-Adresse in Sequoia verwenden.');
        }
    }
}
