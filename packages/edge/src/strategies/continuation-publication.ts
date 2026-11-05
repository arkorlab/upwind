import { resumePublicationHeader } from '@stayingupwind/core/paas';

/** Only failure to carry the selected proof permits replacing a resume with a full render. */
export class PublicationResumeUnavailableError extends Error {
  constructor(cause: TypeError | RangeError) {
    super('The selected publication proof cannot be carried by a continuation.', { cause });
    this.name = 'PublicationResumeUnavailableError';
  }
}

export function continuationPublicationHeader(tags: readonly string[]): string | undefined {
  try {
    return resumePublicationHeader(tags);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError)
      throw new PublicationResumeUnavailableError(error);
    throw error;
  }
}
