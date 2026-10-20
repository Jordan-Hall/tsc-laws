// Side tables of checker links, indexed by node or symbol id.
//
// The checker caches values per node and per symbol. A cached value that many nodes or symbols
// have lives in a table of its own (a column) instead of a field of a links object, so a node or
// symbol costs a slot in each column it uses rather than a whole object, and a lookup is two
// array reads. Columns are stored in pages of `LinkPaging.Size` ids created on first write: a
// checker that touches part of a program (as each of several parallel checkers does) stores only
// the pages it touches.

/** Links are stored in pages of 256 ids. */
export const enum LinkPaging {
  Bits = 8,
  Size = 1 << Bits,
  Mask = Size - 1,
}

/** A page of values, indexed by the low bits of an id; undefined until a value in it is stored. */
export type LinkPage<T> = (T | undefined)[] | undefined;

/** Values by id; undefined where none is stored. */
export class LinkTable<T> {
  readonly pages: LinkPage<T>[] = [];

  get(id: number): T | undefined {
    const page = this.pages[id >> LinkPaging.Bits];
    return page !== undefined ? page[id & LinkPaging.Mask] : undefined;
  }

  set(id: number, value: T | undefined): void {
    const index = id >> LinkPaging.Bits;
    const page = this.pages[index];
    if (page !== undefined) page[id & LinkPaging.Mask] = value;
    else if (value !== undefined) newLinkPage(this.pages, index)[id & LinkPaging.Mask] = value;
  }

  clear(): void {
    this.pages.length = 0;
  }
}

/** Creates the page at `index`, filling the gap below it so the page list stays dense. */
export function newLinkPage<T>(pages: LinkPage<T>[], index: number): (T | undefined)[] {
  while (pages.length <= index) pages.push(undefined);
  const page: (T | undefined)[] = [];
  for (let i = 0; i < LinkPaging.Size; i++) page.push(undefined);
  pages[index] = page;
  return page;
}

/** Int32 values by id, zero where none is stored: flags and small counters. */
export class IntLinkTable {
  readonly pages: (Int32Array | undefined)[] = [];

  get(id: number): number {
    const page = this.pages[id >> LinkPaging.Bits];
    return page !== undefined ? page[id & LinkPaging.Mask]! : 0;
  }

  set(id: number, value: number): void {
    const index = id >> LinkPaging.Bits;
    const page = this.pages[index];
    if (page !== undefined) page[id & LinkPaging.Mask] = value;
    else if (value !== 0) this.newPage(index)[id & LinkPaging.Mask] = value;
  }

  private newPage(index: number): Int32Array {
    while (this.pages.length <= index) this.pages.push(undefined);
    const page = new Int32Array(LinkPaging.Size);
    this.pages[index] = page;
    return page;
  }

  clear(): void {
    this.pages.length = 0;
  }
}

/**
 * Values by id in a map, for ids that are sparse: a checker caches values for a small part of the
 * nodes of a program, spread over the declaration files it reads, where a page would mostly hold
 * empty slots.
 */
export class SparseLinkTable<T> {
  readonly values = new Map<number, T>();

  get(id: number): T | undefined {
    return this.values.get(id);
  }

  set(id: number, value: T | undefined): void {
    if (value !== undefined) this.values.set(id, value);
    else this.values.delete(id);
  }

  clear(): void {
    this.values.clear();
  }
}

/**
 * Values by id for ids in a few clusters, as one file's emit uses them: the file's nodes and the
 * nodes the emit synthesizes, far above them. Pages of `LinkPaging.Size` ids are found through a
 * map from the page index, so the ids between clusters cost nothing, and the page of the last
 * lookup is kept, since lookups come in runs of nearby ids.
 */
export class ClusteredLinkTable<T> {
  private readonly pages = new Map<number, (T | undefined)[]>();
  private lastIndex = -1;
  private lastPage: (T | undefined)[] | undefined = undefined;

  get(id: number): T | undefined {
    const page = this.pageOf(id >> LinkPaging.Bits);
    return page !== undefined ? page[id & LinkPaging.Mask] : undefined;
  }

  set(id: number, value: T | undefined): void {
    const index = id >> LinkPaging.Bits;
    const page = this.pageOf(index);
    if (page !== undefined) page[id & LinkPaging.Mask] = value;
    else if (value !== undefined) {
      const created: (T | undefined)[] = [];
      for (let i = 0; i < LinkPaging.Size; i++) created.push(undefined);
      created[id & LinkPaging.Mask] = value;
      this.pages.set(index, created);
      this.lastPage = created;
    }
  }

  private pageOf(index: number): (T | undefined)[] | undefined {
    if (index !== this.lastIndex) {
      this.lastIndex = index;
      this.lastPage = this.pages.get(index);
    }
    return this.lastPage;
  }
}

/** Int32 values by id, zero where none is stored, for ids in a few clusters (`ClusteredLinkTable`). */
export class ClusteredIntLinkTable {
  private readonly pages = new Map<number, Int32Array>();
  private lastIndex = -1;
  private lastPage: Int32Array | undefined = undefined;

  get(id: number): number {
    const page = this.pageOf(id >> LinkPaging.Bits);
    return page !== undefined ? page[id & LinkPaging.Mask]! : 0;
  }

  set(id: number, value: number): void {
    const index = id >> LinkPaging.Bits;
    const page = this.pageOf(index);
    if (page !== undefined) page[id & LinkPaging.Mask] = value;
    else if (value !== 0) {
      const created = new Int32Array(LinkPaging.Size);
      created[id & LinkPaging.Mask] = value;
      this.pages.set(index, created);
      this.lastPage = created;
    }
  }

  private pageOf(index: number): Int32Array | undefined {
    if (index !== this.lastIndex) {
      this.lastIndex = index;
      this.lastPage = this.pages.get(index);
    }
    return this.lastPage;
  }
}
