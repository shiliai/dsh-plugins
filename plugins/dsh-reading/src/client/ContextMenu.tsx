import { useEffect } from 'react'
import css from './styles.module.css?dsh-inline'

export function ContextMenu({ x, y, onClose, onSend, onOpen }: { x: number; y: number; onClose(): void; onSend(): void; onOpen(): void }) {
  useEffect(() => { const close = () => onClose(); window.addEventListener('click', close); return () => window.removeEventListener('click', close) }, [onClose])
  return <div className={css.contextMenu} style={{ left: x, top: y }} onClick={event => event.stopPropagation()} role="menu">
    <button type="button" onClick={() => { onSend(); onClose() }}>发送元数据到当前对话</button>
    <button type="button" onClick={() => { onOpen(); onClose() }}>打开本篇新对话</button>
  </div>
}
