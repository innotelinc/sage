/**
 * Foundation documents.
 *
 * A course is answered from its own material: the PDF handed out in week one, a
 * .doc of lecture notes, screenshots of slides, a recording of the seminar. This
 * turns any of those into text once, on the server, so the app can carry it with
 * the course and ground Answer, Quiz and Read in it afterwards without uploading
 * the file again.
 *
 * No dependencies, and no parsing library: the text layer of a PDF is recovered
 * by inflating its content streams, a .docx by reading its zip, a legacy .doc by
 * picking the readable runs out of the binary. An image goes to the vision model
 * and audio to the transcription model, because those are the only honest ways to
 * read them here. A PDF that is a scan rather than text says so instead of
 * pretending it was read.
 */

const MAX_FILES = 6;
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_DOC_CHARS = 60000;

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'vtt', 'srt', 'json', 'rtf', 'html', 'htm']);

function extensionOf(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return match ? match[1] : '';
}

/** UTF-16 with a BOM, or anything else as UTF-8 with the BOM stripped. */
export function extractPlainText(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le', 2);
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ── pdf ───────────────────────────────────────────────────── */

/** The text-drawing operators in one decoded content stream. */
function pdfContentText(content) {
  const out = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '(') {
      i += 1;
      let depth = 1;
      let text = '';
      while (i < content.length && depth > 0) {
        const c = content[i];
        if (c === '\\') {
          const next = content[i + 1];
          const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          if (next !== undefined && Object.prototype.hasOwnProperty.call(simple, next)) {
            text += simple[next];
            i += 2;
            continue;
          }
          const octal = content.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
          if (octal) {
            text += String.fromCharCode(parseInt(octal[0], 8));
            i += 1 + octal[0].length;
            continue;
          }
          i += 2;
          continue;
        }
        if (c === '(') depth += 1;
        if (c === ')') {
          depth -= 1;
          if (!depth) {
            i += 1;
            break;
          }
        }
        text += c;
        i += 1;
      }
      out.push(text);
      continue;
    }
    // A hex string, but not the « of a dictionary.
    if (ch === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      if (end > i) {
        const hex = content.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
        let text = '';
        for (let h = 0; h + 1 < hex.length; h += 2) text += String.fromCharCode(parseInt(hex.slice(h, h + 2), 16));
        out.push(text);
        i = end + 1;
        continue;
      }
    }
    // A new line is begun by a positional operator, not by the string itself.
    if (content.startsWith('Td', i) || content.startsWith('TD', i) || content.startsWith('T*', i)) {
      out.push('\n');
      i += 2;
      continue;
    }
    if (content.startsWith('TJ', i) || content.startsWith('Tj', i)) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function inflateAny(bytes, zlib) {
  for (const attempt of ['inflateSync', 'inflateRawSync']) {
    try {
      return zlib[attempt](bytes);
    } catch {
      /* try the next framing */
    }
  }
  return null;
}

/**
 * Every content stream, decoded as far as it will inflate. Image streams inflate
 * too, which is harmless: they decode to bytes that hold no text operators.
 */
export function extractPdfText(bytes, zlib = null) {
  const buffer = Buffer.from(bytes);
  // A Buffer's toString('latin1') keeps one character per byte, so offsets and
  // operator scanning line up with the file.
  const raw = buffer.toString('latin1');
  const pages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const streams = [];
  const re = /\bstream\r\n?|\bstream\n|\bstream\b/g;
  for (const match of raw.matchAll(re)) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    streams.push(buffer.subarray(start, end));
  }
  if (!streams.length) return { text: '', pages, note: 'no content streams — this PDF may be a scan' };

  const chunks = [];
  for (const stream of streams) {
    // Most streams are FlateDecode; some are already plain.
    let content = zlib ? inflateAny(stream, zlib) : null;
    if (!content) content = stream;
    const decoded = content.toString('latin1');
    if (/BT|Tj|TJ/.test(decoded)) chunks.push(pdfContentText(decoded));
  }

  const text = tidy(chunks.join('\n'));
  if (text.replace(/\s/g, '').length < 40) {
    return {
      text,
      pages,
      note: 'little or no text layer — a scanned PDF cannot be read here; add screenshots of the pages instead',
    };
  }
  // A page number is only worth printing if it is true. Generated PDFs usually draw
  // one content stream per page, and then stream order is page order; when the counts
  // disagree (forms, reused streams) the document is offered whole rather than sliced
  // into pages it does not have.
  const segments =
    pages > 1 && chunks.length === pages
      ? chunks.map((chunk, index) => ({ locator: `p.${index + 1}`, text: tidy(chunk) }))
      : [{ locator: 'whole document', text }];
  return { text, pages, note: '', segments: segments.filter((segment) => segment.text) };
}

