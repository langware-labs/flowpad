'use strict';

/*
 * Read ONE member of a remote .whl (a zip) with HTTP Range requests: the end-of-central-directory record,
 * the central directory, then just that member's bytes -- tens of KB instead of the tens of MB of the whole
 * wheel. This is how the desktop learns a candidate engine release's `flow_sdk/compat.json` BEFORE the update
 * dialog is shown (engine-compat.js), without downloading the release and without running any of its code.
 *
 * Pure: the network is injected as `fetchRange(url, rangeHeader)` -> `{status, contentRange, body}` (status 206
 * and a Buffer body when the server honoured the range; anything else means "no range support").
 *
 * Every doubt returns null -- ZIP64, a method other than stored/deflate, a size mismatch, a CRC mismatch, a
 * server that ignores Range -- and the caller falls back to unpacking the wheel with uv. A member that is not
 * in the wheel at all is an ANSWER, `{found: false}` (the central directory lists every member).
 */

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const TAIL_BYTES = 64 * 1024;       // covers the end record; the central directory is fetched separately when larger
const MAX_MEMBER_BYTES = 1024 * 1024; // a floor declaration is a few bytes: refuse anything absurd

function totalFromContentRange(header) {
  const m = /^bytes\s+\d+-\d+\/(\d+)$/.exec(String(header || '').trim());
  return m ? Number(m[1]) : null;
}

async function range(fetchRange, url, from, toInclusive) {
  const r = await fetchRange(url, `bytes=${from}-${toInclusive}`);
  const want = toInclusive - from + 1;
  return r && r.status === 206 && Buffer.isBuffer(r.body) && r.body.length === want ? r.body : null;
}

/**
 * @param {{url: string, member: string, fetchRange: (url: string, range: string) => Promise<{status: number, contentRange?: string, body?: Buffer}>}} o
 * @returns {Promise<{found: false}|{found: true, data: Buffer}|null>} null = could not tell
 */
async function readWheelMember({ url, member, fetchRange }) {
  const tail = await fetchRange(url, `bytes=-${TAIL_BYTES}`);
  if (!tail || tail.status !== 206 || !Buffer.isBuffer(tail.body)) return null;
  const total = totalFromContentRange(tail.contentRange);
  const buf = tail.body;
  if (total === null || total < buf.length) return null;

  // End of central directory: the last record, 22 bytes + an (almost always empty) comment.
  let e = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { e = i; break; }
  }
  if (e < 0) return null;
  const entries = buf.readUInt16LE(e + 10);
  const cdSize = buf.readUInt32LE(e + 12);
  const cdOffset = buf.readUInt32LE(e + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null; // ZIP64

  const tailStart = total - buf.length;
  let cd;
  if (cdOffset >= tailStart) {
    cd = buf.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize);
    if (cd.length !== cdSize) return null;
  } else {
    cd = await range(fetchRange, url, cdOffset, cdOffset + cdSize - 1);
    if (!cd) return null;
  }

  let hit = null;
  for (let off = 0, n = 0; n < entries; n++) {
    if (off + 46 > cd.length || cd.readUInt32LE(off) !== CENTRAL_SIG) return null;
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    if (cd.toString('utf8', off + 46, off + 46 + nameLen) === member) {
      hit = {
        method: cd.readUInt16LE(off + 10),
        crc: cd.readUInt32LE(off + 16),
        compressed: cd.readUInt32LE(off + 20),
        size: cd.readUInt32LE(off + 24),
        localOffset: cd.readUInt32LE(off + 42),
      };
      break;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (!hit) return { found: false };
  if (hit.compressed > MAX_MEMBER_BYTES || hit.size > MAX_MEMBER_BYTES) return null;

  // The local header has its own name/extra lengths; the data starts after them.
  const local = await range(fetchRange, url, hit.localOffset, hit.localOffset + 29);
  if (!local || local.readUInt32LE(0) !== LOCAL_SIG) return null;
  const dataStart = hit.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const raw = hit.compressed === 0 ? Buffer.alloc(0) : await range(fetchRange, url, dataStart, dataStart + hit.compressed - 1);
  if (!raw) return null;

  let data;
  if (hit.method === 0) data = raw;
  else if (hit.method === 8) {
    try { data = zlib.inflateRawSync(raw); } catch { return null; }
  } else return null;
  if (data.length !== hit.size) return null;
  if (typeof zlib.crc32 === 'function' && (zlib.crc32(data) >>> 0) !== hit.crc) return null;
  return { found: true, data };
}

module.exports = { readWheelMember };
