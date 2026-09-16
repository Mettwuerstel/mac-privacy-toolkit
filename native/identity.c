/* Process-scoped interposition. No system writes, kernel hooks or hiding. */
#include "session.h"
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <uuid/uuid.h>
#include <string.h>

static const mpt_shared *shared_state;
static pthread_once_t once = PTHREAD_ONCE_INIT;
static _Atomic unsigned int seen;
static int events_fd = -1;

static uint64_t now_ns(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts)) return 0;
    return (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
}

static void event(unsigned int bit, const char *name) {
    if (events_fd < 0 || (atomic_fetch_or(&seen, bit) & bit)) return;
    char line[160];
    int length = snprintf(line, sizeof line, "pid=%ld %s\n", (long)getpid(), name);
    if (length > 0 && length < (int)sizeof line) (void)write(events_fd, line, (size_t)length);
}

static void initialize(void) {
    if (getuid() != geteuid()) return;
    const char *path = getenv("MPT_SESSION_STATE");
    if (!path || path[0] != '/') return;
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return;
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid() ||
        (st.st_mode & 0022) || st.st_size != (off_t)sizeof(mpt_shared)) { close(fd); return; }
    void *mapping = mmap(NULL, sizeof(mpt_shared), PROT_READ, MAP_SHARED, fd, 0);
    close(fd);
    if (mapping == MAP_FAILED) return;
    const mpt_shared *state = mapping;
    if (state->magic != MPT_MAGIC || state->version != MPT_VERSION || state->size != sizeof *state) {
        munmap(mapping, sizeof(mpt_shared)); return;
    }
    shared_state = state;
    const char *log = getenv("MPT_SESSION_EVENTS");
    if (log && log[0] == '/') {
        /* The controller creates the file first; do not create arbitrary paths. */
        int candidate = open(log, O_WRONLY | O_APPEND | O_NOFOLLOW | O_CLOEXEC);
        if (candidate >= 0) {
            if (!fstat(candidate, &st) && S_ISREG(st.st_mode) && st.st_uid == getuid() && !(st.st_mode & 0022)) events_fd = candidate;
            else close(candidate);
        }
    }
    event(1u, "LOADED (not proof of intercepted queries)");
}

__attribute__((constructor)) static void load_module(void) { pthread_once(&once, initialize); }
__attribute__((visibility("default"))) int MPTIdentityModulePresent(void) { return 1; }

static int current_profile(mpt_profile *profile) {
    pthread_once(&once, initialize);
    return shared_state && mpt_read(shared_state, now_ns(), profile);
}

static CFTypeRef replace_owned(CFTypeRef original, CFStringRef key, CFAllocatorRef allocator, unsigned int api_bit) {
    if (!original || !key || CFGetTypeID(original) != CFStringGetTypeID()) return original;
    int is_uuid = CFEqual(key, CFSTR("IOPlatformUUID"));
    int is_serial = CFEqual(key, CFSTR("IOPlatformSerialNumber"));
    if (!is_uuid && !is_serial) return original;
    mpt_profile profile;
    if (!current_profile(&profile)) return original;
    CFStringRef replacement = CFStringCreateWithCString(allocator, is_uuid ? profile.uuid : profile.serial, kCFStringEncodingASCII);
    if (!replacement) return original;
    CFRelease(original);
    event(api_bit << (is_serial ? 1 : 0), is_uuid ? "REPLACED IOPlatformUUID" : "REPLACED IOPlatformSerialNumber");
    return replacement;
}

static CFTypeRef mpt_create_property(io_registry_entry_t entry, CFStringRef key, CFAllocatorRef allocator, IOOptionBits options) {
    CFTypeRef value = IORegistryEntryCreateCFProperty(entry, key, allocator, options);
    return replace_owned(value, key, allocator, 2u);
}

static CFTypeRef mpt_search_property(io_registry_entry_t entry, const io_name_t plane, CFStringRef key, CFAllocatorRef allocator, IOOptionBits options) {
    CFTypeRef value = IORegistryEntrySearchCFProperty(entry, plane, key, allocator, options);
    return replace_owned(value, key, allocator, 8u);
}

static kern_return_t mpt_create_properties(io_registry_entry_t entry, CFMutableDictionaryRef *properties, CFAllocatorRef allocator, IOOptionBits options) {
    kern_return_t result = IORegistryEntryCreateCFProperties(entry, properties, allocator, options);
    if (result != KERN_SUCCESS || !properties || !*properties) return result;
    mpt_profile profile;
    if (!current_profile(&profile)) return result;
    CFStringRef keys[2] = {CFSTR("IOPlatformUUID"), CFSTR("IOPlatformSerialNumber")};
    const char *values[2] = {profile.uuid, profile.serial};
    CFMutableDictionaryRef copy = CFDictionaryCreateMutableCopy(allocator, 0, *properties);
    if (!copy) return result;
    for (int i = 0; i < 2; ++i) {
        CFTypeRef existing = CFDictionaryGetValue(copy, keys[i]);
        if (!existing || CFGetTypeID(existing) != CFStringGetTypeID()) continue;
        CFStringRef replacement = CFStringCreateWithCString(allocator, values[i], kCFStringEncodingASCII);
        if (replacement) {
            CFDictionarySetValue(copy, keys[i], replacement);
            CFRelease(replacement);
            event(32u << i, i ? "REPLACED dictionary.IOPlatformSerialNumber" : "REPLACED dictionary.IOPlatformUUID");
        }
    }
    CFRelease(*properties);
    *properties = copy;
    return result;
}

static int mpt_gethostuuid(uuid_t id, const struct timespec *wait) {
    int result = gethostuuid(id, wait);
    if (result == 0) {
        mpt_profile profile;
        unsigned char bytes[16];
        if (current_profile(&profile) && mpt_uuid_bytes(profile.uuid, bytes)) {
            memcpy(id, bytes, sizeof bytes);
            event(128u, "REPLACED gethostuuid");
        }
    }
    return result;
}

/* dyld static interpose pairs. References from this image to the original
 * functions remain original; no inline patches or remote memory writes. */
__attribute__((used, section("__DATA,__interpose")))
static const struct { const void *replacement; const void *original; } interpositions[] = {
    {(const void *)mpt_create_property, (const void *)IORegistryEntryCreateCFProperty},
    {(const void *)mpt_search_property, (const void *)IORegistryEntrySearchCFProperty},
    {(const void *)mpt_create_properties, (const void *)IORegistryEntryCreateCFProperties},
    {(const void *)mpt_gethostuuid, (const void *)gethostuuid}
};
