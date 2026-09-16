#import <Foundation/Foundation.h>
#include "storage.h"
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <uuid/uuid.h>

/* Actual macOS integration test. Real identifiers stay in memory and are never
 * printed or written to disk. The subprocess runs with a disabled initial state. */
typedef struct {
    CFTypeRef direct[4];
    CFTypeRef search[4];
    CFMutableDictionaryRef dictionary;
    kern_return_t dictionary_status;
    uuid_t host_uuid;
    int host_status;
} snapshot;

static CFStringRef key_at(int index) {
    switch (index) {
        case 0: return CFSTR("IOPlatformUUID");
        case 1: return CFSTR("IOPlatformSerialNumber");
        case 2: return CFSTR("model");
        default: return CFSTR("MPT.Test.Property.Does.Not.Exist");
    }
}
static snapshot take_snapshot(io_registry_entry_t entry) {
    snapshot value = {0};
    for (int i = 0; i < 4; ++i) {
        value.direct[i] = IORegistryEntryCreateCFProperty(entry, key_at(i), kCFAllocatorDefault, 0);
        value.search[i] = IORegistryEntrySearchCFProperty(entry, kIOServicePlane, key_at(i), kCFAllocatorDefault, 0);
    }
    value.dictionary_status = IORegistryEntryCreateCFProperties(entry, &value.dictionary, kCFAllocatorDefault, 0);
    struct timespec wait = {1, 0};
    value.host_status = gethostuuid(value.host_uuid, &wait);
    return value;
}
static void release_snapshot(snapshot *value) {
    for (int i = 0; i < 4; ++i) {
        if (value->direct[i]) CFRelease(value->direct[i]);
        if (value->search[i]) CFRelease(value->search[i]);
    }
    if (value->dictionary) CFRelease(value->dictionary);
}
static int equal_nullable(CFTypeRef left, CFTypeRef right) {
    return (!left && !right) || (left && right && CFEqual(left, right));
}
static int matches_string(CFTypeRef value, const char *expected) {
    if (!value || CFGetTypeID(value) != CFStringGetTypeID()) return 0;
    char text[128];
    return CFStringGetCString(value, text, sizeof text, kCFStringEncodingASCII) && !strcmp(text, expected);
}
static int verify(io_registry_entry_t entry, const snapshot *baseline, const mpt_profile *expected, const char *phase) {
    snapshot got = take_snapshot(entry);
    int ok = got.dictionary_status == baseline->dictionary_status && got.dictionary && baseline->dictionary;
    for (int i = 0; i < 4; ++i) {
        if (expected && i < 2) {
            const char *text = i ? expected->serial : expected->uuid;
            ok &= matches_string(got.direct[i], text) && matches_string(got.search[i], text);
            ok &= got.dictionary && matches_string(CFDictionaryGetValue(got.dictionary, key_at(i)), text);
        } else {
            ok &= equal_nullable(got.direct[i], baseline->direct[i]);
            ok &= equal_nullable(got.search[i], baseline->search[i]);
            if (got.dictionary && baseline->dictionary)
                ok &= equal_nullable(CFDictionaryGetValue(got.dictionary, key_at(i)), CFDictionaryGetValue(baseline->dictionary, key_at(i)));
        }
    }
    ok &= got.host_status == baseline->host_status;
    unsigned char expected_uuid[16];
    if (expected) {
        ok &= mpt_uuid_bytes(expected->uuid, expected_uuid);
        ok &= !memcmp(got.host_uuid, expected_uuid, sizeof expected_uuid);
    } else ok &= !memcmp(got.host_uuid, baseline->host_uuid, sizeof expected_uuid);
    if (got.dictionary && baseline->dictionary)
        ok &= CFDictionaryGetCount(got.dictionary) == CFDictionaryGetCount(baseline->dictionary);
    release_snapshot(&got);
    printf("%s: %s (four APIs; original identifiers not printed)\n", ok ? "PASS" : "FAIL", phase);
    return ok;
}
static int child_test(void) {
    if (!dlsym(RTLD_DEFAULT, "MPTIdentityModulePresent")) {
        fputs("FAIL: dyld did not load the identity module.\n", stderr); return 1;
    }
    const char *path = getenv("MPT_SESSION_STATE");
    if (!path) return 1;
    int fd = open(path, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    struct stat st;
    if (fd < 0) return 1;
    if (fstat(fd, &st) || st.st_size != sizeof(mpt_shared) || st.st_uid != getuid() || !S_ISREG(st.st_mode)) { close(fd); return 1; }
    mpt_shared *state = mmap(NULL, sizeof *state, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (state == MAP_FAILED) return 1;
    io_registry_entry_t entry = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"));
    if (!entry) { munmap(state, sizeof *state); fputs("FAIL: no IOPlatformExpertDevice.\n", stderr); return 1; }
    snapshot baseline = take_snapshot(entry);
    int ready = baseline.host_status == 0 && baseline.dictionary_status == KERN_SUCCESS && baseline.dictionary;
    for (int i = 0; i < 2; ++i) {
        ready &= baseline.direct[i] && CFGetTypeID(baseline.direct[i]) == CFStringGetTypeID();
        ready &= baseline.search[i] && CFGetTypeID(baseline.search[i]) == CFStringGetTypeID();
        ready &= baseline.dictionary && CFDictionaryContainsKey(baseline.dictionary, key_at(i));
    }
    int ok = ready;
    if (ready) {
        mpt_profile first, second;
        ok &= mpt_parse_profile(&first, "12345678-ABCD-4DEF-8ABC-0123456789AB", "MP1234567890");
        ok &= mpt_parse_profile(&second, "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "MPABCDEFGHIJ");
        ok &= mpt_rotate(state, &first, mpt_now());
        ok &= verify(entry, &baseline, &first, "initial profile");
        ok &= mpt_rotate(state, &second, mpt_now());
        ok &= verify(entry, &baseline, &second, "rotation while process is running");
        mpt_stop(state);
        ok &= verify(entry, &baseline, NULL, "stop restores original responses");
        ok &= mpt_rotate(state, &first, mpt_now());
        /* Expire explicitly: deterministic, no multi-second test sleep. */
        mpt_heartbeat(state, 1);
        ok &= verify(entry, &baseline, NULL, "stale controller restores original responses");
    } else fputs("FAIL: this Mac does not expose the required baseline properties.\n", stderr);
    mpt_stop(state);
    release_snapshot(&baseline);
    IOObjectRelease(entry);
    munmap(state, sizeof *state);
    return ok ? 0 : 1;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc == 2 && !strcmp(argv[1], "--verify")) return child_test();
        if (argc != 3 || strcmp(argv[1], "--self-test")) {
            fputs("Usage: identity-probe --self-test /absolute/path/libmpt_identity.dylib\n", stderr); return 2;
        }
        NSString *library = [NSString stringWithUTF8String:argv[2]];
        if (![library isAbsolutePath] || [library containsString:@":"] || ![[NSFileManager defaultManager] fileExistsAtPath:library]) return 2;
        mpt_storage storage;
        if (!mpt_storage_create(&storage)) { perror("session files"); return 1; }
        NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
        environment[@"DYLD_INSERT_LIBRARIES"] = library;
        environment[@"MPT_SESSION_STATE"] = [NSString stringWithUTF8String:storage.state_path];
        environment[@"MPT_SESSION_EVENTS"] = [NSString stringWithUTF8String:storage.events_path];
        NSTask *task = [[NSTask alloc] init];
        NSString *executable = [NSString stringWithUTF8String:argv[0]];
        if (![executable isAbsolutePath]) executable = [[[NSFileManager defaultManager] currentDirectoryPath] stringByAppendingPathComponent:executable];
        task.executableURL = [NSURL fileURLWithPath:executable];
        task.arguments = @[@"--verify"];
        task.environment = environment;
        NSError *error = nil;
        int result = 1;
        if ([task launchAndReturnError:&error]) {
            [task waitUntilExit];
            result = task.terminationStatus == 0 ? 0 : 1;
        } else fprintf(stderr, "FAIL: %s\n", error.localizedDescription.UTF8String);
        mpt_storage_close(&storage);
        if (!result) puts("PASS: macOS probe only. This does NOT prove compatibility with another application.");
        return result;
    }
}
