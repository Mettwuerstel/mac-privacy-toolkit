#include "storage.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

uint64_t mpt_now(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts)) return 0;
    return (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
}

int mpt_storage_create(mpt_storage *storage) {
    memset(storage, 0, sizeof *storage);
    const char *base = getenv("TMPDIR");
    if (!base || base[0] != '/') base = "/tmp";
    int length = snprintf(storage->directory, sizeof storage->directory, "%s/mpt-session-XXXXXX", base);
    /* Reserve space for the two filenames as well. */
    if (length < 0 || length > PATH_MAX - 32) { storage->directory[0] = 0; errno = ENAMETOOLONG; return 0; }
    if (!mkdtemp(storage->directory)) { storage->directory[0] = 0; return 0; }
    size_t directory_length = (size_t)length;
    memcpy(storage->state_path, storage->directory, directory_length);
    memcpy(storage->state_path + directory_length, "/state", sizeof "/state");
    memcpy(storage->events_path, storage->directory, directory_length);
    memcpy(storage->events_path + directory_length, "/events", sizeof "/events");
    int fd = open(storage->state_path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) goto failed;
    if (ftruncate(fd, sizeof(mpt_shared))) { close(fd); goto failed; }
    void *mapping = mmap(NULL, sizeof(mpt_shared), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (mapping == MAP_FAILED) goto failed;
    storage->state = mapping;
    mpt_init(storage->state);
    fd = open(storage->events_path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) goto failed;
    close(fd);
    return 1;
failed: {
    int saved = errno;
    mpt_storage_close(storage);
    errno = saved;
    return 0;
}}

void mpt_storage_close(mpt_storage *storage) {
    if (storage->state) {
        mpt_stop(storage->state);
        munmap(storage->state, sizeof(mpt_shared));
    }
    if (storage->state_path[0]) unlink(storage->state_path);
    if (storage->events_path[0]) unlink(storage->events_path);
    if (storage->directory[0]) rmdir(storage->directory);
    memset(storage, 0, sizeof *storage);
}
