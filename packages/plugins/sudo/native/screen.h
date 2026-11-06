/* Only pre-authentication presentation data enters this pipe. No terminal queries or readback. */
#include <sys/ioctl.h>

struct screen {
  int columns, rows, top;
  uint32_t colors[5];
  char *background;
  int original_columns, original_rows;
};

static int screen_read(void *data, size_t length) {
  int64_t deadline = milliseconds() + 1000;
  unsigned char *cursor = data;
  while (length) {
    struct pollfd input = {3, POLLIN, 0};
    int64_t remaining = deadline - milliseconds();
    if (remaining <= 0 || poll(&input, 1, (int)remaining) <= 0) return -1;
    ssize_t count = read(3, cursor, length);
    if (count <= 0) return -1;
    cursor += count;
    length -= (size_t)count;
  }
  return 0;
}

static struct screen screen_load(void) {
  struct screen screen = { .columns = 80, .rows = 24, .top = 1 };
  for (int i = 0; i < 5; i++) screen.colors[i] = UINT32_MAX;
  unsigned char header[40];
  if (screen_read(header, sizeof(header)) || memcmp(header, "OCUI1\0\0\0", 8)) goto done;
  uint32_t values[8];
  memcpy(values, header + 8, sizeof(values));
  for (int i = 0; i < 8; i++) values[i] = ntohl(values[i]);
  if (values[0] > 500 || values[1] > 200 || values[7] > 65536) goto done;
  for (int i = 2; i < 7; i++) if (values[i] > 0xffffff && values[i] != UINT32_MAX) goto done;
  screen.original_columns = (int)values[0];
  screen.original_rows = (int)values[1];
  memcpy(screen.colors, values + 2, sizeof(screen.colors));
  screen.background = calloc(values[7] + 1, 1);
  if (!screen.background || screen_read(screen.background, values[7])) {
    free(screen.background);
    screen.background = NULL;
    goto done;
  }
  for (uint32_t i = 0; i < values[7]; i++)
    if (screen.background[i] != '\n' && (screen.background[i] < 32 || screen.background[i] > 126)) screen.background[i] = ' ';
 done:
  close(3);
  return screen;
}

static void screen_color(int tty, struct screen *screen, int role) {
  uint32_t fg = screen->colors[role], bg = screen->colors[1];
  dprintf(tty, "\033[0m");
  if (fg != UINT32_MAX) dprintf(tty, "\033[38;2;%u;%u;%um", fg >> 16, (fg >> 8) & 255, fg & 255);
  if (bg != UINT32_MAX) dprintf(tty, "\033[48;2;%u;%u;%um", bg >> 16, (bg >> 8) & 255, bg & 255);
}

static void screen_size(int tty, struct screen *screen) {
  struct winsize size;
  if (!ioctl(tty, TIOCGWINSZ, &size) && size.ws_col > 0 && size.ws_row > 0) {
    screen->columns = size.ws_col > 500 ? 500 : size.ws_col;
    screen->rows = size.ws_row > 200 ? 200 : size.ws_row;
  }
  screen->top = screen->rows >= 10 ? screen->rows - 7 : 1;
}

static void screen_line(int tty, struct screen *screen, int row, const char *text, int role) {
  screen_color(tty, screen, role);
  dprintf(tty, "\033[%d;1H\033[2K", row);
  int width = screen->columns - 1;
  for (const unsigned char *ch = (const unsigned char *)text; *ch && width > 0; ch++) {
    if (*ch < 32 || *ch > 126) { if (write(tty, "?", 1) != 1) return; }
    else if (write(tty, ch, 1) != 1) return;
    width--;
  }
}

static void screen_begin(int tty, struct screen *screen) {
  screen_size(tty, screen);
  dprintf(tty, "\033[?1049h\033[?6l\033[r\033[2J\033[H");
  if (screen->background && screen->columns == screen->original_columns && screen->rows == screen->original_rows) {
    char *line = screen->background;
    for (int row = 1; row < screen->top && *line; row++) {
      char *end = strchr(line, '\n');
      if (end) *end = 0;
      screen_line(tty, screen, row, line, 3);
      if (!end) break;
      *end = '\n';
      line = end + 1;
    }
  }
  screen_line(tty, screen, screen->top, "--- OpenCode | Run as root ---", 2);
  for (int row = screen->top + 1; row <= screen->rows; row++) screen_line(tty, screen, row, "", 0);
  if (screen->rows >= 8)
    dprintf(tty, "\033[%d;%dr\033[%d;1H", screen->top + 1, screen->rows - 2, screen->top + 1);
  else dprintf(tty, "\033[r\033[%d;1H", screen->rows);
}

/* During authentication sudo/PAM alone reads the terminal. On resize, release the
 * scroll region without querying the cursor or trying to reconstruct its prompt. */
static void screen_resize(int tty, struct screen *screen) {
  screen_size(tty, screen);
  dprintf(tty, "\033[r\033[%d;1H", screen->rows);
}

static void screen_end(int tty, struct screen *screen) {
  dprintf(tty, "\033[0m\033[?6l\033[r\033[?1049l");
  free(screen->background);
}
