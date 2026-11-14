import { UPDATE_NOTES_LABEL } from '@/renderer/update/copy'

export function ReleaseNotesLink({ href, label = UPDATE_NOTES_LABEL }: { readonly href: string; readonly label?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="rounded-sm text-small text-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
      {label}
    </a>
  )
}
