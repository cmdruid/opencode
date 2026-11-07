#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

int __real_tcsetattr(int, int, const struct termios *);
int __real_tcgetattr(int, struct termios *);
int __real_tcsetpgrp(int, pid_t);
pid_t __real_tcgetpgrp(int);
static struct termios saved;
static int captured, restoring, returned;

int __wrap_tcgetattr(int fd, struct termios *value) {
  int result = __real_tcgetattr(fd, value);
  if (!result && !captured) { saved = *value; captured = 1; }
  if (!result && restoring && !strcmp(TEST_FAILURE, "readback")) value->c_lflag ^= ECHO;
  return result;
}

int __wrap_tcsetattr(int fd, int action, const struct termios *value) {
  if (captured && value->c_lflag == saved.c_lflag && action == TCSAFLUSH) {
    restoring = 1;
    int ready = open(TEST_CLEANUP_PATH, O_CREAT | O_WRONLY, 0600);
    if (ready >= 0) close(ready);
    while (access(TEST_CLEANUP_PATH ".release", F_OK)) poll(NULL, 0, 2);
    if (!strcmp(TEST_FAILURE, "attributes")) { errno = EIO; return -1; }
  }
  return __real_tcsetattr(fd, action, value);
}

int __wrap_tcsetpgrp(int fd, pid_t group) {
  if (restoring && !strcmp(TEST_FAILURE, "ownership")) { errno = EIO; return -1; }
  int result = __real_tcsetpgrp(fd, group);
  if (restoring) returned = 1;
  return result;
}

pid_t __wrap_tcgetpgrp(int fd) {
  if (returned && !strcmp(TEST_FAILURE, "foreground-readback")) return -1;
  return __real_tcgetpgrp(fd);
}
