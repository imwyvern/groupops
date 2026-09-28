import type { ReactNode } from 'react';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="btn-link" onClick={onClose}>关闭</button>
        </div>
        {children}
      </div>
    </div>
  );
}
