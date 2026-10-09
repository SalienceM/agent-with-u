/** 推送或更新的读取优先；迟到的只读响应不能复活已处理的计划。 */
export class AuthoritativeReadGate {
  private clock = 0;
  private revisions = new Map<string, number>();
  begin(key: string): number {
    const revision = ++this.clock;
    this.revisions.delete(key); this.revisions.set(key, revision);
    while (this.revisions.size > 512) this.revisions.delete(this.revisions.keys().next().value!);
    return revision;
  }
  current(key: string, revision: number): boolean { return this.revisions.get(key) === revision; }
  clear() { this.clock++; this.revisions.clear(); }
}
