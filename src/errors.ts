export class ModelError extends Error {
  // "Models can raise this error, which will be displayed to the user"
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NeedsKeyException extends ModelError {
  // "Model needs an API key which has not been provided"
}
