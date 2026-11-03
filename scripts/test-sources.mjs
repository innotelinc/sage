/**
 * Foundation documents: the extraction paths and the prompt grounding.
 *
 * Run with `node scripts/test-sources.mjs`. No network: the image and audio
 * paths are only checked for refusing without a key, since driving them would
 * mean calling a model.
 */
import assert from 'node:assert/strict';
import { deflateSync, deflateRawSync, inflateSync, inflateRawSync } from 'node:zlib';
import {
  extractPlainText,
  extractPdfText,
  extractDocxText,
  extractDocText,
  readDocument,
} from '../src/sources.mjs';
import { buildSystemPrompt, foundationBlock } from '../src/persona.mjs';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

/** A PDF with one content stream, optionally FlateDecode'd. */
function makePdf(content, { compress = true } = {}) {
  const payload = compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  const head = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Page /MediaBox [0 0 612 792] >>\nendobj\n2 0 obj\n<< /Length ${payload.length}${
      compress ? ' /Filter /FlateDecode' : ''
    } >>\nstream\n`,
    'latin1'
  );
  const tail = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
  return Buffer.concat([head, payload, tail]);
}

/** A minimal single-entry zip, enough for the .docx reader. */
function makeZip(name, content) {
  const nameBytes = Buffer.from(name, 'utf8');
  const body = Buffer.from(content, 'utf8');
  const data = deflateRawSync(body);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + nameBytes.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([local, nameBytes, data, central, nameBytes, eocd]);
}

const PDF_CONTENT =
  'BT /F1 12 Tf 72 720 Td (Cell membranes are selectively permeable.) Tj T* (Water crosses them by osmosis.) Tj ET';

console.log('\nfoundation documents');

test('plain text keeps its words and drops the BOM', () => {
  const bytes = Buffer.from('\uFEFFLecture one\r\n\r\nOsmosis is diffusion of water.\r\n', 'utf8');
  const text = extractPlainText(bytes);
  assert.match(text, /Lecture one/);
  assert.match(text, /Osmosis is diffusion of water\./);
  assert.ok(!text.includes('\uFEFF'));
});

test('utf-16 text from a BOM is decoded, not mojibake', () => {
  const body = Buffer.from('Genetics lecture', 'utf16le');
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  assert.match(extractPlainText(bytes), /Genetics lecture/);
});

test('a deflated PDF yields its text layer', () => {
  const { text, pages } = extractPdfText(makePdf(PDF_CONTENT), { inflateSync, inflateRawSync });
  assert.match(text, /selectively permeable/);
  assert.match(text, /osmosis/);
  assert.equal(pages, 1);
});

test('an uncompressed PDF yields its text layer too', () => {
  const { text } = extractPdfText(makePdf(PDF_CONTENT, { compress: false }));
  assert.match(text, /Water crosses them/);
});

test('a scanned PDF says it has no text instead of inventing some', () => {
  const { text, note } = extractPdfText(makePdf('q 612 0 0 792 0 0 cm /Im0 Do Q', { compress: false }));
  assert.equal(text, '');
  assert.match(note, /scan/i);
});

test('a .docx is unpacked paragraph by paragraph', () => {
  const xml =
    '<w:document><w:body><w:p><w:r><w:t>Lecture 3: membranes</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Osmosis moves water, not solute.</w:t></w:r></w:p></w:body></w:document>';
  const zlib = { inflateRawSync };
  const { text } = extractDocxText(makeZip('word/document.xml', xml), zlib);
  assert.match(text, /Lecture 3: membranes/);
  assert.match(text, /Osmosis moves water, not solute\./);
  assert.match(text, /membranes\nOsmosis/);
});

test('a .docx without a word/document.xml is refused, not guessed at', () => {
  const zlib = { inflateRawSync };
  const { text, note } = extractDocxText(makeZip('other.xml', '<x/>'), zlib);
  assert.equal(text, '');
  assert.match(note, /document\.xml/);
});

test('legacy .doc text is recovered from the binary', () => {
  const words = 'Mitochondria are the site of aerobic respiration in the cell.';
  const bytes = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.from(words, 'utf16le'),
    Buffer.from('\u0000\u0000\u0001\u0005', 'utf16le'),
  ]);
  const { text } = extractDocText(bytes);
  assert.match(text, /aerobic respiration/);
});

test('a text file is read through the same door as the rest', async () => {
  const bytes = Buffer.from('Week 2 handout: diffusion and osmosis.', 'utf8');
  const doc = await readDocument({ name: 'handout.txt', mime: 'text/plain', bytes }, {});
  assert.equal(doc.kind, 'text');
  assert.match(doc.text, /diffusion and osmosis/);
});

await testAsync('an image without a key is refused with a reason', async () => {
  await assert.rejects(
    () => readDocument({ name: 'slide.png', mime: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, {}),
    /needs a gateway key/
  );
});

await testAsync('audio without a key is refused with a reason', async () => {
  await assert.rejects(
    () => readDocument({ name: 'seminar.m4a', mime: 'audio/mp4', bytes: Buffer.from([0, 1, 2, 3]) }, {}),
    /needs a gateway key/
  );
});

test('the prompt carries the documents and names them', () => {
  const prompt = buildSystemPrompt({
    mode: 'answer',
    sources: [{ name: 'lecture-3.pdf', kind: 'pdf', text: 'Osmosis moves water across a semipermeable membrane.' }],
  });
  assert.match(prompt, /Grounding rule/);
  assert.match(prompt, /lecture-3\.pdf/);
  assert.match(prompt, /Osmosis moves water/);
  assert.ok(prompt.indexOf('Grounding rule') < prompt.indexOf('Current task'), 'grounding comes before the task');
});

test('a turn with no documents is unchanged', () => {
  const prompt = buildSystemPrompt({ mode: 'answer', sources: [] });
  assert.ok(!prompt.includes('Grounding rule'));
  assert.ok(!prompt.includes('Foundation documents'));
});

test('a long document is trimmed with the omission stated', () => {
  const block = foundationBlock([{ name: 'book.txt', kind: 'text', text: 'x'.repeat(40000) }], 2000);
  assert.match(block, /characters omitted/);
  assert.ok(block.length < 4000, `block was ${block.length} characters`);
});

test('empty documents never become a section', () => {
  assert.equal(foundationBlock([{ name: 'blank.txt', kind: 'text', text: '   ' }]), '');
});

if (failures.length) {
  console.log(`\n${failures.length} failed, ${passed} passed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed\n`);
