# Mac Privacy Toolkit 0.2

Quellcode-Paket fuer den genannten **Intel MacBookPro15,3 mit macOS Sequoia
15.7.5**. Zwei lokale Programme sind enthalten:

| Startdatei | Funktion |
| --- | --- |
| `Build-Identity.command` | Baut die neue **Identity Session**: UUID-/Seriennummer-Antworten in neu gestarteten Prozessen ersetzen, Kennungen wechseln, Sitzung beenden. Benoetigt Apples Command Line Tools. |
| `Start.command` | Baut die MAC-/Cache-Verwaltung mit macOS-Bordmitteln. Benoetigt keine Command Line Tools. |

**Die neue Identity Session ist eine experimentelle Implementierung.** Sie
ersetzt bestimmte API-Antworten; sie veraendert nicht saemtliche Kennungen des
Mac. Das Paket wurde unter Windows entwickelt. Portable Logik und Dateizugriff
wurden unter Linux getestet. macOS-Kompilierung, Oberflaeche, Interposition und
LoL-Kompatibilitaet wurden hier nicht ausgefuehrt.

## Identity Session starten

1. ZIP auf dem Mac entpacken; den gesamten Ordner zusammenlassen.
2. Falls noch nicht installiert, im Terminal `xcode-select --install` ausfuehren
   und Apples Command Line Tools installieren.
3. `Build-Identity.command` oeffnen. Der Starter kompiliert lokal, prueft die
   Sitzungslogik und fuehrt einen echten macOS-Integrationstest im eigenen
   Testprozess durch. Erst nach dessen Erfolg wird die App geoeffnet.
4. Riot-/League-Prozesse und Launcher vollstaendig beenden. In der App
   **Programm auswaehlen** und die gewuenschte App bzw. deren ausfuehrbare Datei
   auswaehlen. **Neue Sitzung starten** erzeugt Kennungen und startet das Ziel.
5. Das Prueflog beachten: `LOADED` belegt nur das Laden. Erst `REPLACED` belegt
   eine tatsaechlich ersetzte Abfrage in der angegebenen PID. Auch das beweist
   keine vollstaendige Abdeckung eines Spiels.
6. **Neue Kennungen** wechselt die bereitgestellten Werte waehrend der Sitzung.
   Bereits vom Ziel gespeicherte Werte bleiben bestehen. **Sitzung beenden**
   schaltet fuer neue Abfragen auf Originalantworten zurueck.

Die erstellte `Identity Session.app` unter `build/identity-...` kannst du
anschliessend direkt oeffnen oder nach `Programme` kopieren. Sie enthaelt ihre
Bibliothek. Zum erneuten Bauen wird weiterhin der komplette Quellordner gebraucht.

Bei blockierter Einbindung gibt es **keine bestaetigte Wirkung**. Das Programm
umgeht keine macOS-Ladebeschraenkungen. Der Testprozess ist bewusst fuer diese
Technik gebaut; ein erfolgreicher Test ist kein Nachweis fuer LoL.

Details zu APIs, Sitzungsende und Grenzen: **[IDENTITY.md](IDENTITY.md)**.

Falls `.command` nicht direkt startet: Terminal oeffnen, `/bin/zsh ` eingeben,
die jeweilige Datei hineinziehen und Return druecken. Die selbst erstellten Apps
sind nicht mit einem Apple-Developer-Zertifikat signiert oder notarisiert.

## MAC-/Cache-Verwaltung

`Start.command` erstellt mit Apples `osacompile` eine separate App unter
`build`. Das Erstellen und Oeffnen aendert noch keine Einstellungen.

| Funktion | Wirkung |
| --- | --- |
| Status | Liest macOS-Version und aktive MAC-Adressen physischer Anschluesse. |
| Private WLAN-Adresse | Oeffnet Systemeinstellungen und erklaert die Sequoia-Option. Keine automatische Aktivierung oder Schutzbestaetigung. |
| Manueller MAC-Wechsel | Erzeugt eine lokal administrierte Unicast-MAC, sichert die Ausgangsadresse und versucht `ifconfig <Anschluss> ether <Adresse>` mit macOS-Administratorabfrage. Liest das Ergebnis zurueck. |
| Wiederherstellung | Setzt die vor dem ersten manuellen Wechsel gespeicherte Adresse zurueck; nicht zwingend die werksseitige Adresse. |
| Caches | Verschiebt ausgewaehlte vorhandene Ordner direkt unter `~/Library/Caches` in den Papierkorb. Apple-Systemcaches und Verknuepfungen werden ausgeschlossen. |

