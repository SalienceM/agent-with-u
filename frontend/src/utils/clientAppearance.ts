export type ThemeType = 'dark' | 'midnight' | 'light' | 'classic' | 'cyber';

export interface ClientAppearance {
  theme: ThemeType;
  bgImage: string;
  bgOpacity: number;
  uiOpacity: number;
}

export interface ClientAppearanceIdentity {
  mode: 'local' | 'relay';
  userId: string;
}

export interface AppearanceMetadataStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AppearanceImageStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ClientAppearanceStorageOptions {
  metadata?: AppearanceMetadataStorage;
  images?: AppearanceImageStorage;
}

interface StoredAppearanceMetadata {
  version: 1;
  theme: ThemeType;
  bgOpacity: number;
  uiOpacity: number;
  background: 'none' | 'indexeddb' | 'inline';
  inlineBgImage?: string;
}

export const DEFAULT_CLIENT_APPEARANCE: ClientAppearance = {
  theme: 'dark',
  bgImage: '',
  bgOpacity: 0.3,
  uiOpacity: 1,
};

export const CLIENT_APPEARANCE_FIELDS = [
  'theme',
  'bgImage',
  'bgOpacity',
  'uiOpacity',
] as const;

const VALID_THEMES = new Set<ThemeType>(['dark', 'midnight', 'light', 'classic', 'cyber']);
const STORAGE_PREFIX = 'agent-with-u:appearance:v1';
const IMAGE_DB_NAME = 'agent-with-u-client-appearance';
const IMAGE_DB_STORE = 'backgrounds';

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

/** Normalize both current values and the old executor-side appearance format. */
export function normalizeClientAppearance(value: unknown): ClientAppearance {
  const candidate = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const rawTheme = candidate.theme === 'ocean' ? 'midnight' : candidate.theme;
  const theme = typeof rawTheme === 'string' && VALID_THEMES.has(rawTheme as ThemeType)
    ? rawTheme as ThemeType
    : DEFAULT_CLIENT_APPEARANCE.theme;
  return {
    theme,
    bgImage: typeof candidate.bgImage === 'string' ? candidate.bgImage : '',
    bgOpacity: clampNumber(
      candidate.bgOpacity,
      DEFAULT_CLIENT_APPEARANCE.bgOpacity,
      0,
      1,
    ),
    uiOpacity: clampNumber(
      candidate.uiOpacity,
      DEFAULT_CLIENT_APPEARANCE.uiOpacity,
      0.1,
      1,
    ),
  };
}

export function clientAppearanceStorageKey(identity: ClientAppearanceIdentity): string {
  const mode = identity.mode === 'relay' ? 'relay' : 'local';
  const fallback = mode === 'relay' ? 'legacy' : 'local';
  const userId = String(identity.userId || '').trim() || fallback;
  return `${STORAGE_PREFIX}:${mode}:${encodeURIComponent(userId)}`;
}

/** Appearance must never be included in an executor-side AppConfig write. */
export function stripClientAppearance<T extends Record<string, unknown>>(
  config: T,
): Omit<T, typeof CLIENT_APPEARANCE_FIELDS[number]> {
  const copy: Record<string, unknown> = { ...config };
  for (const field of CLIENT_APPEARANCE_FIELDS) delete copy[field];
  return copy as Omit<T, typeof CLIENT_APPEARANCE_FIELDS[number]>;
}

export function hasClientAppearancePatch(patch: Record<string, unknown>): boolean {
  return CLIENT_APPEARANCE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(patch, field));
}

export function hasExecutorConfigPatch(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).some(
    (field) => !(CLIENT_APPEARANCE_FIELDS as readonly string[]).includes(field),
  );
}

export function resolveClientAppearance(
  stored: ClientAppearance | null,
  legacyExecutorConfig: unknown,
): { appearance: ClientAppearance; migrated: boolean } {
  if (stored) return { appearance: normalizeClientAppearance(stored), migrated: false };
  return {
    appearance: normalizeClientAppearance(legacyExecutorConfig),
    migrated: true,
  };
}

function browserMetadataStorage(): AppearanceMetadataStorage | undefined {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* Storage can be disabled by the browser. */ }
  return undefined;
}

let imageDbPromise: Promise<IDBDatabase> | null = null;

function openImageDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable'));
  }
  if (!imageDbPromise) {
    imageDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(IMAGE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(IMAGE_DB_STORE)) {
          request.result.createObjectStore(IMAGE_DB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        imageDbPromise = null;
        reject(request.error || new Error('Unable to open appearance image database'));
      };
      request.onblocked = () => {
        imageDbPromise = null;
        reject(new Error('Appearance image database is blocked'));
      };
    });
  }
  return imageDbPromise;
}

