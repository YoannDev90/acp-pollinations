/**
 * A tool refused the request for a reason written to be read: a missing file,
 * a path outside the workspace, an argument the model got wrong.
 *
 * Marking the expected refusals separately from unexpected failures is what
 * lets a reader tell "the model should correct itself" from "this is a bug".
 * Note that nothing escapes with it in practice — `executeTool` converts
 * every failure into an `isError` result so the turn survives — so the class
 * is a signal to handlers and library consumers, not a control-flow edge.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}
