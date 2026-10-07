package checkhost

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"time"

	"github.com/microsoft/typescript-go/internal/execute"
	"github.com/microsoft/typescript-go/internal/tspath"
	"github.com/microsoft/typescript-go/internal/vfs"
)

// Host is the file system and output of a tsc run, provided by the caller.
type Host struct {
	Cwd     string
	LibPath string
	// ReadFile returns a file's contents.
	ReadFile func(path string) (string, bool)
	// WriteFile writes a file, creating its directory.
	WriteFile func(path string, data string) bool
	// Stat returns 1 for a file, 2 for a directory, 0 if path doesn't exist,
	// with the size and modification time in milliseconds.
	Stat func(path string) (kind int, size int, mtime float64)
	// ReadDir returns the names of a directory's files and directories,
	// following symbolic links.
	ReadDir  func(path string) (files []string, dirs []string)
	Realpath func(path string) string
	Write    func(text string)
	Now      func() float64
}

// RunTSC runs the tsc command line with args and returns its exit status.
func RunTSC(host *Host, args []string) int {
	sys := &hostSys{host: host, fs: &hostFS{host: host}, start: host.Now()}
	return int(execute.CommandLine(context.Background(), sys, args, nil).Status)
}

type hostSys struct {
	host  *Host
	fs    *hostFS
	start float64
}

func (s *hostSys) Writer() io.Writer                         { return &hostWriter{s.host} }
func (s *hostSys) ErrorWriter() io.Writer                    { return &hostWriter{s.host} }
func (s *hostSys) FS() vfs.FS                                { return s.fs }
func (s *hostSys) DefaultLibraryPath() string                { return s.host.LibPath }
func (s *hostSys) GetCurrentDirectory() string               { return s.host.Cwd }
func (s *hostSys) WriteOutputIsTTY() bool                    { return false }
func (s *hostSys) GetWidthOfTerminal() int                   { return 0 }
func (s *hostSys) GetEnvironmentVariable(name string) string { return "" }
func (s *hostSys) Now() time.Time                            { return time.UnixMilli(int64(s.host.Now())) }
func (s *hostSys) SinceStart() time.Duration {
	return time.Duration((s.host.Now() - s.start) * float64(time.Millisecond))
}

func (s *hostSys) Spawn(command []string, dir string, stderr io.Writer) (io.ReadWriteCloser, error) {
	return nil, errors.New("spawn is not supported")
}

type hostWriter struct{ host *Host }

func (w *hostWriter) Write(p []byte) (int, error) {
	w.host.Write(string(p))
	return len(p), nil
}

type hostFS struct{ host *Host }

func (f *hostFS) UseCaseSensitiveFileNames() bool { return true }

func (f *hostFS) FileExists(path string) bool {
	kind, _, _ := f.host.Stat(path)
	return kind == 1
}

func (f *hostFS) DirectoryExists(path string) bool {
	kind, _, _ := f.host.Stat(path)
	return kind == 2
}

func (f *hostFS) ReadFile(path string) (string, bool) { return f.host.ReadFile(path) }

func (f *hostFS) WriteFile(path string, data string) error {
	if !f.host.WriteFile(path, data) {
		return errors.New("cannot write " + path)
	}
	return nil
}

func (f *hostFS) AppendFile(path string, data string) error {
	old, _ := f.host.ReadFile(path)
	return f.WriteFile(path, old+data)
}

func (f *hostFS) Remove(path string) error { return errors.New("remove is not supported") }

func (f *hostFS) Chtimes(path string, aTime time.Time, mTime time.Time) error { return nil }

func (f *hostFS) GetAccessibleEntries(path string) vfs.Entries {
	files, dirs := f.host.ReadDir(path)
	return vfs.Entries{Files: files, Directories: dirs}
}

func (f *hostFS) Stat(path string) vfs.FileInfo {
	kind, size, mtime := f.host.Stat(path)
	if kind == 0 {
		return nil
	}
	return &hostFileInfo{name: tspath.GetBaseFileName(path), dir: kind == 2, size: size, mtime: mtime}
}

// WalkDir is only used by watch mode and the language service.
func (f *hostFS) WalkDir(root string, walkFn vfs.WalkDirFunc) error {
	return errors.New("walking directories is not supported")
}

func (f *hostFS) Realpath(path string) string { return f.host.Realpath(path) }

type hostFileInfo struct {
	name  string
	dir   bool
	size  int
	mtime float64
}

func (i *hostFileInfo) Name() string { return i.name }
func (i *hostFileInfo) Size() int64  { return int64(i.size) }
func (i *hostFileInfo) Mode() fs.FileMode {
	if i.dir {
		return fs.ModeDir | 0o755
	}
	return 0o644
}
func (i *hostFileInfo) ModTime() time.Time { return time.UnixMilli(int64(i.mtime)) }
func (i *hostFileInfo) IsDir() bool        { return i.dir }
func (i *hostFileInfo) Sys() any           { return nil }
