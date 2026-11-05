// Runs one command inside a Windows job object and reports its wall time, CPU time and peak resident set size.
//
// The job object holds the command and every process it starts (workers, browsers, dev servers), so "peak RSS" is the
// largest sum of working sets over the whole tree, sampled every few milliseconds, and nothing it starts can outlive
// the run: the job is terminated when the command exits.
//
// Input (environment): RSSWRAP_CMDLINE (full command line), RSSWRAP_CWD, RSSWRAP_OUT (result JSON path),
// RSSWRAP_TIMEOUT_MS (optional). stdin, stdout and stderr of this process are handed to the command.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class RssWrap
{
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint WAIT_OBJECT_0 = 0;
    const int STD_INPUT_HANDLE = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE = -12;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_MEMORY_COUNTERS
    {
        public uint cb, PageFaultCount;
        public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int size, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int size, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder commandLine, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("psapi.dll", SetLastError = true)] static extern bool GetProcessMemoryInfo(IntPtr process, out PROCESS_MEMORY_COUNTERS counters, uint size);

    static string Json(string s)
    {
        StringBuilder b = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') b.Append("\\\"");
            else if (c == '\\') b.Append("\\\\");
            else if (c < 32) b.Append("\\u" + ((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    static string Take(string name)
    {
        string v = Environment.GetEnvironmentVariable(name);
        Environment.SetEnvironmentVariable(name, null);
        return v;
    }

    // Working set of every process in the job right now, and the per-process peaks seen so far.
    static ulong Sample(IntPtr job, Dictionary<uint, ulong> peaks, out int count)
    {
        int size = 16 + 8 * 4096;
        IntPtr buf = Marshal.AllocHGlobal(size);
        ulong total = 0;
        count = 0;
        try
        {
            int returned;
            if (!QueryInformationJobObject(job, 3, buf, size, out returned)) return 0;
            int listed = Marshal.ReadInt32(buf, 4);
            for (int i = 0; i < listed; i++)
            {
                uint pid = (uint)Marshal.ReadInt64(buf, 8 + 8 * i);
                IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (h == IntPtr.Zero) continue;
                PROCESS_MEMORY_COUNTERS c;
                if (GetProcessMemoryInfo(h, out c, (uint)Marshal.SizeOf(typeof(PROCESS_MEMORY_COUNTERS))))
                {
                    total += (ulong)c.WorkingSetSize;
                    ulong peak = (ulong)c.PeakWorkingSetSize;
                    ulong old;
                    if (!peaks.TryGetValue(pid, out old) || peak > old) peaks[pid] = peak;
                    count++;
                }
                CloseHandle(h);
            }
        }
        finally { Marshal.FreeHGlobal(buf); }
        return total;
    }

    static int Main()
    {
        string cmd = Take("RSSWRAP_CMDLINE");
        string cwd = Take("RSSWRAP_CWD");
        string outPath = Take("RSSWRAP_OUT");
        string timeoutText = Take("RSSWRAP_TIMEOUT_MS");
        long timeoutMs = timeoutText == null ? 0 : long.Parse(timeoutText, CultureInfo.InvariantCulture);
        if (cmd == null || outPath == null) { Console.Error.WriteLine("rsswrap: RSSWRAP_CMDLINE and RSSWRAP_OUT are required"); return 2; }

        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, 9, ref limit, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        PROCESS_INFORMATION pi;
        Stopwatch clock = Stopwatch.StartNew();
        if (!CreateProcessW(null, new StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi))
        {
            File.WriteAllText(outPath, "{\"started\":false,\"error\":" + Json("CreateProcess failed: " + Marshal.GetLastWin32Error()) + "}");
            return 3;
        }
        AssignProcessToJobObject(job, pi.hProcess);
        ResumeThread(pi.hThread);

        Dictionary<uint, ulong> peaks = new Dictionary<uint, ulong>();
        ulong peakTotal = 0;
        int peakProcs = 0;
        bool timedOut = false;
        while (WaitForSingleObject(pi.hProcess, 8) != WAIT_OBJECT_0)
        {
            int n;
            ulong total = Sample(job, peaks, out n);
            if (total > peakTotal) peakTotal = total;
            if (n > peakProcs) peakProcs = n;
            if (timeoutMs > 0 && clock.ElapsedMilliseconds > timeoutMs) { timedOut = true; break; }
        }
        double wallMs = clock.Elapsed.TotalMilliseconds;
        uint exitCode = 1;
        if (timedOut) TerminateJobObject(job, 1); else GetExitCodeProcess(pi.hProcess, out exitCode);

        // Anything still alive after the command exited is a leftover (a server or browser it did not stop).
        int leftovers;
        ulong lastTotal = Sample(job, peaks, out leftovers);
        if (lastTotal > peakTotal) peakTotal = lastTotal;
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION acct;
        int ret;
        double cpuMs = 0;
        int totalProcs = 0;
        if (QueryInformationJobObject(job, 1, out acct, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), out ret))
        {
            cpuMs = (acct.TotalUserTime + acct.TotalKernelTime) / 10000.0;
            totalProcs = (int)acct.TotalProcesses;
        }
        TerminateJobObject(job, 1);
        ulong sumPeaks = 0;
        foreach (ulong p in peaks.Values) sumPeaks += p;

        string json = "{\"started\":true,\"exitCode\":" + exitCode.ToString(CultureInfo.InvariantCulture)
            + ",\"timedOut\":" + (timedOut ? "true" : "false")
            + ",\"innerWallMs\":" + wallMs.ToString("F3", CultureInfo.InvariantCulture)
            + ",\"cpuMs\":" + cpuMs.ToString("F1", CultureInfo.InvariantCulture)
            + ",\"peakRssBytes\":" + peakTotal.ToString(CultureInfo.InvariantCulture)
            + ",\"sumOfProcessPeaksBytes\":" + sumPeaks.ToString(CultureInfo.InvariantCulture)
            + ",\"peakProcesses\":" + peakProcs.ToString(CultureInfo.InvariantCulture)
            + ",\"totalProcesses\":" + totalProcs.ToString(CultureInfo.InvariantCulture)
            + ",\"leftoverProcesses\":" + leftovers.ToString(CultureInfo.InvariantCulture) + "}";
        File.WriteAllText(outPath, json);
        return 0;
    }
}
