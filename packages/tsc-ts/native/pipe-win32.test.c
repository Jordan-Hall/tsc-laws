/* Checks the DACL of the pipe tsc_ts_create_pipe makes: protected, with one
 * entry, allowing all access to the current user only. The Windows CI job
 * builds it with zig and runs it. Exits 0 when the DACL is as expected. */
#include <stdio.h>
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>

#include "pipe-win32.h"

static int fail(const char *message) {
  fprintf(stderr, "pipe-win32.test: %s (%lu)\n", message, (unsigned long)GetLastError());
  return 1;
}

int main(void) {
  wchar_t name[128];
  swprintf(name, sizeof name / sizeof name[0], L"\\\\.\\pipe\\tsc-ts-dacl-test-%lu", (unsigned long)GetCurrentProcessId());
  HANDLE pipe = tsc_ts_create_pipe(name);
  if (pipe == INVALID_HANDLE_VALUE) return fail("cannot create the pipe");
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (GetSecurityInfo(pipe, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, &dacl, NULL, &descriptor) !=
      ERROR_SUCCESS)
    return fail("cannot read the pipe's DACL");
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision)) return fail("cannot read the descriptor control");
  if ((control & SE_DACL_PROTECTED) == 0) return fail("the DACL is not protected");
  if (dacl == NULL || dacl->AceCount != 1) return fail("the DACL does not have exactly one entry");
  ACCESS_ALLOWED_ACE *ace = NULL;
  if (!GetAce(dacl, 0, (void **)&ace) || ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE)
    return fail("the entry is not an access-allowed entry");
  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return fail("cannot open the process token");
  BYTE buffer[512];
  DWORD size = 0;
  if (!GetTokenInformation(token, TokenUser, buffer, sizeof buffer, &size)) return fail("cannot read the token user");
  if (!EqualSid((PSID)&ace->SidStart, ((TOKEN_USER *)buffer)->User.Sid))
    return fail("the entry is not for the current user");
  /* GENERIC_ALL maps to the pipe's full access rights. */
  if ((ace->Mask & FILE_ALL_ACCESS) != FILE_ALL_ACCESS) return fail("the entry does not grant full access");
  LocalFree(descriptor);
  CloseHandle(token);
  CloseHandle(pipe);
  printf("the pipe's DACL grants access to the current user only\n");
  return 0;
}
