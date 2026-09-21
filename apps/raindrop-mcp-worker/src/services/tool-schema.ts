import type { z } from "zod";

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Prepare only immutable JSON metadata; validation stays with the original Zod schema. */
export function prepareToolSchema(schema: z.ZodTypeAny, io: "input" | "output" = "input"): Pick<z.ZodTypeAny, "~standard"> {
  const standard = schema["~standard"];
  const converter = standard.jsonSchema;
  const target = "draft-2020-12";
  const json = freezeJson(converter[io]({ target }));
  return Object.freeze({
    "~standard": Object.freeze({
      ...standard,
      jsonSchema: Object.freeze({
        input: (options: Parameters<typeof converter.input>[0]) =>
          options.target === target && io === "input" ? json : converter.input(options),
        output: (options: Parameters<typeof converter.output>[0]) =>
          options.target === target && io === "output" ? json : converter.output(options),
      }),
    }),
  });
}
