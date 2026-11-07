#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/time.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#ifndef SUDO_PATH
#define SUDO_PATH "/usr/bin/sudo"
#endif

static volatile sig_atomic_t interrupted;
static volatile sig_atomic_t resized;
static void resize(int signal_number) { (void)signal_number; resized = 1; }
static void interrupt(int signal_number) { interrupted = signal_number; }

static int transfer(int fd, void *buffer, size_t length, int writing) {
  unsigned char *cursor = buffer;
  while (length) {
    ssize_t count = writing ? write(fd, cursor, length) : read(fd, cursor, length);
    if (count < 0 && errno == EINTR && !interrupted) continue;
    if (count <= 0) return -1;
    cursor += count;
    length -= (size_t)count;
  }
  return 0;
}

static char *field(int fd) {
  uint32_t size;
  if (transfer(fd, &size, sizeof(size), 0)) return NULL;
  size = ntohl(size);
  if (!size || size > 65536) return NULL;
  char *value = calloc((size_t)size + 1, 1);
  if (!value) return NULL;
  if (transfer(fd, value, size, 0) || memchr(value, 0, size)) {
    free(value);
    return NULL;
  }
  return value;
}

static int frame(int fd, char type, const void *data, uint32_t length) {
  uint32_t size = htonl(length);
  if (transfer(fd, &type, 1, 1) || transfer(fd, &size, sizeof(size), 1)) return -1;
  return transfer(fd, (void *)data, length, 1);
}

static int64_t milliseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now)) return 0;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

