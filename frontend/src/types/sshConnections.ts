export interface SshEndpoint { host: string; port: number; user: string }
export interface SshProbe extends SshEndpoint {
  status: string; probeId: string; fingerprint: string; algorithm: string; message?: string;
}
export interface SshProfile extends SshEndpoint {
  id: string; label: string; fingerprint: string; algorithm: string;
  authMode: 'agent' | 'key'; keyPath: string; revision: string;
}
export interface SshSave extends SshEndpoint {
  probeId: string; fingerprint: string; confirmed: boolean; label: string;
  authMode: 'agent' | 'key'; keyPath: string;
}
