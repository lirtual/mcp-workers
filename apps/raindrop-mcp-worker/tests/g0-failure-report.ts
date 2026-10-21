// Preserve the original G0 assertion failure and any separate cleanup failure.
// A wrapper distinguishes thrown falsy values from a successful operation.
export type RecordedFailure = { error: unknown } | null;

export function raiseG0Failures(
  primary: RecordedFailure,
  cleanup: RecordedFailure,
): void {
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  if (primary && cleanup)
    throw new AggregateError(
      [primary.error, cleanup.error],
      "G0 primary failure: " + message(primary.error) +
        "; separate cleanup failure: " + message(cleanup.error),
    );
  if (primary) throw primary.error;
  if (cleanup) throw cleanup.error;
}
