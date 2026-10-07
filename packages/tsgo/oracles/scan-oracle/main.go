// Command scan-oracle prints TypeScript-Go's token stream for a file.
package main

import (
	"bufio"
	"fmt"
	"os"
	"time"

	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/scanner"
)

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	text := string(data)
	if len(os.Args) > 2 && os.Args[2] == "--bench" {
		start := time.Now()
		count := 0
		for range 20 {
			s := scanner.NewScanner()
			s.SetText(text)
			s.SetScriptTarget(core.ScriptTargetLatest)
			for s.Scan() != 1 {
				count++
			}
		}
		fmt.Printf("tokens %d time %.2fms\n", count, float64(time.Since(start).Microseconds())/1000/20)
		return
	}
	s := scanner.NewScanner()
	s.SetText(text)
	s.SetScriptTarget(core.ScriptTargetLatest)
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	for {
		k := s.Scan()
		fmt.Fprintf(w, "%d %d %d %d\n", k, s.TokenStart(), s.TokenEnd(), s.TokenFlags())
		if k == 1 {
			break
		}
	}
}
