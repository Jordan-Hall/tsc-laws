/* The named pipe `tsc-ts --api --pipe` serves on Windows, where a client
 * such as scriptc's Node host has no synchronous standard streams of a
 * child: the server creates the pipe, waits for its one client, and hands
 * the connection to the API server as a C runtime descriptor, which it
 * reads and writes as it does standard input and output. Linked only into
 * the Windows build (scripts/build-native.mjs).
 *
 * Only the user the server runs as can open the pipe: its DACL grants
 * access to that user's SID alone, so another local user cannot take the
 * one instance before the intended client, and the server serves a client
 * only after checking that it runs as the same user. */
#include <fcntl.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <windows.h>
#include <sddl.h>

#include "pipe-win32.h"

static void report(const char *operation, const wchar_t *name) {
  DWORD code = GetLastError();
  char message[512];
  DWORD length = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, code, 0,
                                message, sizeof message, NULL);
  while (length > 0 && (message[length - 1] == '\n' || message[length - 1] == '\r')) length--;
  fprintf(stderr, "tsc-ts: %s %ls: %.*s (%lu)\n", operation, name, (int)length, message, (unsigned long)code);
}

/* The user SID of a process's token, allocated with malloc, or NULL. */
static PSID process_user(HANDLE process) {
  HANDLE token;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) return NULL;
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  TOKEN_USER *user = size > 0 ? malloc(size) : NULL;
  PSID sid = NULL;
  if (user != NULL && GetTokenInformation(token, TokenUser, user, size, &size)) {
    DWORD length = GetLengthSid(user->User.Sid);
    sid = malloc(length);
    if (sid != NULL && !CopySid(length, sid, user->User.Sid)) {
      free(sid);
      sid = NULL;
    }
  }
  free(user);
  CloseHandle(token);
  return sid;
}

HANDLE tsc_ts_create_pipe(const wchar_t *name) {
  /* A protected DACL with one entry: all access for this process's user. */
  PSID user = process_user(GetCurrentProcess());
  wchar_t *sid_text = NULL;
  if (user == NULL || !ConvertSidToStringSidW(user, &sid_text)) {
    free(user);
    return INVALID_HANDLE_VALUE;
  }
  free(user);
  wchar_t sddl[256];
  int written = swprintf(sddl, sizeof sddl / sizeof sddl[0], L"D:P(A;;GA;;;%ls)", sid_text);
  LocalFree(sid_text);
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (written < 0 ||
      !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &descriptor, NULL))
    return INVALID_HANDLE_VALUE;
  SECURITY_ATTRIBUTES security = {sizeof security, descriptor, FALSE};
  /* One instance, local clients only, byte mode with blocking reads and
   * writes, as tsgo's server makes it. */
  HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                 PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1,
                                 1 << 16, 1 << 16, 0, &security);
  DWORD code = GetLastError();
  LocalFree(descriptor);
  SetLastError(code);
  return pipe;
}

/* Whether the client connected to `pipe` runs as the same user as this process. */
static int client_is_same_user(HANDLE pipe) {
  ULONG pid = 0;
  if (!GetNamedPipeClientProcessId(pipe, &pid)) return 0;
  HANDLE client = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (client == NULL) return 0;
  PSID theirs = process_user(client);
  CloseHandle(client);
  PSID ours = process_user(GetCurrentProcess());
  int same = theirs != NULL && ours != NULL && EqualSid(theirs, ours);
  free(theirs);
  free(ours);
  return same;
}

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
  HANDLE pipe = tsc_ts_create_pipe(name);
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
  if (!client_is_same_user(pipe)) {
    fprintf(stderr, "tsc-ts: the client of pipe %ls does not run as this user\n", name);
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
