/*
 * A role's launcher, in the executable of the role's app (<name>.app, ai.hh.role.<id>; main.swift calls it): launchd runs
 * `HH -- /absolute/program [args...]` for each of the role's jobs. It starts the program as its child (posix_spawn,
 * responsibility not disclaimed) and stays its parent, so macOS's privacy checks (TCC) count the program and everything
 * it starts against the role's app: the owner grants it once, and a new node, a new path or a new tool needs nothing more.
 * Signals launchd sends are passed on; the child's exit code is this process's, and a child killed by a signal kills this
 * process with the same signal. It starts nothing when its own path could have been changed by someone else: every
 * directory from / down to its executable must be owned by root or by the user it runs as, and writable by nobody else
 * (a sticky directory like /Users/Shared excepted, whose entries only their owners can move).
 * apps/macos/build.sh builds and signs the app.
 */
#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include "launcher.h"

extern char **environ;

static volatile sig_atomic_t child = 0;

static void pass_on(int sig) {
    if (child > 0) kill(child, sig);
}

/* the first path from / down to this executable that someone other than root or this user could change, or NULL */
static const char *unsafe_part(void) {
    static char path[PATH_MAX];
    char raw[PATH_MAX];
    uint32_t n = sizeof raw;
    if (_NSGetExecutablePath(raw, &n) != 0 || !realpath(raw, path)) return "(own path unreadable)";
    uid_t me = getuid();
    for (char *end = path + strlen(path); end > path; ) {
        struct stat st;
        if (lstat(path, &st) != 0 || S_ISLNK(st.st_mode)) return path;
        if (st.st_uid != 0 && st.st_uid != me) return path;
        if ((st.st_mode & 022) && !(S_ISDIR(st.st_mode) && (st.st_mode & S_ISVTX))) return path;
        end = strrchr(path, '/');
        if (end == path) end++;   /* keep "/" itself */
        if (end == path + 1 && path[1] == 0) break;
        *end = 0;
    }
    return NULL;
}

int hh_launch(int argc, char *argv[]) {
    const char *bad = unsafe_part();
    if (bad) {
        fprintf(stderr, "HH: warn: not starting: %s can be changed by someone other than root and this user\n", bad);
        return 78;
    }
    if (argc < 3 || strcmp(argv[1], "--") != 0 || argv[2][0] != '/') {
        fprintf(stderr, "usage: HH -- /absolute/program [args...]\n");
        return 64;
    }
    static const int SIGS[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2};
    sigset_t block, old;
    sigemptyset(&block);
    for (size_t i = 0; i < sizeof SIGS / sizeof *SIGS; i++) sigaddset(&block, SIGS[i]);
    sigprocmask(SIG_BLOCK, &block, &old);   /* no signal is lost between the spawn and knowing the child's pid */

    posix_spawnattr_t attr;
    posix_spawnattr_init(&attr);
    posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
    posix_spawnattr_setsigmask(&attr, &old);      /* the child starts with the mask this process was started with, */
    posix_spawnattr_setsigdefault(&attr, &block); /* and the passed-on signals at their default action */
    pid_t pid;
    int rc = posix_spawn(&pid, argv[2], NULL, &attr, &argv[2], environ);
    posix_spawnattr_destroy(&attr);
    if (rc != 0) {
        fprintf(stderr, "HH: %s: %s\n", argv[2], strerror(rc));
        return 127;
    }
    child = pid;
    struct sigaction sa = {0};
    sa.sa_handler = pass_on;
    for (size_t i = 0; i < sizeof SIGS / sizeof *SIGS; i++) sigaction(SIGS[i], &sa, NULL);
    sigprocmask(SIG_SETMASK, &old, NULL);

    int status;
    while (waitpid(pid, &status, 0) < 0)
        if (errno != EINTR) { perror("HH: waitpid"); return 70; }
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    int sig = WTERMSIG(status);
    signal(sig, SIG_DFL);
    sigset_t only;
    sigemptyset(&only);
    sigaddset(&only, sig);
    sigprocmask(SIG_UNBLOCK, &only, NULL);
    kill(getpid(), sig);
    return 128 + sig;
}
