import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pdfRoot = join(frontendRoot, 'node_modules', 'pdfjs-dist');
const targetRoot = join(frontendRoot, 'public', 'vendor', 'pdfjs');
const docxRoot = join(frontendRoot, 'node_modules', 'docx-preview');
const docxTarget = join(frontendRoot, 'public', 'vendor', 'docx-preview');

if (!existsSync(pdfRoot)) {
  throw new Error('pdfjs-dist is missing; run npm install before building.');
}

rmSync(targetRoot, { recursive: true, force: true });
mkdirSync(targetRoot, { recursive: true });
for (const name of ['cmaps', 'standard_fonts']) {
  cpSync(join(pdfRoot, name), join(targetRoot, name), { recursive: true });
}
cpSync(join(pdfRoot, 'LICENSE'), join(targetRoot, 'LICENSE'));
rmSync(docxTarget, { recursive: true, force: true });
mkdirSync(docxTarget, { recursive: true });
cpSync(join(docxRoot, 'LICENSE'), join(docxTarget, 'LICENSE'));

console.log('[preview-assets] PDF.js assets and preview-engine licenses prepared for offline preview.');
