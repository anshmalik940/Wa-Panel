class ProviderError extends Error {
  constructor(message, { retryable = false, code = null, status = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
    this.code = code;
    this.status = status;
  }
}

module.exports = { ProviderError };
