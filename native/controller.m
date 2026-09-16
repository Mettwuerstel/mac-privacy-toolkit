#import <AppKit/AppKit.h>
#import <dispatch/dispatch.h>
#include "storage.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>

@interface MPTController : NSObject <NSApplicationDelegate, NSWindowDelegate> {
    NSWindow *_window;
    NSTextField *_targetLabel, *_profileLabel, *_statusLabel;
    NSTextView *_eventsView;
    NSButton *_startButton, *_rotateButton, *_stopButton, *_chooseButton;
    NSURL *_target;
    NSTask *_task;
    NSTimer *_refreshTimer;
    dispatch_source_t _heartbeat;
    dispatch_semaphore_t _heartbeatDone;
    mpt_storage _storage;
    mpt_profile _profile;
    NSDate *_started;
    NSString *_lastEvents;
}
@end

@implementation MPTController
- (NSTextField *)label:(NSString *)text frame:(NSRect)frame {
    NSTextField *label = [NSTextField wrappingLabelWithString:text];
    label.frame = frame;
    [_window.contentView addSubview:label];
    return label;
}
- (NSButton *)button:(NSString *)title action:(SEL)action x:(CGFloat)x width:(CGFloat)width {
    NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
    button.frame = NSMakeRect(x, 352, width, 34);
    [_window.contentView addSubview:button];
    return button;
}
- (void)showError:(NSString *)message {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Sitzung konnte nicht gestartet werden";
    alert.informativeText = message;
    [alert runModal];
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    _window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 880, 620)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
        backing:NSBackingStoreBuffered defer:NO];
    _window.title = @"Identity Session - Intel Mac";
    _window.releasedWhenClosed = NO;
    _window.delegate = self;
    [_window center];
    NSTextField *heading = [self label:@"Temporäre Gerätekennungen" frame:NSMakeRect(24, 557, 832, 38)];
    heading.font = [NSFont boldSystemFontOfSize:25];
    [self label:@"Ersetzt UUID und Seriennummer über ausgewählte Schnittstellen in neu gestarteten Prozessen. Die Wirkung im gewählten Programm muss das Prüflog belegen."
          frame:NSMakeRect(24, 497, 832, 52)];
    _targetLabel = [self label:@"Ziel: noch nicht ausgewählt" frame:NSMakeRect(24, 446, 832, 42)];
    _profileLabel = [self label:@"Noch keine Sitzung." frame:NSMakeRect(24, 394, 832, 48)];
    _profileLabel.font = [NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightRegular];
    _chooseButton = [self button:@"Programm auswählen…" action:@selector(chooseTarget:) x:24 width:194];
    _startButton = [self button:@"Neue Sitzung starten" action:@selector(startSession:) x:224 width:208];
    _rotateButton = [self button:@"Neue Kennungen" action:@selector(rotate:) x:438 width:194];
    _stopButton = [self button:@"Sitzung beenden" action:@selector(stop:) x:638 width:218];
    _startButton.enabled = NO; _rotateButton.enabled = NO; _stopButton.enabled = NO;
    _statusLabel = [self label:@"Beende das Zielprogramm samt Launcher zuerst vollständig. Bereits laufende Prozesse werden nicht erfasst."
                         frame:NSMakeRect(24, 272, 832, 68)];
    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(24, 105, 832, 155)];
    scroll.hasVerticalScroller = YES;
    scroll.borderType = NSBezelBorder;
    _eventsView = [[NSTextView alloc] initWithFrame:scroll.bounds];
    _eventsView.editable = NO;
    _eventsView.font = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
    _eventsView.autoresizingMask = NSViewWidthSizable;
    scroll.documentView = _eventsView;
    [_window.contentView addSubview:scroll];
    [self label:@"Keine vollständige Anonymisierung. Andere Abfragewege und schon gespeicherte Kennungen bleiben möglich. Nach Beenden oder Ausfall der Steuerung liefern neue Abfragen wieder Originalwerte."
          frame:NSMakeRect(24, 29, 832, 64)];
    NSMenu *mainMenu = [[NSMenu alloc] init];
    NSMenuItem *item = [[NSMenuItem alloc] init];
    [mainMenu addItem:item];
    NSMenu *appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:@"Identity Session beenden" action:@selector(terminate:) keyEquivalent:@"q"];
    item.submenu = appMenu; NSApp.mainMenu = mainMenu;
    [_window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    _refreshTimer = [NSTimer timerWithTimeInterval:0.5 target:self selector:@selector(refresh:) userInfo:nil repeats:YES];
    [[NSRunLoop mainRunLoop] addTimer:_refreshTimer forMode:NSRunLoopCommonModes];
}
- (void)chooseTarget:(id)sender {
    (void)sender;
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title = @"App oder ausführbare Datei auswählen";
    panel.canChooseFiles = YES; panel.canChooseDirectories = NO;
    panel.allowsMultipleSelection = NO;
    panel.directoryURL = [NSURL fileURLWithPath:@"/Applications" isDirectory:YES];
    if ([panel runModal] != NSModalResponseOK) return;
    NSURL *selected = panel.URL;
    if ([selected.pathExtension.lowercaseString isEqualToString:@"app"]) {
        NSBundle *bundle = [NSBundle bundleWithURL:selected];
        _target = bundle.executableURL;
    } else _target = selected;
    if (!_target || ![[NSFileManager defaultManager] isExecutableFileAtPath:_target.path]) {
        _target = nil; _startButton.enabled = NO;
        _targetLabel.stringValue = @"Ziel: keine gültige ausführbare Datei";
        [self showError:@"In dieser Auswahl wurde keine ausführbare Datei gefunden."];
        return;
    }
    _targetLabel.stringValue = [@"Ziel: " stringByAppendingString:_target.path];
    _startButton.enabled = YES;
}
- (BOOL)newProfile {
    NSString *uuid = NSUUID.UUID.UUIDString;
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    char serial[MPT_SERIAL_LENGTH + 1];
    for (unsigned int i = 0; i < MPT_SERIAL_LENGTH; ++i) serial[i] = alphabet[arc4random_uniform(36)];
    serial[MPT_SERIAL_LENGTH] = 0;
    if (!mpt_parse_profile(&_profile, uuid.UTF8String, serial) ||
        !mpt_rotate(_storage.state, &_profile, mpt_now())) return NO;
    _profileLabel.stringValue = [NSString stringWithFormat:@"UUID: %s\nSynthetische Seriennummer: %s", _profile.uuid, _profile.serial];
    return YES;
}
- (void)startSession:(id)sender {
    (void)sender;
    if (_storage.state || !_target) return;
    NSURL *library = [NSBundle.mainBundle URLForResource:@"libmpt_identity" withExtension:@"dylib"];
    if (!library || [library.path containsString:@":"]) {
        [self showError:@"Bibliothek fehlt oder der App-Pfad enthält einen Doppelpunkt. Verschiebe die App in einen Pfad ohne Doppelpunkt."];
        return;
    }
    if (!mpt_storage_create(&_storage)) {
        [self showError:[NSString stringWithFormat:@"Sitzungsdateien: %s", strerror(errno)]];
        return;
    }
    if (![self newProfile]) { [self stop:nil]; [self showError:@"Kennungen konnten nicht erzeugt werden."]; return; }
    mpt_shared *state = _storage.state;
    _heartbeatDone = dispatch_semaphore_create(0);
    dispatch_semaphore_t completion = _heartbeatDone;
    _heartbeat = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
        dispatch_queue_create("local.mpt.heartbeat", DISPATCH_QUEUE_SERIAL));
    dispatch_source_set_timer(_heartbeat, DISPATCH_TIME_NOW, NSEC_PER_SEC / 2, NSEC_PER_MSEC * 25);
    dispatch_source_set_event_handler(_heartbeat, ^{ mpt_heartbeat(state, mpt_now()); });
    dispatch_source_set_cancel_handler(_heartbeat, ^{ dispatch_semaphore_signal(completion); });
    dispatch_resume(_heartbeat);
    NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
    /* Keep injection local to this NSTask; no global launchctl or shell state. */
    environment[@"DYLD_INSERT_LIBRARIES"] = library.path;
    environment[@"MPT_SESSION_STATE"] = [NSString stringWithUTF8String:_storage.state_path];
    environment[@"MPT_SESSION_EVENTS"] = [NSString stringWithUTF8String:_storage.events_path];
    _task = [[NSTask alloc] init];
    _task.executableURL = _target;
    _task.currentDirectoryURL = [_target URLByDeletingLastPathComponent];
    _task.environment = environment;
    _task.arguments = @[];
    _task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
    _task.standardError = NSFileHandle.fileHandleWithNullDevice;
    NSError *error = nil;
    if (![_task launchAndReturnError:&error]) {
        [self stop:nil]; [self showError:error.localizedDescription]; return;
    }
    _started = [NSDate date]; _lastEvents = nil;
    _eventsView.string = @"Warte auf Nachweis aus dem gestarteten Prozess…";
    _chooseButton.enabled = NO; _startButton.enabled = NO;
    _rotateButton.enabled = YES; _stopButton.enabled = YES;
    [self refresh:nil];
}
- (void)rotate:(id)sender {
    (void)sender;
    if (_storage.state && ![self newProfile]) [self showError:@"Kennungen konnten nicht gewechselt werden."];
    /* Earlier events prove interception, not use of this new profile. */
    [self refresh:nil];
}
- (void)refresh:(id)sender {
    (void)sender;
    if (!_storage.state) return;
    NSFileHandle *file = [NSFileHandle fileHandleForReadingAtPath:[NSString stringWithUTF8String:_storage.events_path]];
    NSData *data = [file readDataOfLength:131072];
    [file closeFile];
    NSString *events = [[NSString alloc] initWithData:data ?: [NSData data] encoding:NSUTF8StringEncoding] ?: @"";
    if (![_lastEvents isEqualToString:events]) { _eventsView.string = events; _lastEvents = events; }
    NSString *status;
    if ([events containsString:@"REPLACED "]) status = @"Ersetzte Abfragen wurden protokolliert (PID siehe Log). Das belegt einzelne Aufrufe, nicht alle Kennungen oder die Übernahme neu rotierter Werte.";
    else if ([events containsString:@"LOADED "]) status = @"Bibliothek geladen. Noch keine ersetzte Abfrage nachgewiesen; keine bestätigte Wirkung im Zielprogramm.";
    else if ([_started timeIntervalSinceNow] < -5) status = @"Kein Laden der Bibliothek nachgewiesen. Das Ziel kann die Einbindung blockieren oder einen anderen Prozess verwenden. Wirkung unbestätigt.";
    else status = @"Programm gestartet; warte auf Nachweis des Ladens und der ersetzten Abfragen.";
    if (!_task.running) status = [status stringByAppendingFormat:@" Startprozess beendet (Status %d). Kindprozesse werden dadurch nicht automatisch beendet.", _task.terminationStatus];
    _statusLabel.stringValue = status;
}
- (void)stop:(id)sender {
    (void)sender;
    if (_storage.state) mpt_stop(_storage.state);
    if (_heartbeat) {
        dispatch_source_cancel(_heartbeat);
        dispatch_semaphore_wait(_heartbeatDone, DISPATCH_TIME_FOREVER);
        _heartbeat = nil; _heartbeatDone = nil;
    }
    mpt_storage_close(&_storage);
    _task = nil;
    _chooseButton.enabled = YES; _startButton.enabled = (_target != nil);
    _rotateButton.enabled = NO; _stopButton.enabled = NO;
    _profileLabel.stringValue = @"Sitzung beendet. Neue Abfragen erhalten wieder Originalwerte.";
    _statusLabel.stringValue = @"Das Zielprogramm läuft gegebenenfalls weiter. Bereits gelesene Kennungen bleiben in dessen Speicher. Vor einer neuen Sitzung das Ziel samt Launcher vollständig beenden.";
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { (void)sender; return YES; }
- (void)applicationWillTerminate:(NSNotification *)notification { (void)notification; [self stop:nil]; [_refreshTimer invalidate]; }
@end

int main(void) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        __attribute__((objc_precise_lifetime)) MPTController *controller = [[MPTController alloc] init];
        app.delegate = controller;
        [app run];
    }
    return 0;
}
