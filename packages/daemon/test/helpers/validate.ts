// 够用的 JSON Schema 校验器（只覆盖 schemas.ts 用到的子集：type / enum / properties / required / items / oneOf / $ref / additionalProperties:schema）。
type S = Record<string, any>;

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/** 返回错误列表（空 = 通过）。 */
export function validate(schema: S, value: unknown, root: S = schema, path = "$"): string[] {
  if (schema.$ref) {
    const name = String(schema.$ref).replace("#/$defs/", "");
    const target = root.$defs?.[name];
    return target ? validate(target, value, root, path) : [`${path}: 找不到 ${schema.$ref}`];
  }
  if (schema.oneOf) {
    const results = (schema.oneOf as S[]).map((s) => validate(s, value, root, path));
    const passing = results.filter((r) => r.length === 0).length;
    return passing === 1 ? [] : [`${path}: oneOf 通过了 ${passing} 个（需要恰好 1 个）：${results.map((r) => r[0]).join(" | ")}`];
  }
  const errs: string[] = [];
  const t = typeOf(value);
  if (schema.type) {
    const allowed: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const okType = allowed.includes(t) || (t === "integer" && allowed.includes("number"));
    if (!okType) return [`${path}: 类型 ${t} 不在 ${allowed.join("|")}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} 不在 enum ${JSON.stringify(schema.enum)}`);
  if (t === "object") {
    const o = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in o)) errs.push(`${path}: 缺少必需字段 ${r}`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in o) errs.push(...validate(s as S, o[k], root, `${path}.${k}`));
    if (schema.additionalProperties && typeof schema.additionalProperties === "object" && !schema.properties) for (const [k, v] of Object.entries(o)) errs.push(...validate(schema.additionalProperties, v, root, `${path}.${k}`));
  }
  if (t === "array" && schema.items) (value as unknown[]).forEach((v, i) => errs.push(...validate(schema.items, v, root, `${path}[${i}]`)));
  return errs;
}
