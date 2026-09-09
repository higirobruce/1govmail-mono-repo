export class CapabilityNotSupportedError extends Error {
  constructor(capability: string) {
    super(`This mail server does not support ${capability}.`);
    this.name = 'CapabilityNotSupportedError';
  }
}
