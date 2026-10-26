import { trackRendererWork } from '../lib/renderer-work-log'
import type { IBufferCell, IBufferLine, Terminal } from '@xterm/xterm'
import { drawTerminalGraphicGlyph, isGraphicGlyph } from './terminal-graphic-glyphs'

const BLOCK_GLYPH_CLASS = 'xterm-block-glyph'
const BLOCK_GLYPH_PLACEHOLDER_CLASS = 'xterm-block-glyph-placeholder'
const BLOCK_GLYPH_SOURCE_CLASS = 'xterm-block-glyph-source'
const BLOCK_GLYPH_TEXT_CLASS = 'xterm-block-glyph-text'

type GlyphColor = { css: string; rgba: number }
type GlyphPalette = { foreground: GlyphColor; background: GlyphColor; ansi: GlyphColor[] }
type ThemeServiceView = {
  _core?: {
    _themeService?: {
      colors?: GlyphPalette
      onChangeColors?: (listener: () => void) => { dispose(): void }
    }
  }
}
type TerminalDimensions = {
  _core?: {
    _renderService?: {
      dimensions?: { css?: { cell?: { width?: number; height?: number }; canvas?: { width?: number } } }
    }
  }
}
type SourceStyle = { generation: number; color: string; background: string; inline: string; priority: string }
type BufferGlyph = { codepoint: number; column: number; color: string }

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function getGlyphForeground(cell: IBufferCell, palette: GlyphPalette, drawBoldTextInBrightColors: boolean) {
  const inverse = Boolean(cell.isInverse())
  const rgb = inverse ? cell.isBgRGB() : cell.isFgRGB()
  const indexed = inverse ? cell.isBgPalette() : cell.isFgPalette()
  let value = inverse ? cell.getBgColor() : cell.getFgColor()
  let color: GlyphColor
  if (rgb) {
    color = { css: `rgb(${value >>> 16}, ${(value >>> 8) & 255}, ${value & 255})`, rgba: (value << 8) | 255 }
  } else if (indexed) {
    if (cell.isBold() && value < 8 && drawBoldTextInBrightColors) value += 8
    color = palette.ansi[value]
  } else {
    color = inverse ? palette.background : palette.foreground
  }
  // Graphic cells bypass text contrast adjustment. A DOM span can start with
  // a space and merge later blocks, incorrectly inheriting that space's adjusted
  // color. Resolve from the buffer and live palette instead (including OSC).
  if (cell.isDim() || (inverse && !rgb && !indexed)) {
    const rgba = color.rgba >>> 0
    const alpha = cell.isDim() ? (inverse && !rgb && !indexed ? 0.5 : (rgba & 255) / 510) : 1
    return `rgba(${rgba >>> 24}, ${(rgba >>> 16) & 255}, ${(rgba >>> 8) & 255}, ${alpha})`
  }
  return color.css
}

function collectGraphicGlyphs(
  bufferLine: IBufferLine | undefined,
  columnCount: number,
  reusableCell: IBufferCell,
  palette: GlyphPalette,
  drawBoldTextInBrightColors: boolean
): BufferGlyph[] {
  if (!bufferLine) return []
  const glyphs: BufferGlyph[] = []
  for (let column = 0; column < Math.min(columnCount, bufferLine.length); column++) {
    const cell = bufferLine.getCell(column, reusableCell)
    const codepoint = cell?.getCode() ?? 0
    if (isGraphicGlyph(codepoint)) {
      glyphs.push({
        codepoint,
        column,
        color: getGlyphForeground(cell!, palette, drawBoldTextInBrightColors)
      })
    }
  }
  return glyphs
}

function restoreSourceBackground(source: HTMLElement, styles: WeakMap<HTMLElement, SourceStyle>) {
  const style = styles.get(source)
  if (!style) return
  if (style.inline) source.style.setProperty('background-color', style.inline, style.priority)
  else source.style.removeProperty('background-color')
  source.classList.remove(BLOCK_GLYPH_SOURCE_CLASS)
  styles.delete(source)
}

