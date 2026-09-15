export class InstapaperError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = new.target.name;
  }
}

export class InstapaperAuthError extends InstapaperError {}
export class InstapaperApiError extends InstapaperError {}
export class InstapaperRateLimitError extends InstapaperError {}
export class InstapaperNotFoundError extends InstapaperError {}
export class InstapaperValidationError extends InstapaperError {}

export function toSafeInstapaperError(status: number, body?: string): InstapaperError {
  if (status === 401 || status === 403) {
    return new InstapaperAuthError(
      "Instapaper authentication failed. Re-run setup:instapaper and refresh the deployed OAuth token.",
      status,
    );
  }
  if (status === 404) {
    return new InstapaperNotFoundError("The requested Instapaper resource was not found.", status);
  }
  if (status === 429) {
    return new InstapaperRateLimitError("Instapaper rate limit exceeded. Try again later.", status);
  }

  const suffix = body ? ` (${body.slice(0, 160)})` : "";
  return new InstapaperApiError(`Instapaper API request failed with HTTP ${status}${suffix}`, status);
}
