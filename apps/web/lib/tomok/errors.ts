export class TomokError extends Error {
  constructor(message: string, public readonly status = 503) {
    super(message);
    this.name = "TomokError";
  }
}

export function safeStorageError(error: unknown): never {
  if (error instanceof TomokError) throw error;
  // Driver errors can include connection details. Never send them to a model or browser.
  throw new TomokError("Project storage is unavailable. Check the MongoDB connection and try again.");
}
