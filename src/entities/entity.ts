import type { PKey } from "./types";

export default class Entity<T, U extends string> {
  id!: PKey<U>;
  constructor(attrs?: Partial<T>) {
    if (attrs) {
      Object.assign(this, attrs);
    }
  }
}