/* ── docx ──────────────────────────────────────────────────── */

/** One entry out of a zip, inflated if it is deflated. */
export function unzipEntry(bytes, wanted, zlib) {
  const buffer = Buffer.from(bytes);
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  let off = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (off + 46 > buffer.length || buffer.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(off + 10);
    const compressedSize = buffer.readUInt32LE(off + 20);
    const nameLength = buffer.readUInt16LE(off + 28);
    const extraLength = buffer.readUInt16LE(off + 30);
    const commentLength = buffer.readUInt16LE(off + 32);
    const localOffset = buffer.readUInt32LE(off + 42);
    const name = buffer.toString('utf8', off + 46, off + 46 + nameLength);
    if (name === wanted) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) return data;
      return zlib ? zlib.inflateRawSync(data) : null;
    }
    off += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** WordprocessingML to plain text: paragraphs are lines, tabs and breaks survive. */
export function xmlToText(xml) {
  return tidy(
    String(xml || '')
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  );
}

export function extractDocxText(bytes, zlib) {
  if (!zlib) return { text: '', note: 'this build cannot unpack a .docx — export it as PDF or text' };
  const document = unzipEntry(bytes, 'word/document.xml', zlib);
  if (!document) return { text: '', note: 'that .docx has no word/document.xml — it may be a renamed .doc' };
  return { text: xmlToText(document.toString('utf8')), note: '' };
}

/* ── legacy .doc ───────────────────────────────────────────── */

/**
 * Word 97 is a compound binary with the text in a piece table. Reconstructing
 * that properly is a project in itself, so this reads the readable runs out of
 * both plausible encodings and keeps whichever makes more words.
 */
export function extractDocText(bytes) {
  const buffer = Buffer.from(bytes);
  const latin = buffer.toString('latin1').replace(/[^\t\n\r\x20-\x7e\xa0-\xff]+/g, '\n');
  const utf16 = buffer.toString('utf16le').replace(/[^\t\n\r\x20-\x7e\u00a0-\uffff\ud800-\udfff]+/g, '\n');
  const words = (value) => (value.match(/\b[A-Za-z]{3,}\b/g) || []).length;
  const best = words(utf16) > words(latin) ? utf16 : latin;
  const text = tidy(
    best
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 3)
      .join('\n')
  );
  return {
    text,
    note: text ? 'converted best-effort from the old Word format — check it against the original' : 'nothing readable in that .doc',
  };
}

/* ── images and audio ──────────────────────────────────────── */

async function ocrImage(buffer, mime, cfg) {
  const kind = /^image\//.test(mime) ? mime : 'image/png';
  const dataUrl = `data:${kind};base64,${Buffer.from(buffer).toString('base64')}`;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
    body: JSON.stringify({
      model: cfg.autoModel ? cfg.chatModel : cfg.visionModel || cfg.chatModel,
      temperature: 0.1,
      max_tokens: 2000,
      messages: [
        {
          role: 'system',
          content:
            'You transcribe study material. Return plain text only: every word visible in the image, in reading order, keeping headings, lists, numbers, formulas and labels. Describe any diagram, graph or figure in one bracketed line beginning "[figure:". Do not summarise, do not comment, do not add anything that is not in the image.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe this page so it can be studied from as text.' },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
          ],
        },
      ],
      signal: AbortSignal.timeout(120000),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`the vision model returned ${res.status}${detail ? ` (${String(detail).slice(0, 160)})` : ''}`);
  }
  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((part) => part?.text || '').join('') : String(content || '');
  return tidy(text);
}

async function transcribeAudio(buffer, name, mime, cfg) {
  const route = cfg.sttKey
    ? { baseUrl: cfg.sttBaseUrl, key: cfg.sttKey, model: cfg.sttModel }
    : { baseUrl: cfg.baseUrl, key: cfg.key, model: cfg.transcribeModel };
  if (!route.key) throw new Error('transcription needs a gateway key');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/mpeg' }), name || 'audio.mp3');
  form.append('model', route.model);
  const res = await fetch(`${route.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${route.key}` },
    body: form,
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`transcription returned ${res.status}${detail ? ` (${String(detail).slice(0, 160)})` : ''}`);
  }
  const data = await res.json().catch(() => ({}));
  return tidy(String(data.text || ''));
}

