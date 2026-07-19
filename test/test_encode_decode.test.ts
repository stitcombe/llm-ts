/** Port of tests/test_encode_decode.py */

import { expect, test } from "vitest";
import * as llm from "../src/index.js";

test.each([
  [[0.0, 1.0, 1.5]],
  [[3423.0, 222.0, -1234.5]],
])("test_roundtrip %#", (array) => {
  const encoded = llm.encode(array);
  const decoded = llm.decode(encoded);
  expect(decoded).toEqual(array);
  // Python cross-checks with numpy frombuffer("<f4"); Float32Array is the
  // JS equivalent (little-endian on all supported platforms).
  const floats = new Float32Array(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength / 4,
  );
  expect(Array.from(floats)).toEqual(array);
});