const browserImageStorage: AppearanceImageStorage = {
  async get(key) {
    const db = await openImageDb();
    return new Promise<string | undefined>((resolve, reject) => {
      const tx = db.transaction(IMAGE_DB_STORE, 'readonly');
      const request = tx.objectStore(IMAGE_DB_STORE).get(key);
      request.onsuccess = () => resolve(
        typeof request.result === 'string' ? request.result : undefined,
      );
      request.onerror = () => reject(request.error || tx.error);
    });
  },
  async set(key, value) {
    const db = await openImageDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGE_DB_STORE, 'readwrite');
      tx.objectStore(IMAGE_DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  async remove(key) {
    const db = await openImageDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGE_DB_STORE, 'readwrite');
      tx.objectStore(IMAGE_DB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
};

function getMetadataStorage(options?: ClientAppearanceStorageOptions): AppearanceMetadataStorage | undefined {
  return options?.metadata || browserMetadataStorage();
}

function getImageStorage(options?: ClientAppearanceStorageOptions): AppearanceImageStorage {
  return options?.images || browserImageStorage;
}

function readMetadata(
  identity: ClientAppearanceIdentity,
  options?: ClientAppearanceStorageOptions,
): StoredAppearanceMetadata | null {
  const storage = getMetadataStorage(options);
  if (!storage) return null;
  try {
    const raw = storage.getItem(clientAppearanceStorageKey(identity));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAppearanceMetadata> | null;
    if (!parsed || parsed.version !== 1) return null;
    const appearance = normalizeClientAppearance(parsed);
    const background = parsed.background === 'indexeddb' || parsed.background === 'inline'
      ? parsed.background
      : 'none';
    return {
      version: 1,
      theme: appearance.theme,
      bgOpacity: appearance.bgOpacity,
      uiOpacity: appearance.uiOpacity,
      background,
      inlineBgImage: background === 'inline' && typeof parsed.inlineBgImage === 'string'
        ? parsed.inlineBgImage
        : undefined,
    };
  } catch {
    return null;
  }
}

/** Synchronous preview used during an account switch; IndexedDB images hydrate just after it. */
export function readClientAppearancePreview(
  identity: ClientAppearanceIdentity,
  options?: ClientAppearanceStorageOptions,
): ClientAppearance | null {
  const metadata = readMetadata(identity, options);
  if (!metadata) return null;
  return normalizeClientAppearance({
    ...metadata,
    bgImage: metadata.background === 'inline' ? metadata.inlineBgImage || '' : '',
  });
}

export async function loadClientAppearance(
  identity: ClientAppearanceIdentity,
  options?: ClientAppearanceStorageOptions,
): Promise<ClientAppearance | null> {
  const metadata = readMetadata(identity, options);
  if (!metadata) return null;
  let bgImage = '';
  if (metadata.background === 'inline') {
    bgImage = metadata.inlineBgImage || '';
  } else if (metadata.background === 'indexeddb') {
    try {
      bgImage = await getImageStorage(options).get(clientAppearanceStorageKey(identity)) || '';
    } catch {
      bgImage = '';
    }
  }
  return normalizeClientAppearance({ ...metadata, bgImage });
}

async function persistClientAppearance(
  identity: ClientAppearanceIdentity,
  value: ClientAppearance,
  backgroundChanged: boolean,
  options?: ClientAppearanceStorageOptions,
): Promise<void> {
  const storage = getMetadataStorage(options);
  if (!storage) throw new Error('Client appearance metadata storage is unavailable');

  const key = clientAppearanceStorageKey(identity);
  const appearance = normalizeClientAppearance(value);
  const previous = readMetadata(identity, options);
  let background: StoredAppearanceMetadata['background'] = previous?.background || 'none';
  let inlineBgImage = previous?.inlineBgImage;

  if (backgroundChanged || !previous) {
    if (!appearance.bgImage) {
      background = 'none';
      inlineBgImage = undefined;
      try { await getImageStorage(options).remove(key); } catch { /* Nothing to remove. */ }
    } else {
      try {
        await getImageStorage(options).set(key, appearance.bgImage);
        background = 'indexeddb';
        inlineBgImage = undefined;
      } catch {
        // Very old/private WebViews may not expose IndexedDB. Keep a localStorage
        // fallback; quota errors still surface to the caller instead of touching the executor.
        background = 'inline';
        inlineBgImage = appearance.bgImage;
      }
    }
  }

  const metadata: StoredAppearanceMetadata = {
    version: 1,
    theme: appearance.theme,
    bgOpacity: appearance.bgOpacity,
    uiOpacity: appearance.uiOpacity,
    background,
    ...(background === 'inline' && inlineBgImage ? { inlineBgImage } : {}),
  };
  storage.setItem(key, JSON.stringify(metadata));
}

const appearanceWriteQueues = new Map<string, Promise<void>>();

/**
 * Serialize writes per user so a late IndexedDB transaction from user A cannot
 * overwrite a newer setting. `backgroundChanged=false` updates only small metadata.
 */
export function saveClientAppearance(
  identity: ClientAppearanceIdentity,
  value: ClientAppearance,
  options?: ClientAppearanceStorageOptions & { backgroundChanged?: boolean },
): Promise<void> {
  const key = clientAppearanceStorageKey(identity);
  const previous = appearanceWriteQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => persistClientAppearance(
      identity,
      value,
      options?.backgroundChanged !== false,
      options,
    ));
  appearanceWriteQueues.set(key, next);
  void next.finally(() => {
    if (appearanceWriteQueues.get(key) === next) appearanceWriteQueues.delete(key);
  }).catch(() => undefined);
  return next;
}

