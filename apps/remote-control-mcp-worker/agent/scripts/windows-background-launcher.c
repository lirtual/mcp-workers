// Windowless Windows Task Scheduler entrypoint. No shell, no command interpreter.
// A private job owns the native Node Agent and kills it when the task is stopped.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>
#include <stdio.h>

#define PATH_CAP 32768
static wchar_t executable[PATH_CAP];
static wchar_t node[PATH_CAP];
static wchar_t rust_agent[PATH_CAP];
static wchar_t entry[PATH_CAP];
static wchar_t resolved[PATH_CAP];
static wchar_t command[PATH_CAP];

static int regular_file(const wchar_t *name) {
    DWORD attributes = GetFileAttributesW(name);
    return attributes != INVALID_FILE_ATTRIBUTES &&
        !(attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT));
}
static int acceptable_generation(const wchar_t *value) {
    if (wcslen(value) != 36) return 0;
    for (size_t i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (value[i] != L'-') return 0;
        } else if (!((value[i] >= L'0' && value[i] <= L'9') ||
                     (value[i] >= L'a' && value[i] <= L'f'))) return 0;
    }
    return 1;
}
static int acceptable_endpoint(const wchar_t *value) {
    size_t n = wcslen(value);
    if (n < 11 || n > 256 || wcsncmp(value, L"https://", 8) != 0 ||
        value[n - 1] != L'/') return 0;
    for (size_t i = 8; i < n; ++i) {
        wchar_t c = value[i];
        if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') ||
              (c >= L'0' && c <= L'9') || c == L'.' || c == L'-' ||
              c == L':' || c == L'/')) return 0;
    }
    for (size_t i = 8; i + 1 < n; ++i) if (value[i] == L'/') return 0;
    return n > 9;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR unused, int show) {
    (void)instance; (void)previous; (void)unused; (void)show;
    int argc = 0, rc = 1;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    HANDLE job = NULL;
    PROCESS_INFORMATION child = {0};
    if (!argv) goto done;
    DWORD count = GetModuleFileNameW(NULL, executable, PATH_CAP);
    if (!count || count >= PATH_CAP) goto done;
    wchar_t *slash = wcsrchr(executable, L'\\');
    if (!slash) goto done;
    slash[1] = L'\0';
    if (swprintf_s(node, PATH_CAP, L"%lsnode.exe", executable) < 0 ||
        swprintf_s(resolved, PATH_CAP,
            L"%ls..\\apps\\remote-control-agent\\src\\windows-v2.js", executable) < 0)
        goto done;
    DWORD length = GetFullPathNameW(resolved, PATH_CAP, entry, NULL);
    if (!length || length >= PATH_CAP || !regular_file(node) || !regular_file(entry)) goto done;

    const wchar_t *child_exe = node;
    if (argc == 5 && wcscmp(argv[2], L"run") == 0 &&
        wcscmp(argv[3], L"--endpoint") == 0 && acceptable_endpoint(argv[4]) &&
        CompareStringOrdinal(argv[1], -1, entry, -1, TRUE) == CSTR_EQUAL) {
        if (swprintf_s(command, PATH_CAP, L"\"%ls\" \"%ls\" run --endpoint \"%ls\"",
                       node, entry, argv[4]) < 0) goto done;
    } else if (argc == 7 && wcscmp(argv[2], L"--service") == 0 &&
        wcscmp(argv[3], L"--endpoint") == 0 && acceptable_endpoint(argv[4]) &&
        wcscmp(argv[5], L"--generation") == 0 && acceptable_generation(argv[6])) {
        if (swprintf_s(resolved, PATH_CAP,
            L"%ls..\\apps\\remote-control-agent\\.build\\rca-standard-windows-candidate.exe", executable) < 0)
            goto done;
        length = GetFullPathNameW(resolved, PATH_CAP, rust_agent, NULL);
        if (!length || length >= PATH_CAP || !regular_file(rust_agent) ||
            CompareStringOrdinal(argv[1], -1, rust_agent, -1, TRUE) != CSTR_EQUAL) goto done;
        child_exe = rust_agent;
        if (swprintf_s(command, PATH_CAP,
            L"\"%ls\" --service --endpoint \"%ls\" --generation \"%ls\"",
            rust_agent, argv[4], argv[6]) < 0) goto done;
    } else goto done;

    job = CreateJobObjectW(NULL, NULL);
    if (!job) goto done;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits))) goto done;
    STARTUPINFOW startup = {0};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(child_exe, command, NULL, NULL, FALSE,
                        CREATE_NO_WINDOW | CREATE_SUSPENDED,
                        NULL, executable, &startup, &child)) goto done;
    if (!AssignProcessToJobObject(job, child.hProcess)) goto done;
    if (ResumeThread(child.hThread) == (DWORD)-1) goto done;
    if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0) goto done;
    DWORD exit_code = 1;
    if (!GetExitCodeProcess(child.hProcess, &exit_code)) goto done;
    rc = (int)exit_code;
done:
    if (child.hProcess) {
        if (rc != 0) TerminateProcess(child.hProcess, 1);
        CloseHandle(child.hProcess);
    }
    if (child.hThread) CloseHandle(child.hThread);
    if (job) CloseHandle(job);
    if (argv) LocalFree(argv);
    return rc;
}
