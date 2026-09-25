// Pure AWS EventStream binary framing for Kiro (ByteQueue, CRC32, frame parsing).
// Extracted verbatim from kiro.ts. Self-contained (local JsonRecord, no host imports).

type JsonRecord = Record<string, unknown>;

/**
 * Kiro EventStream frames are normally tiny JSON envelopes. A bounded limit
 * prevents a corrupted length prefix from retaining arbitrary upstream bytes
 * forever while the parser waits for a frame that will never complete.
 *
 * This matches the native Kiro client's 8 MiB incomplete-frame ceiling.
 */
export const KIRO_MAX_EVENTSTREAM_FRAME_BYTES = 8 * 1024 * 1024;
export const KIRO_MAX_EVENTSTREAM_BUFFER_BYTES = 8 * 1024 * 1024;
export const KIRO_MAX_EVENTSTREAM_RESPONSE_BYTES = 64 * 1024 * 1024;

export class KiroEventStreamProtocolError extends Error {
  readonly status = 502;
  readonly statusCode = 502;
  readonly type = "stream_error";
  readonly isKiroEventStreamProtocolError = true;

  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "KiroEventStreamProtocolError";
  }
}

export type EventFrame = {
  headers: Record<string, string>;
  payload: JsonRecord | null;
};

export class ByteQueue {
  private chunks: Uint8Array[] = [];
  private headOffset = 0;
  length = 0;

  constructor(private readonly maxBytes = KIRO_MAX_EVENTSTREAM_BUFFER_BYTES) {}

  push(chunk: Uint8Array) {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) return;
    if (chunk.length > this.maxBytes - this.length) {
      throw new KiroEventStreamProtocolError(
        "kiro_eventstream_buffer_too_large",
        `Kiro EventStream incomplete frame exceeded ${this.maxBytes} bytes`
      );
    }
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  peekUint32BE(offset = 0): number | null {
    if (this.length < offset + 4) return null;

    let value = 0;
    for (let i = 0; i < 4; i++) {
      value = (value << 8) | this.byteAt(offset + i);
    }
    return value >>> 0;
  }

  read(length: number): Uint8Array | null {
    if (length < 0 || this.length < length) return null;

    const output = new Uint8Array(length);
    let written = 0;

    while (written < length) {
      const head = this.chunks[0];
      const available = head.length - this.headOffset;
      const take = Math.min(available, length - written);
      output.set(head.subarray(this.headOffset, this.headOffset + take), written);
      written += take;
      this.headOffset += take;
      this.length -= take;

      if (this.headOffset >= head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }

    return output;
  }

  private byteAt(offset: number): number {
    let remaining = offset;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const start = i === 0 ? this.headOffset : 0;
      const available = chunk.length - start;
      if (remaining < available) {
        return chunk[start + remaining];
      }
      remaining -= available;
    }
    return 0;
  }
}

// ── CRC32 lookup table (IEEE polynomial, no dependency) ──
export const CRC32_TABLE = new Uint32Array(256);
export const TEXT_ENCODER = new TextEncoder();
export const TEXT_DECODER = new TextDecoder();
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

// Full per-frame message-CRC validation is O(frame bytes) and runs for EVERY frame of
// every Kiro response on the main thread. The transport is TLS-protected and the 8-byte
// prelude CRC already guards framing, so the full-message CRC is redundant overhead that
// contributes to the CPU-runaway on large/long generations. Keep it opt-in for debugging.
export const KIRO_VERIFY_FULL_CRC = process.env.KIRO_VERIFY_FULL_CRC === "true";

