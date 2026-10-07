// Command xxh3-vectors prints XXH3-128 reference vectors as JSON.
//
//	go run . > vectors.json
//	go run . -bench 10485760
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/zeebo/xxh3"
)

// input returns n deterministic bytes (LCG seeded with n).
func input(n int) []byte {
	b := make([]byte, n)
	s := uint32(n)
	for i := range b {
		s = s*1664525 + 1013904223
		b[i] = byte(s >> 24)
	}
	return b
}

func hex(h xxh3.Uint128) string {
	return fmt.Sprintf("%016x%016x", h.Hi, h.Lo)
}

type streamCase struct {
	Length int    `json:"length"`
	Chunks []int  `json:"chunks"`
	Hash   string `json:"hash"`
}

type stringCase struct {
	Text string `json:"text"`
	Hash string `json:"hash"`
}

type vectors struct {
	Sizes   []int        `json:"sizes"`
	Hashes  []string     `json:"hashes"`
	Streams []streamCase `json:"streams"`
	Strings []stringCase `json:"strings"`
}

func main() {
	bench := flag.Int("bench", 0, "hash this many bytes and report throughput")
	flag.Parse()
	if *bench > 0 {
		b := input(*bench)
		const runs = 20
		start := time.Now()
		var h xxh3.Uint128
		for range runs {
			h = xxh3.Hash128(b)
		}
		d := time.Since(start) / runs
		fmt.Printf("%s %.0f MB/s\n", hex(h), float64(len(b))/1e6/d.Seconds())
		return
	}

	var v vectors
	for n := 0; n <= 300; n++ {
		v.Sizes = append(v.Sizes, n)
	}
	v.Sizes = append(v.Sizes, 1024, 1087, 1088, 1089, 2048, 4096, 4097, 102400, 1048576, 1048576+63)
	for _, n := range v.Sizes {
		v.Hashes = append(v.Hashes, hex(xxh3.Hash128(input(n))))
	}

	patterns := [][]int{{1}, {7}, {64}, {1000}, {1024}, {1088}, {1089}, {4096}, {3, 1021, 64, 1, 2000, 5}}
	lengths := []int{0, 1, 17, 129, 240, 241, 1024, 1087, 1088, 1089, 2112, 4097, 102400, 1048576}
	for _, n := range lengths {
		b := input(n)
		for _, chunks := range patterns {
			h := xxh3.New128()
			for i, off := 0, 0; off < n; i++ {
				end := min(off+chunks[i%len(chunks)], n)
				h.Write(b[off:end])
				off = end
			}
			v.Streams = append(v.Streams, streamCase{n, chunks, hex(h.Sum128())})
		}
	}

	for _, s := range []string{"", "a", "abc", "héllo wörld", "日本語のテキスト", "emoji 😀 and more 🎉", "const x: number = 1;\n"} {
		v.Strings = append(v.Strings, stringCase{s, hex(xxh3.HashString128(s))})
	}

	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
}
