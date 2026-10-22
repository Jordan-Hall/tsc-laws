/* The named pipe `tsc-ts --api --pipe` serves on Windows, where a client
 * such as scriptc's Node host has no synchronous standard streams of a
 * child: the server creates the pipe, waits for its one client, and hands
 * the connection to the API server as a C runtime descriptor, which it
 * reads and writes as it does standard input and output. Linked only into
 * the Windows build (scripts/build-native.mjs). */
#include <fcntl.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <windows.h>

static void report(const char *operation, const wchar_t *name) {
  DWORD code = GetLastError();
  char message[512];
  DWORD length = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, code, 0,
                                message, sizeof message, NULL);
  while (length > 0 && (message[length - 1] == '\n' || message[length - 1] == '\r')) length--;
  fprintf(stderr, "tsc-ts: %s %ls: %.*s (%lu)\n", operation, name, (int)length, message, (unsigned long)code);
}

/* The descriptor of a connected pipe named by the UTF-8 `bytes`, or -1
 * after an error message on standard error. */
int32_t tsc_ts_open_pipe(const uint8_t *bytes, size_t size) {
  if (size == 0 || size > 32767) {
    fprintf(stderr, "tsc-ts: invalid pipe name\n");
    return -1;
  }
  int wide_size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)bytes, (int)size, NULL, 0);
  if (wide_size <= 0) {
    fprintf(stderr, "tsc-ts: invalid pipe name\n");
    return -1;
  }
  wchar_t *name = malloc(((size_t)wide_size + 1) * sizeof(wchar_t));
  if (name == NULL) {
    fprintf(stderr, "tsc-ts: out of memory\n");
    return -1;
  }
  MultiByteToWideChar(CP_UTF8, 0, (const char *)bytes, (int)size, name, wide_size);
  name[wide_size] = 0;
  /* One instance, local clients only, byte mode with blocking reads and
   * writes, as tsgo's server makes it. */
  HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                 PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1,
                                 1 << 16, 1 << 16, 0, NULL);
  if (pipe == INVALID_HANDLE_VALUE) {
    report("cannot create pipe", name);
    free(name);
    return -1;
  }
  /* A client that connected between the two calls is already connected. */
  if (!ConnectNamedPipe(pipe, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) {
    report("cannot accept a client on pipe", name);
    CloseHandle(pipe);
    free(name);
    return -1;
  }
  int fd = _open_osfhandle((intptr_t)pipe, _O_BINARY);
  if (fd < 0) {
    report("cannot open a descriptor for pipe", name);
    CloseHandle(pipe);
  }
  free(name);
  return fd;
}
