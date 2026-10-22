/* The named pipe server of `tsc-ts --api --pipe` on Windows (pipe-win32.c). */
#ifndef TSC_TS_PIPE_WIN32_H
#define TSC_TS_PIPE_WIN32_H

#include <stddef.h>
#include <stdint.h>
#include <windows.h>

/* Creates the one instance of the pipe `name`, open only to this process's
 * user and to local clients; INVALID_HANDLE_VALUE (with GetLastError) on
 * failure. */
HANDLE tsc_ts_create_pipe(const wchar_t *name);

/* The descriptor of a client of this process's user connected to the pipe
 * named by the UTF-8 `bytes`, which it creates, or -1 after an error
 * message on standard error. */
int32_t tsc_ts_open_pipe(const uint8_t *bytes, size_t size);

#endif
