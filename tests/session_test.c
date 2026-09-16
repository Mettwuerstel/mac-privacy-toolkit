#include "../native/session.h"
#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>

static const uint64_t tick = UINT64_C(9000000000);
static mpt_profile first, second;
static mpt_shared shared;
static _Atomic int done;
static _Atomic unsigned int successful_reads;
static _Atomic unsigned int ready;

static void *reader(void *unused) {
    (void)unused;
    atomic_fetch_add(&ready, 1);
    while (!atomic_load(&done)) {
        mpt_profile value;
        if (mpt_read(&shared, tick, &value)) {
            int a = !strcmp(value.uuid, first.uuid) && !strcmp(value.serial, first.serial);
            int b = !strcmp(value.uuid, second.uuid) && !strcmp(value.serial, second.serial);
            assert(a || b); /* A snapshot must never mix profiles. */
            atomic_fetch_add(&successful_reads, 1);
        }
    }
    return NULL;
}

int main(void) {
    assert(mpt_parse_profile(&first, "12345678-abcd-4def-8abc-0123456789ab", "MP1234567890"));
    assert(!strcmp(first.uuid, "12345678-ABCD-4DEF-8ABC-0123456789AB"));
    assert(mpt_parse_profile(&second, "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "MPABCDEFGHIJ"));
    mpt_profile untouched = first;
    assert(!mpt_parse_profile(&untouched, "invalid", second.serial));
    assert(!memcmp(&untouched, &first, sizeof first));
    assert(!mpt_parse_profile(&untouched, "00000000-0000-0000-0000-000000000000", first.serial));
    assert(!mpt_parse_profile(&untouched, first.uuid, "short"));
    assert(!mpt_parse_profile(&untouched, first.uuid, "MP12345678;x"));
    unsigned char bytes[16];
    assert(mpt_uuid_bytes(first.uuid, bytes));
    assert(bytes[0] == 0x12 && bytes[15] == 0xab);
    mpt_init(&shared);
    mpt_profile observed;
    assert(!mpt_read(&shared, tick, &observed));
    assert(mpt_rotate(&shared, &first, tick));
    assert(mpt_read(&shared, tick, &observed));
    assert(!memcmp(&observed, &first, sizeof first));
    assert(mpt_read(&shared, tick - 1, &observed)); /* concurrent heartbeat */
    assert(!mpt_read(&shared, tick - MPT_TIMEOUT_NS - 1, &observed));
    assert(!mpt_read(&shared, tick + MPT_TIMEOUT_NS + 1, &observed));
    mpt_stop(&shared);
    assert(!mpt_read(&shared, tick, &observed));
    mpt_heartbeat(&shared, tick);
    assert(!mpt_read(&shared, tick, &observed)); /* heartbeat must not re-enable */
    assert(mpt_rotate(&shared, &second, tick));
    shared.version = 999;
    assert(!mpt_read(&shared, tick, &observed));
    assert(!mpt_rotate(&shared, &first, tick));
    shared.version = MPT_VERSION;
    mpt_profile bad = first;
    bad.uuid[MPT_UUID_LENGTH] = 'x';
    assert(!mpt_rotate(&shared, &bad, tick));
    assert(mpt_read(&shared, tick, &observed));
    assert(!memcmp(&observed, &second, sizeof second));
    atomic_init(&done, 0);
    atomic_init(&successful_reads, 0);
    atomic_init(&ready, 0);
    pthread_t readers[4];
    for (int i = 0; i < 4; ++i) assert(!pthread_create(&readers[i], NULL, reader, NULL));
    while (atomic_load(&ready) != 4 || !atomic_load(&successful_reads)) sched_yield();
    for (int i = 0; i < 25000; ++i) assert(mpt_rotate(&shared, i & 1 ? &first : &second, tick));
    atomic_store(&done, 1);
    for (int i = 0; i < 4; ++i) assert(!pthread_join(readers[i], NULL));
    assert(atomic_load(&successful_reads) > 0);
    printf("PASS: profile validation, rotation, stop, stale heartbeat, invalid state, concurrent readers (%u snapshots)\n", atomic_load(&successful_reads));
    return 0;
}
