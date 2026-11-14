import { parse } from "@babel/parser";

/** Change path literals only, leaving datasource/seed/application expressions untouched. */
export function patchPrismaConfig(
  source: string,
  schema: string,
  migrations: string,
): string | null {
  let ast;
  try {
    ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  } catch {
    return null;
  }
  const exported = ast.program.body.find((node) => node.type === "ExportDefaultDeclaration");
  if (exported?.type !== "ExportDefaultDeclaration") return null;
  let object: any = exported.declaration;
  if (
    object.type === "CallExpression" &&
    object.callee.type === "Identifier" &&
    object.callee.name === "defineConfig"
  )
    object = object.arguments[0];
  if (
    object?.type !== "ObjectExpression" ||
    object.properties.some(
      (property: any) => property.type !== "ObjectProperty" || property.computed,
    )
  )
    return null;
  const changes: { start: number; end: number; text: string }[] = [];
  const key = (property: any): string | undefined =>
    property.key.type === "Identifier"
      ? property.key.name
      : property.key.type === "StringLiteral"
        ? property.key.value
        : undefined;
  const assign = (target: any, name: string, value: string): boolean => {
    const property = target.properties.find((item: any) => key(item) === name);
    if (property) {
      if (
        property.value.type !== "StringLiteral" ||
        property.value.start === null ||
        property.value.end === null
      )
        return false;
      changes.push({
        start: property.value.start,
        end: property.value.end,
        text: JSON.stringify(value),
      });
    } else {
      const last = target.properties.at(-1);
      const trailing = source.slice(last?.end ?? target.start + 1, target.end - 1);
      changes.push({
        start: target.end - 1,
        end: target.end - 1,
        text: `${target.properties.length && !trailing.includes(",") ? "," : ""}\n  ${name}: ${JSON.stringify(value)},\n`,
      });
    }
    return true;
  };
  if (!assign(object, "schema", schema)) return null;
  const migrationProperty = object.properties.find(
    (property: any) => key(property) === "migrations",
  );
  if (migrationProperty) {
    if (
      migrationProperty.value.type !== "ObjectExpression" ||
      migrationProperty.value.properties.some(
        (property: any) => property.type !== "ObjectProperty" || property.computed,
      )
    )
      return null;
    if (!assign(migrationProperty.value, "path", migrations)) return null;
  } else {
    const last = object.properties.at(-1);
    const trailing = source.slice(last?.end ?? object.start + 1, object.end - 1);
    const sameLocation = changes.find((change) => change.start === object.end - 1);
    const addition = `\n  migrations: { path: ${JSON.stringify(migrations)} },\n`;
    if (sameLocation) sameLocation.text += addition;
    else
      changes.push({
        start: object.end - 1,
        end: object.end - 1,
        text: `${object.properties.length && !trailing.includes(",") ? "," : ""}${addition}`,
      });
  }
  let result = source;
  for (const change of changes.sort((a, b) => b.start - a.start))
    result = result.slice(0, change.start) + change.text + result.slice(change.end);
  try {
    parse(result, { sourceType: "module", plugins: ["typescript"] });
  } catch {
    return null;
  }
  return result;
}
