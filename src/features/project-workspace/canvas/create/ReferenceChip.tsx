'use client'

import { useTranslations } from 'next-intl'
import { AppIcon, type AppIconName } from '@/components/ui/icons'
import { SELECTABLE_TEXT_CLASS } from '../nodes/renderers/renderer-shared'
import type { CanvasDraftReferenceCandidate, CanvasDraftReferenceRole } from './canvas-draft'

const REFERENCE_ICON: Readonly<Record<CanvasDraftReferenceCandidate['mediaType'], AppIconName>> = {
  image: 'image',
  video: 'video',
  audio: 'audioWave',
  text: 'fileText',
}

/** A reference attached to an edit: the project resource it points at plus the role it plays. */
export type ReferenceChipReference = CanvasDraftReferenceCandidate & { readonly role: string }

/**
 * One attached reference — thumbnail, name and role — shared by the create
 * draft and the "run again" editor. The role becomes a select only when the
 * owner can re-role it (`onChangeRole`) and more than the current role fits.
 */
export function ReferenceChip({
  reference,
  roles,
  disabled,
  onRemove,
  onChangeRole,
}: {
  readonly reference: ReferenceChipReference
  /** Roles this reference may take in the owner's current composition; empty when the owner cannot re-role it. */
  readonly roles: readonly CanvasDraftReferenceRole[]
  readonly disabled: boolean
  readonly onRemove: () => void
  readonly onChangeRole?: (role: CanvasDraftReferenceRole) => void
}) {
  const t = useTranslations('projectWorkflow.canvas.workspace.create')
  const selectable = onChangeRole && roles.length > 0 && (roles.length > 1 || !roles.includes(reference.role as CanvasDraftReferenceRole))
  return (
    <li className="flex items-center gap-2 rounded-[12px] bg-white px-2 py-1.5 ring-1 ring-slate-200">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-slate-100 text-[var(--glass-text-tertiary)]">
        {reference.previewUrl && reference.mediaType === 'image' ? (
          // Protected server View URL, never a raw storage key.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={reference.previewUrl} alt="" className="h-full w-full object-cover" />
        ) : reference.previewUrl && reference.mediaType === 'video' ? (
          <video src={`${reference.previewUrl}#t=0.1`} muted preload="metadata" className="h-full w-full object-cover" />
        ) : (
          <AppIcon name={REFERENCE_ICON[reference.mediaType]} className="h-4 w-4" />
        )}
      </span>
      <span className={`${SELECTABLE_TEXT_CLASS} min-w-0 flex-1 truncate text-xs font-medium text-[var(--glass-text-primary)]`} title={reference.name}>
        {reference.name}
      </span>
      {selectable ? (
        <select
          value={roles.includes(reference.role as CanvasDraftReferenceRole) ? reference.role : ''}
          disabled={disabled}
          aria-label={t('referenceRoleLabel')}
          className="nodrag h-7 rounded-[8px] border border-slate-200 bg-white px-1.5 text-[11px] text-[var(--glass-text-secondary)] outline-none focus:border-slate-400"
          onMouseDown={(event) => event.stopPropagation()}
          onChange={(event) => onChangeRole(event.target.value as CanvasDraftReferenceRole)}
        >
          <option value="" disabled>{t('parameterRequired')}</option>
          {roles.map((role) => (
            <option key={role} value={role}>{t(`referenceRole.${role}`)}</option>
          ))}
        </select>
      ) : (
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-[var(--glass-text-tertiary)]">
          {t(`referenceRole.${reference.role}`)}
        </span>
      )}
      <button
        type="button"
        disabled={disabled}
        aria-label={t('removeReference', { name: reference.name })}
        title={t('removeReference', { name: reference.name })}
        className="nodrag inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--glass-text-tertiary)] transition hover:bg-slate-100 hover:text-[var(--glass-text-primary)] disabled:opacity-50"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
      >
        <AppIcon name="close" className="h-3 w-3" />
      </button>
    </li>
  )
}
