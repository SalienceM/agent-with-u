import { SessionFavorites, favoriteRevision, type FavoriteIO, type FavoriteRepository, type FavoriteTarget } from './sessionFavorites';

export interface PrivacyRemote { isPrivate: boolean; privacyRevision: number; lastRequestId?: string }
export interface PrivacyIO extends Omit<FavoriteIO, 'remote'> { remote(target: FavoriteTarget, value: PrivacyRemote): void }
export function mergePrivacyRemote(current: any, incoming: any): any {
  return favoriteRevision(current?.privacyRevision) && (!favoriteRevision(incoming?.privacyRevision) || incoming.privacyRevision < current.privacyRevision)
    ? { ...incoming, isPrivate: current.isPrivate, privacyRevision: current.privacyRevision } : incoming;
}

/** 复用经过离线/并发验证的布尔选择协调器，仅转换私密字段和专用 RPC。 */
export class SessionPrivacy extends SessionFavorites {
  private loaded = false;
  private readonly notify: () => void;
  constructor(repository: FavoriteRepository, io: PrivacyIO) {
    super(repository, { ...io,
      call: async (target, method, params) => {
        const args = [...params];
        if (method === 'sessionFavoriteSet') {
          const { pinned, ...rest } = JSON.parse(args[1]); args[1] = JSON.stringify({ ...rest, isPrivate: pinned });
        }
        try {
          const result = await io.call(target, method.replace('Favorite', 'Privacy'), args);
          return result == null ? result : { ...result, pinned: result.isPrivate, favoriteRevision: result.privacyRevision };
        } catch (error) {
          if (error instanceof Error) error.message = error.message.replaceAll('收藏', '私密');
          throw error;
        }
      },
      remote: (target, value) => io.remote(target, { isPrivate: value.pinned, privacyRevision: value.favoriteRevision, lastRequestId: value.lastRequestId }),
    });
    this.notify = io.changed;
  }
  async reload(): Promise<void> {
    try { await super.reload(); this.loaded = true; }
    catch (error) { this.loaded = false; throw error; }
    finally { this.notify(); }
  }
  async choose(target: FavoriteTarget, value: boolean, observedRevision: unknown): Promise<void> {
    if (!this.loaded) await this.reload();
    await super.choose(target, value, observedRevision);
  }
  project(target: FavoriteTarget, remote: any): any {
    const view = super.project(target, { pinned: !!remote.isPrivate, favoriteRevision: remote.privacyRevision });
    return { ...remote, privacyKnown: this.loaded, isPrivate: view.pinned, privacyStatus: view.favoriteStatus,
      privacyMessage: view.favoriteMessage?.replaceAll('收藏', '私密') };
  }
}
