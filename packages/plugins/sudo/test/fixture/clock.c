#define _POSIX_C_SOURCE 200809L
#include <poll.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>

int __real_clock_gettime(clockid_t clock, struct timespec *value);
int __real_poll(struct pollfd *fds, nfds_t count, int timeout);

// Freeze this helper's clock, then advance it while fake sudo awaits input.
// Command startup speed must not consume this test's short execution allowance.
int __wrap_clock_gettime(clockid_t clock, struct timespec *value) {
  int result = __real_clock_gettime(clock, value);
  if (!result && clock == CLOCK_MONOTONIC) {
    value->tv_sec = 1000 + (!access(TEST_CLOCK_PATH, F_OK) ? TEST_AUTH_SECONDS : 0);
    value->tv_nsec = 0;
  }
  return result;
}

int __wrap_poll(struct pollfd *fds, nfds_t count, int timeout) {
  static int observed;
  int result = __real_poll(fds, count, timeout);
  // A second poll proves the supervisor evaluated the advanced clock before input is released.
  if (!access(TEST_CLOCK_PATH, F_OK) && ++observed == 2) {
    FILE *acknowledged = fopen(TEST_CLOCK_PATH ".observed", "w");
    if (acknowledged) fclose(acknowledged);
  }
  return result;
}
