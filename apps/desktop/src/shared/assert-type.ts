// A compile-time-only equality check between two types — used to pin a
// hand-maintained literal union against a type derived elsewhere (e.g.
// `shared/ipc.ts`'s `IpcChannel` against `IpcMap`'s keys, and #76's
// `PipelineFailureKind` against the platform layer's own failure kinds), so
// the two drifting apart is a compile error rather than a silent `unknown`
// value at runtime. Extracted here once a second consumer needed it, rather
// than each declaring its own copy.
export type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
