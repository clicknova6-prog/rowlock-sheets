export class SheetRuleError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "SheetRuleError";
  }
}
