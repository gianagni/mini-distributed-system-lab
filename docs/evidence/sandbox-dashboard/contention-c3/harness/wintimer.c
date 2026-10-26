// LD_PRELOAD shim (C-3): Windows timing for BOTH blocking sleeps and the Node/libuv event-loop timer.
// Extends contention-c2/harness/wintick.c, which only rounded blocking sleeps.
//  - usleep/nanosleep/clock_nanosleep (SQLite busy handler): rounded UP to a multiple of 15.625 ms,
//    identical to wintick.c (validated: busy_timeout 200 ms -> 299 ms; Windows measured 296.9 ms).
//  - epoll_wait/epoll_pwait (libuv poll timeout = next JS timer): wake at the first 15.625 ms tick
//    boundary at or after the requested deadline, like GetQueuedCompletionStatusEx with the default
//    64 Hz clock. I/O still wakes immediately. Windows measured setTimeout(1): median 15.58 ms.
//  - WINTICK_FSYNC_US: extra cost per fsync/fdatasync (slow FlushFileBuffers), as in wintick.c.
//    WINTICK_FSYNC_SLOW_US + WINTICK_FSYNC_SLOW_PCT: that percentage of flushes costs SLOW_US instead
//    (Windows measured commit: median 5.23 ms, p90 14.23 ms, max 16.17 ms -> 4700 / 13700 us, 30 %).
// Not emulated: LockFileEx semantics, real Windows disk behaviour, scheduler differences.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <sys/epoll.h>
#include <time.h>
#include <unistd.h>
static const long long TICK_NS = 15625000LL;
static long long round_up(long long ns) { if (ns <= 0) return 0; return ((ns + TICK_NS - 1) / TICK_NS) * TICK_NS; }
static int (*real_clock_nanosleep)(clockid_t, int, const struct timespec *, struct timespec *);
static int sleep_ns(long long ns) {
  if (!real_clock_nanosleep) real_clock_nanosleep = dlsym(RTLD_NEXT, "clock_nanosleep");
  struct timespec ts = { ns / 1000000000LL, ns % 1000000000LL };
  return real_clock_nanosleep(CLOCK_MONOTONIC, 0, &ts, NULL);
}
int usleep(useconds_t us) { sleep_ns(round_up((long long)us * 1000LL)); return 0; }
int nanosleep(const struct timespec *req, struct timespec *rem) {
  (void)rem; if (!req) { errno = EINVAL; return -1; }
  sleep_ns(round_up((long long)req->tv_sec * 1000000000LL + req->tv_nsec)); return 0;
}
int clock_nanosleep(clockid_t c, int flags, const struct timespec *req, struct timespec *rem) {
  if (!real_clock_nanosleep) real_clock_nanosleep = dlsym(RTLD_NEXT, "clock_nanosleep");
  if (flags & TIMER_ABSTIME) return real_clock_nanosleep(c, flags, req, rem);
  (void)rem; sleep_ns(round_up((long long)req->tv_sec * 1000000000LL + req->tv_nsec)); return 0;
}

static long long mono_ns(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000000000LL + t.tv_nsec; }
static int tick_timeout(int timeout_ms) {
  if (timeout_ms <= 0) return timeout_ms; // 0 = poll, -1 = infinite: unchanged
  long long now = mono_ns();
  long long deadline = now + (long long)timeout_ms * 1000000LL;
  long long aligned = ((deadline + TICK_NS - 1) / TICK_NS) * TICK_NS;
  return (int)((aligned - now + 999999LL) / 1000000LL);
}
static int (*real_epoll_wait)(int, struct epoll_event *, int, int);
static int (*real_epoll_pwait)(int, struct epoll_event *, int, int, const sigset_t *);
int epoll_wait(int fd, struct epoll_event *ev, int n, int timeout) {
  if (!real_epoll_wait) real_epoll_wait = dlsym(RTLD_NEXT, "epoll_wait");
  return real_epoll_wait(fd, ev, n, tick_timeout(timeout));
}
int epoll_pwait(int fd, struct epoll_event *ev, int n, int timeout, const sigset_t *ss) {
  if (!real_epoll_pwait) real_epoll_pwait = dlsym(RTLD_NEXT, "epoll_pwait");
  return real_epoll_pwait(fd, ev, n, tick_timeout(timeout), ss);
}

static long long fsync_extra_ns = -1, fsync_slow_ns = 0; static int fsync_slow_pct = 0; static unsigned rng = 0;
static void flush_delay(void) {
  if (fsync_extra_ns < 0) {
    const char *v = getenv("WINTICK_FSYNC_US"); fsync_extra_ns = v ? atoll(v) * 1000LL : 0;
    const char *s = getenv("WINTICK_FSYNC_SLOW_US"); fsync_slow_ns = s ? atoll(s) * 1000LL : 0;
    const char *p = getenv("WINTICK_FSYNC_SLOW_PCT"); fsync_slow_pct = p ? atoi(p) : 0;
    rng = (unsigned)getpid() * 2654435761u;
  }
  long long ns = fsync_extra_ns;
  if (fsync_slow_pct > 0) { rng = rng * 1103515245u + 12345u; if ((int)((rng >> 16) % 100) < fsync_slow_pct) ns = fsync_slow_ns; }
  if (ns > 0) sleep_ns(ns);
}
static int (*real_fsync)(int); static int (*real_fdatasync)(int);
int fsync(int fd) { if (!real_fsync) real_fsync = dlsym(RTLD_NEXT, "fsync"); int r = real_fsync(fd); flush_delay(); return r; }
int fdatasync(int fd) { if (!real_fdatasync) real_fdatasync = dlsym(RTLD_NEXT, "fdatasync"); int r = real_fdatasync(fd); flush_delay(); return r; }