function replaceBlockGlyphs(
  row: HTMLElement,
  screen: HTMLElement,
  rowIndex: number,
  columnCount: number,
  cellWidth: number,
  pixelRatio: number,
  bufferGlyphs: BufferGlyph[],
  sourceStyles: WeakMap<HTMLElement, SourceStyle>,
  styleGeneration: number,
  screenWidth: number,
  rowTopOffset: number,
  rowHeight: number,
  lineThickness: number,
  existingCanvas: HTMLCanvasElement | undefined
) {
  const document = row.ownerDocument
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let current = walker.nextNode()
  while (current) {
    const text = current.textContent ?? ''
    if (/[\u2500-\u259f]/u.test(text)) {
      textNodes.push(current as Text)
    }
    current = walker.nextNode()
  }

  const domGlyphs: Array<{ codepoint: number; color: string; background: string; decorated: boolean }> = []
  // A wrapped row keeps its placeholder spans and transparent sources until
  // xterm replaces the row's children. Re-wrapping it again only invalidates
  // style and layout, which is what made selection repaints expensive.
  let needsWrap = false
  let stylesRefreshed = false
  for (const textNode of textNodes) {
    const text = textNode.data
    const placeholder = textNode.parentElement?.classList.contains(BLOCK_GLYPH_PLACEHOLDER_CLASS)
      ? textNode.parentElement
      : null
    if (!placeholder || placeholder.style.color !== 'transparent') needsWrap = true
    const colorElement = placeholder?.parentElement ?? textNode.parentElement
    const source = colorElement ?? row
    if (!source.classList.contains('xterm-cursor') && !source.classList.contains(BLOCK_GLYPH_SOURCE_CLASS)) {
      needsWrap = true
    }
    const cached = sourceStyles.get(source)
    if (!cached || cached.generation !== styleGeneration) {
      stylesRefreshed = true
      const computed = document.defaultView!.getComputedStyle(source)
      sourceStyles.set(source, {
        generation: styleGeneration,
        color: computed.color,
        // While our wrapper is active the inline background is transparent;
        // keep the value resolved before we painted the source.
        background:
          cached && source.classList.contains(BLOCK_GLYPH_SOURCE_CLASS) ? cached.background : computed.backgroundColor,
        inline: cached?.inline ?? source.style.getPropertyValue('background-color'),
        priority: cached?.priority ?? source.style.getPropertyPriority('background-color')
      })
    }
    const snapshot = sourceStyles.get(source)!
    const background = snapshot.background
    for (const character of text) {
      const codepoint = character.codePointAt(0)!
      if (isGraphicGlyph(codepoint)) {
        domGlyphs.push({
          codepoint,
          color: snapshot.color,
          background,
          decorated: source.classList.contains('xterm-decoration-top')
        })
      }
    }
  }

  const glyphsMatchBuffer =
    bufferGlyphs.length === domGlyphs.length &&
    bufferGlyphs.every(({ codepoint }, index) => codepoint === domGlyphs[index].codepoint)
  if (!glyphsMatchBuffer) {
    existingCanvas?.remove()
    row.querySelectorAll<HTMLElement>(`.${BLOCK_GLYPH_SOURCE_CLASS}`).forEach((source) => {
      restoreSourceBackground(source, sourceStyles)
    })
    row.querySelectorAll<HTMLElement>(`.${BLOCK_GLYPH_TEXT_CLASS}`).forEach((text) => {
      text.replaceWith(document.createTextNode(text.textContent ?? ''))
    })
    row.querySelectorAll<HTMLElement>(`.${BLOCK_GLYPH_PLACEHOLDER_CLASS}`).forEach((placeholder) => {
      placeholder.style.color = ''
    })
    return
  }

  const glyphs = bufferGlyphs.map(({ codepoint, column, color }, index) => ({
    codepoint,
    column: Math.max(0, Math.min(columnCount - 1, column)),
    color: domGlyphs[index].decorated ? domGlyphs[index].color : color,
    background: domGlyphs[index].background
  }))

  if (glyphs.length === 0) {
    existingCanvas?.remove()
    return
  }

  // Snap once in the screen's local grid. Snapping the page origin and then
  // offsetting an absolutely positioned canvas can make the browser snap its
  // compositing layer a second time at fractional window/UI zoom positions.
  const pixelTop = Math.round(rowTopOffset * pixelRatio)
  const pixelBottom = Math.round((rowTopOffset + rowHeight) * pixelRatio)
  const pixelWidth = Math.round(screenWidth * pixelRatio)
  const pixelHeight = pixelBottom - pixelTop
  if (
    existingCanvas &&
    existingCanvas.width === pixelWidth &&
    existingCanvas.height === pixelHeight &&
    !needsWrap &&
    !stylesRefreshed
  ) {
    // The row already hides its text under an up-to-date canvas. Touching it
    // again would only invalidate style and layout during selection repaints.
    return
  }
  const canvas = existingCanvas ?? document.createElement('canvas')
  canvas.className = `${BLOCK_GLYPH_CLASS} xterm-block-glyph-row`
  canvas.dataset.rowIndex = String(rowIndex)
  canvas.dataset.blockCount = String(glyphs.length)
  canvas.setAttribute('aria-hidden', 'true')
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight
  const context = canvas.getContext('2d', { alpha: true })
  if (!context) {
    return
  }

  context.imageSmoothingEnabled = false
  context.clearRect(0, 0, pixelWidth, pixelHeight)
  for (const { codepoint, column, color, background } of glyphs) {
    const cellLeft = Math.round(column * cellWidth * pixelRatio)
    const cellRight = Math.round((column + 1) * cellWidth * pixelRatio)
    context.fillStyle = background
    context.fillRect(cellLeft, 0, cellRight - cellLeft, pixelHeight)
    context.fillStyle = color
    drawTerminalGraphicGlyph(context, codepoint, cellLeft, cellRight - cellLeft, pixelHeight, lineThickness)
  }

  Object.assign(canvas.style, {
    position: 'absolute',
    left: '0',
    top: `${pixelTop / pixelRatio}px`,
    display: 'block',
    width: `${pixelWidth / pixelRatio}px`,
    height: `${pixelHeight / pixelRatio}px`,
    margin: '0',
    padding: '0',
    border: '0',
    pointerEvents: 'none',
    // Selected DOM text is at level 2; graphical cells must also stay above
    // xterm's opaque selection layer (level 1).
    zIndex: '2',
    cursor: 'inherit'
  })
  return () => {
    if (!existingCanvas) {
      const selectionLayer = screen.querySelector('.xterm-selection')
      screen.insertBefore(canvas, selectionLayer ?? null)
    }

    for (const textNode of textNodes) {
      const placeholder = textNode.parentElement?.classList.contains(BLOCK_GLYPH_PLACEHOLDER_CLASS)
        ? textNode.parentElement
        : null
      const source = placeholder?.parentElement ?? textNode.parentElement
      if (!source) continue
      const background = sourceStyles.get(source)!.background
      // Span backgrounds use font line boxes rather than snapped terminal cells.
      // Move graphical backgrounds into the same bitmap as their foreground so
      // fractional UI positions cannot expose a black border above the sprite.
      if (!source.classList.contains('xterm-cursor')) {
        source.classList.add(BLOCK_GLYPH_SOURCE_CLASS)
        source.style.backgroundColor = 'transparent'
      }
      if (placeholder) {
        placeholder.style.color = 'transparent'
        continue
      }
      const fragment = document.createDocumentFragment()
      // One placeholder per graphical run preserves text/style boundaries without a DOM node per cell.
      for (const text of textNode.data.split(/([\u2500-\u259f]+)/u)) {
        if (!text) continue
        const graphic = isGraphicGlyph(text.codePointAt(0)!)
        const span = document.createElement('span')
        span.className = graphic ? BLOCK_GLYPH_PLACEHOLDER_CLASS : BLOCK_GLYPH_TEXT_CLASS
        if (graphic) span.style.color = 'transparent'
        else span.style.backgroundColor = background
        span.textContent = text
        fragment.append(span)
      }
      textNode.replaceWith(fragment)
    }

    row.querySelectorAll<HTMLElement>('.xterm-cursor').forEach((cursor) => {
      cursor.style.position = 'relative'
      cursor.style.zIndex = '2'
    })
  }
}

