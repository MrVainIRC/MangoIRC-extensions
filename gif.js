/*
 * DigitalTouch 0.1.0
 *
 * Small GIF89a encoder with an adaptive global palette and LZW compression.
 */
(function () {
  'use strict';

  const SWATCHES = [
    [255, 55, 95],
    [255, 159, 10],
    [255, 214, 10],
    [48, 209, 88],
    [100, 210, 255],
    [10, 132, 255],
    [191, 90, 242],
    [255, 255, 255]
  ];

  function push16(out, n) { out.push(n & 255, (n >> 8) & 255); }

  function colorBin(red, green, blue) {
    return (red >> 3) * 1024 + (green >> 3) * 32 + (blue >> 3);
  }

  function buildAdaptivePalette(frames) {
    const counts = new Uint32Array(32768);
    const sumsR = new Float64Array(32768);
    const sumsG = new Float64Array(32768);
    const sumsB = new Float64Array(32768);
    for (const frame of frames) {
      const data = frame.rgba;
      for (let i = 0; i < data.length; i += 4) {
        const bin = colorBin(data[i], data[i + 1], data[i + 2]);
        counts[bin]++;
        sumsR[bin] += data[i];
        sumsG[bin] += data[i + 1];
        sumsB[bin] += data[i + 2];
      }
    }

    const colors = [];
    for (let bin = 0; bin < counts.length; bin++) {
      const count = counts[bin];
      if (!count) continue;
      colors.push({
        r: sumsR[bin] / count,
        g: sumsG[bin] / count,
        b: sumsB[bin] / count,
        count
      });
    }

    const boxes = colors.length ? [colors] : [];
    while (boxes.length < 248) {
      let selected = -1;
      let selectedScore = -1;
      let selectedChannel = 0;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.length < 2) continue;
        let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
        let weight = 0;
        for (const color of box) {
          minR = Math.min(minR, color.r); maxR = Math.max(maxR, color.r);
          minG = Math.min(minG, color.g); maxG = Math.max(maxG, color.g);
          minB = Math.min(minB, color.b); maxB = Math.max(maxB, color.b);
          weight += color.count;
        }
        const ranges = [maxR - minR, maxG - minG, maxB - minB];
        const channel = ranges[0] >= ranges[1] && ranges[0] >= ranges[2] ? 0 : ranges[1] >= ranges[2] ? 1 : 2;
        const score = ranges[channel] * Math.log2(weight + 1);
        if (score > selectedScore) {
          selected = i;
          selectedScore = score;
          selectedChannel = channel;
        }
      }
      if (selected < 0) break;
      const box = boxes[selected];
      box.sort((a, b) => a[['r', 'g', 'b'][selectedChannel]] - b[['r', 'g', 'b'][selectedChannel]]);
      const total = box.reduce((sum, color) => sum + color.count, 0);
      let accumulated = 0;
      let split = 1;
      for (let i = 0; i < box.length - 1; i++) {
        accumulated += box[i].count;
        if (accumulated >= total / 2) {
          split = i + 1;
          break;
        }
      }
      boxes.splice(selected, 1, box.slice(0, split), box.slice(split));
    }

    const palette = SWATCHES.map((color) => color.slice());
    for (const box of boxes) {
      let weight = 0, red = 0, green = 0, blue = 0;
      for (const color of box) {
        weight += color.count;
        red += color.r * color.count;
        green += color.g * color.count;
        blue += color.b * color.count;
      }
      palette.push([
        Math.round(red / Math.max(1, weight)),
        Math.round(green / Math.max(1, weight)),
        Math.round(blue / Math.max(1, weight))
      ]);
    }
    while (palette.length < 256) palette.push([0, 0, 0]);
    return palette.slice(0, 256);
  }

  function buildPaletteLookup(palette) {
    const lookup = new Uint8Array(32768);
    for (let bin = 0; bin < lookup.length; bin++) {
      const red = ((bin >> 10) & 31) * 8 + 4;
      const green = ((bin >> 5) & 31) * 8 + 4;
      const blue = (bin & 31) * 8 + 4;
      let best = 0;
      let distance = Infinity;
      for (let index = 0; index < palette.length; index++) {
        const color = palette[index];
        const dr = red - color[0];
        const dg = green - color[1];
        const db = blue - color[2];
        const candidate = dr * dr + dg * dg + db * db;
        if (candidate < distance) {
          distance = candidate;
          best = index;
        }
      }
      lookup[bin] = best;
    }
    return lookup;
  }

  function flattenPalette(palette) {
    const out = [];
    for (const color of palette) out.push(...color);
    return out;
  }

  function rgbaToPalette(data, lookup) {
    if (!data || data.length % 4 !== 0) throw new Error('Invalid RGBA frame data.');
    const out = new Uint8Array(data.length / 4);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) out[p] = lookup[colorBin(data[i], data[i + 1], data[i + 2])];
    return out;
  }

  function lzwEncode(indices, minCodeSize) {
    if (!indices || !indices.length) throw new Error('Cannot encode an empty GIF frame.');
    const clear = 1 << minCodeSize;
    const eoi = clear + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = eoi + 1;
    let dict;
    const bytes = [];
    let cur = 0, bits = 0;

    function resetDict() {
      dict = new Map();
      for (let i = 0; i < clear; i++) dict.set(String(i), i);
      codeSize = minCodeSize + 1;
      nextCode = eoi + 1;
    }

    function write(code) {
      cur |= code << bits;
      bits += codeSize;
      while (bits >= 8) {
        bytes.push(cur & 255);
        cur >>= 8;
        bits -= 8;
      }
    }

    resetDict();
    write(clear);

    let prefix = String(indices[0] ?? 0);
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const combo = prefix + ',' + k;
      if (dict.has(combo)) {
        prefix = combo;
      } else {
        write(dict.get(prefix));
        if (nextCode < 4096) {
          dict.set(combo, nextCode++);
          // The decoder adds this dictionary entry only after it has read the
          // next code. Keep the current width for that code and grow it one
          // entry later, otherwise the bit stream becomes misaligned at 9→10
          // bits (and again at every subsequent code-width boundary).
          if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
        } else {
          write(clear);
          resetDict();
        }
        prefix = String(k);
      }
    }
    write(dict.get(prefix));
    write(eoi);
    if (bits > 0) bytes.push(cur & 255);
    return bytes;
  }

  function subBlocks(out, bytes) {
    for (let i = 0; i < bytes.length; i += 255) {
      const n = Math.min(255, bytes.length - i);
      out.push(n);
      for (let j = 0; j < n; j++) out.push(bytes[i + j]);
    }
    out.push(0);
  }

  class GIFEncoder {
    constructor(width, height, loop = 0) {
      this.width = width;
      this.height = height;
      this.loop = loop;
      this.frames = [];
    }

    addFrame(imageData, delayCs) {
      if (!imageData || !imageData.data || imageData.data.length !== this.width * this.height * 4) {
        throw new Error('Invalid GIF frame dimensions.');
      }
      this.frames.push({
        rgba: new Uint8Array(imageData.data),
        delayCs: Math.max(2, Math.min(65535, delayCs | 0))
      });
    }

    finish() {
      if (!this.frames.length) throw new Error('Cannot finish an empty GIF.');
      const out = [];
      for (const c of 'GIF89a') out.push(c.charCodeAt(0));
      push16(out, this.width);
      push16(out, this.height);
      out.push(0xF7, 0, 0); // global 256-color table, color resolution 8
      const palette = buildAdaptivePalette(this.frames);
      const lookup = buildPaletteLookup(palette);
      out.push(...flattenPalette(palette));

      if (this.loop !== null) {
        // Netscape loop extension. A value of 0 loops forever.
        out.push(0x21, 0xFF, 0x0B);
        for (const c of 'NETSCAPE2.0') out.push(c.charCodeAt(0));
        out.push(3, 1);
        push16(out, this.loop);
        out.push(0);
      }

      for (const frame of this.frames) {
        // Graphics Control Extension.
        out.push(0x21, 0xF9, 4, 0x00);
        push16(out, frame.delayCs);
        out.push(0, 0);

        // Image descriptor.
        out.push(0x2C);
        push16(out, 0); push16(out, 0);
        push16(out, this.width); push16(out, this.height);
        out.push(0x00);

        out.push(8); // minimum code size
        subBlocks(out, lzwEncode(rgbaToPalette(frame.rgba, lookup), 8));
      }

      out.push(0x3B);
      return new Uint8Array(out);
    }
  }

  window.MangoTouchGIF = { GIFEncoder };
})();