/* This mode runs only after sudo authenticates. No authentication stream is captured. */
static int execute(const char *fifo, const char *cwd, const char *command) {
#ifndef OPENCODE_SUDO_TEST
  if (geteuid() != 0) return 126;
#endif
  int output = open(fifo, O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat info;
  if (output < 0 || fstat(output, &info) || !S_ISFIFO(info.st_mode)) return 126;
  unsigned char started = 0;
  if (write(output, &started, 1) != 1) return 126;
  pid_t child = fork();
  if (child < 0) return 126;
  if (!child) {
    if (setsid() < 0 || chdir(cwd)) _exit(126);
    int input = open("/dev/null", O_RDONLY);
    if (input < 0 || dup2(input, STDIN_FILENO) < 0 || dup2(output, STDOUT_FILENO) < 0 || dup2(output, STDERR_FILENO) < 0) _exit(126);
    close(input);
    close(output);
    signal(SIGINT, SIG_DFL);
    signal(SIGTERM, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    execl("/bin/sh", "sh", "-c", command, (char *)NULL);
    _exit(127);
  }
  close(output);
  int status = 0;
  int64_t stopping = 0;
  for (;;) {
    pid_t ended = waitpid(child, &status, WNOHANG);
    if (ended == child) break;
    if (ended < 0 && errno != EINTR) return 126;
    if (interrupted && !stopping) {
      stopping = milliseconds();
      kill(-child, SIGTERM);
    }
    if (stopping && milliseconds() - stopping > 1000) kill(-child, SIGKILL);
    (void)poll(NULL, 0, 20);
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

#include "screen.h"

static int supervise(const char *socket_path, const char *id) {
  struct screen screen = screen_load();
  int tty = open("/dev/tty", O_RDWR | O_CLOEXEC);
  struct termios original;
  pid_t previous = tty >= 0 ? tcgetpgrp(tty) : -1;
  if (tty < 0 || previous != getpgrp() || tcgetattr(tty, &original)) {
    dprintf(STDERR_FILENO, "OpenCode sudo: a foreground controlling terminal is required.\n");
    return 125;
  }
  signal(SIGTTOU, SIG_IGN);
  if (setpgid(0, 0) || tcsetpgrp(tty, getpgrp())) return 125;
  struct termios guarded = original;
  guarded.c_lflag &= (tcflag_t)~(ECHO | ECHONL | ICANON);
  guarded.c_cc[VMIN] = 1;
  guarded.c_cc[VTIME] = 0;
  if (tcsetattr(tty, TCSAFLUSH, &guarded)) return 125;

  screen_begin(tty, &screen);
  int connection = -1;
  char *cwd = NULL;
  char *command = NULL;
  char directory[] = "/tmp/opencode-sudo-tty-XXXXXX";
  char fifo[128] = {0};
  int output = -1;
  int result = 125;
  int timed_out = 0;
  int status = 0;
  pid_t child = -1;
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  if (strlen(socket_path) >= sizeof(address.sun_path) || strlen(id) != 36) goto guard;
  memcpy(address.sun_path, socket_path, strlen(socket_path) + 1);
  connection = socket(AF_UNIX, SOCK_STREAM, 0);
  if (connection < 0 || connect(connection, (struct sockaddr *)&address, sizeof(address))) {
    dprintf(STDERR_FILENO, "OpenCode sudo: local request unavailable. Run the TUI on the server through SSH.\n");
    goto guard;
  }
  if (fcntl(connection, F_SETFD, FD_CLOEXEC)) goto guard;
  struct timeval handshake_timeout = { .tv_sec = 5 };
  if (setsockopt(connection, SOL_SOCKET, SO_RCVTIMEO, &handshake_timeout, sizeof(handshake_timeout)) ||
      setsockopt(connection, SOL_SOCKET, SO_SNDTIMEO, &handshake_timeout, sizeof(handshake_timeout))) goto guard;
  if (transfer(connection, (void *)id, 36, 1)) goto guard;
  char magic[8];
  if (transfer(connection, magic, sizeof(magic), 0) || memcmp(magic, "OCSUDO1\0", 8)) goto guard;
  cwd = field(connection);
  command = field(connection);
  uint32_t timeout;
  if (!cwd || !command || transfer(connection, &timeout, sizeof(timeout), 0)) goto guard;
  timeout = ntohl(timeout);
  if (!timeout || timeout > 2147483647) goto guard;


  if (!mkdtemp(directory)) goto guard;
  snprintf(fifo, sizeof(fifo), "%s/output", directory);
  if (mkfifo(fifo, 0600) || (output = open(fifo, O_RDWR | O_NONBLOCK | O_CLOEXEC)) < 0) goto guard;

  if (interrupted) goto guard;
  struct termios authentication = original;
  authentication.c_lflag &= (tcflag_t)~(ECHO | ECHONL);
  if (tcsetattr(tty, TCSAFLUSH, &authentication)) goto guard;
  dprintf(tty, "System sudo · Ctrl+C cancels.\r\n");
  // Keep sudo's post-authentication entry bound to this running image, even during a package update.
  char executable[64];
  snprintf(executable, sizeof(executable), "/proc/%ld/exe", (long)getpid());
  child = fork();
  if (child < 0) goto guard;
  if (!child) {
    int input = open("/dev/null", O_RDONLY);
    if (input < 0 || dup2(input, STDIN_FILENO) < 0 || dup2(tty, STDOUT_FILENO) < 0 || dup2(tty, STDERR_FILENO) < 0) _exit(126);
    close(input);
    signal(SIGINT, SIG_DFL);
    signal(SIGTERM, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    execl(SUDO_PATH, "sudo", "-k", "--", executable, "--execute", fifo, cwd, command, (char *)NULL);
    _exit(127);
  }
  int started = 0;
  // Waiting for the user does not spend the command's execution allowance.
  int64_t deadline = 0;
  int cancelled = 0;
  for (;;) {
    struct pollfd running[] = {{output, POLLIN, 0}, {connection, POLLIN, 0}};
    (void)poll(running, 2, 20);
    if (resized) { resized = 0; screen_resize(tty, &screen); }
    if ((interrupted || running[1].revents || (started && milliseconds() >= deadline)) && !cancelled) {
      cancelled = 1;
      timed_out = started && milliseconds() >= deadline;
      kill(child, SIGTERM);
    }
    char buffer[4096];
    ssize_t count;
    for (int batch = 0; batch < 16 && (count = read(output, buffer, sizeof(buffer))) > 0; batch++) {
      if (!started) {
        if (buffer[0] != 0) { kill(child, SIGTERM); cancelled = 1; continue; }
        started = 1;
        deadline = milliseconds() + timeout;
        memmove(buffer, buffer + 1, (size_t)--count);
      }
      if (count && frame(connection, 'O', buffer, (uint32_t)count)) {
        shutdown(connection, SHUT_RDWR);
        if (!cancelled) {
          cancelled = 1;
          kill(child, SIGTERM);
        }
      }
    }
    pid_t ended = waitpid(child, &status, WNOHANG);
    if (ended == child) {
      for (int batch = 0; batch < 16 && (count = read(output, buffer, sizeof(buffer))) > 0; batch++) {
        if (!started) {
          started = 1;
          memmove(buffer, buffer + 1, (size_t)--count);
        }
        if (count) (void)frame(connection, 'O', buffer, (uint32_t)count);
      }
      result = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      break;
    }
    if (ended < 0 && errno != EINTR) break;
  }

guard:
  if (output >= 0) close(output);
  if (fifo[0]) unlink(fifo);
  if (strstr(directory, "XXXXXX") == NULL) rmdir(directory);
  uint32_t code[] = {htonl((uint32_t)result), htonl((uint32_t)timed_out)};
  (void)frame(connection, 'X', code, sizeof(code));
  close(connection);
  free(cwd);
  free(command);
  // Treat Ctrl+C as a byte only after sudo exits; a prior SIGINT cannot dismiss this guard.
  guarded.c_lflag &= (tcflag_t)~ISIG;
  if (tcsetattr(tty, TCSAFLUSH, &guarded)) return 125;
  screen_color(tty, &screen, 0);
  dprintf(tty, "\r\nFinished (exit %d).\r\n", result);
  screen_color(tty, &screen, 4);
  dprintf(tty, "Ctrl+C to close.\r\n");
  unsigned char key = 0;
  while (key != 3) {
    ssize_t count = read(tty, &key, 1);
    if (resized) { resized = 0; screen_resize(tty, &screen); }
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return 125;
  }
  screen_end(tty, &screen);
  if (tcflush(tty, TCIFLUSH) || tcsetattr(tty, TCSANOW, &original) || tcsetpgrp(tty, previous)) return 125;
  close(tty);
  return 0;
}

int main(int argc, char **argv) {
  // Never turn this arbitrary-command helper into a setuid or setgid entry point.
  if (getuid() != geteuid() || getgid() != getegid()) return 126;
  struct sigaction action = { .sa_handler = interrupt };
  sigemptyset(&action.sa_mask);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGHUP, &action, NULL);
  action.sa_handler = resize;
  sigaction(SIGWINCH, &action, NULL);
  signal(SIGPIPE, SIG_IGN);
  // Job suspension must not abandon a terminal that may contain unfinished password input.
  signal(SIGTSTP, SIG_IGN);
  if (argc == 5 && !strcmp(argv[1], "--execute")) return execute(argv[2], argv[3], argv[4]);
  if (argc == 3) return supervise(argv[1], argv[2]);
  dprintf(STDERR_FILENO, "Usage: opencode-sudo-tty SOCKET REQUEST_ID\n");
  return 125;
}
