#ifndef MPT_SESSION_H
#define MPT_SESSION_H

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>

#define MPT_MAGIC UINT64_C(0x4d50544944454e54)
#define MPT_VERSION 1u
#define MPT_UUID_LENGTH 36u
#define MPT_SERIAL_LENGTH 12u
#define MPT_TIMEOUT_NS UINT64_C(3000000000)

typedef struct {
    char uuid[MPT_UUID_LENGTH + 1];
    char serial[MPT_SERIAL_LENGTH + 1];
} mpt_profile;

/* The same x86_64 binary ABI is used by the app, library and probe. All shared
 * mutable bytes are atomic: profile rotation has no plain-data seqlock race. */
typedef struct {
    uint64_t magic;
    uint32_t version;
    uint32_t size;
    _Atomic unsigned int sequence;
    _Atomic unsigned int enabled;
    _Atomic uint64_t heartbeat;
    _Atomic unsigned char uuid[MPT_UUID_LENGTH + 1];
    _Atomic unsigned char serial[MPT_SERIAL_LENGTH + 1];
} mpt_shared;

int mpt_parse_profile(mpt_profile *out, const char *uuid, const char *serial);
int mpt_uuid_bytes(const char *uuid, unsigned char out[16]);
void mpt_init(mpt_shared *state);
int mpt_rotate(mpt_shared *state, const mpt_profile *profile, uint64_t now);
void mpt_stop(mpt_shared *state);
void mpt_heartbeat(mpt_shared *state, uint64_t now);
int mpt_read(const mpt_shared *state, uint64_t now, mpt_profile *out);

#endif
