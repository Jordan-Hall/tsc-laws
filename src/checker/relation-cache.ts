// Numeric pair cache: concrete native arrays avoid checked-value Map key/value boxing.
// A generation counter makes cold relation resets independent of cache size.
export class RelationCache {
  private capacity = 1024;
  private keys = new Float64Array(1024);
  private values = new Int8Array(1024);
  private generations = new Uint32Array(1024);
  private generation = 1;
  private count = 0;

  get(key: number): number {
    let slot = this.hash(key) & (this.capacity - 1);
    while (this.generations[slot] === this.generation) {
      if (this.keys[slot] === key) return this.values[slot];
      slot = (slot + 1) & (this.capacity - 1);
    }
    return 2;
  }

  set(key: number, value: number): void {
    if ((this.count + 1) * 4 >= this.capacity * 3) this.grow();
    let slot = this.hash(key) & (this.capacity - 1);
    while (this.generations[slot] === this.generation && this.keys[slot] !== key) slot = (slot + 1) & (this.capacity - 1);
    if (this.generations[slot] !== this.generation) {
      this.generations[slot] = this.generation;
      this.keys[slot] = key;
      this.count++;
    }
    this.values[slot] = value;
  }

  clear(): void {
    this.count = 0;
    if (this.generation === 0xffffffff) {
      this.generations.fill(0);
      this.generation = 1;
    } else this.generation++;
  }

  private hash(key: number): number {
    let hash = (key >>> 0) ^ (Math.floor(key / 4294967296) >>> 0);
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
    return hash ^ (hash >>> 16);
  }

  private grow(): void {
    const oldKeys = this.keys;
    const oldValues = this.values;
    const oldGenerations = this.generations;
    const oldCapacity = this.capacity;
    this.capacity *= 2;
    this.keys = new Float64Array(this.capacity);
    this.values = new Int8Array(this.capacity);
    this.generations = new Uint32Array(this.capacity);
    this.count = 0;
    for (let i = 0; i < oldCapacity; i++) {
      if (oldGenerations[i] === this.generation) this.set(oldKeys[i], oldValues[i]);
    }
  }
}