/* ── one file in, one document out ─────────────────────────── */

export async function readDocument({ name, mime, bytes }, cfg) {
  const buffer = Buffer.from(bytes);
  const ext = extensionOf(name);
  const type = String(mime || '').toLowerCase();

  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif'].includes(ext)) {
    if (!cfg.key) throw new Error('reading an image needs a gateway key — add one in Settings');
    return { kind: 'image', text: await ocrImage(buffer, type, cfg), note: 'transcribed from the image by the vision model' };
  }

  if (type.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'webm', 'aac', 'flac'].includes(ext)) {
    if (!cfg.key) throw new Error('transcribing audio needs a gateway key — add one in Settings');
    return { kind: 'audio', text: await transcribeAudio(buffer, name, type, cfg), note: 'transcribed from the recording' };
  }

  if (type === 'application/pdf' || ext === 'pdf') {
    const read = extractPdfText(buffer, await zlibModule());
    return { kind: 'pdf', text: read.text, pages: read.pages, note: read.note, segments: read.segments };
  }

  if (ext === 'docx' || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const { text, note } = extractDocxText(buffer, await zlibModule());
    return { kind: 'docx', text, note };
  }

  if (ext === 'doc' || type === 'application/msword') {
    const { text, note } = extractDocText(buffer);
    return { kind: 'doc', text, note };
  }

  if (TEXT_EXTENSIONS.has(ext) || type.startsWith('text/') || type === 'application/json') {
    const raw = extractPlainText(buffer);
    // RTF and HTML are markup with readable words in them; the same strip is
    // close enough for a foundation document.
    const text =
      ext === 'rtf' || ext === 'html' || ext === 'htm'
        ? tidy(raw.replace(/<[^>]+>/g, ' ').replace(/\\[a-z]+-?\d*\s?/gi, ' '))
        : tidy(raw);
    return { kind: 'text', text, note: '' };
  }

  // Last resort: a file that is not obviously text still gets a plain decode, so
  // an unknown extension is not silently dropped.
  return { kind: 'text', text: tidy(extractPlainText(buffer)), note: 'read as plain text, which may not fit this format' };
}

/** node:zlib, only where a node runtime exists (never in the Worker). */
async function zlibModule() {
  try {
    return await import('node:zlib');
  } catch {
    return null;
  }
}

export async function handleSources(request, url, env, cfg, json) {
  if (url.pathname !== '/api/sources') return json({ error: 'not_found' }, 404);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'bad_form', message: 'Send the file as multipart form data with a "file" field.' }, 400);
  }

  const files = form
    .getAll('file')
    .filter((entry) => entry && typeof entry !== 'string')
    .slice(0, MAX_FILES);
  if (!files.length) return json({ error: 'no_file', message: 'No file arrived.' }, 400);

  const docs = [];
  for (const file of files) {
    const name = String(file.name || 'document').slice(0, 120);
    try {
      const bytes = Buffer.from(await file.arrayBuffer());
      if (!bytes.length) {
        docs.push({ name, error: 'that file is empty' });
        continue;
      }
      if (bytes.length > MAX_BYTES) {
        docs.push({ name, error: `over the ${Math.round(MAX_BYTES / 1024 / 1024)} MB this accepts` });
        continue;
      }
      const read = await readDocument({ name, mime: file.type, bytes }, cfg);
      const full = String(read.text || '');
      const text = full.slice(0, MAX_DOC_CHARS);
      docs.push({
        name,
        kind: read.kind,
        text,
        chars: full.length,
        truncated: full.length > MAX_DOC_CHARS,
        pages: read.pages || 0,
        // Where a reply may point: a page for a PDF whose streams line up with its
        // pages, or one segment for everything else. Capped so a big document does
        // not ship twice over the wire.
        segments: Array.isArray(read.segments) ? read.segments.slice(0, 120) : [],
        note: read.note || '',
      });
    } catch (error) {
      docs.push({ name, error: error.message });
    }
  }

  return json({ docs });
}
