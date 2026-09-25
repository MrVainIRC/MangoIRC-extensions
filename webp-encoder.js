/*
 * DigitalTouch 0.1.0
 *
 * Pure-JavaScript VP8L encoder based on the MIT-licensed implementation
 * from cross-org/image. Supports lossless output and RGB quantization.
 */
(() => {
  'use strict';

  function writeUint32LE(value) {
    return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
  }

  class BitWriter {
    constructor() {
      this.bytes = [];
      this.bits = 0;
      this.bitCount = 0;
    }
    writeBits(value, numBits) {
      for (let i = 0; i < numBits; i++) {
        const bit = (value >>> i) & 1;
        if (this.bitCount > 0 && this.bitCount % 8 === 0) {
          this.bytes.push(this.bits);
          this.bits = 0;
        }
        this.bits |= bit << (this.bitCount % 8);
        this.bitCount++;
      }
    }
    flush() {
      if (this.bitCount % 8 !== 0) {
        this.bytes.push(this.bits);
        this.bits = 0;
      } else if (this.bitCount > 0 && this.bytes.length * 8 < this.bitCount) {
        this.bytes.push(this.bits);
        this.bits = 0;
      }
    }
    getBytes() { return new Uint8Array(this.bytes); }
  }

  class WebPEncoder {
    constructor(width, height, rgba) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) {
        throw new Error('Invalid WebP dimensions.');
      }
      if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4) {
        throw new Error('Invalid WebP RGBA buffer.');
      }
      this.width = width;
      this.height = height;
      this.data = rgba;
      this.quality = 100;
    }

    encode(quality = 100) {
      this.quality = Math.max(1, Math.min(100, Number(quality) || 100));
      const output = [0x52,0x49,0x46,0x46, 0,0,0,0, 0x57,0x45,0x42,0x50, 0x56,0x50,0x38,0x4c, 0,0,0,0];
      const vp8lSizePos = 16;
      const vp8lData = this.encodeVP8L();
      output.push(...vp8lData);
      if (vp8lData.length & 1) output.push(0);
      const chunkSize = writeUint32LE(vp8lData.length);
      for (let i = 0; i < 4; i++) output[vp8lSizePos + i] = chunkSize[i];
      const fileSize = writeUint32LE(output.length - 8);
      for (let i = 0; i < 4; i++) output[4 + i] = fileSize[i];
      return new Uint8Array(output);
    }

    encodeVP8L() {
      const output = [0x2f];
      const hasAlpha = this.hasAlphaChannel() ? 1 : 0;
      const bits = ((this.width - 1) & 0x3fff) |
        (((this.height - 1) & 0x3fff) << 14) |
        (hasAlpha << 28);
      output.push(...writeUint32LE(bits));
      output.push(...this.encodeImageData(hasAlpha));
      return output;
    }

    hasAlphaChannel() {
      for (let i = 3; i < this.data.length; i += 4) if (this.data[i] !== 255) return true;
      return false;
    }

    quantizeImageData() {
      if (this.quality >= 100) return this.data;
      let shift;
      if (this.quality >= 90) shift = 1;
      else if (this.quality >= 70) shift = 2;
      else if (this.quality >= 50) shift = 3;
      else if (this.quality >= 30) shift = 4;
      else shift = 5;
      const result = new Uint8Array(this.data.length);
      const mask = (0xff << shift) & 0xff;
      for (let i = 0; i < this.data.length; i += 4) {
        result[i] = this.data[i] & mask;
        result[i + 1] = this.data[i + 1] & mask;
        result[i + 2] = this.data[i + 2] & mask;
        result[i + 3] = this.data[i + 3];
      }
      return result;
    }

    encodeImageData(hasAlpha) {
      const writer = new BitWriter();
      writer.writeBits(0, 1); // no transforms
      writer.writeBits(0, 1); // no color cache
      writer.writeBits(0, 1); // no meta Huffman codes

      const data = this.quantizeImageData();
      const greenFreqs = new Map();
      const redFreqs = new Map();
      const blueFreqs = new Map();
      const alphaFreqs = new Map();
      const count = this.width * this.height;

      for (let i = 0; i < count; i++) {
        const o = i * 4;
        const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
        greenFreqs.set(g, (greenFreqs.get(g) || 0) + 1);
        redFreqs.set(r, (redFreqs.get(r) || 0) + 1);
        blueFreqs.set(b, (blueFreqs.get(b) || 0) + 1);
        if (hasAlpha) alphaFreqs.set(a, (alphaFreqs.get(a) || 0) + 1);
      }

      const greenCodes = this.writeHuffmanCode(writer, greenFreqs, 280);
      const redCodes = this.writeHuffmanCode(writer, redFreqs, 256);
      const blueCodes = this.writeHuffmanCode(writer, blueFreqs, 256);
      const alphaCodes = hasAlpha
        ? this.writeHuffmanCode(writer, alphaFreqs, 256)
        : this.writeHuffmanCode(writer, new Map([[255, count]]), 256);
      this.writeHuffmanCode(writer, new Map([[0, 1]]), 40);

      for (let i = 0; i < count; i++) {
        const o = i * 4;
        this.writeSymbol(writer, greenCodes, data[o + 1]);
        this.writeSymbol(writer, redCodes, data[o]);
        this.writeSymbol(writer, blueCodes, data[o + 2]);
        if (hasAlpha) this.writeSymbol(writer, alphaCodes, data[o + 3]);
      }
      writer.flush();
      return Array.from(writer.getBytes());
    }

    writeHuffmanCode(writer, frequencies, maxSymbol) {
      const symbols = Array.from(frequencies.keys()).sort((a,b) => a-b);
      if (symbols.length === 0) {
        this.writeSimpleHuffmanCode(writer, [0]);
        return new Map([[0, { code: 0, length: 0 }]]);
      }
      if (symbols.length === 1) {
        this.writeSimpleHuffmanCode(writer, [symbols[0]]);
        return new Map([[symbols[0], { code: 0, length: 0 }]]);
      }
      if (symbols.length === 2) {
        this.writeSimpleHuffmanCode(writer, symbols);
        return new Map([
          [symbols[0], { code: 0, length: 1 }],
          [symbols[1], { code: 1, length: 1 }]
        ]);
      }
      return this.writeComplexHuffmanCode(writer, frequencies, maxSymbol);
    }

    writeSymbol(writer, codes, symbol) {
      const h = codes.get(symbol);
      if (!h) throw new Error(`No Huffman code for symbol ${symbol}`);
      for (let i = h.length - 1; i >= 0; i--) writer.writeBits((h.code >>> i) & 1, 1);
    }

    writeSimpleHuffmanCode(writer, symbols) {
      writer.writeBits(1, 1);
      if (symbols.length === 1) {
        writer.writeBits(0, 1);
        writer.writeBits(1, 1);
        writer.writeBits(symbols[0], 8);
      } else if (symbols.length === 2) {
        writer.writeBits(1, 1);
        writer.writeBits(1, 1);
        writer.writeBits(symbols[0], 8);
        writer.writeBits(symbols[1], 8);
      } else {
        throw new Error('Invalid simple Huffman code.');
      }
    }

    calculateCodeLengths(frequencies, maxSymbol, maxCodeLength = 15) {
      const lengths = new Uint8Array(maxSymbol);
      const symbols = Array.from(frequencies.keys()).sort((a,b) => a-b);
      if (!symbols.length) return lengths;
      if (symbols.length === 1) { lengths[symbols[0]] = 1; return lengths; }
      if (symbols.length === 2) { lengths[symbols[0]] = 1; lengths[symbols[1]] = 1; return lengths; }

      let nodes = symbols.map(symbol => ({ freq: frequencies.get(symbol), symbol }));
      const buildTree = leafs => {
        const queue = [...leafs];
        while (queue.length > 1) {
          queue.sort((a,b) => a.freq - b.freq);
          const left = queue.shift();
          const right = queue.shift();
          queue.push({ freq: left.freq + right.freq, left, right });
        }
        return queue[0];
      };

      let root = buildTree(nodes);
      const maxTreeDepth = tree => {
        let max = 0;
        const stack = [{ node: tree, depth: 0 }];
        while (stack.length) {
          const { node, depth } = stack.pop();
          if (node.symbol !== undefined) max = Math.max(max, depth);
          else {
            if (node.left) stack.push({ node: node.left, depth: depth + 1 });
            if (node.right) stack.push({ node: node.right, depth: depth + 1 });
          }
        }
        return max;
      };

      let depth = maxTreeDepth(root);
      let attempts = 0;
      while (depth > maxCodeLength && attempts < 5) {
        attempts++;
        const bias = (Math.ceil(root.freq / (symbols.length * 2)) || 1) * attempts;
        nodes = symbols.map(symbol => ({ freq: frequencies.get(symbol) + bias, symbol }));
        root = buildTree(nodes);
        depth = maxTreeDepth(root);
      }

      const stack = [{ node: root, depth: 0 }];
      while (stack.length) {
        const entry = stack.pop();
        const node = entry.node;
        if (node.symbol !== undefined) lengths[node.symbol] = Math.min(entry.depth, maxCodeLength);
        else {
          if (node.left) stack.push({ node: node.left, depth: entry.depth + 1 });
          if (node.right) stack.push({ node: node.right, depth: entry.depth + 1 });
        }
      }
      for (const symbol of symbols) if (lengths[symbol] === 0) lengths[symbol] = 1;
      return lengths;
    }

    buildCanonicalCodes(lengths) {
      const codes = new Map();
      let maxLength = 0;
      for (const len of lengths) maxLength = Math.max(maxLength, len);
      const counts = new Uint32Array(maxLength + 1);
      for (const len of lengths) if (len > 0) counts[len]++;
      let code = 0;
      const next = new Uint32Array(maxLength + 1);
      for (let len = 1; len <= maxLength; len++) {
        code = (code + counts[len - 1]) << 1;
        next[len] = code;
      }
      for (let symbol = 0; symbol < lengths.length; symbol++) {
        const len = lengths[symbol];
        if (len > 0) {
          codes.set(symbol, { code: next[len], length: len });
          next[len]++;
        }
      }
      return codes;
    }

    rleEncodeCodeLengths(lengths) {
      const encoded = [];
      let i = 0;
      while (i < lengths.length) {
        const length = lengths[i];
        if (length === 0) {
          let count = 0;
          while (i + count < lengths.length && lengths[i + count] === 0) count++;
          const total = count;
          while (count > 0) {
            if (count >= 11) {
              const n = Math.min(count, 138);
              encoded.push(18, n - 11);
              count -= n;
            } else if (count >= 3) {
              const n = Math.min(count, 10);
              encoded.push(17, n - 3);
              count -= n;
            } else {
              encoded.push(0);
              count--;
            }
          }
          i += total;
        } else {
          encoded.push(length);
          i++;
          let count = 0;
          while (i + count < lengths.length && lengths[i + count] === length && count < 6) count++;
          if (count >= 3) {
            encoded.push(16, count - 3);
            i += count;
          }
        }
      }
      return encoded;
    }

    writeComplexHuffmanCode(writer, frequencies, maxSymbol) {
      const codeLengths = this.calculateCodeLengths(frequencies, maxSymbol);
      const codes = this.buildCanonicalCodes(codeLengths);
      writer.writeBits(0, 1);
      const rle = this.rleEncodeCodeLengths(codeLengths);
      const lengthFreqs = new Map();
      for (let i = 0; i < rle.length; i++) {
        const c = rle[i];
        lengthFreqs.set(c, (lengthFreqs.get(c) || 0) + 1);
        if (c === 16 || c === 17 || c === 18) i++;
      }
      const lengthCodeLengths = this.calculateCodeLengths(lengthFreqs, 19, 7);
      const order = [17,18,0,1,2,3,4,5,16,6,7,8,9,10,11,12,13,14,15];
      let numCodes = 19;
      for (let i = 18; i >= 4; i--) {
        if (lengthCodeLengths[order[i]] === 0) numCodes = i;
        else break;
      }
      numCodes = Math.max(4, numCodes);
      writer.writeBits(numCodes - 4, 4);
      for (let i = 0; i < numCodes; i++) writer.writeBits(lengthCodeLengths[order[i]], 3);
      writer.writeBits(0, 1); // no trimming
      const lengthCodes = this.buildCanonicalCodes(lengthCodeLengths);
      let nonZero = 0;
      for (const len of lengthCodeLengths) if (len > 0) nonZero++;
      if (nonZero === 1) for (const info of lengthCodes.values()) info.length = 0;

      for (let i = 0; i < rle.length; i++) {
        const symbol = rle[i];
        const h = lengthCodes.get(symbol);
        if (!h) throw new Error(`No Huffman code for code-length symbol ${symbol}`);
        for (let b = h.length - 1; b >= 0; b--) writer.writeBits((h.code >>> b) & 1, 1);
        if (symbol === 16) writer.writeBits(rle[++i], 2);
        else if (symbol === 17) writer.writeBits(rle[++i], 3);
        else if (symbol === 18) writer.writeBits(rle[++i], 7);
      }
      return codes;
    }
  }

  window.MangoTouchWebP = { WebPEncoder };
})();
