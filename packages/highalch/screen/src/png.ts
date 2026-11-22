import { deflateSync, inflateSync } from "node:zlib";

/** An image as 8-bit RGBA pixels, row by row. */
export type Pixels = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
};

const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;

  for (let bit = 0; bit < 8; bit += 1)
    value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;

  return value >>> 0;
});

const crc = (bytes: Uint8Array) => {
  let value = 0xff_ff_ff_ff;

  for (const byte of bytes) value = (table[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);

  return (value ^ 0xff_ff_ff_ff) >>> 0;
};

const chunk = (type: string, body: Uint8Array) => {
  const bytes = new Uint8Array(12 + body.length);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, body.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(body, 8);
  view.setUint32(8 + body.length, crc(bytes.subarray(4, 8 + body.length)));

  return bytes;
};

/** Encodes RGBA pixels as a PNG (8-bit RGBA, no filter): what baselines and frames are stored as. */
export const encode = (pixels: Pixels): Uint8Array => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);

  view.setUint32(0, pixels.width);
  view.setUint32(4, pixels.height);
  header.set([8, 6, 0, 0, 0], 8);

  const stride = pixels.width * 4;
  const raw = new Uint8Array((stride + 1) * pixels.height);

  for (let row = 0; row < pixels.height; row += 1)
    raw.set(pixels.data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);

  const parts = [
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];

  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

/** Channels per pixel of a PNG colour type this decoder reads: RGBA, RGB, else none. */
const channelsOf = (color: number | undefined) => {
  if (color === 6) return 4;

  if (color === 2) return 3;

  return 0;
};

const paeth = (left: number, up: number, corner: number) => {
  const estimate = left + up - corner;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toCorner = Math.abs(estimate - corner);

  if (toLeft <= toUp && toLeft <= toCorner) return left;

  if (toUp <= toCorner) return up;

  return corner;
};

/**
 * Decodes a PNG to RGBA pixels: 8-bit RGB or RGBA, not interlaced, any filter (what `encode`
 * writes, and what common tools re-save it as). Anything else is an error.
 */
export const decode = (png: Uint8Array): Pixels => {
  if (!signature.every((byte, index) => png[index] === byte)) throw new Error("not a PNG");

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const data: Array<Uint8Array> = [];
  let width = 0;
  let height = 0;
  let channels = 0;

  for (let offset = 8; offset < png.length;) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const [depth, color, , , interlace] = body.subarray(8, 13);

      width = header.getUint32(0);
      height = header.getUint32(4);
      channels = channelsOf(color);

      if (depth !== 8 || channels === 0 || interlace !== 0)
        throw new Error("only 8-bit RGB or RGBA PNGs without interlacing are compared");
    }

    if (type === "IDAT") data.push(body);

    offset += 12 + length;
  }

  const joined = new Uint8Array(data.reduce((total, part) => total + part.length, 0));
  let at = 0;

  for (const part of data) {
    joined.set(part, at);
    at += part.length;
  }

  const raw = inflateSync(joined);
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);

  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));

    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? (rows[row * stride + index - channels] ?? 0) : 0;
      const up = row > 0 ? (rows[(row - 1) * stride + index] ?? 0) : 0;

      const corner =
        row > 0 && index >= channels ? (rows[(row - 1) * stride + index - channels] ?? 0) : 0;

      const value = line[index] ?? 0;

      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter ?? 0];

      if (predicted === undefined) throw new Error(`unknown PNG filter ${filter}`);

      rows[row * stride + index] = (value + predicted) & 0xff;
    }
  }

  if (channels === 4) return { width, height, data: rows };

  const rgba = new Uint8Array(width * height * 4);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba.set(rows.subarray(pixel * 3, pixel * 3 + 3), pixel * 4);
    rgba[pixel * 4 + 3] = 255;
  }

  return { width, height, data: rgba };
};

/** How two images differ: the pixels that differ, and an image marking them in red. */
export type Difference = { readonly pixels: number; readonly image: Pixels };

/**
 * Compares decoded pixels exactly (not PNG bytes). Images of different sizes differ everywhere;
 * the difference image then has the actual image's size.
 */
export const compare = (actual: Pixels, expected: Pixels): Difference => {
  const data = new Uint8Array(actual.width * actual.height * 4);
  const same = actual.width === expected.width && actual.height === expected.height;
  let pixels = 0;

  for (let pixel = 0; pixel < actual.width * actual.height; pixel += 1) {
    const at = pixel * 4;

    const differs =
      !same ||
      [0, 1, 2, 3].some((channel) => actual.data[at + channel] !== expected.data[at + channel]);

    if (differs) {
      pixels += 1;
      data.set([220, 30, 30, 255], at);
    } else {
      // The unchanged image, faded, for orientation.
      const grey = Math.round(
        ((actual.data[at] ?? 0) + (actual.data[at + 1] ?? 0) + (actual.data[at + 2] ?? 0)) / 3,
      );

      const faded = 255 - Math.round((255 - grey) * 0.25);

      data.set([faded, faded, faded, 255], at);
    }
  }

  return { pixels, image: { width: actual.width, height: actual.height, data } };
};
