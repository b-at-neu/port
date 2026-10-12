export declare const DESKTOP_ROOT: string
export declare const SRC_ROOT: string
export declare const REPO_ROOT: string

export declare function walkSourceFiles(dir: string): string[]

export declare function maskNonCode(src: string): string

export interface Declaration {
  name: string
  kind: 'interface' | 'type'
  start: number
  end: number
  text: string
}

export declare function findDeclarations(content: string): Declaration[]

export interface NamedImport {
  name: string
  specifier: string
}

export declare function findNamedImports(content: string): NamedImport[]

export interface ClassifiedDeclaration extends Declaration {
  file: string
  importers: Set<string>
}

export declare function classify(): {
  declByKey: Map<string, ClassifiedDeclaration>
  declsByFile: Map<string, Declaration[]>
  mainFiles: string[]
}

export declare function classOf(decl: ClassifiedDeclaration, selfFile: string): 'NONE' | 'SINGLE-WITH-TEST' | 'MULTI'
