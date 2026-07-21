// RFC 8785 (JCS) canonical JSON — the byte representation everything is
// signed and hashed over. Object keys sorted by UTF-16 code units; numbers
// serialized with ECMAScript semantics (JSON.stringify matches JCS here).

// Depth cap: this runs on attacker-controlled JSON on the PUBLIC register/
// results path, before auth. Unbounded recursion on ~4k nested arrays blows
// the JS stack (RangeError) and 500s the request anonymously. No legitimate
// protocol payload nests anywhere near this deep.
export const MAX_CANONICALIZE_DEPTH = 32;

export function canonicalize(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICALIZE_DEPTH) {
    throw new Error(`cannot canonicalize: nesting deeper than ${MAX_CANONICALIZE_DEPTH}`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot canonicalize non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v, depth + 1)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k], depth + 1)).join(",") + "}";
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}
