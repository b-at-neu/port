import { UPDATE_NOTES_LABEL } from '@/renderer/update/copy'

export function ReleaseNotesLink({ href }: { readonly href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="rounded-sm text-small text-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
      {UPDATE_NOTES_LABEL}
    </a>
  )
}
