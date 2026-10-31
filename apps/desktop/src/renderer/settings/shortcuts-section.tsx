// A read-only reference over `KEY_BINDINGS`, grouped by scope.
import { SettingsCard } from '@/renderer/components/settings-card'
import { KEY_BINDINGS } from '@/renderer/shell/key-bindings'
import { SHORTCUT_SCOPE_LABEL, WIDE_CARD } from '@/renderer/settings/copy'

const SCOPES = ['global', 'composer', 'list'] as const

export function ShortcutsSection() {
  return (
    <SettingsCard title="Keyboard shortcuts" className={WIDE_CARD}>
      <div data-slot="settings-shortcuts" className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-2">
        {SCOPES.map((scope) => (
          <div key={scope} className="flex flex-col gap-1">
            <h3 className="text-meta font-medium text-muted-foreground">{SHORTCUT_SCOPE_LABEL[scope]}</h3>
            <table className="w-full text-small">
              <tbody>
                {KEY_BINDINGS.filter((binding) => binding.scope === scope).map((binding) => (
                  <tr key={binding.keys} className="border-t border-border first:border-t-0">
                    <td className="w-48 py-1.5 pr-3 align-top font-mono text-foreground">{binding.keys}</td>
                    <td className="py-1.5 text-foreground-secondary">{binding.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </SettingsCard>
  )
}
