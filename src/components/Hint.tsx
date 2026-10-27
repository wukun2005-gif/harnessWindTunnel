// Inline hover explanation. The popover is portalled and fixed-positioned
// because panels use overflow-x: auto and would clip a local tooltip. Touch and
// keyboard users get the same text: tap the label or focus it with Tab.
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface PopPos {
  left: number
  top: number
  above: boolean
  arrow: number
}

export function Hint({ text, children, className = '', style }: {
  text: string
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<PopPos | null>(null)
  const id = useId()

  const show = () => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const gap = 8
    const left = Math.min(Math.max(12, r.left), Math.max(12, window.innerWidth - 332))
    // Prefer below the label; flip above when the lower half lacks room.
    const above = r.bottom + 150 > window.innerHeight && r.top > 160
    setPos({
      left,
      top: above ? r.top - gap : r.bottom + gap,
      above,
      // Keep the arrow pointing at the label even when the box is clamped.
      arrow: Math.min(Math.max(12, r.left + r.width / 2 - left), 300),
    })
  }
  const hide = () => setPos(null)

  useEffect(() => {
    if (!pos) return
    const onScroll = () => hide()
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) hide()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [pos])

  return (
    <span
      ref={ref}
      className={`hint ${className}`.trim()}
      style={style}
      tabIndex={0}
      aria-describedby={pos ? id : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={() => (pos ? hide() : show())}
    >
      {children}
      <span className="hint-mark" aria-hidden="true">ⓘ</span>
      {pos && createPortal(
        <span
          id={id}
          role="tooltip"
          className={`hint-pop${pos.above ? ' above' : ''}`}
          style={{ left: pos.left, top: pos.top, '--hint-arrow': `${pos.arrow}px` } as CSSProperties}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  )
}
