export interface ParentImportCase {
  file: string
  spec: string
  flagged: boolean
}

export declare function isParentImport(file: string, spec: string): boolean
export declare const CASES: readonly ParentImportCase[]
