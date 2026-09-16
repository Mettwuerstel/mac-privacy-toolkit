#include "../native/storage.h"
#include <assert.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    mpt_storage storage;
    assert(mpt_storage_create(&storage));
    struct stat st;
    assert(!stat(storage.directory, &st) && S_ISDIR(st.st_mode) && (st.st_mode & 0777) == 0700);
    assert(!stat(storage.state_path, &st) && S_ISREG(st.st_mode) && (st.st_mode & 0777) == 0600);
    assert(!stat(storage.events_path, &st) && (st.st_mode & 0777) == 0600);
    mpt_profile profile, observed;
    assert(mpt_parse_profile(&profile, "12345678-ABCD-4DEF-8ABC-0123456789AB", "MP1234567890"));
    assert(mpt_rotate(storage.state, &profile, mpt_now()));
    pid_t child = fork();
    assert(child >= 0);
    if (!child) {
        int fd = open(storage.state_path, O_RDONLY | O_NOFOLLOW);
        assert(fd >= 0);
        const mpt_shared *view = mmap(NULL, sizeof *view, PROT_READ, MAP_SHARED, fd, 0);
        assert(view != MAP_FAILED);
        assert(!close(fd));
        assert(mpt_read(view, mpt_now(), &observed));
        assert(!memcmp(&profile, &observed, sizeof profile));
        assert(!munmap((void *)view, sizeof *view));
        _exit(0);
    }
    int status;
    assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    int fd = open(storage.state_path, O_RDONLY | O_NOFOLLOW);
    assert(fd >= 0);
    const mpt_shared *view = mmap(NULL, sizeof *view, PROT_READ, MAP_SHARED, fd, 0);
    assert(view != MAP_FAILED);
    assert(!close(fd));
    char path[PATH_MAX];
    strcpy(path, storage.directory);
    mpt_storage_close(&storage);
    assert(!storage.state && !storage.directory[0]);
    assert(access(path, F_OK) != 0);
    assert(!mpt_read(view, mpt_now(), &observed)); /* mapped readers see stop after unlink */
    assert(!munmap((void *)view, sizeof *view));
    mpt_storage_close(&storage); /* idempotent cleanup */
    puts("PASS: private file modes, independent process mapping, cleanup and mapped-reader stop");
    return 0;
}
