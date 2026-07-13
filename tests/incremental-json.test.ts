import { isProbablyCompleteJson } from "../src/incremental-json";

describe("isProbablyCompleteJson", () => {
  // --- Empty / non-JSON input ---
  it("returns false for empty string", () => {
    expect(isProbablyCompleteJson("")).toBe(false);
  });

  it("returns false for whitespace-only string", () => {
    expect(isProbablyCompleteJson("   ")).toBe(false);
  });

  it("returns false for string that doesn't start with { or [", () => {
    expect(isProbablyCompleteJson("hello")).toBe(false);
  });

  it("returns false for number literal (not object/array)", () => {
    expect(isProbablyCompleteJson("42")).toBe(false);
  });

  // --- Complete objects ---
  it("returns true for empty object", () => {
    expect(isProbablyCompleteJson("{}")).toBe(true);
  });

  it("returns true for simple object with single key", () => {
    expect(isProbablyCompleteJson('{"key":"value"}')).toBe(true);
  });

  it("returns true for object with multiple keys", () => {
    expect(isProbablyCompleteJson('{"a":1,"b":2,"c":3}')).toBe(true);
  });

  it("returns true for nested object", () => {
    expect(isProbablyCompleteJson('{"outer":{"inner":"value"}}')).toBe(true);
  });

  it("returns true for object with array value", () => {
    expect(isProbablyCompleteJson('{"items":[1,2,3]}')).toBe(true);
  });

  it("returns true for object with escaped quotes in string value", () => {
    expect(isProbablyCompleteJson('{"key":"value with \\"quotes\\""}')).toBe(true);
  });

  it("returns true for object with whitespace padding", () => {
    expect(isProbablyCompleteJson('  { "key" : "value" }  ')).toBe(true);
  });

  // --- Complete arrays ---
  it("returns true for empty array", () => {
    expect(isProbablyCompleteJson("[]")).toBe(true);
  });

  it("returns true for simple array", () => {
    expect(isProbablyCompleteJson("[1,2,3]")).toBe(true);
  });

  it("returns true for array of objects", () => {
    expect(isProbablyCompleteJson('[{"a":1},{"b":2}]')).toBe(true);
  });

  // --- Incomplete objects ---
  it("returns false for object missing closing brace", () => {
    expect(isProbablyCompleteJson('{"key":"value"')).toBe(false);
  });

  it("returns false for object with open nested object", () => {
    expect(isProbablyCompleteJson('{"outer":{"inner":"value"}')).toBe(false);
  });

  it("returns false for object with unterminated string", () => {
    expect(isProbablyCompleteJson('{"key":"value')).toBe(false);
  });

  it("returns false for object with only opening brace", () => {
    expect(isProbablyCompleteJson("{")).toBe(false);
  });

  // --- Incomplete arrays ---
  it("returns false for array missing closing bracket", () => {
    expect(isProbablyCompleteJson("[1,2,3")).toBe(false);
  });

  // --- Unbalanced braces ---
  it("returns false for too many closing braces", () => {
    expect(isProbablyCompleteJson("}}")).toBe(false);
  });

  it("returns false for mismatched brace types", () => {
    expect(isProbablyCompleteJson('{"array":[1,2}')).toBe(false);
  });

  // --- Streaming fragments ---
  it("returns false for partial key (incomplete string)", () => {
    expect(isProbablyCompleteJson('{"ke')).toBe(false);
  });

  it("returns false for partial value after colon", () => {
    expect(isProbablyCompleteJson('{"key":')).toBe(false);
  });

  it("returns false for partial number value", () => {
    expect(isProbablyCompleteJson('{"key":12')).toBe(false);
  });

  it("returns false for partial array element", () => {
    expect(isProbablyCompleteJson('{"items":[1,')).toBe(false);
  });

  // --- Edge cases ---
  it("returns true for object with boolean values", () => {
    expect(isProbablyCompleteJson('{"a":true,"b":false,"c":null}')).toBe(true);
  });

  it("returns true for deeply nested structure", () => {
    const json = JSON.stringify({ a: { b: { c: { d: [1, 2, { e: "f" }] } } } });
    expect(isProbablyCompleteJson(json)).toBe(true);
  });

  it("returns false for string that looks like JSON but is unclosed", () => {
    expect(isProbablyCompleteJson('{"key":"value"')).toBe(false);
  });
});
