import type { ReactNode } from 'react'
import { cn } from './cn'

/*
 * PageHeader — consistent page title block: kicker → title → subtitle, with an
 * optional actions slot on the right. Standardizes the h1 scale across pages
 * (previously text-2xl / text-3xl / NavHeader-title were all used as "the title").
 */
export function PageHeader({
  kicker,
  title,
  subtitle,
  actions,
  className,
}: {
  kicker?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0 max-w-full break-words">
        {kicker && <p className="text-xs uppercase tracking-wide text-gray-400">{kicker}</p>}
        <h1 className="text-2xl font-bold tracking-tight text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-gray-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * PageContainer — the responsive max-width wrapper the app currently lacks on
 * desktop (mobile columns were stretching full-width). Mobile-first padding.
 */
export function PageContainer({
  size = 'md',
  className,
  children,
}: {
  size?: 'sm' | 'md' | 'lg'
  className?: string
  children: ReactNode
}) {
  const max = size === 'sm' ? 'max-w-2xl' : size === 'lg' ? 'max-w-6xl' : 'max-w-4xl'
  return <div className={cn('mx-auto w-full min-w-0 px-4 sm:px-6', max, className)}>{children}</div>
}
