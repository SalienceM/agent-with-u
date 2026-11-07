import { React as R, createRoot } from './react-harness';
import { api, getCurrentUserProfile, setConnectionTarget, getConnectionTarget } from '../../src/api';
import { FileTreePanel } from '../../src/components/FileTreePanel';
import { FilePreviewWindow } from '../../src/components/FilePreviewWindow';
import { byteHash } from '../../src/utils/documentCodec';
import { excelFixture, docxBytes, pdfBytes } from './preview-fixtures';
import { useManagedLocalDir } from '../../src/utils/dirSync';
import { LocalDocuments } from '../../src/utils/localDocuments';

const w = window as any;
if (new URL(location.href).searchParams.has('profile') && getConnectionTarget().mode === 'local') await setConnectionTarget({ mode: 'relay',
  url: 'ws://127.0.0.1:55191/isolated-relay', token: 'isolated-fixture-only', deviceId: 'fixture',
  user: { userId: 'fixture-user', username: 'fixture', displayName: 'Fixture', avatarData: '', avatarColor: '#777', managed: false } });
const kind = new URL(location.href).searchParams.get('fixture') || localStorage.getItem('fixture-kind') || 'excel';
localStorage.setItem('fixture-kind', kind);
const name = ({ excel: 'book.xlsx', docx: 'paper.docx', pdf: 'paper.pdf', text: 'note.txt', markdown: 'note.md', html: 'index.html' } as any)[kind];
const text = kind === 'html' ? '<h1>Independent HTML</h1><img src="asset.svg"><a href="next.html">Next document</a>' : kind === 'markdown' ? '# Independent markdown\n\ntext' : 'Independent original text';
const bytes = new Uint8Array(kind === 'docx' ? docxBytes() : kind === 'pdf' ? pdfBytes() : new TextEncoder().encode(text));
const encode = (value: Uint8Array) => btoa(Array.from(value, v => String.fromCharCode(v)).join(''));
const identity = { ownerId: getCurrentUserProfile().userId, executorInstance: 'fixture-node', sessionId: 'preview-fixture', workingDir: '/fixture', workspaceRevision: 'a'.repeat(64) };
const fixture = w.lifecycleFixture = { api, calls: [] as any[], offline: new URL(location.href).searchParams.has('filePreview') && localStorage.getItem('fixture-fail-child') === '1', revision: identity.workspaceRevision, identity, name, bytes, text,
  generation: 1, savedText: '', unknownSave: false, writes: 0, reads: 0, mounts: 0, connection: undefined as any };
if (kind === 'text' && !new URL(location.href).searchParams.has('filePreview')) {
  const fs = await useManagedLocalDir('preview-fixture'); await fs.writeFile(name, encode(bytes));
}
const localRead = LocalDocuments.prototype.read, localSave = LocalDocuments.prototype.save, localGet = LocalDocuments.prototype.saveGet;
LocalDocuments.prototype.read = async function(...args) { fixture.reads++; return localRead.apply(this, args); };
LocalDocuments.prototype.save = async function(request) {
  fixture.writes++; fixture.calls.push({ method: 'save', args: [request] });
  if (fixture.unknownSave) throw new Error('Fixture receipt lost');
  return localSave.call(this, request);
};
LocalDocuments.prototype.saveGet = async function(requestId) {
  fixture.calls.push({ method: 'saveGet', args: [requestId] });
  return fixture.unknownSave ? { status: 'unknown', requestId } : localGet.call(this, requestId);
};
const record = (method: string, args: any[]) => { fixture.calls.push({ method, args }); if (fixture.offline) throw new Error('Fixture node offline'); };
api.onSessionConnectionStatus = (_: string, cb: any) => { cb(true); return () => {}; };
api.onExecutorConnectionStatus = (_: string, cb: any) => { fixture.connection = cb; cb(true); return () => { fixture.connection = undefined; }; };
api.previewDocumentWriteAllowed = async () => true;
api.listDirectory = async () => [{ name, path: name, isDir: false, size: bytes.length }];
api.gitDetect = async () => ({ isRepo: false }) as any;
api.sessionWorkbenchCapabilities = async (...args: any[]) => { record('capabilities', args); return { status: 'ok', identity: { ...identity, workspaceRevision: fixture.revision }, capabilities: { documents: 1 } } as any; };
api.workspaceDocuments = async (...args: any[]) => {
  record('documents', args.slice(0, 3));
  return { identity: { ...identity, workspaceRevision: fixture.revision }, source: 'executor', read: async (rel: string) => {
    record('documentRead', [rel]); fixture.reads++;
    const content = fixture.savedText || text, data = new TextEncoder().encode(content);
    return { status: 'ok', document: { workspace: identity, relativePath: rel, canonicalPath: '/fixture/' + rel, source: 'executor' },
      version: { exists: true, sha256: byteHash(data), fileId: rel, modifiedNs: `${fixture.generation}`, changedNs: `${fixture.generation}`, byteLength: data.length },
      complete: true, byteLength: data.length, readByteLength: data.length, text: content, encoding: 'utf-8', bom: '', eol: 'lf', editable: true, canSave: true, controlRevision: 0 };
  }, save: async (request: any) => { record('save', [request]); fixture.writes++; if (fixture.unknownSave) throw new Error('Fixture receipt lost'); return { status: 'failed', requestId: request.requestId, relativePath: request.relativePath, bufferRevision: request.bufferRevision, reasonCode: 'disk_conflict' }; },
    saveGet: async (id: string) => { record('saveGet', [id]); return { status: 'unknown', requestId: id }; } } as any;
};
const resource = (rel: string) => rel === 'asset.svg' ? new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" fill="teal"/></svg>')
  : rel === 'next.html' ? new TextEncoder().encode('<h1>Second HTML</h1>') : bytes;
api.syncFileStat = async (...args: any[]) => { record('stat', args); return { status: 'ok', size: resource(args[1]).length }; };
api.syncReadFile = async (...args: any[]) => { record('file', args); return { status: 'ok', data: encode(resource(args[1])) }; };
api.syncReadChunk = async (...args: any[]) => { record('chunk', args); return { status: 'ok', data: encode(resource(args[1]).slice(args[2], args[2] + args[3])) }; };
api.filePreview = async (...args: any[]) => { record('parse', args); return excelFixture; };
api.revealFile = async (...args: any[]) => { record('reveal', args); return { status: 'ok' }; };
api.syncWriteFile = async () => { throw new Error('Unexpected unversioned write'); };
for (const [key, value] of Object.entries({ '--theme-text': '#ddd', '--theme-text-muted': '#aaa', '--theme-bg-secondary': '#161b22', '--theme-bg-tertiary': '#222', '--theme-border': '#444' })) document.documentElement.style.setProperty(key, value);
const root = createRoot(document.getElementById('root')!);
fixture.unmount = () => root.unmount();
fixture.mount = () => root.render(R.createElement(FileTreePanel, { sessionId: 'preview-fixture', workingDir: '/fixture', execKey: 'local', execMode: 'local' }));
fixture.switchView = (sessionId: string, workingDir: string, engine: boolean) => {
  const host = document.getElementById('engine-fixture') || Object.assign(document.createElement('div'), { id: 'engine-fixture' });
  host.style.cssText = 'width:400px;height:600px;display:flex'; document.body.append(host);
  root.render(R.createElement(FileTreePanel, { sessionId, workingDir, execKey: 'local', execMode: 'local', documentHost: engine ? host : undefined }));
};
if (new URL(location.href).searchParams.has('filePreview')) root.render(R.createElement(FilePreviewWindow));
else fixture.mount();
