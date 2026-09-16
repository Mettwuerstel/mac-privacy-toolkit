#ifndef MPT_STORAGE_H
#define MPT_STORAGE_H
#include "session.h"
#include <limits.h>

typedef struct {
    mpt_shared *state;
    char directory[PATH_MAX];
    char state_path[PATH_MAX];
    char events_path[PATH_MAX];
} mpt_storage;

uint64_t mpt_now(void);
int mpt_storage_create(mpt_storage *storage);
void mpt_storage_close(mpt_storage *storage);
#endif