Manuelle MAC-Wechsel sind vom Netzwerktreiber abhaengig. Ein ignorierter oder
abgelehnter Wechsel wird gemeldet. Bei teilweiser Aenderung versucht die App,
den unmittelbar vorherigen Wert wiederherzustellen, und prueft das Ergebnis.
Ein Wechsel kann die Verbindung unterbrechen. Sequoia kann einen manuell
gesetzten Wert spaeter wieder ersetzen. Die separate Identity Session aendert
die MAC-Adresse nicht.

Fuer WLAN bietet Sequoia **Systemeinstellungen > WLAN > Details > Private
WLAN-Adresse > Rotierend**. Apple beschreibt eine Rotation etwa alle zwei
Wochen, nicht mit jedem Klick.

Caches werden erst nach Auswahl verschoben. Zugehoerige Anwendungen vorher
beenden; erkannte laufende Programme und Riot-/League-Prozesse blockieren die
entsprechende Bereinigung. Die Erkennung erfasst nicht jeden Hintergrundprozess.
Es werden keine Spielinstallationen, Schluesselbund-Eintraege oder
Browser-Cookie-Datenbanken bereinigt. Im Papierkorb bleiben die Daten vorhanden
und koennen wiederhergestellt werden.

## Lokale Daten

Keine Telemetrie, Downloads, Online-Pruefung oder Uploads. Beide Programme
arbeiten mit lokalen macOS-Schnittstellen.

MAC-Ausgangswerte bleiben fuer die Wiederherstellung unter
`~/Library/Application Support/Mac Privacy Toolkit/mac-backups.json`
gespeichert: Ordner `700`, Datei `600`. Die Datei enthaelt urspruengliche MAC,
Anschluss, Zeitpunkt und Aenderungsstatus.

Identity Session verwendet einen privaten temporaeren Sitzungsordner mit
synthetischen Kennungen und einem Ereignisprotokoll. Er wird beim normalen
Sitzungsende entfernt. Nach einem Absturz kann er als `mpt-session-*` im
Benutzer-Tempverzeichnis liegen bleiben; neue API-Abfragen fallen nach Ablauf
des Heartbeats wieder auf Originalwerte zurueck.

## Quellcode und Pruefung

- `native/session.c`: validierte Kennungen, atomare Rotation und Heartbeat.
- `native/storage.c`: private Sitzungsdateien und gemeinsam genutzter Speicher.
- `native/identity.c`: vier macOS-API-Interpositionen.
- `native/controller.m`: AppKit-Oberflaeche und gezielter Prozessstart.
- `native/probe.m`: macOS-Integrationstest fuer aktive, rotierte und deaktivierte Werte.
- `src/`: JavaScript-for-Automation-Code der MAC-/Cache-App.
- `tests/`: portable C-Tests und JavaScript-Tests.
- `tools/package.py`: erstellt das ZIP mit Unix-Ausfuehrungsrechten fuer die Starter.

JavaScript-Tests: `node --test tests/core.test.js`. Die nativen Tests werden von
`Build-Identity.command` kompiliert und ausgefuehrt. Sie geben echte UUIDs und
Seriennummern nicht aus. Es werden nur selbst erzeugte Binaerdateien gestartet;
keine Binaerdateien oder eingebetteten Codekopien aus dem Sidewinder-Installer.

## Quellen

- [Apple: Private WLAN-Adressen](https://support.apple.com/de-de/102509)
- [Apple: dyld-Interposition](https://github.com/apple-oss-distributions/dyld/blob/main/include/mach-o/dyld-interposing.h)
- [Apple: Library Validation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation)
- [Apple: DYLD-Umgebungsvariablen unter Hardened Runtime](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-dyld-environment-variables)

Eigenstaendiger Code; keine Verbindung zu Apple, Riot Games oder Sidewinder.
