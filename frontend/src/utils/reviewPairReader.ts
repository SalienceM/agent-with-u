import { reviewScopeKey, type CompareSnapshot, type ReviewPair, type ReviewSide } from './directorySyncReview';

/** 只合并在途请求；完成后不缓存正文。快切达到上限时明确受限，不积压整个目录。 */
export class ReviewPairReader {
  private pending = new Map<string, Promise<{ local: ReviewSide; remote: ReviewSide }>>();
  constructor(private local: (path: string) => Promise<ReviewSide>, private remote: (path: string) => Promise<ReviewSide>) {}
  async read(snapshot: CompareSnapshot, path: string, revision: number): Promise<ReviewPair> {
    const scopeKey = reviewScopeKey(snapshot.scope), key = JSON.stringify([scopeKey, snapshot.revision, path]);
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= 4) throw new Error('read_limit');
      const safe = async (read: (p: string) => Promise<ReviewSide>): Promise<ReviewSide> => {
        try { return await read(path); }
        catch (e) { return { kind: 'unavailable', version: null, reasonCode: e instanceof Error ? e.message : 'read_failed' }; }
      };
      pending = Promise.all([safe(this.local), safe(this.remote)]).then(([local, remote]) => ({ local, remote }));
      this.pending.set(key, pending);
      void pending.finally(() => { this.pending.delete(key); });
    }
    return Object.freeze({ scopeKey, compareRevision: snapshot.revision, readRevision: revision, path, ...await pending });
  }
}
