// BlockNode[] to DOM (#92) — `createElement`/`textContent` only, the only
// file under `renderer/` that imports `shared/markdown/`. A `link` node
// becomes `<a target="_blank" rel="noreferrer">`; everything else is built
// from the node's own `kind`, recursing for nested block or inline content.
import { parseMarkdown } from '../../shared/markdown/block'
import type { BlockNode, InlineNode, ListItem, TableAlign } from '../../shared/markdown/types'

function appendInline(container: HTMLElement, nodes: readonly InlineNode[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        container.appendChild(document.createTextNode(node.value))
        break
      case 'code': {
        const code = document.createElement('code')
        code.textContent = node.value
        container.appendChild(code)
        break
      }
      case 'strong': {
        const strong = document.createElement('strong')
        appendInline(strong, node.children)
        container.appendChild(strong)
        break
      }
      case 'emphasis': {
        const em = document.createElement('em')
        appendInline(em, node.children)
        container.appendChild(em)
        break
      }
      case 'link': {
        const a = document.createElement('a')
        a.href = node.href
        a.target = '_blank'
        a.rel = 'noreferrer'
        a.textContent = node.text
        container.appendChild(a)
        break
      }
    }
  }
}

function appendListItem(list: HTMLElement, item: ListItem): void {
  const li = document.createElement('li')
  if (item.checked !== null) {
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = item.checked
    checkbox.disabled = true
    li.appendChild(checkbox)
  }
  const span = document.createElement('span')
  appendInline(span, item.inline)
  li.appendChild(span)
  if (item.children.length > 0) appendMarkdown(li, item.children)
  list.appendChild(li)
}

function applyAlign(cell: HTMLElement, align: TableAlign | undefined): void {
  if (align !== undefined && align !== null) cell.style.textAlign = align
}

/** Appends every rendered block into `container`, recursively for
 *  blockquote/list nesting — the caller owns clearing `container` first, the
 *  same convention `board/view.ts`'s own DOM builders follow. */
export function appendMarkdown(container: HTMLElement, nodes: readonly BlockNode[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'heading': {
        const heading = document.createElement(`h${String(node.level)}`)
        appendInline(heading, node.inline)
        container.appendChild(heading)
        break
      }
      case 'paragraph': {
        const p = document.createElement('p')
        appendInline(p, node.inline)
        container.appendChild(p)
        break
      }
      case 'code': {
        const pre = document.createElement('pre')
        const code = document.createElement('code')
        if (node.language !== null) code.dataset.language = node.language
        code.textContent = node.code
        pre.appendChild(code)
        container.appendChild(pre)
        break
      }
      case 'blockquote': {
        const blockquote = document.createElement('blockquote')
        appendMarkdown(blockquote, node.children)
        container.appendChild(blockquote)
        break
      }
      case 'list': {
        const list = document.createElement(node.ordered ? 'ol' : 'ul')
        for (const item of node.items) appendListItem(list, item)
        container.appendChild(list)
        break
      }
      case 'table': {
        const table = document.createElement('table')
        const thead = document.createElement('thead')
        const headRow = document.createElement('tr')
        node.header.forEach((cell, idx) => {
          const th = document.createElement('th')
          applyAlign(th, node.align[idx])
          appendInline(th, cell)
          headRow.appendChild(th)
        })
        thead.appendChild(headRow)
        table.appendChild(thead)

        const tbody = document.createElement('tbody')
        for (const row of node.rows) {
          const tr = document.createElement('tr')
          row.forEach((cell, idx) => {
            const td = document.createElement('td')
            applyAlign(td, node.align[idx])
            appendInline(td, cell)
            tr.appendChild(td)
          })
          tbody.appendChild(tr)
        }
        table.appendChild(tbody)
        container.appendChild(table)
        break
      }
      case 'thematic-break':
        container.appendChild(document.createElement('hr'))
        break
    }
  }
}

/** Parses and appends in one call — `renderer/src/gate/view.ts`'s own entry
 *  point, so no second file under `renderer/` needs its own `shared/
 *  markdown/` import just to go from a raw string to DOM. */
export function renderMarkdown(container: HTMLElement, source: string): void {
  appendMarkdown(container, parseMarkdown(source))
}
