/** A source whose resolved destination is forbidden by the image configuration. */
export class ImageDestinationError extends Error {
  constructor() {
    super('the image source resolves to a local address');
    this.name = 'ImageDestinationError';
  }
}
