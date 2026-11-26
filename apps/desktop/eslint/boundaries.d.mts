export interface LayerCase {
  file: string
  spec: string
  allowed: boolean
}

export interface MemberCase {
  name: string
  rule: 'gh-write' | 'github-http-member'
  flagged: boolean
}

export declare function layerViolations(file: string, spec: string): string[]
export declare function memberFlagged(rule: MemberCase['rule'], name: string): boolean
export declare const LAYER_CASES: readonly LayerCase[]
export declare const MEMBER_CASES: readonly MemberCase[]
