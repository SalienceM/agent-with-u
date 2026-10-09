/** 路由/账号是流身份的一部分；同名 Session 不能共享累积器。 */
export class ScopedStreamStates<T> {
  private values = new Map<string, T>();
  private key: (session: string, executor?: string) => string = session => session;
  configure(key: (session: string, executor?: string) => string) { this.values.clear(); this.key = key; }
  get(session: string, executor?: string) { return this.values.get(this.key(session, executor)); }
  set(session: string, value: T, executor?: string) { this.values.set(this.key(session, executor), value); }
  delete(session: string, executor?: string) { this.values.delete(this.key(session, executor)); }
  clear() { this.values.clear(); }
}