export function crc32(buf: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Parse AWS EventStream frame
 */
export function parseEventFrame(data: Uint8Array): EventFrame | null {
  try {
    if (data.length < 16) {
      console.warn(`[Kiro] EventStream frame too short: ${data.length} bytes`);
      return null;
    }
    const view = new DataView(data.buffer, data.byteOffset);
    const totalLength = view.getUint32(0, false);
    const headersLength = view.getUint32(4, false);

    if (
      totalLength < 16 ||
      totalLength !== data.length ||
      totalLength > KIRO_MAX_EVENTSTREAM_FRAME_BYTES ||
      headersLength > totalLength - 16
    ) {
      console.warn(
        `[Kiro] Invalid EventStream frame bounds: total=${totalLength}, headers=${headersLength}, bytes=${data.length}`
      );
      return null;
    }

    // ── CRC32 validation ──
    // Prelude CRC covers bytes [0..7] (totalLength + headersLength)
    const preludeCRC = view.getUint32(8, false);
    const computedPreludeCRC = crc32(data.slice(0, 8));
    if (preludeCRC !== computedPreludeCRC) {
      console.warn(
        `[Kiro] Prelude CRC mismatch: expected ${preludeCRC}, got ${computedPreludeCRC} — skipping corrupted frame`
      );
      return null;
    }

    // Message CRC covers bytes [0..totalLength-5] (everything except the CRC itself).
    // Skipped by default (O(frame bytes) per frame) — the prelude CRC above already
    // validates framing and the stream is TLS-protected. Enable KIRO_VERIFY_FULL_CRC=true
    // to restore full validation for debugging corrupted-stream issues.
    if (KIRO_VERIFY_FULL_CRC) {
      const messageCRC = view.getUint32(data.length - 4, false);
      const computedMessageCRC = crc32(data.slice(0, data.length - 4));
      if (messageCRC !== computedMessageCRC) {
        console.warn(
          `[Kiro] Message CRC mismatch: expected ${messageCRC}, got ${computedMessageCRC} — skipping corrupted frame`
        );
        return null;
      }
    }
    // Parse headers
    const headers: Record<string, string> = {};
    let offset = 12; // After prelude
    const headerEnd = 12 + headersLength;

    while (offset < headerEnd && offset < data.length) {
      const nameLen = data[offset];
      offset++;
      if (offset + nameLen > data.length) break;

      const name = TEXT_DECODER.decode(data.subarray(offset, offset + nameLen));
      offset += nameLen;

      const headerType = data[offset];
      offset++;

      if (headerType === 7) {
        // String type
        const valueLen = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        if (offset + valueLen > data.length) break;

        const value = TEXT_DECODER.decode(data.subarray(offset, offset + valueLen));
        offset += valueLen;
        headers[name] = value;
      } else {
        break;
      }
    }

    // Parse payload
    const payloadStart = 12 + headersLength;
    const payloadEnd = data.length - 4; // Exclude message CRC

    let payload: JsonRecord | null = null;
    if (payloadEnd > payloadStart) {
      const payloadStr = TEXT_DECODER.decode(data.subarray(payloadStart, payloadEnd));

      // Skip empty or whitespace-only payloads
      if (!payloadStr || !payloadStr.trim()) {
        return { headers, payload: null };
      }

      try {
        payload = JSON.parse(payloadStr);
      } catch {
        // JSON parser diagnostics can quote the invalid input. Keep the frame
        // useful to the caller, but never echo upstream content to retained logs.
        console.warn(`[Kiro] Failed to parse payload (${payloadEnd - payloadStart} bytes)`);
        payload = { raw: payloadStr };
      }
    }

    return { headers, payload };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.warn(`[Kiro] Frame parse error: ${error.message}`);
    return null;
  }
}

export type EventStreamException = {
  exceptionType: string;
  message: string;
  statusCode: number;
  errorCode: string;
  errorType: string;
};

/**
 * Extract and classify an exception embedded within an AWS EventStream frame.
 * CodeWhisperer/Amazon Q encodes stream errors with `:message-type: exception`
 * and `:exception-type` in the frame headers, while the JSON payload carries
 * the human-readable message.
 */
export function extractEventStreamException(event: EventFrame): EventStreamException | null {
  const messageType = event.headers[":message-type"];
  const exceptionType = event.headers[":exception-type"];
  if (messageType !== "exception" && !exceptionType) {
    return null;
  }

  const exType = exceptionType || "ServiceException";
  const rawMsg = event.payload?.message || event.payload?.Message;
  const message = typeof rawMsg === "string" ? rawMsg : `${exType}: AWS EventStream error`;

  let statusCode = 500;
  let errorCode = "service_exception";
  let errorType = "api_error";

  if (/throttling|toomanyrequests/i.test(exType)) {
    statusCode = 429;
    errorCode = "rate_limit_exceeded";
    errorType = "requests";
  } else if (/servicequotaexceeded|quota/i.test(exType)) {
    statusCode = 429;
    errorCode = "quota_exhausted";
    errorType = "insufficient_quota";
  } else if (/accessdenied|unauthorized/i.test(exType)) {
    statusCode = 403;
    errorCode = "access_denied";
    errorType = "permission_error";
  } else if (/expiredtoken|unrecognizedclient/i.test(exType)) {
    statusCode = 401;
    errorCode = "invalid_api_key";
    errorType = "authentication_error";
  } else if (/internalserver|serviceexception|modelstreamerror/i.test(exType)) {
    statusCode = 503;
    errorCode = "internal_server_error";
    errorType = "api_error";
  } else if (/validation|invalidparameter/i.test(exType)) {
    statusCode = 400;
    errorCode = "validation_error";
    errorType = "invalid_request_error";
  }

  return {
    exceptionType: exType,
    message,
    statusCode,
    errorCode,
    errorType,
  };
}
