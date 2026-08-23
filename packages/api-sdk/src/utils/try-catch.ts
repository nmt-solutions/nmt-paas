type SyncFunction<T> = () => T;
type AsyncFunction<T> = () => Promise<T>;

// Types
type Success<T> = {
  data: T;
  error: null;
};

type Failure<E> = {
  data: null;
  error: E;
};

export type Result<T, E = Error> = Success<T> | Failure<E>;

// 🔹 Helper: detect Promise-like
function isThenable<T = unknown>(value: unknown): value is PromiseLike<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}

// 🔹 Overloads
export function tryCatch<T, E = Error>(fn: SyncFunction<T>): Result<T, E>;

export function tryCatch<T, E = Error>(
  fn: AsyncFunction<T>,
): Promise<Result<T, E>>;

export function tryCatch<T, E = Error>(
  promise: Promise<T>,
): Promise<Result<T, E>>;

// 🔹 Implementation
export function tryCatch<T, E = Error>(
  input: SyncFunction<T> | AsyncFunction<T> | Promise<T>,
): Result<T, E> | Promise<Result<T, E>> {
  try {
    // Case 1: Promise / thenable directly passed
    if (isThenable<T>(input)) {
      return input
        .then((data) => ({ data, error: null }))
        .catch((error) => ({
          data: null,
          error: error as E,
        }));
    }

    // Case 2: Function passed
    const result = input();

    // Async function / QueryPromise return
    if (isThenable<T>(result)) {
      return result
        .then((data) => ({ data, error: null }))
        .catch((error) => ({
          data: null,
          error: error as E,
        }));
    }

    // Sync function
    return { data: result, error: null };
  } catch (error) {
    console.error("Error in tryCatch:", error);
    return { data: null, error: error as E };
  }
}
