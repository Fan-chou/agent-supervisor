import { createHash } from "node:crypto";

export function sha1(s: string | Uint8Array): string {
  return createHash("sha1").update(s).digest("hex");
}

/** 16 位十六进制短哈希，够用于指纹比较。 */
export function shortHash(s: string | Uint8Array): string {
  return sha1(s).slice(0, 16);
}

/** 键排序的稳定 JSON，用于 argsHash。 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
      .join(",") +
    "}"
  );
}
