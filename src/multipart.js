// Minimal multipart/form-data parser for the §2.2 render upload. Only what the
// protocol needs: a small number of parts, each with a Content-Disposition name
// and optional filename, body is raw bytes. Not a general-purpose RFC 7578
// implementation — but correct for the two-part (metadata + image) payload
// hdr.toys sends, and tolerant of a truncated/aborted body (cancelled upload).

/**
 * @param {Buffer} body   the full request body
 * @param {string} contentType  the Content-Type header (must include boundary)
 * @returns {{name:string|null, filename:string|null, contentType:string|null, data:Buffer}[]}
 */
export function parseMultipart(body, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
    if (!m) throw new Error('no boundary in content-type');
    const boundary = `--${m[1] || m[2]}`.trim();
    const boundaryBuf = Buffer.from(boundary);

    const parts = [];
    let pos = body.indexOf(boundaryBuf);
    if (pos < 0) throw new Error('boundary not found in body');
    pos += boundaryBuf.length;

    while (pos < body.length) {
        // After a boundary: either "--" (final) or CRLF then the part.
        if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing "--"
        // Skip the trailing CRLF after the boundary line.
        if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;

        // Headers end at the first CRLFCRLF.
        const headerEnd = body.indexOf('\r\n\r\n', pos, 'latin1');
        if (headerEnd < 0) break;
        const headerBlock = body.toString('latin1', pos, headerEnd);
        const dataStart = headerEnd + 4;

        // Next boundary terminates this part's data.
        let next = body.indexOf(boundaryBuf, dataStart);
        if (next < 0) next = body.length; // tolerate truncated final part
        // Data is everything up to the CRLF that precedes the boundary.
        let dataEnd = next;
        if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;

        const data = body.subarray(dataStart, dataEnd);
        const { name, filename, type } = parseHeaders(headerBlock);
        parts.push({ name, filename, contentType: type, data: Buffer.from(data) });

        pos = next + boundaryBuf.length;
    }
    return parts;
}

function parseHeaders(block) {
    let name = null, filename = null, type = null;
    for (const line of block.split('\r\n')) {
        const lower = line.toLowerCase();
        if (lower.startsWith('content-disposition:')) {
            const n = /name="([^"]*)"/i.exec(line);
            const f = /filename="([^"]*)"/i.exec(line);
            if (n) name = n[1];
            if (f) filename = f[1];
        } else if (lower.startsWith('content-type:')) {
            type = line.slice(line.indexOf(':') + 1).trim();
        }
    }
    return { name, filename, type };
}
