import { Type } from "typebox";
import { Value } from "typebox/value";

const MissingFileSchema = Type.Object({ code: Type.Literal("ENOENT") });

export function isMissingFileError(error: unknown): boolean {
  return Value.Check(MissingFileSchema, error);
}