/**
 * xterm's DOM renderer draws blocks and box drawing from the active font.
 * Rasterize graphical cells from terminal-cell geometry, drawing each row into
 * one device-pixel bitmap using the terminal buffer's exact cell columns. This
 * keeps ANSI style-span boundaries and glyph bearings from shifting block art.
 */
export function registerTerminalBlockGlyphRenderer(terminal: Terminal) {
  const sourceStyles = new WeakMap<HTMLElement, SourceStyle>()
  // Bumped on theme changes so cached computed colors are re-read once.
  let styleGeneration = 0
  const reusableCell = terminal.buffer.active.getNullCell()
  let rowGeometry: { cellHeight: number; pixelRatio: number; height: number } | undefined
  // Increments once per pass so a coalesced observer flush can skip rows that an
  // onRender-driven pass already processed after the mutation was recorded.
  let passCount = 0
  let lastPass: { first: number; last: number; id: number } | undefined
  const renderRows = trackRendererWork('block-layout', (start: number, end: number) => {
    // xterm rewrites rows just before onRender, so this pass already covers them.
    // Drop those records up front: ranges without graphic rows return early
    // below, and leaving them queued would make the observer repeat the scan.
    observer?.takeRecords()
    const element = terminal.element
    const screen = element?.querySelector<HTMLElement>('.xterm-screen')
    const rowsElement = element?.querySelector<HTMLElement>('.xterm-rows')
    const rows = rowsElement?.children
    // Guard this narrow xterm 6 internal access; a future incompatible version
    // falls back to its native DOM renderer rather than guessing palette colors.
    const palette = (terminal as unknown as ThemeServiceView)._core?._themeService?.colors
    if (!screen || !rowsElement || !rows?.length || !palette || terminal.cols < 1 || terminal.rows < 1) {
      return
    }

    const canvases = new Map<number, HTMLCanvasElement>()
    screen.querySelectorAll<HTMLCanvasElement>('.xterm-block-glyph-row').forEach((canvas) => {
      const index = Number(canvas.dataset.rowIndex)
      if (index >= rows.length) canvas.remove()
      else canvases.set(index, canvas)
    })
    const first = Math.max(0, start)
    const last = Math.min(end, rows.length - 1)
    lastPass = { first, last, id: ++passCount }
    const buffer = terminal.buffer.active
    const drawBoldTextInBrightColors = terminal.options.drawBoldTextInBrightColors ?? true
    const affected: Array<{ index: number; row: HTMLElement; bufferGlyphs: BufferGlyph[] }> = []
    for (let index = first; index <= last; index++) {
      const row = rows[index]
      if (!(row instanceof HTMLElement)) continue
      const bufferGlyphs = collectGraphicGlyphs(
        buffer.getLine(buffer.viewportY + index),
        terminal.cols,
        reusableCell,
        palette,
        drawBoldTextInBrightColors
      )
      // A row that already carries a canvas must be revisited so a removed
      // glyph run is cleaned up even when the buffer no longer lists one.
      if (bufferGlyphs.length === 0 && !canvases.has(index)) continue
      affected.push({ index, row, bufferGlyphs })
    }
    if (!affected.length) return

    // Cache the browser's quantized row height so fractional layout rounding
    // cannot accumulate down the screen; unchanged grids need no layout read.
    const css = (terminal as unknown as TerminalDimensions)._core?._renderService?.dimensions?.css
    const calibratedWidth = css?.cell?.width
    const calibratedHeight = css?.cell?.height
    const calibratedCanvasWidth = css?.canvas?.width
    let cellWidth: number
    let cellHeight: number
    let rowHeight: number
    let screenWidth: number
    let rowTopBase = 0
    const pixelRatio = window.devicePixelRatio || 1
    if (
      isPositiveFinite(calibratedWidth) &&
      isPositiveFinite(calibratedHeight) &&
      isPositiveFinite(calibratedCanvasWidth)
    ) {
      cellWidth = calibratedWidth
      cellHeight = calibratedHeight
      screenWidth = calibratedCanvasWidth
      if (rowGeometry?.cellHeight !== calibratedHeight || rowGeometry.pixelRatio !== pixelRatio) {
        const height = rows[0].getBoundingClientRect().height
        if (!isPositiveFinite(height)) return
        rowGeometry = { cellHeight: calibratedHeight, pixelRatio, height }
      }
      rowHeight = rowGeometry.height
    } else {
      const bounds = screen.getBoundingClientRect()
      const rowsBounds = rowsElement.getBoundingClientRect()
      cellWidth = bounds.width / terminal.cols
      cellHeight = rowsBounds.height / terminal.rows
      rowHeight = cellHeight
      screenWidth = bounds.width
      rowTopBase = rowsBounds.top - bounds.top
    }
    if (cellWidth <= 0 || cellHeight <= 0 || screenWidth <= 0) {
      return
    }
    // Use one nominal thickness across rows; fractional DPI can give adjacent
    // snapped rows different bitmap heights at a rounding threshold.
    // A fractional display scale must not shrink light rules below one CSS
    // pixel. Such hairlines can disappear during WebView2 composition/capture.
    const lineThickness = Math.max(Math.ceil(pixelRatio), Math.round((cellHeight * pixelRatio) / 16))

    const updates: Array<() => void> = []
    for (const { index, row, bufferGlyphs } of affected) {
      const update = replaceBlockGlyphs(
        row,
        screen,
        index,
        terminal.cols,
        cellWidth,
        pixelRatio,
        bufferGlyphs,
        sourceStyles,
        styleGeneration,
        screenWidth,
        rowTopBase + index * rowHeight,
        rowHeight,
        lineThickness,
        canvases.get(index)
      )
      if (update) updates.push(update)
    }
    for (const update of updates) update()
    // Our own row-level writes must not schedule another pass.
    observer?.takeRecords()
  })

  const renderAllRows = () => renderRows(0, terminal.rows - 1)
  // xterm replaces a row's direct children when the selection or cursor state
  // changes, and a held selection rebuilds every row on each mouse move. Without
  // re-wrapping them the canvas keeps painting while the fresh text is visible
  // again, which reads as a heavier glyph until the next scroll. Coalesce those
  // records into one pass per animation frame: running the full block layout
  // synchronously per mutation made selection repaints saturate the renderer.
  // The symbol adapter observes the same rows and registers first, so its rewrite
  // lands before this pass and the placeholders win.
  const rowsElement = terminal.element?.querySelector<HTMLElement>('.xterm-rows')
  const view = rowsElement?.ownerDocument?.defaultView
  // Theme updates mutate the same palette object, so watch its change event
  // instead of comparing colors; re-resolve cached styles once per change.
  const themeSubscription = (terminal as unknown as ThemeServiceView)._core?._themeService?.onChangeColors?.(() => {
    styleGeneration++
  })
  let pendingRows: number[] = []
  let pendingFrame: number | undefined
  let pendingSincePass = 0
  const flushObserverRows = () => {
    pendingFrame = undefined
    const indexes = pendingRows
    pendingRows = []
    if (!indexes.length) return
    const first = Math.min(...indexes)
    const last = Math.max(...indexes)
    if (lastPass && lastPass.id > pendingSincePass && first >= lastPass.first && last <= lastPass.last) {
      return
    }
    renderRows(first, last)
  }
  const scheduleObserverRows = (indexes: number[]) => {
    if (!indexes.length) return
    if (!pendingRows.length) pendingSincePass = passCount
    pendingRows.push(...indexes)
    if (pendingFrame !== undefined) return
    // A hidden window may never receive animation frames, and it needs no smooth
    // repaint; settle those rows immediately instead of leaving text visible
    // under the canvas until the window returns.
    if (view && typeof view.requestAnimationFrame === 'function' && view.document?.visibilityState !== 'hidden') {
      pendingFrame = view.requestAnimationFrame(flushObserverRows)
      return
    }
    flushObserverRows()
  }
  const observer =
    rowsElement && view && typeof view.MutationObserver === 'function'
      ? new view.MutationObserver((records) => {
          const changed = new Set<HTMLElement>()
          for (const record of records) {
            if (record.target instanceof view.HTMLElement && record.target.parentElement === rowsElement) {
              changed.add(record.target as HTMLElement)
            }
          }
          const children = Array.from(rowsElement.children)
          const indexes = [...changed].map((row) => children.indexOf(row)).filter((index) => index >= 0)
          if (indexes.length) scheduleObserverRows(indexes)
        })
      : null
  if (observer && rowsElement) observer.observe(rowsElement, { childList: true, subtree: true })
  // xterm batches scroll/resize into onRender; their immediate events still have stale DOM rows.
  const disposable = terminal.onRender(({ start, end }) => renderRows(start, end))
  renderAllRows()
  return {
    dispose() {
      disposable.dispose()
      themeSubscription?.dispose()
      if (pendingFrame !== undefined) view?.cancelAnimationFrame?.(pendingFrame)
      pendingFrame = undefined
      pendingRows = []
      observer?.disconnect()
      terminal.element?.querySelectorAll(`.${BLOCK_GLYPH_CLASS}`).forEach((glyph) => glyph.remove())
      terminal.element?.querySelectorAll(`.${BLOCK_GLYPH_PLACEHOLDER_CLASS}`).forEach((glyph) => {
        glyph.replaceWith(glyph.ownerDocument.createTextNode(glyph.textContent ?? ''))
      })
      terminal.element?.querySelectorAll(`.${BLOCK_GLYPH_TEXT_CLASS}`).forEach((text) => {
        text.replaceWith(text.ownerDocument.createTextNode(text.textContent ?? ''))
      })
      terminal.element?.querySelectorAll<HTMLElement>(`.${BLOCK_GLYPH_SOURCE_CLASS}`).forEach((source) => {
        restoreSourceBackground(source, sourceStyles)
      })
    }
  }
}
