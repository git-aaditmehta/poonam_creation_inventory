import React, { useEffect, useRef, useState } from 'react';
import { Search, RotateCcw, X } from 'lucide-react';
import type { CropBox } from '../lib/dino/catalogCropCore';

/**
 * Gold box over a gallery photo (agreed 2026-11-21): starts around the piece the app found (colour crop) or, if none
 * was found, as the centre square; the user drags it to move and drags its corners to resize, then taps Identify.
 * Box coordinates are in the prepared photo's pixels.
 */
interface Props {
  canvas: HTMLCanvasElement;
  autoBox: CropBox | null;
  onIdentify: (box: CropBox) => void;
  onCancel: () => void;
}

type Drag = { mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; startX: number; startY: number; box: CropBox };
const MIN = 24; // smallest box side in photo pixels

function centreBox(W: number, H: number): CropBox {
  const s = Math.min(W, H);
  const i = Math.floor(s * 0.12);
  return { sx: Math.floor((W - s) / 2) + i, sy: Math.floor((H - s) / 2) + i, sw: s - 2 * i, sh: s - 2 * i };
}

export const GalleryBoxPicker: React.FC<Props> = ({ canvas, autoBox, onIdentify, onCancel }) => {
  const W = canvas.width;
  const H = canvas.height;
  const start = autoBox ?? centreBox(W, H);
  const [box, setBox] = useState<CropBox>(start);
  const [url] = useState(() => canvas.toDataURL('image/jpeg', 0.9));
  const imgRef = useRef<HTMLImageElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const [scale, setScale] = useState(1); // screen px per photo px

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / W);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W]);

  const clamp = (b: CropBox): CropBox => {
    const sw = Math.max(MIN, Math.min(W, b.sw));
    const sh = Math.max(MIN, Math.min(H, b.sh));
    return { sx: Math.max(0, Math.min(W - sw, b.sx)), sy: Math.max(0, Math.min(H - sh, b.sy)), sw, sh };
  };

  const onDown = (mode: Drag['mode']) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { mode, startX: e.clientX, startY: e.clientY, box };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / scale;
    const dy = (e.clientY - d.startY) / scale;
    const b = d.box;
    let n: CropBox;
    if (d.mode === 'move') n = { ...b, sx: Math.round(b.sx + dx), sy: Math.round(b.sy + dy) };
    else {
      let x0 = b.sx, y0 = b.sy, x1 = b.sx + b.sw, y1 = b.sy + b.sh;
      if (d.mode.includes('w')) x0 = Math.min(x1 - MIN, Math.max(0, x0 + dx));
      if (d.mode.includes('e')) x1 = Math.max(x0 + MIN, Math.min(W, x1 + dx));
      if (d.mode.includes('n')) y0 = Math.min(y1 - MIN, Math.max(0, y0 + dy));
      if (d.mode.includes('s')) y1 = Math.max(y0 + MIN, Math.min(H, y1 + dy));
      n = { sx: Math.round(x0), sy: Math.round(y0), sw: Math.round(x1 - x0), sh: Math.round(y1 - y0) };
    }
    setBox(clamp(n));
  };
  const onUp = () => {
    drag.current = null;
  };

  const handle = (mode: 'nw' | 'ne' | 'sw' | 'se') => {
    const pos: React.CSSProperties = {
      position: 'absolute',
      width: 36,
      height: 36,
      ...(mode.includes('n') ? { top: -22 } : { bottom: -22 }),
      ...(mode.includes('w') ? { left: -22 } : { right: -22 }),
      cursor: mode === 'nw' || mode === 'se' ? 'nwse-resize' : 'nesw-resize',
      touchAction: 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    };
    return (
      <div key={mode} style={pos} onPointerDown={onDown(mode)} aria-label="Resize the box">
        <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#D4AF37', border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,.5)' }} />
      </div>
    );
  };

  return (
    <div className="sj-sheet-backdrop" style={{ alignItems: 'center' }} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div className="sj-sheet" style={{ borderRadius: 16, maxHeight: '94vh', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 13, lineHeight: 1.4 }}>
            <strong>{autoBox ? 'Piece found' : 'Piece not found automatically'}</strong>
            <div style={{ color: 'var(--text-secondary)' }}>
              {autoBox
                ? 'Check the gold box covers just the piece. Drag it to move, drag a corner to resize, then tap Identify.'
                : 'Move the gold box over the piece and resize it from a corner, then tap Identify.'}
            </div>
          </div>
          <button type="button" className="btn-icon" onClick={onCancel} aria-label="Cancel"><X size={18} /></button>
        </div>
        <div style={{ position: 'relative', alignSelf: 'center', maxWidth: 'calc(100% - 24px)', margin: '12px', touchAction: 'none', userSelect: 'none' }}>
          <img ref={imgRef} src={url} alt="Picked photo" draggable={false} style={{ display: 'block', maxWidth: '100%', maxHeight: '58vh', borderRadius: 8 }} />
          {/* Photo dimmed outside the box (clipped to the photo) */}
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 8, pointerEvents: 'none' }}>
            <div style={{ position: 'absolute', left: box.sx * scale, top: box.sy * scale, width: box.sw * scale, height: box.sh * scale, boxShadow: '0 0 0 9999px rgba(0,0,0,.45)' }} />
          </div>
          {/* The gold box: drag inside to move; the dots just outside its corners resize it */}
          <div
            style={{
              position: 'absolute',
              left: box.sx * scale,
              top: box.sy * scale,
              width: box.sw * scale,
              height: box.sh * scale,
              border: '2px solid #D4AF37',
              borderRadius: 6,
              cursor: 'move',
              touchAction: 'none',
            }}
            onPointerDown={onDown('move')}
            aria-label="Gold box: drag to move"
          >
            {(['nw', 'ne', 'sw', 'se'] as const).map(handle)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" style={{ flex: '1 1 160px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => onIdentify(box)}>
            <Search size={16} /> Identify
          </button>
          <button type="button" className="btn btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setBox(start)}>
            <RotateCcw size={14} /> {autoBox ? 'Back to auto box' : 'Reset box'}
          </button>
        </div>
      </div>
    </div>
  );
};
