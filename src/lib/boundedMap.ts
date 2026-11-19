/** A size-bounded cache; refreshing a key makes it the newest entry. */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly limit: number) {
    super();
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Cache limit must be a positive integer');
  }

  override set(key: K, value: V): this {
    this.delete(key);
    super.set(key, value);
    if (this.size > this.limit) this.delete(this.keys().next().value!);
    return this;
  }
}
