// Custom error class that carries an HTTP status code for use in Express
// error handling middleware.

export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}
