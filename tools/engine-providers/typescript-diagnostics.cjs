/* 固定 TypeScript 5.7.3 API。只读配置/源码，不加载项目插件，不写入文件。 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const ts = require(path.join(process.argv[2], 'lib/typescript.js'));
if (ts.version !== '5.7.3') throw new Error('typescript_version_mismatch');
const root = path.resolve(process.argv[3]);
let input = '', bytes = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  bytes += Buffer.byteLength(chunk);
  if (bytes > 24 * 1024 * 1024) process.exit(2);
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input);
    if (!Array.isArray(payload.documents) || payload.documents.length > 32) throw new Error('document_limit');
    const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    const docs = new Map();
    for (const doc of payload.documents) {
      const file = path.resolve(fileURLToPath(doc.uri));
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative) || typeof doc.text !== 'string'
        || Buffer.byteLength(doc.text) > 2 * 1024 * 1024 || !Number.isSafeInteger(doc.revision)) throw new Error('document_invalid');
      docs.set(key(file), { ...doc, file });
    }
    const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')
      || ts.findConfigFile(root, ts.sys.fileExists, 'jsconfig.json');
    let options = { jsx: ts.JsxEmit.ReactJSX, strict: true, allowJs: true, checkJs: true,
      target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Node10 };
    let files = [...docs.values()].map(doc => doc.file);
    if (configPath && !path.relative(root, configPath).startsWith('..')) {
      const content = ts.readConfigFile(configPath, ts.sys.readFile);
      if (content.error) throw new Error('config_invalid');
      const config = ts.parseJsonConfigFileContent(content.config, ts.sys, path.dirname(configPath));
      if (config.errors.length) throw new Error('config_invalid');
      options = config.options;
      files = [...new Map([...files, ...config.fileNames].map(file => [key(file), file])).values()];
    }
    if (files.length > 2048) throw new Error('project_file_limit');
    options = { ...options, noEmit: true, plugins: [], incremental: false, composite: false };
    let readBytes = 0;
    const read = file => {
      const opened = docs.get(key(file));
      if (opened) return opened.text;
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile()) return undefined;
      readBytes += stat.size;
      if (stat.size > 8 * 1024 * 1024 || readBytes > 64 * 1024 * 1024) throw new Error('project_read_limit');
      return ts.sys.readFile(file);
    };
    const host = {
      getCompilationSettings: () => options, getScriptFileNames: () => files,
      getScriptVersion: file => String(docs.get(key(file))?.revision ?? 0),
      getScriptSnapshot: file => { const text = read(file); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
      getCurrentDirectory: () => root, getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists, readFile: read, readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    const service = ts.createLanguageService(host);
    const results = [];
    for (const doc of docs.values()) {
      const source = ts.createSourceFile(doc.file, doc.text, ts.ScriptTarget.Latest);
      const problems = [...service.getSyntacticDiagnostics(doc.file), ...service.getSemanticDiagnostics(doc.file)];
      results.push({ path: doc.path, revision: doc.revision, diagnostics: problems.slice(0, 500).map(problem => {
        const start = source.getLineAndCharacterOfPosition(Math.min(doc.text.length, problem.start ?? 0));
        const end = source.getLineAndCharacterOfPosition(Math.min(doc.text.length, (problem.start ?? 0) + (problem.length ?? 0)));
        return { range: { start, end }, severity: problem.category === ts.DiagnosticCategory.Error ? 1 : 2,
          source: 'TypeScript 5.7.3', message: ts.flattenDiagnosticMessageText(problem.messageText, '\n').slice(0, 4096) };
      }), truncated: problems.length > 500 });
    }
    service.dispose();
    const output = JSON.stringify(results);
    if (Buffer.byteLength(output) > 2 * 1024 * 1024) throw new Error('diagnostic_limit');
    process.stdout.write(output);
  } catch (_) { process.exitCode = 2; }
});
