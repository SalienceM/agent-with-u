// 合成的真实文档，不读取用户文件；ZIP 使用 store，避免新增夹具依赖。
export function docxBytes(): number[] {
  const entries: Record<string, string> = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + Array.from({ length: 70 }, (_, i) => `<w:p><w:r><w:t>Word fixture paragraph ${i} - selectable text and page edges</w:t></w:r></w:p>`).join('') + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:bottom="720" w:left="720" w:right="720"/></w:sectPr></w:body></w:document>',
  };
  const local: number[] = [], central: number[] = [];
  const uint = (n: number, size: number) => Array.from({ length: size }, (_, i) => n >>> (i * 8) & 255);
  for (const [path, text] of Object.entries(entries)) {
    const name = [...new TextEncoder().encode(path)], data = [...new TextEncoder().encode(text)];
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const offset = local.length;
    local.push(...uint(0x04034b50, 4), 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...uint(crc, 4), ...uint(data.length, 4), ...uint(data.length, 4), ...uint(name.length, 2), 0, 0, ...name, ...data);
    central.push(...uint(0x02014b50, 4), 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...uint(crc, 4), ...uint(data.length, 4), ...uint(data.length, 4), ...uint(name.length, 2), ...Array(12).fill(0), ...uint(offset, 4), ...name);
  }
  return [...local, ...central, ...uint(0x06054b50, 4), 0, 0, 0, 0, 3, 0, 3, 0, ...uint(central.length, 4), ...uint(local.length, 4), 0, 0];
}

export function pdfBytes(): number[] {
  const stream = 'BT /F1 24 Tf 40 760 Td (PDF fixture - wide page) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = text.length;
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return [...new TextEncoder().encode(text)];
}

export const excelFixture = {
  status: 'ok', kind: 'excel', truncated: true,
  sheets: Array.from({ length: 8 }, (_, s) => ({ name: `Sheet ${s + 1} 很长的工作表名称`, rowCount: 90, columnCount: 24,
    frozen: { rows: 1, columns: 1 }, columns: [{ index: 3, hidden: true }],
    merges: [{ ref: 'B2:C2', startRow: 2, startColumn: 1, endRow: 2, endColumn: 2 }],
    rows: Array.from({ length: 90 }, (_, r) => ({ index: r + 1, hidden: r === 4,
      cells: Array.from({ length: 24 }, (_, c) => ({ row: r + 1, column: c, address: `${String.fromCharCode(65 + c)}${r + 1}`,
        value: r === 0 && c === 0 ? 'Long content '.repeat(80) : `value ${r + 1}:${c}`, type: 'string',
        ...(r === 2 && c === 1 ? { formula: 'SUM(A1:A2)', formulaCached: false } : {}) })) })) })),
};

export const drawioXml = '<mxfile>' + [1, 2].map(i => `<diagram id="p${i}" name="Page ${i}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Diagram ${i}" style="rounded=1;fillColor=#66aaaa" vertex="1" parent="1"><mxGeometry x="40" y="40" width="160" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram>`).join('') + '</mxfile>';
export const drawioFallback = { status: 'ok', kind: 'drawio', pages: [1, 2].map(i => ({ name: `Page ${i}`, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect x="40" y="40" width="160" height="80" fill="teal"/><text x="50" y="80">Diagram ${i}</text></svg>` })) };
