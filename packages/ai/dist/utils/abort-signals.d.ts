export interface CombinedAbortSignal {
    signal?: AbortSignal;
    cleanup: () => void;
}
export declare function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal;
/** Standard abort error used by provider streams. */
export declare function createAbortError(message?: string): Error;
/**
 * Race an async iterable against AbortSignal.
 *
 * Why: many OpenAI-compatible proxies ignore request cancellation mid-SSE.
 * Checking `signal.aborted` only between chunks still hangs if no chunk arrives.
 * Racing each `iterator.next()` with abort forces the consumer to tear down
 * immediately when the user hits Stop.
 */
export declare function abortableAsyncIterable<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T, void, undefined>;
//# sourceMappingURL=abort-signals.d.ts.map