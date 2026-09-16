#include "session.h"
#include <string.h>

_Static_assert(ATOMIC_CHAR_LOCK_FREE == 2, "Shared bytes must be lock-free");
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "Shared counters must be lock-free");
_Static_assert(ATOMIC_LLONG_LOCK_FREE == 2, "Shared timestamps must be lock-free");

static int hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int mpt_uuid_bytes(const char *uuid, unsigned char out[16]) {
    if (!uuid || !out || strlen(uuid) != MPT_UUID_LENGTH) return 0;
    unsigned char bytes[16];
    size_t index = 0;
    unsigned int nonzero = 0;
    for (size_t i = 0; i < MPT_UUID_LENGTH;) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (uuid[i++] != '-') return 0;
            continue;
        }
        int a = hex_value(uuid[i++]);
        int b = hex_value(uuid[i++]);
        if (a < 0 || b < 0 || index >= sizeof bytes) return 0;
        bytes[index] = (unsigned char)((a << 4) | b);
        nonzero |= bytes[index++];
    }
    if (index != sizeof bytes || !nonzero) return 0;
    memcpy(out, bytes, sizeof bytes);
    return 1;
}

int mpt_parse_profile(mpt_profile *out, const char *uuid, const char *serial) {
    unsigned char ignored[16];
    if (!out || !serial || strlen(serial) != MPT_SERIAL_LENGTH || !mpt_uuid_bytes(uuid, ignored)) return 0;
    for (size_t i = 0; i < MPT_SERIAL_LENGTH; ++i) {
        if (!((serial[i] >= 'A' && serial[i] <= 'Z') || (serial[i] >= '0' && serial[i] <= '9'))) return 0;
    }
    mpt_profile value;
    for (size_t i = 0; i < MPT_UUID_LENGTH; ++i) {
        char c = uuid[i];
        value.uuid[i] = (c >= 'a' && c <= 'f') ? (char)(c - 'a' + 'A') : c;
    }
    value.uuid[MPT_UUID_LENGTH] = '\0';
    memcpy(value.serial, serial, MPT_SERIAL_LENGTH + 1);
    *out = value;
    return 1;
}

void mpt_init(mpt_shared *state) {
    state->magic = MPT_MAGIC;
    state->version = MPT_VERSION;
    state->size = (uint32_t)sizeof *state;
    atomic_init(&state->sequence, 0);
    atomic_init(&state->enabled, 0);
    atomic_init(&state->heartbeat, 0);
    for (size_t i = 0; i <= MPT_UUID_LENGTH; ++i) atomic_init(&state->uuid[i], 0);
    for (size_t i = 0; i <= MPT_SERIAL_LENGTH; ++i) atomic_init(&state->serial[i], 0);
}

int mpt_rotate(mpt_shared *state, const mpt_profile *profile, uint64_t now) {
    if (!state || !profile || state->magic != MPT_MAGIC || state->version != MPT_VERSION ||
        state->size != sizeof *state || !now) return 0;
    mpt_profile valid;
    /* Buffers from callers must terminate before any string operation. */
    if (profile->uuid[MPT_UUID_LENGTH] || profile->serial[MPT_SERIAL_LENGTH] ||
        !mpt_parse_profile(&valid, profile->uuid, profile->serial)) return 0;
    unsigned int old = atomic_load(&state->sequence);
    if (old & 1u || !atomic_compare_exchange_strong(&state->sequence, &old, old + 1u)) return 0;
    for (size_t i = 0; i <= MPT_UUID_LENGTH; ++i) atomic_store(&state->uuid[i], (unsigned char)valid.uuid[i]);
    for (size_t i = 0; i <= MPT_SERIAL_LENGTH; ++i) atomic_store(&state->serial[i], (unsigned char)valid.serial[i]);
    atomic_store(&state->heartbeat, now);
    atomic_store(&state->enabled, 1);
    atomic_store(&state->sequence, old + 2u);
    return 1;
}

void mpt_stop(mpt_shared *state) { atomic_store(&state->enabled, 0); }
void mpt_heartbeat(mpt_shared *state, uint64_t now) { atomic_store(&state->heartbeat, now); }

int mpt_read(const mpt_shared *state, uint64_t now, mpt_profile *out) {
    if (!state || !out || state->magic != MPT_MAGIC || state->version != MPT_VERSION || state->size != sizeof *state) return 0;
    for (unsigned int attempt = 0; attempt < 128; ++attempt) {
        if (!atomic_load(&state->enabled)) return 0;
        uint64_t beat = atomic_load(&state->heartbeat);
        /* The heartbeat writer may run after the caller sampled 'now'. A tiny
         * future timestamp is therefore fresh, not a reason to expose originals. */
        if (!beat || (now >= beat ? now - beat : beat - now) > MPT_TIMEOUT_NS) return 0;
        unsigned int before = atomic_load(&state->sequence);
        if (before & 1u) continue;
        mpt_profile value;
        for (size_t i = 0; i <= MPT_UUID_LENGTH; ++i) value.uuid[i] = (char)atomic_load(&state->uuid[i]);
        for (size_t i = 0; i <= MPT_SERIAL_LENGTH; ++i) value.serial[i] = (char)atomic_load(&state->serial[i]);
        if (before == atomic_load(&state->sequence) && atomic_load(&state->enabled)) {
            if (value.uuid[MPT_UUID_LENGTH] || value.serial[MPT_SERIAL_LENGTH]) return 0;
            return mpt_parse_profile(out, value.uuid, value.serial);
        }
    }
    return 0;
}
