export class SkillMeshError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SkillMeshError";
    this.code = code;
    this.details = details;
  }
}
export function invariant(condition, code, message, details) {
  if (!condition) throw new SkillMeshError(code, message, details);
}
