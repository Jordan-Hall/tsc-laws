package core

// This file replaces TypeScript-Go's core/text.go when translating. A
// TextRange packs its start and end into one integer, so the translated
// code stores ranges without allocating. Positions must be within ±2^26.

// TextPos

type TextPos int32

// TextRange

type TextRange int64

const textRangeScale = 1 << 27

func makeTextRange(pos TextPos, end TextPos) TextRange {
	const limit = textRangeScale / 2
	if pos <= -limit || pos >= limit || end <= -limit || end >= limit {
		panic("text position out of range")
	}
	return TextRange(int64(pos)*textRangeScale + int64(end))
}

func (t TextRange) pos() TextPos {
	p := int64(t) / textRangeScale
	e := int64(t) % textRangeScale
	if e >= textRangeScale/2 {
		p++
	} else if e < -textRangeScale/2 {
		p--
	}
	return TextPos(p)
}

func (t TextRange) end() TextPos {
	e := int64(t) % textRangeScale
	if e >= textRangeScale/2 {
		e -= textRangeScale
	} else if e < -textRangeScale/2 {
		e += textRangeScale
	}
	return TextPos(e)
}

func NewTextRange(pos int, end int) TextRange {
	return makeTextRange(TextPos(pos), TextPos(end))
}

func UndefinedTextRange() TextRange {
	return makeTextRange(-1, -1)
}

func (t TextRange) Pos() int {
	return int(t.pos())
}

func (t TextRange) End() int {
	return int(t.end())
}

func (t TextRange) Len() int {
	return int(t.end() - t.pos())
}

func (t TextRange) IsValid() bool {
	return t.pos() >= 0 || t.end() >= 0
}

func (t TextRange) Contains(pos int) bool {
	return pos >= int(t.pos()) && pos < int(t.end())
}

func (t TextRange) ContainsInclusive(pos int) bool {
	return pos >= int(t.pos()) && pos <= int(t.end())
}

func (t TextRange) ContainsExclusive(pos int) bool {
	return int(t.pos()) < pos && pos < int(t.end())
}

func (t TextRange) WithPos(pos int) TextRange {
	return makeTextRange(TextPos(pos), t.end())
}

func (t TextRange) WithEnd(end int) TextRange {
	return makeTextRange(t.pos(), TextPos(end))
}

func (t TextRange) ContainedBy(t2 TextRange) bool {
	return t2.pos() <= t.pos() && t2.end() >= t.end()
}

func (t TextRange) Overlaps(t2 TextRange) bool {
	start := max(t.pos(), t2.pos())
	end := min(t.end(), t2.end())
	return start < end
}

// Similar to Overlaps, but treats touching ranges as intersecting.
// For example, [0, 5) intersects [5, 10).
func (t TextRange) Intersects(t2 TextRange) bool {
	start := max(t.pos(), t2.pos())
	end := min(t.end(), t2.end())
	return start <= end
}

func CompareTextRanges(r1 TextRange, r2 TextRange) int {
	c := int(r1.pos()) - int(r2.pos())
	if c != 0 {
		return c
	}
	return int(r1.end()) - int(r2.end())
}
