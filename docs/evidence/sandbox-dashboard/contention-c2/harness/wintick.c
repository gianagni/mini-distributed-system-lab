// LD_PRELOAD shim: emulate Windows default timer granularity (15.625 ms) for blocking sleeps.
// Every usleep/nanosleep/clock_nanosleep is rounded UP to the next multiple of 15.625 ms,
// like Windows Sleep(ms) with the default 64 Hz timer. Nothing else is changed.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <time.h>
#include <unistd.h>
#include <errno.h>
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

// Optional: emulate a slower durable flush (Windows FlushFileBuffers) with WINTICK_FSYNC_US.
#include <stdlib.h>
static long long fsync_extra_ns = -1;
static void flush_delay(void) {
  if (fsync_extra_ns < 0) { const char *v = getenv("WINTICK_FSYNC_US"); fsync_extra_ns = v ? atoll(v) * 1000LL : 0; }
  if (fsync_extra_ns > 0) sleep_ns(fsync_extra_ns);
}
static int (*real_fsync)(int); static int (*real_fdatasync)(int);
int fsync(int fd) { if (!real_fsync) real_fsync = dlsym(RTLD_NEXT, "fsync"); int r = real_fsync(fd); flush_delay(); return r; }
int fdatasync(int fd) { if (!real_fdatasync) real_fdatasync = dlsym(RTLD_NEXT, "fdatasync"); int r = real_fdatasync(fd); flush_delay(); return r; }
