import assert from "node:assert";
import { describe, it } from "node:test";
import { formatByteValue } from "./format.mjs";

describe("formatByteValue", () => {
  it("scales by decimal SI units with one decimal place", () => {
    assert.equal(formatByteValue(0), "0B");
    assert.equal(formatByteValue(999), "999B");
    assert.equal(formatByteValue(1500), "1.5kB");
    assert.equal(formatByteValue(12345), "12.3kB");
    assert.equal(formatByteValue(12345678), "12.3MB");
    assert.equal(formatByteValue(5_000_000_000_000), "5TB");
  });

  // Regression for the `notation: "compact"` bug: short-scale "B"(illion)
  // collided with the byte unit, rendering 10⁹ as "1.5BB" instead of a GB.
  it("renders the billions scale as GB, not the '1.5BB' collision", () => {
    assert.equal(formatByteValue(1_500_000_000), "1.5GB");
  });

  // The same bug emitted a capitalised "KB"; SI is a lowercase "kB".
  it("uses SI casing 'kB', not 'KB'", () => {
    assert.equal(formatByteValue(1000), "1kB");
  });
});
