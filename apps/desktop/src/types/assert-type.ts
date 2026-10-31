// A compile-time-only equality check between two types — pins a hand-maintained literal union against a type derived elsewhere, so drift is a compile error rather than a silent `unknown` at runtime.
export type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
