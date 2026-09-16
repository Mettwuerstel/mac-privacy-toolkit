# Identity Session: genaue Wirkung

Die App startet eine ausgewaehlte ausfuehrbare Datei ueber `NSTask` mit
`DYLD_INSERT_LIBRARIES`. Die beigefuegte Bibliothek registriert dyld-Interpositionen
fuer diese Funktionen:

| Funktion | Ersetzte Antwort |
| --- | --- |
| `IORegistryEntryCreateCFProperty` | Bestehende String-Werte fuer `IOPlatformUUID` und `IOPlatformSerialNumber`. |
| `IORegistryEntrySearchCFProperty` | Dieselben beiden Eigenschaften. |
| `IORegistryEntryCreateCFProperties` | Dieselben beiden vorhandenen String-Werte im Ergebnis-Dictionary. |
| `gethostuuid` | UUID-Bytes nach einem erfolgreichen Originalaufruf. |

Fehler, nicht vorhandene Eigenschaften und andere Eigenschaftswerte bleiben
erhalten. UUID und Seriennummer werden zufaellig erzeugt; die Seriennummer ist
synthetisch und kein nachgewiesener Apple-Produktdatensatz.

Es gibt keine dauerhafte Aenderung an Hardware, Firmware, I/O Registry oder
installierten Zielprogrammen. Die Bibliothek aendert ausgewaehlte Rueckgaben in
Prozessen, in denen sie tatsaechlich geladen wird. Das ist keine systemweite HWID.

## Sitzung und Wertewechsel

Ein privater temporaerer Ordner (`700`) enthaelt eine gemeinsam abgebildete
Statusdatei und ein Ereignisprotokoll (je `600`). Das Steuerprogramm schreibt
alle 0,5 Sekunden einen Heartbeat; die Bibliothek liest den Status. Die
Sitzungsdatei enthaelt nur neu erzeugte Kennungen, keine Originalkennungen.

**Neue Kennungen** veroeffentlicht ein konsistentes neues UUID-/Seriennummer-Paar.
Eine einzelne abgefangene Abfrage sieht einen konsistenten Stand. Zwei getrennte
Abfragen vor und nach einem Wechsel koennen naturgemaess unterschiedliche
Generationen sehen. Eine Rotation zwingt das Ziel nicht, zuvor gespeicherte
Kennungen zu vergessen oder eine Abfrage zu wiederholen.

Bei **Sitzung beenden** oder normalem Beenden der App werden neue Abfragen wieder
durchgereicht. Nach einem Ausfall der Steuerung gilt der Heartbeat hoechstens
drei Sekunden weiter. Bereits begonnene Abfragen und vom Ziel gespeicherte
Werte werden nicht rueckwirkend geaendert. Bei ungueltigem, abgelaufenem oder
nicht konsistent lesbarem Zustand werden Originalantworten geliefert.
Es gibt keinen Mechanismus, der dann das Spiel oder dessen Netzwerkverkehr stoppt.

Die Bibliothek bleibt bis zum Ende des Zielprozesses geladen. Sitzung beenden
beendet das Ziel nicht und entfernt keine Werte aus dessen Speicher. Vor einer
neuen Sitzung Ziel und Launcher vollstaendig schliessen.

## Aussagekraft des Prueflogs

`LOADED` bedeutet, dass die Bibliothek mit gueltiger Sitzungsdatei geladen wurde.
`REPLACED` bedeutet, dass eine konkrete API-Antwort ersetzt wurde. Das Protokoll
enthaelt PID, Aufrufart und Eigenschaftsname, keine Originalkennungen. Ereignisse
werden pro API/Eigenschaft und Prozess einmal protokolliert. Fruehere Zeilen
sind kein Nachweis, dass nach einer Rotation schon neue Werte abgefragt wurden.

Ein Launcher kann die Bibliothek laden, waehrend ein Spielprozess sie nicht
laedt. PID und gestartete Prozesse beachten; die Oberflaeche behauptet deshalb
keinen pauschalen Status wie "LoL geschuetzt". Bereits laufende Prozesse werden
nicht nachtraeglich erfasst. Kindprozesse koennen die Umgebungsvariablen erben,
muessen dies aber nicht. Der Prozessstart verwendet keine zusaetzlichen
Kommandozeilenargumente und ist nicht fuer jedes Launcher-Protokoll geeignet.

## Abdeckung und Plattformgrenzen

Nicht abgedeckt sind beispielsweise Datentraegerkennungen, Board-Eigenschaften,
Netzwerk-API-Antworten, Schluesselbund- oder Installationskennungen, eigene
niedrigere Abfragewege und bereits zwischengespeicherte Werte. Andere Apps
koennen weiterhin echte Kennungen auslesen. Die MAC-/Cache-App im Paket ist
separat und wird durch den Sitzungsstart nicht automatisch ausgefuehrt.

Hardened Runtime, Library Validation, geschuetzte Prozesse oder ein Launcher,
der Umgebungsvariablen entfernt, koennen die Einbindung verhindern. Die App
veraendert solche Schutzmechanismen nicht. Sie bietet keine Verschleierung
der eigenen Bibliothek und keinen Nachweis fuer Unauffaelligkeit gegenueber
einem Pruef- oder Anti-Cheat-System.

## Integrationstest auf dem Mac

`Build-Identity.command` baut zuerst alle Komponenten. Dann startet
`identity-probe --self-test <Bibliothek>` einen eigenen Prozess mit derselben
Einbindungsmethode. Der Test prueft:

1. Bibliothek tatsaechlich geladen und originale Ausgangsantworten verfuegbar.
2. Beide Kennungen ueber die drei IOKit-APIs und UUID ueber `gethostuuid` ersetzt.
3. Zweites Profil waehrend desselben Prozesses sichtbar.
4. Originalantworten nach Stop und nach abgelaufenem Heartbeat wiederhergestellt.
5. Die beispielhaft gepruefte Eigenschaft `model`, eine fehlende Eigenschaft und
   die Anzahl der Dictionary-Eintraege bleiben erhalten.

Die echten Kennungen verbleiben dabei nur im Speicher des Testprozesses. Ein
Fehler stoppt den Build-Starter vor dem Oeffnen der Oberflaeche. Ein erfolgreicher
Test bestaetigt die Technik in diesem Testprozess auf diesem Mac; die Wirkung
in LoL muss separat nachgewiesen werden und ist hier nicht getestet.
